// The helper the native cores' tests pair with (test/support/access-host.ts), driven as they drive
// it: a child process told what to do line by line, with a Node peer from the desktop's tests in
// the phone's place (a WebRTC data channel and an SSH client over it). No network but the loopback.
import assert from "node:assert/strict";
import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { connect } from "node:net";
import { tmpdir } from "node:os";
import { join as joinPath } from "node:path";
import { after, test } from "node:test";
import { fileURLToPath } from "node:url";

/** The parts of the desktop's test support the phone is played with (desktop/test/support/meeting.ts, desktop/electron/access/store.ts). */
type Channel = { write(data: string | Buffer): void; on(event: string, fn: (data: Buffer) => void): void; once(event: string, fn: () => void): void };
type Client = { end(): void; once(event: string, fn: () => void): void; on(event: string, fn: (e: Error) => void): void };
type Meeting = {
	join(service: string, id: string): { channel: Promise<unknown>; closed: Promise<number>; close(): void };
	sshOver(stream: unknown, id: string, privateKey: string, config?: { username?: string }): { client: Client; ready: Promise<Client>; seen: string[]; offered(): number };
	exec(client: Client, command: string): Promise<Channel>;
	firstLine(channel: Channel): Promise<string>;
	tunnel(client: Client, host: string, port: number): Promise<Channel>;
};
type Store = { newEd25519Key(): { private: string; public: Buffer }; keyId(blob: Buffer): string };
// Loaded by address, so that the mobile type check does not compile the desktop's sources.
const desktop = (file: string) => new URL(`../../desktop/${file}`, import.meta.url).href;
const { join, sshOver, exec, firstLine, tunnel } = (await import(desktop("test/support/meeting.ts"))) as Meeting;
const { newEd25519Key, keyId } = (await import(desktop("electron/access/store.ts"))) as Store;

const HELPER = fileURLToPath(new URL("./support/access-host.ts", import.meta.url));
/** The remote command both cores run (cases/remote-command.txt), which the access server compares. */
const REMOTE_COMMAND = readFileSync(new URL("../cases/remote-command.txt", import.meta.url), "utf8").trimEnd();

type Line = Record<string, any>;

/** A running helper: the lines it wrote, a way to wait for one, and a way to tell it something. */
function helper(args: string[] = []) {
	const child: ChildProcessWithoutNullStreams = spawn(process.execPath, [HELPER, ...args], { stdio: ["pipe", "pipe", "pipe"] });
	const lines: Line[] = [];
	const waiters: Array<() => void> = [];
	let rest = "";
	let errors = "";
	child.stderr.on("data", (d) => (errors += d));
	child.stdout.on("data", (d) => {
		rest += d;
		for (let end = rest.indexOf("\n"); end >= 0; end = rest.indexOf("\n")) {
			lines.push(JSON.parse(rest.slice(0, end)));
			rest = rest.slice(end + 1);
		}
		for (const w of waiters.splice(0)) w();
	});
	const exited = new Promise<number | null>((resolve) => child.once("exit", (code) => resolve(code)));
	let read = 0;
	/** The next line, from the last one read on, that `ok` accepts. */
	async function next(ok: (line: Line) => boolean, what: string, ms = 10_000): Promise<Line> {
		const end = Date.now() + ms;
		for (;;) {
			const at = lines.findIndex((l, i) => i >= read && ok(l));
			if (at >= 0) {
				read = at + 1;
				return lines[at];
			}
			if (Date.now() > end || child.exitCode !== null) throw new Error(`never: ${what}. Lines: ${JSON.stringify(lines)} ${errors}`);
			await new Promise<void>((resolve) => {
				waiters.push(resolve);
				setTimeout(resolve, 50);
			});
		}
	}
	/** Sends a line and waits for its answer (or the error about it). */
	async function say(command: string): Promise<Line> {
		child.stdin.write(`${command}\n`);
		const word = command.split(" ")[0];
		return next((l) => l.t === word || (l.t === "error" && l.to === word), `an answer to ${word}`);
	}
	running.add(child);
	return { child, lines, next, say, exited, errors: () => errors };
}
const running = new Set<ChildProcessWithoutNullStreams>();
const folders: string[] = [];
// A helper a failed test left running is asked to end, so that it removes its home; killed if it does not.
after(async () => {
	await Promise.all(
		[...running].filter((child) => child.exitCode === null && child.signalCode === null).map((child) => {
			const gone = new Promise<void>((resolve) => child.once("exit", () => resolve()));
			child.kill("SIGTERM");
			const timer = setTimeout(() => child.kill("SIGKILL"), 5000);
			return gone.then(() => clearTimeout(timer));
		}),
	);
	for (const f of folders) rmSync(f, { recursive: true, force: true });
});

/** The four digits and the outcome a pairing request is answered with. */
async function pairingRequest(service: string, machineId: string, link: string, key: string, name: string) {
	const code = link.slice(link.lastIndexOf(".") + 1);
	const meeting = join(service, machineId);
	const session = await sshOver(await meeting.channel, machineId, key, { username: `pair.${code}` }).ready;
	const request = await exec(session, `pine-pair ${Buffer.from(JSON.stringify({ name })).toString("base64url")}`);
	let said = "";
	const lines = new Promise<Line[]>((resolve) => {
		request.on("data", (d: Buffer) => {
			said += d;
			if (said.includes('"ok"')) resolve(said.trim().split("\n").map((l) => JSON.parse(l)));
		});
	});
	return { lines, end: () => (session.end(), meeting.close()) };
}

/** A paired session as user `pine`, the remote command's line, and an HTTP request to the daemon through a direct-tcpip channel. */
async function reach(service: string, machineId: string, key: string) {
	const meeting = join(service, machineId);
	const client = await sshOver(await meeting.channel, machineId, key).ready;
	const line = JSON.parse(await firstLine(await exec(client, REMOTE_COMMAND)));
	return { client, line, meeting };
}

async function get(client: Client, base: string, path: string, token: string) {
	const url = new URL(base);
	const channel = await tunnel(client, url.hostname, Number(url.port));
	let text = "";
	const done = new Promise<string>((resolve) => {
		channel.on("data", (d: Buffer) => (text += d));
		channel.once("close", () => resolve(text));
	});
	channel.write(`GET ${path} HTTP/1.1\r\nHost: ${url.host}\r\nAuthorization: Bearer ${token}\r\nConnection: close\r\n\r\n`);
	const answer = await done;
	return JSON.parse(answer.slice(answer.indexOf("\r\n\r\n") + 4));
}

test("helper: a pairing it opens pairs a client, which then reaches the stand-in daemon through the access host", async () => {
	const h = helper(["--computer-name", "Studio Mac"]);
	const ready = await h.next((l) => l.t === "ready", "ready");
	assert.match(ready.service, /^http:\/\/127\.0\.0\.1:\d+$/);
	assert.match(ready.machineId, /^[A-Za-z0-9_-]{43}$/);
	const { link } = await h.say("open");
	assert.ok(link.startsWith(`${ready.service}/#pair=${ready.machineId}.`), link);

	const phone = newEd25519Key();
	const request = await pairingRequest(ready.service, ready.machineId, link, phone.private, "Pine on Pixel 9");
	const asked = await h.next((l) => l.t === "asked", "the owner is asked");
	assert.equal(asked.name, "Pine on Pixel 9");
	assert.match(asked.code, /^\d{4}$/);
	assert.equal((await h.say("allow")).waiting, true);
	const [digits, outcome] = await request.lines;
	assert.equal(digits.code, asked.code, "the phone was shown the digits the owner was asked with");
	assert.deepEqual(outcome, { ok: true, name: "Studio Mac" });
	const paired = await h.next((l) => l.t === "paired", "paired");
	assert.equal(paired.id, keyId(phone.public));
	request.end();

	const { client, line, meeting } = await reach(ready.service, ready.machineId, phone.private);
	assert.equal(line.base, ready.daemon.base);
	assert.equal(line.token, ready.daemon.token);
	assert.deepEqual(await get(client, line.base, "/health", line.token), { ok: true });
	assert.deepEqual(await get(client, line.base, "/agents", line.token), { echoed: { method: "GET", url: "/agents", body: "" } });
	await h.next((l) => l.t === "connected" && l.id === paired.id, "connected");
	const { devices } = await h.say("devices");
	assert.deepEqual(
		devices.map((d: Line) => ({ id: d.id, name: d.name, connected: d.connected })),
		[{ id: paired.id, name: "Pine on Pixel 9", connected: true }],
	);
	client.end();
	meeting.close();
	await h.say("stop");
	assert.equal(await h.exited, 0);
});

test("helper: a request it is told to refuse is refused; a decision given before the request is kept for it", async () => {
	const h = helper();
	const ready = await h.next((l) => l.t === "ready", "ready");
	const { link } = await h.say("open");
	assert.equal((await h.say("refuse")).waiting, false);
	const request = await pairingRequest(ready.service, ready.machineId, link, newEd25519Key().private, "Pine on iPhone");
	const [, outcome] = await request.lines;
	assert.deepEqual(outcome, { ok: false, reason: "refused" });
	request.end();
	assert.deepEqual((await h.say("devices")).devices, []);
	h.child.stdin.end();
	assert.equal(await h.exited, 0);
});

/**
 * A codeless session as user `nearby.<nonce>`: whether the computer let it in. One that was let in
 * holds the computer's one place until it ended there, which is waited for.
 */
async function letIn(h: ReturnType<typeof helper>, nonce: string): Promise<boolean> {
	const { service, machineId } = h.lines[0];
	const meeting = join(service, machineId);
	const ssh = sshOver(await meeting.channel, machineId, newEd25519Key().private, { username: `nearby.${nonce}` });
	// Refused, the computer lets go of the channel: SSH's goodbye after that finds it closed, which is no fault.
	ssh.client.on("error", () => {});
	const gone = new Promise<void>((resolve) => ssh.client.once("close", () => resolve()));
	const yes = await ssh.ready.then(
		() => true,
		() => false,
	);
	ssh.client.end();
	await gone;
	meeting.close();
	if (yes) await h.next((l) => l.t === "left" && String(l.id).startsWith("pairing:"), "the codeless session ended at the computer");
	return yes;
}

test("helper: with --nearby a codeless request with the announced nonce is let in and asked about; nearby off refuses one before the owner hears of it", async () => {
	const h = helper(["--nearby", "--computer-name", "Studio Mac", "--service-name", "https://pine.test"]);
	const ready = await h.next((l) => l.t === "ready", "ready");
	assert.match(ready.nonce, /^[A-Za-z0-9_-]{22}$/);
	const phone = newEd25519Key();
	const meeting = join(ready.service, ready.machineId);
	const ssh = sshOver(await meeting.channel, ready.machineId, phone.private, { username: `nearby.${ready.nonce}` });
	const session = await ssh.ready;
	const request = await exec(session, `pine-pair ${Buffer.from(JSON.stringify({ name: "Pine on Pixel 9" })).toString("base64url")}`);
	let said = "";
	const lines = new Promise<Line[]>((resolve) => {
		request.on("data", (d: Buffer) => {
			said += d;
			if (said.includes('"ok"')) resolve(said.trim().split("\n").map((l) => JSON.parse(l)));
		});
	});
	const asked = await h.next((l) => l.t === "asked", "the owner is asked");
	assert.equal(asked.kind, "nearby");
	await h.say("allow");
	const [digits, outcome] = await lines;
	assert.deepEqual(digits, { code: asked.code, computer: "Studio Mac", service: "https://pine.test" }, "the computer names the service --service-name gave");
	assert.deepEqual(outcome, { ok: true, name: "Studio Mac" });
	// The data channel is closed only once SSH has said goodbye over it.
	const ended = new Promise<void>((resolve) => ssh.client.once("close", () => resolve()));
	session.end();
	await ended;
	meeting.close();

	assert.deepEqual(await h.say("nearby off"), { t: "nearby", on: false, nonce: ready.nonce });
	assert.equal(await letIn(h, ready.nonce), false);
	assert.equal(h.lines.filter((l) => l.t === "asked").length, 1, "the refused request never reached the owner");
	await h.say("stop");
});

test("helper: a codeless request is let in with the current nonce or the one before it, never with another", async () => {
	const h = helper(["--nearby"]);
	const ready = await h.next((l) => l.t === "ready", "ready");
	const wrong = ready.nonce.startsWith("A") ? `B${ready.nonce.slice(1)}` : `A${ready.nonce.slice(1)}`;
	assert.equal(await letIn(h, wrong), false, "a nonce that was never announced");
	assert.equal(await letIn(h, ""), false, "no nonce");

	const first = await h.say("rotate");
	assert.match(first.nonce, /^[A-Za-z0-9_-]{22}$/);
	assert.notEqual(first.nonce, ready.nonce);
	assert.deepEqual(await h.say("nearby on"), { t: "nearby", on: true, nonce: first.nonce });
	assert.equal(await letIn(h, ready.nonce), true, "the one before still works right after a rotation");
	assert.equal(await letIn(h, first.nonce), true, "the current one");

	const second = await h.say("rotate");
	assert.notEqual(second.nonce, first.nonce);
	assert.equal(await letIn(h, ready.nonce), false, "two rotations ago");
	assert.equal(await letIn(h, first.nonce), true);
	assert.equal(await letIn(h, second.nonce), true);
	assert.equal(h.lines.filter((l) => l.t === "asked").length, 0, "no request was made");
	await h.say("stop");
});

test("helper: a key added directly is let in as pine, and removing the device cuts its connection", async () => {
	const h = helper();
	const ready = await h.next((l) => l.t === "ready", "ready");
	const phone = newEd25519Key();
	const added = await h.say(`add ssh-ed25519 ${phone.public.toString("base64")} Pine on Pixel 9`);
	assert.equal(added.id, keyId(phone.public));
	assert.equal(added.name, "Pine on Pixel 9");
	assert.equal((await h.say("add ssh-ed25519 not-a-key")).t, "error");
	const { client, meeting } = await reach(ready.service, ready.machineId, phone.private);
	const gone = new Promise<void>((resolve) => client.once("close", () => resolve()));
	assert.deepEqual(await h.say(`remove ${added.id}`), { t: "remove", id: added.id, removed: true });
	await gone;
	meeting.close();
	await assert.rejects(reach(ready.service, ready.machineId, phone.private).then((r) => (r.client.end(), r.meeting.close())));
	await h.say("stop");
});

test("helper: cut ends a device's live connection and keeps it paired", async () => {
	const h = helper();
	const ready = await h.next((l) => l.t === "ready", "ready");
	const phone = newEd25519Key();
	const { id } = await h.say(`add ssh-ed25519 ${phone.public.toString("base64")} phone`);
	const first = await reach(ready.service, ready.machineId, phone.private);
	const gone = new Promise<void>((resolve) => first.client.once("close", () => resolve()));
	assert.deepEqual(await h.say("cut"), { t: "cut", count: 1 });
	await gone;
	first.meeting.close();
	const again = await reach(ready.service, ready.machineId, phone.private);
	assert.equal((await h.say("devices")).devices[0].id, id);
	again.client.end();
	again.meeting.close();
	await h.say("stop");
});

test("helper: the meeting can lie about the computer, hold a phone without a path, or turn it away over its limits", async () => {
	const h = helper();
	const ready = await h.next((l) => l.t === "ready", "ready");
	const phone = newEd25519Key();
	await h.say(`add ssh-ed25519 ${phone.public.toString("base64")} phone`);

	const swapped = await h.say("meeting swap");
	assert.match(swapped.impostor, /^[A-Za-z0-9_-]{43}$/);
	assert.notEqual(swapped.impostor, ready.machineId);
	const lied = join(ready.service, ready.machineId);
	const ssh = sshOver(await lied.channel, ready.machineId, phone.private);
	await assert.rejects(ssh.ready);
	assert.deepEqual(ssh.seen, [swapped.impostor], "the phone was shown the other computer's key");
	assert.equal(ssh.offered(), 0);
	lied.close();

	await h.say("meeting limits");
	assert.equal(await join(ready.service, ready.machineId).closed, 4429);

	await h.say("meeting hold");
	const held = join(ready.service, ready.machineId);
	// The helper says nothing when it holds a phone, so a short wait stands for "no channel came";
	// the offer the phone made shows that the meeting did say the computer is there.
	const opened = await Promise.race([held.channel.then(() => "opened", () => "failed"), new Promise((r) => setTimeout(() => r("nothing"), 250))]);
	assert.equal(opened, "nothing", "the meeting said the computer is there, and no channel came");
	assert.ok((held as { peer?: unknown }).peer, "the meeting said the computer is there");
	held.close();

	await h.say("meeting normal");
	const fine = await reach(ready.service, ready.machineId, phone.private);
	fine.client.end();
	fine.meeting.close();
	assert.equal((await h.say("meeting sideways")).t, "error");
	await h.say("stop");
});

test("helper: two run side by side on ports and homes of their own, and each leaves nothing behind when its input closes", async () => {
	const a = helper();
	const b = helper();
	const [ra, rb] = await Promise.all([a.next((l) => l.t === "ready", "a ready"), b.next((l) => l.t === "ready", "b ready")]);
	assert.notEqual(ra.service, rb.service);
	assert.notEqual(ra.daemon.base, rb.daemon.base);
	assert.notEqual(ra.machineId, rb.machineId);
	assert.notEqual(ra.home, rb.home);
	assert.ok(existsSync(ra.home) && existsSync(rb.home));
	a.child.stdin.end();
	assert.equal(await a.exited, 0);
	assert.ok(!existsSync(ra.home), "its home was removed");
	for (const base of [ra.service, ra.daemon.base]) assert.equal(await refused(base), true, `${base} no longer answers`);
	// The other one still works.
	assert.ok((await b.say("open")).link);
	b.child.kill("SIGTERM");
	assert.equal(await b.exited, 0);
	assert.ok(!existsSync(rb.home), "its home was removed when it was ended");
});

/** True when nothing listens at the address any more. */
function refused(base: string) {
	const url = new URL(base);
	return new Promise<boolean>((resolve) => {
		const socket = connect(Number(url.port), url.hostname);
		socket.once("connect", () => (socket.destroy(), resolve(false)));
		socket.once("error", () => resolve(true));
	});
}

test("helper: without the desktop's packages it says what to install, and stops", async () => {
	const empty = mkdtempSync(joinPath(tmpdir(), "pine-helper-empty-"));
	folders.push(empty);
	const h = helper(["--desktop", empty]);
	const missing = await h.next((l) => l.t === "missing", "missing");
	assert.match(missing.message, /npm install/);
	assert.match(missing.message, /ssh2/);
	assert.equal(await h.exited, 2);
});
