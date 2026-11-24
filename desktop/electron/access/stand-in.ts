// A stand-in for the access host, for tests only: the app's tests name it with
// PINE_DESKTOP_ACCESS_STAND_IN, the tests without a window hand it to the control. It has the
// real store, the real access server and the admission it is given (pairing), and no network:
// it says it waits at once, and a "phone" of its own plays the browser over an in-memory stream.
// When a pairing is opened, the phone uses its link after a moment: it connects with the code,
// makes the pairing request as "Stand-in phone", and once allowed connects again as a paired
// device, runs the remote command and stays connected, as a browser does.
import path from "node:path";
import { Duplex } from "node:stream";
import ssh2 from "ssh2";
import { remoteCommand } from "../../../src/remote.ts";
import type { Host } from "./control.ts";
import { ACCESS_FILE, type AccessHostOptions, fileVault, type HostStatus } from "./host.ts";
import { ALGORITHMS, createAccessServer, pairedKeys } from "./server.ts";
import { AccessStore, keyId, newEd25519Key } from "./store.ts";

/** The name the stand-in phone gives itself. */
export const STAND_IN_NAME = "Stand-in phone";

/**
 * Two ends of an in-memory stream whose bytes arrive on a later turn of the event loop, as a
 * socket's or a data channel's do. (Node's `duplexPair` hands them over inside the write, and
 * ssh2 is not written for an answer that arrives while it is still sending.) The tests use it too.
 */
export function duplexPair(): [Duplex, Duplex] {
	const other = new Map<Duplex, Duplex>();
	const make = () =>
		new Duplex({
			read() {},
			write(chunk, _encoding, done) {
				const to = other.get(this)!;
				setImmediate(() => {
					if (!to.destroyed) to.push(chunk);
					done();
				});
			},
			final(done) {
				const to = other.get(this)!;
				setImmediate(() => {
					to.push(null);
					done();
				});
			},
			destroy(err, done) {
				const to = other.get(this)!;
				setImmediate(() => to.destroy());
				done(err);
			},
		});
	const a = make();
	const b = make();
	other.set(a, b).set(b, a);
	return [a, b];
}

/** Runs a command and hands back its channel. */
const exec = (client: ssh2.Client, command: string) =>
	new Promise<ssh2.ClientChannel>((resolve, reject) => client.exec(command, (err, channel) => (err ? reject(err) : resolve(channel))));

export async function startStandIn(options: AccessHostOptions & { waitMs?: number }): Promise<Host> {
	const origin = new URL(options.service).origin;
	const vault = options.vault ?? fileVault(path.join(options.folder!, options.cipher ? ACCESS_FILE.sealed : ACCESS_FILE.plain), options.cipher);
	const store = await AccessStore.open(vault);
	const machineId = store.machineId();
	const admit = options.admit ? options.admit({ store, service: origin, cut: (id) => server.cut(id) }) : pairedKeys(store);
	const server = createAccessServer({
		hostKey: store.hostKey(),
		admit,
		daemon: options.daemon,
		report: (event) => {
			if (event.kind === "connected") void store.seen(event.id, event.at).catch(() => {});
			options.report?.(event);
		},
	});
	let status: HostStatus = "connecting";
	let stopped = false;
	const clients = new Set<ssh2.Client>();
	setImmediate(() => {
		if (stopped) return;
		status = "waiting";
		options.onStatus?.(status);
	});

	/** The phone connects to the server over an in-memory stream, pinning this computer's machine id. */
	const connect = (username: string, privateKey: string) =>
		new Promise<ssh2.Client>((resolve, reject) => {
			const [computer, phone] = duplexPair();
			if (!server.accept(computer, { path: "lan" })) return reject(new Error("turned away"));
			const client = new ssh2.Client();
			clients.add(client);
			client.on("close", () => clients.delete(client));
			client.once("ready", () => resolve(client));
			client.once("error", reject);
			client.connect({ sock: phone, username, privateKey, hostVerifier: (key: Buffer) => keyId(key) === machineId, algorithms: ALGORITHMS as unknown as ssh2.Algorithms });
		});

	async function play(link: string) {
		const code = link.slice(link.lastIndexOf(".") + 1);
		const key = newEd25519Key();
		const pairing = await connect(`pair.${code}`, key.private);
		const name = Buffer.from(JSON.stringify({ name: STAND_IN_NAME })).toString("base64url");
		const request = await exec(pairing, `pine-pair ${name}`);
		let said = "";
		const answer = await new Promise<{ ok?: boolean }>((resolve) => {
			request.on("data", (d: Buffer) => {
				said += d;
				const last = said.trim().split("\n").map((l) => JSON.parse(l)).find((l) => "ok" in l);
				if (last) resolve(last);
			});
			request.on("close", () => resolve({ ok: false }));
		});
		pairing.end();
		if (!answer.ok || stopped) return;
		const paired = await connect("pine", key.private);
		// As the web client: the remote command's channel stays open while the session lasts.
		const channel = await exec(paired, remoteCommand());
		channel.on("data", () => {});
	}

	return {
		machineId,
		service: origin,
		store,
		server,
		status: () => status,
		connected: () => server.connected().map(({ id, tag }) => ({ id, path: (tag as { path?: "lan" } | undefined)?.path })),
		peers: () => clients.size,
		async remove(id) {
			const removed = await store.remove(id);
			server.cut(id);
			return removed;
		},
		opened(link) {
			const wait = options.waitMs ?? 300;
			setTimeout(() => void play(link).catch(() => {}), wait);
		},
		async stop() {
			stopped = true;
			for (const client of clients) client.end();
			server.close();
		},
	};
}
