// The access host (electron/access/host.ts) under plain Node, through the doors its users come
// through: the Worker's meeting module served on a loopback port, a Node peer that plays the
// browser and runs a real SSH client over the data channel, and a stand-in for this computer's
// daemon on a port of the test's own. No network, no window.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import net from "node:net";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";
import { remoteCommand } from "../../src/remote.ts";
import { ACCESS_FILE, type AccessHost, fileVault, type HostStatus, startAccessHost } from "../electron/access/host.ts";
import { createPairing, type Pairing, type PairingRequest } from "../electron/access/pairing.ts";
import { offer, type Peer, type Signal } from "../electron/access/peer.ts";
import { pairedKeys } from "../electron/access/server.ts";
import { AccessStore, newEd25519Key } from "../electron/access/store.ts";
import { exec, firstLine, join, type Meeting, serveMeeting, sshOver, tunnel, until } from "./support/meeting.ts";
import { startTurn, TURN_PASSWORD, TURN_USER } from "./support/turn.ts";

let daemon: net.Server;
let daemonPort: number;
const folders: string[] = [];
const hosts: AccessHost[] = [];
const meetings: Meeting[] = [];

before(async () => {
	daemon = net.createServer((socket) => {
		socket.write("daemon:");
		socket.pipe(socket);
	});
	await new Promise<void>((r) => daemon.listen(0, "127.0.0.1", r));
	daemonPort = (daemon.address() as AddressInfo).port;
});

after(async () => {
	await Promise.all(hosts.map((h) => h.stop()));
	await Promise.all(meetings.map((m) => m.close()));
	daemon.close();
	for (const f of folders) rmSync(f, { recursive: true, force: true });
});

const serviceLine = () => JSON.stringify({ base: `http://127.0.0.1:${daemonPort}`, token: "the-token", mode: "safe", started: true, home: "/nowhere", version: "0.0.0" });

const folder = () => {
	const f = mkdtempSync(path.join(tmpdir(), "pine-access-host-"));
	folders.push(f);
	return f;
};

async function meeting(options: Parameters<typeof serveMeeting>[0] = {}) {
	const m = await serveMeeting(options);
	meetings.push(m);
	return m;
}

/** A host with a paired phone, and what it said its status was. */
async function setup(service: string, more: Partial<Parameters<typeof startAccessHost>[0]> = {}) {
	const statuses: HostStatus[] = [];
	const host = await startAccessHost({
		service,
		folder: folder(),
		daemon: async () => serviceLine(),
		onStatus: (s) => statuses.push(s),
		retry: { firstMs: 50, maxMs: 400 },
		...more,
	});
	hosts.push(host);
	const phone = newEd25519Key();
	await host.store.add({ key: phone.public, name: "phone" });
	return { host, phone, statuses };
}

test("access host: a browser that joins by machine id runs the remote command over SSH over the data channel and reaches the daemon", async () => {
	const m = await meeting();
	const { host, phone, statuses } = await setup(m.url);
	await until(() => host.status() === "waiting", "the host waits");
	assert.ok(statuses.includes("waiting"));

	const browser = join(m.url, host.machineId);
	const ssh = sshOver(await browser.channel, host.machineId, phone.private);
	const client = await ssh.ready;
	assert.equal(await firstLine(await exec(client, remoteCommand())), serviceLine());
	const channel = await tunnel(client, "127.0.0.1", daemonPort);
	channel.write("hello");
	let text = "";
	await new Promise<void>((resolve) => channel.on("data", (d: Buffer) => ((text += d), text.length >= "daemon:hello".length && resolve())));
	assert.equal(text, "daemon:hello");
	client.end();
	browser.close();
});

test("access host: with pairing as its admission, a browser pairs over the data channel and then connects as a paired device", async () => {
	const m = await meeting();
	let pairing: Pairing | undefined;
	const asked: PairingRequest[] = [];
	const { host } = await setup(m.url, {
		admit: ({ store, service, cut }) => (pairing = createPairing({ store, service, cut, ask: async (request) => (asked.push(request), true), computerName: () => "Studio Mac" })).admit,
	});
	await until(() => host.status() === "waiting", "the host waits");
	const { link } = pairing!.open();
	assert.ok(link.startsWith(`${m.url}/#pair=${host.machineId}.`), link);
	const code = link.slice(link.lastIndexOf(".") + 1);

	const browserKey = newEd25519Key();
	const first = join(m.url, host.machineId);
	const pairingSession = await sshOver(await first.channel, host.machineId, browserKey.private, { username: `pair.${code}` }).ready;
	const request = await exec(pairingSession, `pine-pair ${Buffer.from(JSON.stringify({ name: "Chrome on Android" })).toString("base64url")}`);
	let said = "";
	await new Promise<void>((resolve) => request.on("data", (d: Buffer) => ((said += d), said.includes('"ok"') && resolve())));
	const [digits, answer] = said.trim().split("\n").map((l) => JSON.parse(l));
	assert.match(digits.code, /^\d{4}$/);
	assert.deepEqual(asked.map(({ id: _id, ...rest }) => rest), [{ name: "Chrome on Android", code: digits.code, kind: "code" }]);
	assert.match(asked[0].id, /^[A-Za-z0-9_-]{12}$/, "each question has an id the answer names");
	assert.deepEqual(answer, { ok: true, name: "Studio Mac" });
	pairingSession.end();
	first.close();

	const second = join(m.url, host.machineId);
	const client = await sshOver(await second.channel, host.machineId, browserKey.private).ready;
	assert.equal(await firstLine(await exec(client, remoteCommand())), serviceLine());
	client.end();
	second.close();
});

test("access host: a meeting service that puts the browser through to another computer is caught by the pinned host key, before the browser's key is offered", async () => {
	// Two computers wait, each proven under its own id; the service sends a browser that asks for the
	// first to the second.
	let other = "";
	const m = await meeting({ swap: () => other });
	const asked: string[] = [];
	const { host: mine } = await setup(m.url);
	const { host: theirs } = await setup(m.url, { admit: ({ store }) => (user, key) => (asked.push(user), pairedKeys(store)(user, key)) });
	other = theirs.machineId;
	await until(() => mine.status() === "waiting" && theirs.status() === "waiting", "both hosts wait");

	const browser = join(m.url, mine.machineId);
	const ssh = sshOver(await browser.channel, mine.machineId, newEd25519Key().private);
	await assert.rejects(ssh.ready);
	assert.deepEqual(ssh.seen, [theirs.machineId], "the host key the browser was shown is the other computer's");
	assert.equal(ssh.offered(), 0, "the browser offered no key");
	assert.deepEqual(asked, [], "the other computer was asked about nobody");
	browser.close();
});

test("access host: a service without the meeting routes leaves the host unreachable, trying again with a growing wait", async () => {
	const m = await meeting({ absent: true });
	const { host } = await setup(m.url, { retry: { firstMs: 40, maxMs: 1000 } });
	await until(() => m.configs().length >= 4, "four tries", 5000);
	assert.equal(host.status(), "unreachable");
	assert.equal(m.hosts(), 0, "no host socket was opened without the configuration");
	const at = m.configs();
	const gaps = at.slice(1).map((t, i) => t - at[i]);
	assert.ok(gaps[2] > gaps[0], `the waits grow: ${gaps.join(", ")} ms`);
});

test("access host: dropped by the service, it says unreachable, comes back by itself, and waits again", async () => {
	const m = await meeting();
	const { host, statuses } = await setup(m.url);
	await until(() => host.status() === "waiting", "the host waits");
	m.drop();
	await until(() => host.status() === "unreachable", "the host says it cannot be found");
	await until(() => host.status() === "waiting" && m.hosts() >= 2, "the host waits again");
	assert.deepEqual(statuses.slice(-3), ["waiting", "unreachable", "waiting"]);
});

test("access host: a service that is not there at the start is waited for", async () => {
	const probe = await serveMeeting();
	const port = Number(new URL(probe.url).port);
	await probe.close();
	const { host } = await setup(`http://127.0.0.1:${port}`);
	await until(() => host.status() === "unreachable", "the host says it cannot reach the service");
	await meeting({ port });
	await until(() => host.status() === "waiting", "the host waits once the service is there", 5000);
});

test("access host: at most eight browsers at a time; the ninth is turned away by the computer", async () => {
	const m = await meeting();
	const { host } = await setup(m.url);
	await until(() => host.status() === "waiting", "the host waits");
	const browsers = Array.from({ length: 8 }, () => join(m.url, host.machineId));
	await Promise.all(browsers.map((b) => b.channel));
	const ninth = join(m.url, host.machineId);
	assert.equal(await ninth.closed, 1000, "the computer ended the ninth's meeting");
	await assert.rejects(ninth.channel);
	for (const b of browsers) b.close();
	// Once they left, there is room again.
	await until(() => host.peers() === 0, "the eight are gone");
	const tenth = join(m.url, host.machineId);
	await tenth.channel;
	tenth.close();
});

/**
 * A browser that ends its meeting as soon as the two peers have each other's offer, answer and a
 * candidate: the meeting's close reaches the computer before the data channel does, as it can on a
 * slow network. `andLeave`: the browser's own peer goes with the meeting, so no channel ever comes.
 */
function joinAndLeave(service: string, id: string, andLeave = false) {
	const ws = new WebSocket(`${service.replace(/^http/, "ws")}/meet/join?id=${id}`);
	let peer: Peer | undefined;
	let answered = false;
	let heard = false;
	let said = false;
	const leave = () => {
		if (!answered || !heard || !said || ws.readyState !== WebSocket.OPEN) return;
		ws.close();
		if (andLeave) peer?.close();
	};
	const send = (d: Signal) => {
		ws.send(JSON.stringify({ t: "signal", d }));
		if ("ice" in d) said = true;
		leave();
	};
	ws.addEventListener("message", (e) => {
		const message = JSON.parse(String(e.data));
		if (message.t === "ready") peer = offer({ ice: [], send });
		else if (message.t === "signal") {
			peer?.signal(message.d);
			if ("sdp" in message.d) answered = true;
			if ("ice" in message.d) heard = true;
			leave();
		}
	});
	const closed = new Promise<void>((resolve) => ws.addEventListener("close", () => resolve()));
	return { closed, peer: () => peer! };
}

test("access host: a browser whose meeting ends before its data channel reaches the computer is still connected", async () => {
	const m = await meeting();
	const { host, phone } = await setup(m.url);
	await until(() => host.status() === "waiting", "the host waits");
	const browser = joinAndLeave(m.url, host.machineId);
	await browser.closed;
	const client = await sshOver(await browser.peer().channel, host.machineId, phone.private).ready;
	assert.equal(await firstLine(await exec(client, remoteCommand())), serviceLine());
	client.end();
	browser.peer().close();
});

test("access host: a browser that leaves after signalling and never opens its channel is let go of when its time is up", async () => {
	const m = await meeting();
	const { host } = await setup(m.url, { peerTimeoutMs: 300 });
	await until(() => host.status() === "waiting", "the host waits");
	const browser = joinAndLeave(m.url, host.machineId, true);
	await browser.closed;
	await until(() => host.peers() === 0, "the computer let go of the peer", 3000);
});

test("access host: a browser that joins and leaves without an offer is let go of at once, not when its time is up", async () => {
	const m = await meeting();
	const { host } = await setup(m.url, { peerTimeoutMs: 20_000 });
	await until(() => host.status() === "waiting", "the host waits");
	const ws = new WebSocket(`${m.url.replace(/^http/, "ws")}/meet/join?id=${host.machineId}`);
	await until(() => host.peers() === 1, "the computer made a peer for the browser");
	ws.close();
	await until(() => host.peers() === 0, "the computer let go of the peer", 1000);
});

test("access host: with a relay saved without a user name or password, a browser still connects", async () => {
	const m = await meeting();
	const { host, phone } = await setup(m.url, { relay: { hostname: "127.0.0.1", port: 9, username: "" } });
	await until(() => host.status() === "waiting", "the host waits");
	const browser = join(m.url, host.machineId);
	const client = await sshOver(await browser.channel, host.machineId, phone.private).ready;
	assert.equal(await firstLine(await exec(client, remoteCommand())), serviceLine());
	client.end();
	browser.close();
});

test("access host: each connected device is listed with the kind of path its connection took", async () => {
	const m = await meeting();
	const events: Array<{ kind: string; tag?: any }> = [];
	const { host, phone } = await setup(m.url, { report: (e) => events.push(e) });
	await until(() => host.status() === "waiting", "the host waits");
	const browser = join(m.url, host.machineId);
	const client = await sshOver(await browser.channel, host.machineId, phone.private).ready;
	const id = host.store.devices()[0].id;
	// On this computer the pair is usually "lan"; an interface of a VPN can make it "ipv4".
	const [device] = host.connected();
	assert.equal(device.id, id);
	assert.ok(["lan", "ipv4", "ipv6"].includes(device.path!), `path ${device.path}`);
	assert.equal(events[0].kind, "connected");
	assert.equal(events[0].tag.path, device.path);
	await until(() => host.store.devices()[0].seen !== undefined, "the device was seen");
	client.end();
	browser.close();
});

test("access host: with the owner's relay, the computer offers an address on it, with the password from its own store; the browser is given no relay", async () => {
	const turn = await startTurn();
	try {
		const m = await meeting();
		const dir = folder();
		// The password is kept in the store's file, as the app keeps it; the host is told the rest.
		const vault = fileVault(path.join(dir, ACCESS_FILE.plain));
		await (await AccessStore.open(vault)).setRelayPassword(TURN_PASSWORD);
		const { host, phone } = await setup(m.url, { folder: dir, relay: { hostname: "127.0.0.1", port: turn.port, username: TURN_USER } });
		await until(() => host.status() === "waiting", "the host waits");
		const browser = join(m.url, host.machineId);
		const client = await sshOver(await browser.channel, host.machineId, phone.private).ready;
		// The relay gave the computer an address, which it takes only with the right password. (Its candidate
		// may come after the direct path opened and the meeting ended, so it is not looked for in the signals.)
		await until(() => turn.allocations() > 0, "the computer reserved an address on the relay");
		assert.ok(!JSON.stringify(browser.received).includes(TURN_PASSWORD), "the password crossed nowhere");
		client.end();
		browser.close();
	} finally {
		await turn.close();
	}
});

test("access host: removing a device cuts its connection at once", async () => {
	const m = await meeting();
	const { host, phone } = await setup(m.url);
	await until(() => host.status() === "waiting", "the host waits");
	const browser = join(m.url, host.machineId);
	const client = await sshOver(await browser.channel, host.machineId, phone.private).ready;
	const gone = new Promise<void>((resolve) => client.once("close", () => resolve()));
	assert.equal(await host.remove(host.store.devices()[0].id), true);
	await gone;
	assert.deepEqual(host.connected(), []);
	browser.close();
});

test("access host: stopping it closes the meeting socket and every connection", async () => {
	const m = await meeting();
	const { host, phone } = await setup(m.url);
	await until(() => host.status() === "waiting", "the host waits");
	const browser = join(m.url, host.machineId);
	const client = await sshOver(await browser.channel, host.machineId, phone.private).ready;
	const gone = new Promise<void>((resolve) => client.once("close", () => resolve()));
	await host.stop();
	await gone;
	await browser.peer.closed;
	// No computer waits there any more.
	assert.equal(await join(m.url, host.machineId).closed, 4404);
});

test("access host: a second copy of the same key takes the first one's place, which stops trying", async () => {
	const m = await meeting();
	const where = folder();
	const { host: first } = await setup(m.url, { folder: where });
	await until(() => first.status() === "waiting", "the first waits");
	const { host: second } = await setup(m.url, { folder: where });
	assert.equal(second.machineId, first.machineId, "the key was read from the folder, not made again");
	await until(() => second.status() === "waiting" && first.status() === "replaced", "the second took the place");
	const before = m.hosts();
	await new Promise((r) => setTimeout(r, 300));
	assert.equal(m.hosts(), before, "the first did not come back");
});

test("access host: a process that stopped its host ends by itself: nothing is left holding it", async () => {
	// In a process of its own, since this test run is ended by force (`--test-force-exit`).
	const href = (p: string) => JSON.stringify(new URL(p, import.meta.url).href);
	const script = `
		import { serveMeeting, join, sshOver, exec, firstLine, until } from ${href("./support/meeting.ts")};
		import { startAccessHost } from ${href("../electron/access/host.ts")};
		import { memoryVault, newEd25519Key } from ${href("../electron/access/store.ts")};
		import { remoteCommand } from ${href("../../src/remote.ts")};
		const m = await serveMeeting();
		const host = await startAccessHost({ service: m.url, vault: memoryVault(), daemon: async () => JSON.stringify({ base: "http://127.0.0.1:9" }) });
		const phone = newEd25519Key();
		await host.store.add({ key: phone.public, name: "phone" });
		await until(() => host.status() === "waiting", "waiting");
		const browser = join(m.url, host.machineId);
		const client = await sshOver(await browser.channel, host.machineId, phone.private).ready;
		await firstLine(await exec(client, remoteCommand()));
		await host.stop();
		browser.close();
		await browser.peer.closed;
		await m.close();
		console.log("stopped");
	`;
	const child = spawn(process.execPath, ["--input-type=module", "-e", script], { stdio: ["ignore", "pipe", "inherit"] });
	let out = "";
	child.stdout.on("data", (b) => (out += b));
	const timer = setTimeout(() => child.kill("SIGKILL"), 15_000);
	const [code, signal] = await once(child, "exit");
	clearTimeout(timer);
	assert.equal(out.trim(), "stopped");
	assert.equal(signal, null, "the process had to be killed: something held it after the host stopped");
	assert.equal(code, 0);
});
