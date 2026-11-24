// The meeting service: a computer waits under its machine id after it proved it owns the key, a
// browser that names the id is put through, and a few small messages cross both ways (the
// WebRTC offer, answer and candidates) until the two talk directly. The service never carries
// the conversation, keeps nothing and logs nothing.
//
// Nothing of Cloudflare is in here. The meeting is driven by socket-like objects that keep a
// small note each (`Peer`): a Durable Object with hibernating WebSockets keeps the note as the
// socket's attachment (meet-object.ts), and a Node server keeps it in memory (`inMemory`). All
// the state there is lives in those notes, so that an object woken from hibernation, which has
// lost everything else, carries on: timers are a convenience, and every limit is checked again
// when a message comes.

/** The text a computer signs, before the challenge and the service's address. */
export const PROOF_PREFIX = "pine-meet-v1";

/** WebSocket close codes the computer and the browser read. */
export const CLOSE = {
	/** A message that is not one the service expects. */
	bad: 4400,
	/** The computer's proof was refused, or came too late. */
	proof: 4401,
	/** No computer waits under that id, or it left. */
	absent: 4404,
	/** The session ran out of time. */
	timeout: 4408,
	/** A newer proven socket for the same id took this one's place. */
	replaced: 4409,
	/** Over the service's limits: too many connections from the address, a message too big, too many messages. */
	limits: 4429,
};

export type Limits = {
	/** The largest message, in UTF-8 bytes. */
	maxBytes: number;
	/** How many signals a session may carry, both ways together. */
	maxMessages: number;
	/** How long a session lasts. */
	sessionMs: number;
	/** How long a computer has to prove its key. */
	proofMs: number;
};

export const LIMITS: Limits = { maxBytes: 16 * 1024, maxMessages: 64, sessionMs: 30_000, proofMs: 10_000 };

/** What the meeting keeps about a socket: everything it knows. Small, for a hibernating socket's attachment. */
export type Note =
	| { k: string; role: "host"; at: number; nonce: string; origin: string; id: string; proven: boolean; gone?: true }
	| { k: string; role: "join"; at: number; s: string; n: number; gone?: true };

/** A socket of one machine id's meeting, with the note that is kept with it. */
export type Peer = {
	send(text: string): void;
	close(code: number, reason: string): void;
	note(): Note | null;
	keep(note: Note): void;
};

/** The open sockets of one machine id. */
export type Room = { peers(): Peer[] };

export type Options = { limits?: Partial<Limits>; now?: () => number };

/** A machine id: SHA-256 of an SSH public key blob, base64url without padding. */
export function isMachineId(id: unknown): id is string {
	return typeof id === "string" && /^[A-Za-z0-9_-]{43}$/.test(id);
}

/** The route of a meeting request: `/meet/host?id=` for a computer, `/meet/join?id=` for a browser. */
export function route(url: URL): { kind: "host" | "join"; id: string } | null {
	const kind = url.pathname === "/meet/host" ? "host" : url.pathname === "/meet/join" ? "join" : null;
	const id = url.searchParams.get("id");
	return kind && isMachineId(id) ? { kind, id } : null;
}

export type IceServer = { urls: string | string[] };

/** A public STUN server, for a configuration that names none. */
export const DEFAULT_ICE: IceServer[] = [{ urls: "stun:stun.cloudflare.com:3478" }];

/** What `GET /meet/config` answers: the servers that help a connection, and whether the SSH relay is on. */
export function meetConfig(ice: unknown, relay: boolean): { ice: IceServer[]; relay: boolean } {
	const url = (u: unknown) => typeof u === "string" && /^(stun|stuns|turn|turns):[^\s]+$/.test(u);
	const valid = Array.isArray(ice) && ice.length > 0 && ice.every((s) => s && typeof s === "object" && (url(s.urls) || (Array.isArray(s.urls) && s.urls.length > 0 && s.urls.every(url))));
	return { ice: valid ? (ice as IceServer[]).map((s) => ({ urls: s.urls })) : DEFAULT_ICE, relay };
}

function random(bytes: number) {
	return base64url(crypto.getRandomValues(new Uint8Array(bytes)));
}

function base64url(bytes: Uint8Array) {
	let text = "";
	for (const byte of bytes) text += String.fromCharCode(byte);
	return btoa(text).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function fromBase64(text: unknown): Uint8Array | null {
	if (typeof text !== "string" || !/^[A-Za-z0-9+/]*={0,2}$/.test(text)) return null;
	try {
		return Uint8Array.from(atob(text), (c) => c.charCodeAt(0));
	} catch {
		return null;
	}
}

/** The raw Ed25519 key of an SSH public key blob (RFC 8709), or null when it is anything else. */
function ed25519Of(blob: Uint8Array): Uint8Array | null {
	const name = new TextEncoder().encode("ssh-ed25519");
	if (blob.length !== 4 + name.length + 4 + 32) return null;
	const view = new DataView(blob.buffer, blob.byteOffset, blob.byteLength);
	if (view.getUint32(0) !== name.length || view.getUint32(4 + name.length) !== 32) return null;
	if (!name.every((byte, i) => blob[4 + i] === byte)) return null;
	return blob.slice(8 + name.length);
}

/** Whether a proof is a valid signature, by the key whose fingerprint is `id`, over the challenge and the service's address. */
async function proves(proof: { key?: unknown; sig?: unknown }, id: string, nonce: string, origin: string) {
	const blob = fromBase64(proof.key);
	const sig = fromBase64(proof.sig);
	if (!blob || !sig || sig.length !== 64) return false;
	const raw = ed25519Of(blob);
	if (!raw) return false;
	const fingerprint = base64url(new Uint8Array(await crypto.subtle.digest("SHA-256", blob)));
	if (fingerprint !== id) return false;
	try {
		const key = await crypto.subtle.importKey("raw", raw, { name: "Ed25519" }, false, ["verify"]);
		return await crypto.subtle.verify({ name: "Ed25519" }, key, sig, new TextEncoder().encode(`${PROOF_PREFIX}\n${nonce}\n${origin}`));
	} catch {
		return false;
	}
}

function parse(data: unknown): Record<string, unknown> | null {
	if (typeof data !== "string") return null;
	try {
		const value = JSON.parse(data);
		return value && typeof value === "object" && !Array.isArray(value) ? value : null;
	} catch {
		return null;
	}
}

const bytes = (text: string) => new TextEncoder().encode(text).length;

/** One machine id's meeting, over the sockets of its room. */
export function meeting(room: Room, options: Options = {}) {
	const limits = { ...LIMITS, ...options.limits };
	const now = options.now ?? Date.now;

	const live = () => room.peers().filter((p) => p.note() && !p.note()!.gone);
	const byKey = (k: string) => live().find((p) => p.note()!.k === k);
	const waiting = () => live().find((p) => { const n = p.note()!; return n.role === "host" && n.proven; });
	const browser = (s: unknown) => live().find((p) => { const n = p.note()!; return n.role === "join" && n.s === s; });

	const leave = (peer: Peer, code: number, reason: string) => {
		const note = peer.note();
		if (note) peer.keep({ ...note, gone: true });
		try {
			peer.close(code, reason);
		} catch {}
	};

	/** Ends a browser's session, and tells the computer unless it ended it itself. */
	const end = (peer: Peer, code: number, reason: string, tell = true) => {
		const note = peer.note();
		leave(peer, code, reason);
		const host = waiting();
		if (tell && host && note?.role === "join") host.send(JSON.stringify({ t: "close", s: note.s }));
	};

	/** Whether a session may carry one more message of this size; ends it when not. */
	const admit = (peer: Peer, size: number) => {
		const note = peer.note();
		if (note?.role !== "join") return false;
		if (now() - note.at > limits.sessionMs) return end(peer, CLOSE.timeout, "The meeting took too long."), false;
		if (size > limits.maxBytes) return end(peer, CLOSE.limits, "A message was too big."), false;
		if (note.n + 1 > limits.maxMessages) return end(peer, CLOSE.limits, "Too many messages."), false;
		peer.keep({ ...note, n: note.n + 1 });
		return true;
	};

	const later = (ms: number, then: () => void) => {
		const timer = setTimeout(then, ms) as { unref?: () => void };
		timer.unref?.();
	};

	async function fromMac(peer: Peer, note: Extract<Note, { role: "host" }>, data: unknown) {
		const message = parse(data);
		if (!note.proven) {
			if (now() - note.at > limits.proofMs || message?.t !== "proof" || !(await proves(message, note.id, note.nonce, note.origin))) {
				return leave(peer, CLOSE.proof, "The proof was refused.");
			}
			// The proof took a moment: the socket may have gone meanwhile.
			const current = peer.note();
			if (!current || current.gone) return;
			for (const other of live()) {
				const n = other.note()!;
				if (other === peer || n.k === note.k) continue;
				if (n.role === "join") leave(other, CLOSE.absent, "The computer connected again; try again.");
				else if (n.proven) leave(other, CLOSE.replaced, "A newer connection for this computer took this one's place.");
			}
			peer.keep({ ...note, proven: true });
			peer.send(JSON.stringify({ t: "waiting" }));
			return;
		}
		if (!message || typeof message.s !== "string" || (message.t !== "signal" && message.t !== "close")) return leave(peer, CLOSE.bad, "Not a message of the meeting.");
		const other = browser(message.s);
		// A session that ended meanwhile: the computer learns it from the close it was sent.
		if (!other) return;
		if (message.t === "close") return end(other, 1000, "The computer ended the meeting.", false);
		if (!("d" in message) || !admit(other, bytes(data as string))) return;
		other.send(JSON.stringify({ t: "signal", d: message.d }));
	}

	function fromBrowser(peer: Peer, data: unknown) {
		const message = parse(data);
		if (!message || message.t !== "signal" || !("d" in message)) return leave(peer, CLOSE.bad, "Not a message of the meeting.");
		if (!admit(peer, bytes(data as string))) return;
		const host = waiting();
		if (!host) return leave(peer, CLOSE.absent, "The computer left.");
		host.send(JSON.stringify({ t: "signal", s: (peer.note() as Extract<Note, { role: "join" }>).s, d: message.d }));
	}

	return {
		/** Whether a computer waits: a browser has someone to meet. */
		present: () => Boolean(waiting()),
		/** A computer's socket: it is challenged, and waits once it proved its key. */
		host(peer: Peer, id: string, origin: string) {
			const nonce = random(32);
			const k = random(12);
			peer.keep({ k, role: "host", at: now(), nonce, origin, id, proven: false });
			peer.send(JSON.stringify({ t: "challenge", nonce }));
			later(limits.proofMs, () => {
				const p = byKey(k);
				const n = p?.note();
				if (p && n?.role === "host" && !n.proven) leave(p, CLOSE.proof, "No proof in time.");
			});
		},
		/** A browser's socket: put through to the computer, or told there is none. */
		join(peer: Peer) {
			const host = waiting();
			if (!host) return leave(peer, CLOSE.absent, "No computer waits under this id.");
			const s = random(16);
			const k = random(12);
			peer.keep({ k, role: "join", at: now(), s, n: 0 });
			host.send(JSON.stringify({ t: "open", s }));
			peer.send(JSON.stringify({ t: "ready" }));
			later(limits.sessionMs, () => {
				const p = byKey(k);
				if (p) end(p, CLOSE.timeout, "The meeting took too long.");
			});
		},
		/** A message a socket sent: text, or anything else, which is refused. */
		async message(peer: Peer, data: unknown) {
			const note = peer.note();
			if (!note || note.gone) return;
			if (note.role === "host") return fromMac(peer, note, data);
			return fromBrowser(peer, data);
		},
		/** A socket that closed. */
		closed(peer: Peer) {
			const note = peer.note();
			if (!note || note.gone) return;
			// A socket that closed may still be listed for a moment, and its note can no longer be written.
			const others = live().filter((p) => p.note()!.k !== note.k);
			if (note.role === "join") {
				others.find((p) => { const n = p.note()!; return n.role === "host" && n.proven; })?.send(JSON.stringify({ t: "close", s: note.s }));
				return;
			}
			// The computer that left was the one browsers met: their sessions have nobody at the other end.
			if (note.proven) for (const other of others) if (other.note()!.role === "join") leave(other, CLOSE.absent, "The computer left.");
		},
	};
}

/** A socket as a Node server holds it (the `ws` package's, or any other): text out, and a close. */
export type Plain = { send(text: string): void; close(code: number, reason: string): void };

/** What a server tells the meeting about one socket: what it sent, and that it closed. */
export type Connection = { message(data: unknown): Promise<void>; closed(): void };

/**
 * Meetings for every machine id, with the notes kept in memory: the meeting service as a Node
 * process serves it (tests, and nothing deployed). A server routes each WebSocket with `route()`,
 * hands it to `connect()`, and passes on its messages (text as a string) and its close.
 */
export function inMemory(options: Options = {}) {
	const rooms = new Map<string, Set<{ peer: Peer }>>();
	const meetings = new Map<string, ReturnType<typeof meeting>>();
	const of = (id: string) => {
		let room = rooms.get(id);
		if (!room) {
			const entries = new Set<{ peer: Peer }>();
			rooms.set(id, (room = entries));
			meetings.set(id, meeting({ peers: () => [...entries].map((e) => e.peer) }, options));
		}
		return { entries: room, meet: meetings.get(id)! };
	};
	return {
		connect(kind: "host" | "join", id: string, origin: string, socket: Plain): Connection {
			const { entries, meet } = of(id);
			let kept: Note | null = null;
			const entry = {
				peer: {
					send: (text: string) => socket.send(text),
					close: (code: number, reason: string) => socket.close(code, reason),
					note: () => kept,
					keep: (note: Note) => void (kept = note),
				},
			};
			entries.add(entry);
			if (kind === "host") meet.host(entry.peer, id, origin);
			else meet.join(entry.peer);
			return {
				message: (data) => meet.message(entry.peer, data),
				closed: () => {
					meet.closed(entry.peer);
					entries.delete(entry);
					if (entries.size === 0) {
						rooms.delete(id);
						meetings.delete(id);
					}
				},
			};
		},
	};
}
