// The access host: what joins the meeting service, the peer connection and the access server.
// It waits at the meeting service under the host key's fingerprint, proves it owns that key,
// answers each browser's offer with a peer connection, and hands the data channel to the access
// server, which is the only thing that speaks to the browser. The meeting service only passes the
// few messages that set up the connection; what crosses after is SSH, end to end. No Electron
// here, so that it runs under plain Node in tests and in the web client's smoke: the app's main
// process hands it its own daemon, a vault that encrypts, and the admission that adds pairing.
import { randomBytes } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";
import ssh2 from "ssh2";
import { answer, type IceServer, type Peer, type PeerPath, type RelayServer, type Signal } from "./peer.ts";
import { type AccessServer, type Admit, createAccessServer, MAX_CONNECTIONS, pairedKeys, type SessionEvent } from "./server.ts";
import { AccessStore, type Vault } from "./store.ts";

/** The text the computer signs before the challenge and the service's address (the meeting's `PROOF_PREFIX`). */
const PROOF_PREFIX = "pine-meet-v1";

/** The meeting's close code for "a newer proven socket for this computer took this one's place". */
const REPLACED = 4409;

/**
 * Where the host stands with the meeting service. `waiting`: proven and findable. `unreachable`:
 * the service cannot be reached, or refused, and the host tries again by itself. `replaced`:
 * another copy of this computer's key waits there now, and this one stopped trying, so that two apps
 * do not take each other's place for ever.
 */
export type HostStatus = "connecting" | "waiting" | "unreachable" | "replaced";

/** How a kept text is encrypted in its file (Electron's safe storage in the app). */
export interface Cipher {
	seal(text: string): Buffer;
	open(bytes: Buffer): string;
}

/** The file of browser access in a data folder: written whole, readable by this user only. */
export function fileVault(file: string, cipher?: Cipher): Vault {
	return {
		async load() {
			let bytes: Buffer;
			try {
				bytes = readFileSync(file);
			} catch (e) {
				if ((e as NodeJS.ErrnoException).code === "ENOENT") return undefined;
				throw e;
			}
			return cipher ? cipher.open(bytes) : bytes.toString("utf8");
		},
		async save(text) {
			mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
			const temp = `${file}.${randomBytes(4).toString("hex")}.tmp`;
			writeFileSync(temp, cipher ? cipher.seal(text) : text, { mode: 0o600 });
			renameSync(temp, file);
		},
	};
}

/** The name of the file in the data folder: one name for each form, so that one is never read as the other. */
export const ACCESS_FILE = { plain: "access.json", sealed: "access.bin" };

/** What a decision of who may authenticate is made from. */
export interface AdmitContext {
	store: AccessStore;
	/** The service's origin, which a pairing link starts with. */
	service: string;
	/** Ends every live session of an id (`AccessServer.cut`). */
	cut(id: string): number;
}

export interface AccessHostOptions {
	/** The meeting service's address (`http(s)`); its origin is used. */
	service: string;
	/** The folder the host key and the paired devices are kept in. */
	folder?: string;
	/** Encrypts that file. */
	cipher?: Cipher;
	/** Where they are kept instead of a file in `folder`. */
	vault?: Vault;
	/** This computer's daemon: `pine service`'s one line of JSON. */
	daemon: () => Promise<string>;
	/**
	 * Who may authenticate: paired keys by default (`pairedKeys`); paired keys and pairing in the
	 * app (`createPairing(...).admit`, which is handed the same store, the service's origin and `cut`).
	 */
	admit?: (host: AdmitContext) => Admit;
	onStatus?: (status: HostStatus) => void;
	/** Sessions that began or ended (the access server's events); `tag` is `{ path }` of the connection. */
	report?: (event: SessionEvent) => void;
	/** Peer connections at a time, open or opening. */
	maxPeers?: number;
	/** The wait before trying the service again: `firstMs`, doubled each time up to `maxMs`. */
	retry?: { firstMs?: number; maxMs?: number };
	/** How long a browser may take to open its channel. */
	peerTimeoutMs?: number;
	/**
	 * The owner's relay server, without its password, which the host reads from its own store (the
	 * sealed file): every peer connection reserves an address on it, beside the service's STUN servers.
	 */
	relay?: Omit<RelayServer, "password">;
}

export interface AccessHost {
	/** The host key's fingerprint, under which the computer waits and which a pairing link names. */
	machineId: string;
	/** The service's origin. */
	service: string;
	store: AccessStore;
	server: AccessServer;
	status(): HostStatus;
	/** The devices connected now, and the kind of path each connection took. */
	connected(): Array<{ id: string; path?: PeerPath }>;
	/** Forgets a device and cuts its live connections. */
	remove(id: string): Promise<boolean>;
	/** How many peer connections there are, being set up or connected. */
	peers(): number;
	/** Closes the meeting socket, every peer connection and every session. The daemon is not the host's to stop. */
	stop(): Promise<void>;
}

/** What a connection carries for the reports and the device list. */
interface Tag {
	path?: PeerPath;
	peer: Peer;
}

const ICE = (value: unknown): IceServer[] => {
	if (!Array.isArray(value)) return [];
	const url = (u: unknown) => typeof u === "string" && /^stuns?:[^\s]+$/.test(u);
	return value.filter((s) => s && typeof s === "object" && (url(s.urls) || (Array.isArray(s.urls) && s.urls.every(url)))).map((s) => ({ urls: s.urls }));
};

/** Starts browser access: the store is opened (the host key made the first time) and the host goes to wait. */
export async function startAccessHost(options: AccessHostOptions): Promise<AccessHost> {
	const service = new URL(options.service);
	if (service.protocol !== "https:" && service.protocol !== "http:") throw new Error(`The address of the meeting service has to start with https:// (it is ${options.service.slice(0, 80)}).`);
	const origin = service.origin;
	const vault = options.vault ?? (options.folder ? fileVault(path.join(options.folder, options.cipher ? ACCESS_FILE.sealed : ACCESS_FILE.plain), options.cipher) : undefined);
	if (!vault) throw new Error("Browser access needs a folder to keep this computer's key in.");
	const store = await AccessStore.open(vault);
	const machineId = store.machineId();
	const parsed = ssh2.utils.parseKey(store.hostKey());
	if (parsed instanceof Error) throw parsed;
	const hostKey: ssh2.ParsedKey = parsed;
	const publicBlob = hostKey.getPublicSSH();
	const relay: RelayServer | undefined = options.relay && { ...options.relay, password: store.relayPassword() ?? "" };
	const maxPeers = options.maxPeers ?? MAX_CONNECTIONS;
	const firstMs = options.retry?.firstMs ?? 1000;
	const maxMs = options.retry?.maxMs ?? 60_000;

	const admit = options.admit ? options.admit({ store, service: origin, cut: (id) => server.cut(id) }) : pairedKeys(store);
	const server: AccessServer = createAccessServer({
		hostKey: store.hostKey(),
		admit,
		daemon: options.daemon,
		maxConnections: maxPeers,
		report: (event) => {
			if (event.kind === "connected") void store.seen(event.id, event.at).catch(() => {});
			options.report?.(event);
		},
	});

	let status: HostStatus = "connecting";
	const say = (next: HostStatus) => {
		if (next === status) return;
		status = next;
		options.onStatus?.(next);
	};

	let stopped = false;
	let socket: WebSocket | undefined;
	let timer: ReturnType<typeof setTimeout> | undefined;
	let failures = 0;
	/** Peer connections by the meeting's session, while they are being set up. */
	const meeting = new Map<string, Peer>();
	/** Every peer connection there is, set up or connected. */
	const peers = new Set<Peer>();
	/** The peers that were handed the browser's offer. */
	const offered = new WeakSet<Peer>();

	const again = () => {
		if (stopped) return;
		const wait = Math.min(maxMs, firstMs * 2 ** failures);
		failures++;
		timer = setTimeout(connect, wait);
	};

	async function connect() {
		timer = undefined;
		if (stopped) return;
		let ice: IceServer[];
		try {
			const answer = await fetch(new URL("/meet/config", origin), { signal: AbortSignal.timeout(10_000) });
			if (!answer.ok) throw new Error(`the meeting service answered ${answer.status}`);
			ice = ICE(((await answer.json()) as { ice?: unknown })?.ice);
		} catch {
			say("unreachable");
			return again();
		}
		if (stopped) return;
		const url = new URL(`/meet/host?id=${machineId}`, origin);
		url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
		const ws = new WebSocket(url);
		socket = ws;
		ws.addEventListener("message", (e) => {
			if (typeof e.data === "string") onMessage(ws, ice, e.data);
		});
		ws.addEventListener("error", () => {});
		ws.addEventListener("close", (e) => {
			if (socket === ws) socket = undefined;
			// The sessions of the meeting are gone with it; connected peers live on without it.
			for (const [s, peer] of meeting) {
				meeting.delete(s);
				peer.close();
			}
			if (stopped) return;
			if (e.code === REPLACED) return say("replaced");
			say("unreachable");
			again();
		});
	}

	function onMessage(ws: WebSocket, ice: IceServer[], text: string) {
		let message: any;
		try {
			message = JSON.parse(text);
		} catch {
			return;
		}
		const send = (value: unknown) => ws.readyState === WebSocket.OPEN && ws.send(JSON.stringify(value));
		if (message?.t === "challenge" && typeof message.nonce === "string") {
			const sig = hostKey.sign(Buffer.from(`${PROOF_PREFIX}\n${message.nonce}\n${origin}`));
			if (sig instanceof Error) return ws.close();
			return send({ t: "proof", key: publicBlob.toString("base64"), sig: sig.toString("base64") });
		}
		if (message?.t === "waiting") {
			failures = 0;
			return say("waiting");
		}
		const s = message?.s;
		if (typeof s !== "string") return;
		if (message.t === "open") {
			if (peers.size >= maxPeers || meeting.has(s)) return send({ t: "close", s });
			let peer: Peer;
			try {
				peer = answer({ ice, relay, send: (d: Signal) => send({ t: "signal", s, d }), timeoutMs: options.peerTimeoutMs });
			} catch {
				// The library refused the connection (its binary, a server it was handed): the browser is
				// told at once, and nothing escapes this listener into the app's main process.
				return send({ t: "close", s });
			}
			meeting.set(s, peer);
			peers.add(peer);
			peer.closed.then(() => {
				peers.delete(peer);
				if (meeting.get(s) === peer) meeting.delete(s);
			});
			peer.channel.then(
				(stream) => {
					// The meeting has done its part, and SSH takes the channel. The browser ends the
					// meeting once its own end of the channel is open: ended from here, it could close
					// before the browser saw the channel open.
					if (meeting.get(s) === peer) meeting.delete(s);
					const tag: Tag = { path: peer.path(), peer };
					if (!server.accept(stream, tag)) peer.close();
				},
				() => {},
			);
			return;
		}
		if (message.t === "signal") {
			const peer = meeting.get(s);
			if (peer && message.d && typeof message.d === "object" && "sdp" in message.d) offered.add(peer);
			return peer?.signal(message.d);
		}
		if (message.t === "close") {
			// The browser left the meeting before its channel reached this side. With its offer here,
			// the connection may be up already and the channel on its way (the browser leaves once
			// its own end is open): the peer's own state and its time limit (`peerTimeoutMs`) decide.
			// Without one, nothing will come.
			const peer = meeting.get(s);
			meeting.delete(s);
			if (peer && !offered.has(peer)) peer.close();
		}
	}

	void connect();

	return {
		machineId,
		service: origin,
		store,
		server,
		status: () => status,
		connected: () => server.connected().map(({ id, tag }) => ({ id, path: (tag as Tag | undefined)?.peer.path() ?? (tag as Tag | undefined)?.path })),
		peers: () => peers.size,
		async remove(id) {
			const removed = await store.remove(id);
			server.cut(id);
			return removed;
		},
		async stop() {
			if (stopped) return;
			stopped = true;
			clearTimeout(timer);
			socket?.close();
			socket = undefined;
			server.close();
			const all = [...peers];
			for (const peer of all) peer.close();
			await Promise.all(all.map((p) => p.closed));
		},
	};
}
