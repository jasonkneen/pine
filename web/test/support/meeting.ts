// The meeting service for the web client's peer tests: the Worker's own meeting module
// (relay/src/meet.ts) behind an HTTP server and a WebSocket server on a loopback port, which also
// serves the test's page, so that the page reaches `/meet/config` and `/meet/join` at its own
// origin, as the web client does at its deployment.
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { WebSocketServer, type WebSocket } from "ws";
import { bundle } from "../../scripts/bundle.ts";

/** The part of the Worker's meeting module a Node server uses (relay/src/meet.ts). */
type MeetModule = {
	route(url: URL): { kind: "host" | "join"; id: string } | null;
	inMemory(): {
		connect(kind: "host" | "join", id: string, origin: string, socket: { send(text: string): void; close(code: number, reason: string): void }): { message(data: unknown): Promise<void>; closed(): void };
	};
};
// Loaded by its address, so that the web client's type check does not compile the Worker's
// source, which is checked in its own package against the Worker's types.
const { inMemory, route } = (await import(new URL("../../relay/src/meet.ts", import.meta.url).href)) as MeetModule;

export type MeetingServer = {
	/** The origin the page and the meeting service answer at. */
	url: string;
	/** The routes and machine ids of every meeting socket that came, in order. */
	sockets(): { kind: "host" | "join"; id: string }[];
	/** Sends the browsers that join `from` to the computer waiting under `to`: a service that lies about who is the computer. */
	swap(from: string, to: string): void;
	/** Browsers that join `id` are told the computer is there, and then hear nothing: no connection is ever made. */
	hold(id: string): void;
	/** Browsers that join `id` are closed at once with `code`, as the service does when it is over its limits. */
	refuse(id: string, code: number): void;
	close(): Promise<void>;
};

/** Serves `entry`'s browser build at `/`, the meeting at `/meet/`, and `config` at `/meet/config`. */
export async function serveMeeting(entry: string, config: unknown): Promise<MeetingServer> {
	const script = await bundle(entry);
	const meetings = inMemory();
	const sockets: { kind: "host" | "join"; id: string }[] = [];
	const swaps = new Map<string, string>();
	const held = new Set<string>();
	const refused = new Map<string, number>();
	const http: Server = createServer((req, res) => {
		if (req.url === "/meet/config") return void res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(config));
		if (req.url === "/bundle.js") return void res.writeHead(200, { "content-type": "text/javascript" }).end(script);
		if (req.url === "/") return void res.writeHead(200, { "content-type": "text/html" }).end('<!doctype html><meta charset="utf-8"><script src="/bundle.js"></script>');
		res.writeHead(404).end();
	});
	const wss = new WebSocketServer({ noServer: true });
	http.on("upgrade", (req, socket, head) => {
		const to = route(new URL(req.url ?? "/", `http://${req.headers.host}`));
		if (!to) return socket.destroy();
		wss.handleUpgrade(req, socket, head, (ws: WebSocket) => {
			sockets.push(to);
			if (to.kind === "join" && refused.has(to.id)) return ws.close(refused.get(to.id), "Refused by the test.");
			if (to.kind === "join" && held.has(to.id)) return ws.send(JSON.stringify({ t: "ready" }));
			const id = to.kind === "join" ? (swaps.get(to.id) ?? to.id) : to.id;
			const connection = meetings.connect(to.kind, id, `http://${req.headers.host}`, { send: (text) => ws.send(text), close: (code, reason) => ws.close(code, reason) });
			ws.on("message", (data, binary) => void connection.message(binary ? data : data.toString()));
			ws.once("close", () => connection.closed());
		});
	});
	await new Promise<void>((resolve) => http.listen(0, "127.0.0.1", resolve));
	return {
		url: `http://127.0.0.1:${(http.address() as AddressInfo).port}`,
		sockets: () => [...sockets],
		swap: (from, to) => void swaps.set(from, to),
		hold: (id) => void held.add(id),
		refuse: (id, code) => void refused.set(id, code),
		async close() {
			for (const ws of wss.clients) ws.terminate();
			wss.close();
			http.closeAllConnections();
			await new Promise<void>((resolve) => http.close(() => resolve()));
		},
	};
}
