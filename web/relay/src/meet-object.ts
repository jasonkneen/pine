// The Durable Object that holds one machine id's meeting (meet.ts), one object per id. Its
// WebSockets hibernate, so that a computer that waits all day costs no duration; an object that wakes
// has lost everything but its sockets, which is why the meeting keeps its notes as their
// attachments. It keeps no storage, and logs nothing.
//
// Not an RPC class: the Worker reaches it by fetch() alone, so it needs nothing of
// `cloudflare:workers` and runs under Node in the tests.
import { CLOSE, meeting, route, type Note, type Options, type Peer } from "./meet.ts";

/** A WebSocket the object accepted for hibernation: the part of workerd's the meeting uses. */
export type HibernatingSocket = {
	/** Accepts the socket without hibernation: for one that is refused at once. */
	accept(): void;
	send(text: string): void;
	close(code?: number, reason?: string): void;
	serializeAttachment(value: unknown): void;
	deserializeAttachment(): unknown;
};

/** The part of the Durable Object's state the meeting uses: its hibernating sockets, nothing of its storage. */
export type MeetState = {
	acceptWebSocket(ws: HibernatingSocket): void;
	getWebSockets(): HibernatingSocket[];
};

/** The object's end of a new WebSocket pair, and the response that hands the other end over. */
export type Upgrade = () => { socket: HibernatingSocket; response: Response };

const workerdUpgrade: Upgrade = () => {
	const pair = new WebSocketPair();
	return { socket: pair[1] as unknown as HibernatingSocket, response: new Response(null, { status: 101, webSocket: pair[0] }) };
};

function peer(ws: HibernatingSocket): Peer {
	return {
		send: (text) => ws.send(text),
		close: (code, reason) => ws.close(code, reason),
		note: () => (ws.deserializeAttachment() as Note | null) ?? null,
		keep: (note) => {
			// A socket that is closing takes no attachment; the meeting has finished with it.
			try {
				ws.serializeAttachment(note);
			} catch {}
		},
	};
}

export class Meeting {
	#state: MeetState;
	#upgrade: Upgrade;
	#meet: ReturnType<typeof meeting>;

	constructor(state: MeetState, _env: unknown, upgrade: Upgrade = workerdUpgrade, options: Options = {}) {
		this.#state = state;
		this.#upgrade = upgrade;
		this.#meet = meeting({ peers: () => this.#state.getWebSockets().map(peer) }, options);
	}

	async fetch(request: Request): Promise<Response> {
		if (request.headers.get("Upgrade")?.toLowerCase() !== "websocket") return new Response("A WebSocket upgrade is needed.\n", { status: 426 });
		const url = new URL(request.url);
		const where = route(url);
		if (!where) return new Response("Name a machine id: /meet/host?id=<id> or /meet/join?id=<id>.\n", { status: 400 });
		const { socket, response } = this.#upgrade();
		if (where.kind === "join" && !this.#meet.present()) {
			// workerd never finishes the close of a hibernating socket closed before its upgrade
			// was answered; a plain one is closed at once.
			socket.accept();
			socket.close(CLOSE.absent, "No computer waits under this id.");
			return response;
		}
		this.#state.acceptWebSocket(socket);
		if (where.kind === "host") this.#meet.host(peer(socket), where.id, url.origin);
		else this.#meet.join(peer(socket));
		return response;
	}

	async webSocketMessage(ws: HibernatingSocket, message: string | ArrayBuffer) {
		await this.#meet.message(peer(ws), message);
	}

	async webSocketClose(ws: HibernatingSocket, code: number, _reason: string, _clean: boolean) {
		this.#meet.closed(peer(ws));
		// Answers the other side's close, where the runtime has not already.
		try {
			ws.close(code === 1005 || code === 1006 ? 1000 : code, "");
		} catch {}
	}

	async webSocketError(ws: HibernatingSocket) {
		this.#meet.closed(peer(ws));
	}
}
