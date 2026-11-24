// The Pine app's real access host, for the native cores' tests: `node mobile/test/support/access-host.ts`.
// One script for both cores (the Kotlin suite of `npm run test:core`, the Swift one of `swift test`).
// It runs, on loopback ports and in a home of its own in a temp folder:
//   - the Worker's meeting module (web/relay/src/meet.ts) behind an HTTP and WebSocket server, whose
//     configuration names no STUN or TURN server, so that nothing leaves this computer;
//   - the access host of the Pine app (desktop/electron/access/host.ts) waiting there, with pairing as
//     its admission (desktop/electron/access/pairing.ts) and an owner who answers as the test says;
//   - a stand-in daemon, which the access host's service line names.
// It needs `npm install` in desktop/ (ssh2, node-datachannel, ws); without them it says what is missing.
//
// Protocol. Every line it writes on its standard output is one JSON object, whose `t` says what it is.
// Every line it reads on its standard input is one command: words separated by spaces.
//
// Options (arguments):
//   --computer-name <name>   the name the computer gives a paired phone (default "Test Mac")
//   --pairing-ms <ms>        how long an opened pairing's code works (default the app's, 2 minutes)
//   --answer-ms <ms>         how long a pairing request waits for the owner (default the app's, 2 minutes)
//   --service-line <json>    the line `pine service` answers with, for a stand-in daemon of the test's
//                            own; without it the helper runs its own stand-in daemon and names it
//   --desktop <folder>       the desktop package to load the access host from (default the checkout's)
//   --nearby                 codeless requests (user `nearby.<nonce>`) are let in from the start, as when the
//                            owner keeps the computer visible on the network; without it they are refused
//   --service-name <origin>  the meeting service the computer names, in a pairing link and on the pairing
//                            channel (default the loopback meeting service's origin): an https name that a
//                            test routes to `service`, as the announcement of a real computer names one
//
// First line, once the access host waits at the meeting:
//   {"t":"ready","service":"http://127.0.0.1:<port>","machineId":"<43 chars>","nonce":"<22 chars>","daemon":{"base":"http://127.0.0.1:<port>","token":"<token>"},"home":"<temp folder>"}
//   `service` is the meeting service's origin (what a pairing link starts with, unless --service-name
//   names another). `nonce` is the one the computer's announcement carries now, which a codeless request
//   names (`nearby.<nonce>`). `daemon` is the stand-in daemon (absent with --service-line). Instead, when
//   a package is missing, and then it exits with 2:
//   {"t":"missing","message":"..."}
//
// Commands, each answered by exactly one line, in the order they came, whose `t` is the command's
// first word (or {"t":"error","to":"<word>","message":"..."} when it cannot be done):
//   open                         opens a pairing (closing the one that was open)
//                                -> {"t":"open","link":"<service name>/#pair=<machine id>.<code>","expires":"<ISO date>"}
//   cancel                       closes the open pairing -> {"t":"cancel"}
//   allow | refuse               answers the pairing request that waits for the owner; with none waiting,
//                                the answer is kept for the next request -> {"t":"allow","waiting":true|false}
//   devices                      -> {"t":"devices","devices":[{"id","name","key","paired","seen"?,"connected":bool}]}
//                                `key` is the SSH public key blob in base64, `id` its SHA-256 in base64url
//   add <algo> <base64> [name]   pairs a public key directly, as an authorized_keys line (ssh-ed25519 only);
//                                the name is the rest of the line -> {"t":"add","id","name"}
//   remove <id>                  forgets a device and cuts its connections -> {"t":"remove","id","removed":bool}
//   cut [<id>]                   cuts the live connections of a device (of every device without an id),
//                                which stays paired -> {"t":"cut","count":<connections cut>}
//   nearby on|off                whether codeless requests are let in now -> {"t":"nearby","on":bool,"nonce":"<current>"}
//   rotate                       a new nonce, as the announcement gets every few minutes: the one before it
//                                still works, the one before that no longer -> {"t":"rotate","nonce":"<new>"}
//   meeting <mode>               how the meeting service treats a phone that joins this computer's id:
//                                normal; swap (put through to another computer, with another host key,
//                                which has no device: a service that lies); hold (told the computer is
//                                there, then nothing: no path); limits (closed at once with 4429)
//                                -> {"t":"meeting","mode","impostor"?:"<the other computer's machine id>"}
//   stop                         -> {"t":"stop"}, then it ends everything, removes its home and exits with 0
//
// Events, written when they happen, between the answers:
//   {"t":"asked","name":"<device name>","code":"<4 digits>","kind":"code"|"nearby"}
//                                                               a pairing request waits for the owner
//   {"t":"paired","id","name"}                                  the owner's yes stored a device
//   {"t":"connected","id"} / {"t":"left","id"}                  an SSH session began or ended (`id` is the
//                                                               device's, or "pairing:..." for a pairing session)
//
// The end of its standard input, SIGTERM and SIGINT do what `stop` does, without the answer.
import { randomBytes } from "node:crypto";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { createRequire } from "node:module";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";

const write = (line: object) => process.stdout.write(`${JSON.stringify(line)}\n`);

function option(name: string): string | undefined {
	const at = process.argv.indexOf(`--${name}`);
	return at >= 0 ? process.argv[at + 1] : undefined;
}

const checkout = fileURLToPath(new URL("../../../", import.meta.url));
const desktopFolder = path.resolve(option("desktop") ?? path.join(checkout, "desktop"));
const NEEDED = ["ssh2", "node-datachannel", "ws"];
const absent = NEEDED.filter((name) => !existsSync(path.join(desktopFolder, "node_modules", name, "package.json")));
if (absent.length || !existsSync(path.join(desktopFolder, "electron", "access", "host.ts"))) {
	const message = `The access host helper needs the desktop package with its dependencies (${NEEDED.join(", ")}; missing: ${absent.join(", ") || "the access host's sources"}) in ${desktopFolder}. Run \`npm install\` at the root of the checkout and in desktop/.`;
	write({ t: "missing", message });
	process.stderr.write(`${message}\n`);
	process.exit(2);
}

// The modules are loaded by address, so that the mobile type check does not compile the desktop's
// main process or the Worker's source. These are the parts the helper uses.
type Key = { algo: string; data: Buffer };
type Device = { id: string; key: string; name: string; paired: string; seen?: string };
type Store = { devices(): Device[]; add(device: { key: Buffer; name: string }): Promise<Device> };
type SessionEvent = { kind: "connected" | "left"; id: string };
type Admit = (user: string, key: Key) => unknown;
type AdmitContext = { store: Store; service: string; cut(id: string): number };
type AccessHost = {
	machineId: string;
	store: Store;
	server: { cut(id: string): number; connected(): Array<{ id: string }> };
	status(): string;
	remove(id: string): Promise<boolean>;
	stop(): Promise<void>;
};
type Pairing = { open(): { link: string; expires: Date }; cancel(): void; admit: Admit; nearbyNonce(): string; rotateNearbyNonce(): void };
type Plain = { send(text: string): void; close(code: number, reason: string): void };
type MeetModule = {
	route(url: URL): { kind: "host" | "join"; id: string } | null;
	inMemory(): { connect(kind: "host" | "join", id: string, origin: string, socket: Plain): { message(data: unknown): Promise<void>; closed(): void } };
};
type WsSocket = Plain & { on(event: string, fn: (...args: any[]) => void): void; once(event: string, fn: () => void): void; terminate(): void };
type WsServer = {
	clients: Set<WsSocket>;
	handleUpgrade(req: IncomingMessage, socket: unknown, head: Buffer, done: (ws: WsSocket) => void): void;
	close(): void;
};

const access = (file: string) => import(new URL(`file://${path.join(desktopFolder, "electron", "access", file)}`).href);
const { startAccessHost } = (await access("host.ts")) as { startAccessHost(options: Record<string, unknown>): Promise<AccessHost> };
const { createPairing } = (await access("pairing.ts")) as { createPairing(options: Record<string, unknown>): Pairing };
const { inMemory, route } = (await import(new URL("../../../web/relay/src/meet.ts", import.meta.url).href)) as MeetModule;
const { WebSocketServer } = createRequire(path.join(desktopFolder, "package.json"))("ws") as { WebSocketServer: new (options: { noServer: true }) => WsServer };

const home = mkdtempSync(path.join(tmpdir(), "pine-access-helper-"));
const servers: Server[] = [];

async function listen(server: Server) {
	servers.push(server);
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

// The stand-in daemon: the token or 401; `/health` answers that it is fine, everything else is echoed.
const token = randomBytes(18).toString("base64url");
let daemon: { base: string; token: string } | undefined;
let serviceLine = option("service-line");
if (!serviceLine) {
	const base = await listen(
		createServer((req: IncomingMessage, res: ServerResponse) => {
			let body = "";
			req.on("data", (d) => (body += d));
			req.on("end", () => {
				const json = (status: number, value: unknown) => {
					const text = Buffer.from(JSON.stringify(value));
					res.writeHead(status, { "content-type": "application/json", "content-length": text.length }).end(text);
				};
				if (req.headers.authorization !== `Bearer ${token}`) return json(401, { error: "unauthorized" });
				if (req.url === "/health") return json(200, { ok: true });
				json(200, { echoed: { method: req.method, url: req.url, body } });
			});
		}),
	);
	daemon = { base, token };
	serviceLine = JSON.stringify({ base, token, mode: "safe", started: true, home: path.join(home, "pine"), version: "0.0.0" });
}

// The meeting service, with what the `meeting` command changes about a join for this computer's id.
type Mode = "normal" | "swap" | "hold" | "limits";
let mode: Mode = "normal";
let machineId = "";
let impostor: AccessHost | undefined;
const meetings = inMemory();
const wss = new WebSocketServer({ noServer: true });
const meetingServer = createServer((req, res) => {
	if (req.url === "/meet/config") return void res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ ice: [], relay: false }));
	res.writeHead(404).end();
});
meetingServer.on("upgrade", (req, socket, head) => {
	const to = route(new URL(req.url ?? "/", `http://${req.headers.host}`));
	if (!to) return socket.destroy();
	wss.handleUpgrade(req, socket, head, (ws) => {
		const ours = to.kind === "join" && to.id === machineId;
		if (ours && mode === "limits") return ws.close(4429, "Over the limits (the helper was told so).");
		if (ours && mode === "hold") return ws.send(JSON.stringify({ t: "ready" }));
		const id = ours && mode === "swap" && impostor ? impostor.machineId : to.id;
		const connection = meetings.connect(to.kind, id, `http://${req.headers.host}`, ws);
		ws.on("message", (data: Buffer, binary: boolean) => void connection.message(binary ? data : data.toString()));
		ws.once("close", () => connection.closed());
	});
});
const service = await listen(meetingServer);

// The owner: a request waits for `allow` or `refuse`, or takes the one given before it came.
let decide: ((yes: boolean) => void) | undefined;
let early: boolean | undefined;
let pairing: Pairing | undefined;
let visible = process.argv.includes("--nearby");

async function waitingHost(folder: string, admit?: (context: AdmitContext) => Admit, report?: (event: SessionEvent) => void) {
	const host = await startAccessHost({ service, folder, daemon: async () => serviceLine, admit, report, retry: { firstMs: 50, maxMs: 400 } });
	const end = Date.now() + 10_000;
	while (host.status() !== "waiting") {
		if (Date.now() > end) throw new Error(`the access host never waited at the meeting (${host.status()})`);
		await new Promise((r) => setTimeout(r, 20));
	}
	return host;
}

const host = await waitingHost(
	path.join(home, "computer"),
	(context) => {
		pairing = createPairing({
			...context,
			service: option("service-name") ?? context.service,
			computerName: () => option("computer-name") ?? "Test Mac",
			pairingMs: option("pairing-ms") ? Number(option("pairing-ms")) : undefined,
			answerMs: option("answer-ms") ? Number(option("answer-ms")) : undefined,
			nearby: () => visible,
			// The cores' tests ask in a row; the least time between codeless sessions is the desktop tests' to check.
			nearbyGapMs: 0,
			paired: (device: Device) => write({ t: "paired", id: device.id, name: device.name }),
			ask: (request: { name: string; code: string; kind?: string }, signal: AbortSignal) => {
				write({ t: "asked", name: request.name, code: request.code, kind: request.kind ?? "code" });
				if (early !== undefined) {
					const yes = early;
					early = undefined;
					return Promise.resolve(yes);
				}
				return new Promise<boolean>((resolve) => {
					decide = resolve;
					signal.addEventListener("abort", () => decide === resolve && (decide = undefined), { once: true });
				});
			},
		});
		return pairing.admit;
	},
	(event) => write({ t: event.kind, id: event.id }),
);
machineId = host.machineId;
write({ t: "ready", service, machineId, nonce: pairing!.nearbyNonce(), ...(daemon && { daemon }), home });

let stopping: Promise<void> | undefined;
function stop() {
	stopping ??= (async () => {
		await Promise.all([host.stop(), impostor?.stop()]);
		for (const ws of wss.clients) ws.terminate();
		wss.close();
		await Promise.all(
			servers.map((s) => {
				s.closeAllConnections();
				return new Promise<void>((resolve) => s.close(() => resolve()));
			}),
		);
		rmSync(home, { recursive: true, force: true });
	})();
	return stopping;
}

/** The answer to one command. */
async function run(words: string[]): Promise<object> {
	const [word, ...rest] = words;
	switch (word) {
		case "open": {
			const opened = pairing!.open();
			return { link: opened.link, expires: opened.expires.toISOString() };
		}
		case "cancel":
			pairing!.cancel();
			return {};
		case "allow":
		case "refuse": {
			const yes = word === "allow";
			if (decide) {
				const answer = decide;
				decide = undefined;
				answer(yes);
				return { waiting: true };
			}
			early = yes;
			return { waiting: false };
		}
		case "devices": {
			const connected = new Set(host.server.connected().map((c) => c.id));
			return { devices: host.store.devices().map((d) => ({ ...d, connected: connected.has(d.id) })) };
		}
		case "add": {
			const [algo, blob, ...name] = rest;
			if (algo !== "ssh-ed25519" || !blob || !/^[A-Za-z0-9+/]+=*$/.test(blob)) throw new Error("Give the key as an authorized_keys line: add ssh-ed25519 <base64> [name].");
			const device = await host.store.add({ key: Buffer.from(blob, "base64"), name: name.join(" ") });
			return { id: device.id, name: device.name };
		}
		case "remove": {
			if (!rest[0]) throw new Error("Name the device: remove <id>.");
			return { id: rest[0], removed: await host.remove(rest[0]) };
		}
		case "cut": {
			const ids = rest[0] ? [rest[0]] : [...new Set(host.server.connected().map((c) => c.id))];
			return { count: ids.reduce((sum, id) => sum + host.server.cut(id), 0) };
		}
		case "nearby": {
			if (rest[0] !== "on" && rest[0] !== "off") throw new Error("Say nearby on, or nearby off.");
			visible = rest[0] === "on";
			return { on: visible, nonce: pairing!.nearbyNonce() };
		}
		case "rotate":
			pairing!.rotateNearbyNonce();
			return { nonce: pairing!.nearbyNonce() };
		case "meeting": {
			const next = rest[0] as Mode;
			if (!["normal", "swap", "hold", "limits"].includes(next)) throw new Error("The modes are normal, swap, hold and limits.");
			if (next === "swap") impostor ??= await waitingHost(path.join(home, "impostor"));
			mode = next;
			return next === "swap" ? { mode, impostor: impostor!.machineId } : { mode };
		}
		case "stop":
			return {};
		default:
			throw new Error(`Unknown command. The commands are open, cancel, allow, refuse, devices, add, remove, cut, nearby, rotate, meeting and stop.`);
	}
}

// One command at a time, in the order they came, so that answers come in that order too.
let queue = Promise.resolve();
const input = createInterface({ input: process.stdin });
input.on("line", (line) => {
	const words = line.trim().split(/\s+/).filter(Boolean);
	if (!words.length) return;
	queue = queue.then(async () => {
		if (stopping) return;
		try {
			write({ t: words[0], ...(await run(words)) });
		} catch (e) {
			write({ t: "error", to: words[0], message: (e as Error).message });
		}
		if (words[0] === "stop") await end();
	});
});
input.on("close", () => void queue.then(end));
process.on("SIGTERM", () => void end());
process.on("SIGINT", () => void end());

async function end() {
	await stop();
	// The peer connections' library can keep the process for a while after it closed them: what the
	// helper started is all ended, so it does not wait for that. (Its last lines are flushed first: on
	// macOS a pipe is written to asynchronously.)
	process.stdout.write("", () => process.exit(0));
}
