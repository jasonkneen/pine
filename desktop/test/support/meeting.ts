// The meeting service for tests of browser access: the Worker's own meeting module
// (web/relay/src/meet.ts) behind an HTTP server and a WebSocket server on a loopback port, and a
// Node peer that plays the browser: it joins by machine id, makes the offer and the `ssh` channel,
// and runs an SSH client over it. Only tests import the Worker's source; the app never does.
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import type { Duplex } from "node:stream";
import ssh2 from "ssh2";
import type { Client, ClientChannel, ConnectConfig } from "ssh2";
import { WebSocketServer } from "ws";
import { offer, type Peer, type Signal } from "../../electron/access/peer.ts";
import { keyId } from "../../electron/access/store.ts";

/** The part of the Worker's meeting module a Node server uses (web/relay/src/meet.ts). */
interface MeetModule {
	route(url: URL): { kind: "host" | "join"; id: string } | null;
	inMemory(): {
		connect(kind: "host" | "join", id: string, origin: string, socket: { send(text: string): void; close(code: number, reason: string): void }): { message(data: unknown): Promise<void>; closed(): void };
	};
}

// Loaded by its address, so that the desktop's type check does not compile the Worker's source,
// which is checked in its own package against the Worker's types.
const MEET = new URL("../../../web/relay/src/meet.ts", import.meta.url).href;
const { inMemory, route } = (await import(MEET)) as MeetModule;

export interface Meeting {
	/** The service's address, as the app is given it. */
	url: string;
	/** How many host sockets came, in all. */
	hosts(): number;
	/** When each request for the configuration came. */
	configs(): number[];
	/** Every host socket is cut, as a service that went away would. */
	drop(): void;
	/** Stops answering: the address no longer takes connections. */
	close(): Promise<void>;
}

export interface MeetingOptions {
	/** Where a browser that joins `id` is sent instead: a service that lies about who is the computer. */
	swap?: (id: string) => string;
	/** What `/meet/config` answers. No STUN server by default: a test reaches no network. */
	config?: unknown;
	/** A port to listen on (a service that comes back where it was). */
	port?: number;
	/** The configuration answers 404, as a deployment without the meeting service does. */
	absent?: boolean;
}

export async function serveMeeting(options: MeetingOptions = {}): Promise<Meeting> {
	const meetings = inMemory();
	let hosts = 0;
	const configs: number[] = [];
	const hostSockets = new Set<import("ws").WebSocket>();
	const http: Server = createServer((req, res) => {
		if (req.url === "/meet/config") configs.push(Date.now());
		if (req.url === "/meet/config" && !options.absent) {
			res.writeHead(200, { "content-type": "application/json" });
			res.end(JSON.stringify(options.config ?? { ice: [], relay: true }));
			return;
		}
		res.writeHead(404).end();
	});
	const wss = new WebSocketServer({ noServer: true });
	http.on("upgrade", (req, socket, head) => {
		const url = new URL(req.url ?? "/", `http://${req.headers.host}`);
		const to = route(url);
		if (!to || options.absent) return socket.destroy();
		wss.handleUpgrade(req, socket, head, (ws) => {
			const id = to.kind === "join" && options.swap ? options.swap(to.id) : to.id;
			if (to.kind === "host") {
				hosts++;
				hostSockets.add(ws);
				ws.once("close", () => hostSockets.delete(ws));
			}
			const origin = `http://${req.headers.host}`;
			const connection = meetings.connect(to.kind, id, origin, { send: (text) => ws.send(text), close: (code, reason) => ws.close(code, reason) });
			ws.on("message", (data, binary) => void connection.message(binary ? data : data.toString()));
			ws.once("close", () => connection.closed());
		});
	});
	await new Promise<void>((resolve) => http.listen(options.port ?? 0, "127.0.0.1", resolve));
	const port = (http.address() as AddressInfo).port;
	return {
		url: `http://127.0.0.1:${port}`,
		hosts: () => hosts,
		configs: () => [...configs],
		drop() {
			for (const ws of hostSockets) ws.terminate();
		},
		async close() {
			for (const ws of wss.clients) ws.terminate();
			wss.close();
			http.closeAllConnections();
			await new Promise<void>((resolve) => http.close(() => resolve()));
		},
	};
}

/** A browser that joined the meeting of `id`: its peer connection, and how its meeting socket ended. */
export interface Browser {
	peer: Peer;
	/** The close code of the meeting socket, once it closed. */
	closed: Promise<number>;
	/** The data channel, once it is open. */
	channel: Promise<Duplex>;
	/** What the computer sent through the meeting (its description and candidates), in order. */
	received: Signal[];
	close(): void;
}

/** Joins the meeting of a machine id and makes the offer, as the web client does. */
export function join(service: string, id: string): Browser {
	const ws = new WebSocket(`${service.replace(/^http/, "ws")}/meet/join?id=${id}`);
	const early: string[] = [];
	let ready = false;
	const send = (d: Signal) => {
		const text = JSON.stringify({ t: "signal", d });
		if (ready) ws.send(text);
		else early.push(text);
	};
	const closed = new Promise<number>((resolve) => ws.addEventListener("close", (e) => resolve(e.code)));
	const received: Signal[] = [];
	let peer: Peer | undefined;
	ws.addEventListener("message", (e) => {
		const message = JSON.parse(String(e.data));
		if (message.t === "ready") {
			ready = true;
			for (const text of early.splice(0)) ws.send(text);
		} else if (message.t === "signal") (received.push(message.d), peer?.signal(message.d));
	});
	// The offer is made once the computer is there, as the web client does.
	const opened = new Promise<Peer>((resolve, reject) => {
		ws.addEventListener("message", (e) => {
			if (JSON.parse(String(e.data)).t !== "ready") return;
			peer = offer({ ice: [], send });
			resolve(peer);
		});
		closed.then((code) => reject(new Error(`the meeting closed with ${code}`)));
	});
	opened.catch(() => {});
	const channel = opened.then((p) => p.channel);
	channel.catch(() => {});
	// A meeting that ends before the channel opened ends the attempt: nobody answers it any more.
	// Once it is open, the meeting has done its part and the browser ends it.
	let open = false;
	channel.then(() => ((open = true), ws.close()), () => {});
	closed.then(() => !open && peer?.close());
	return {
		get peer() {
			return peer!;
		},
		closed,
		channel,
		received,
		close() {
			ws.close();
			peer?.close();
		},
	};
}

/**
 * An SSH client over a stream, which accepts only the host key whose fingerprint is `id` (the
 * machine id a pairing link names), as the web client does. `offered` counts the times it got as
 * far as offering its key.
 */
export function sshOver(stream: Duplex, id: string, privateKey: string, config: Partial<ConnectConfig> = {}) {
	const client = new ssh2.Client();
	const seen: string[] = [];
	const ready = new Promise<Client>((resolve, reject) => {
		client.once("ready", () => resolve(client));
		client.once("error", reject);
		client.once("close", () => reject(new Error("closed before it was ready")));
	});
	ready.catch(() => {});
	let offered = 0;
	const username = config.username ?? "pine";
	client.connect({
		sock: stream as any,
		username,
		privateKey,
		readyTimeout: 10_000,
		hostVerifier: (key: Buffer) => (seen.push(keyId(key)), keyId(key) === id),
		authHandler: (_methods: unknown, _partial: unknown, next: (m: unknown) => void) => {
			offered++;
			next(offered === 1 ? { type: "publickey", username, key: privateKey } : false);
		},
		...config,
	} as ConnectConfig);
	return { client, ready, seen, offered: () => offered };
}

export const exec = (client: Client, command: string) =>
	new Promise<ClientChannel>((resolve, reject) => client.exec(command, (err, channel) => (err ? reject(err) : resolve(channel))));

/** The first line a channel writes. */
export const firstLine = (channel: ClientChannel) =>
	new Promise<string>((resolve, reject) => {
		let text = "";
		channel.on("data", (data: Buffer) => {
			text += data.toString();
			const end = text.indexOf("\n");
			if (end >= 0) resolve(text.slice(0, end));
		});
		channel.once("close", () => reject(new Error(`closed after ${JSON.stringify(text)}`)));
	});

export const tunnel = (client: Client, host: string, port: number) =>
	new Promise<ClientChannel>((resolve, reject) => client.forwardOut("127.0.0.1", 0, host, port, (err, channel) => (err ? reject(err) : resolve(channel))));

/** Waits until `check` is true, a little at a time. */
export async function until(check: () => boolean, what: string, ms = 5000) {
	const end = Date.now() + ms;
	while (!check()) {
		if (Date.now() > end) throw new Error(`never: ${what}`);
		await new Promise((r) => setTimeout(r, 10));
	}
}
