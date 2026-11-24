// The access server: an SSH server of the app's own, for pine and nothing else. It is handed a
// byte stream (a WebRTC data channel in the app, an in-memory pair in the tests) and a way to get
// this computer's daemon. An admitted session gets exactly two things: the web client's remote
// command answered with the daemon's service line, as `pine service` would answer it over the
// system's sshd, and channels to that daemon's loopback port. Everything else is refused. It runs
// no shell and no program: the command is recognised, never executed. No Electron here, so that
// it runs under plain Node in the tests and in the web client's smoke.
import net from "node:net";
import type { Duplex } from "node:stream";
import ssh2 from "ssh2";
import type { AuthContext, Connection, ServerChannel } from "ssh2";
import { loopbackEnd, remoteCommand } from "../../../src/remote.ts";
import type { AccessStore } from "./store.ts";

/**
 * Algorithms Node's own crypto has, so that ssh2 needs no native binding: an Ed25519 host key,
 * ECDH key exchange and AES-GCM. Curve25519 comes first; P-256 is there because the web client's
 * SSH library (@microsoft/dev-tunnels-ssh) has no Curve25519, and AES-256-GCM is the one GCM it has.
 */
export const ALGORITHMS = {
	serverHostKey: ["ssh-ed25519"],
	kex: ["curve25519-sha256", "curve25519-sha256@libssh.org", "ecdh-sha2-nistp256"],
	cipher: ["aes256-gcm@openssh.com", "aes128-gcm@openssh.com"],
	// GCM carries its own integrity; ssh2 wants a list all the same.
	hmac: ["hmac-sha2-256-etm@openssh.com", "hmac-sha2-256"],
	compress: ["none"],
} as const;

/** How long a connection may stay without authenticating. */
export const AUTH_TIMEOUT_MS = 20_000;
/** How many connections at a time, authenticated or not. */
export const MAX_CONNECTIONS = 8;

/** A public key a client proved it holds: its algorithm and its SSH public key blob. */
export interface Key {
	algo: string;
	data: Buffer;
}

/**
 * What an admitted session is. `id` names who it is, in the reports and for `cut`. `pine` gives
 * it the remote command and the channels to the daemon. `exec` answers one more command of the
 * caller's own (the pairing request): it returns true when it took the channel, false to refuse.
 */
export interface Admission {
	id: string;
	pine: boolean;
	exec?: (command: string, accept: () => ServerChannel) => boolean;
	/** The session's connection ended, whatever ended it. */
	left?: () => void;
}

/**
 * The one decision: may this key, under this user name, authenticate, and as what. It is asked
 * once per connection, after the client proved it holds the key, so that a single-use secret in
 * the user name (pairing) can be consumed there. Undefined refuses; false refuses and closes the
 * connection, so that a client gets one guess at a secret per connection.
 */
export type Admit = (user: string, key: Key) => Admission | undefined | false | Promise<Admission | undefined | false>;

/** Paired devices: user `pine` and a key on the store's list. */
export const pairedKeys =
	(store: AccessStore): Admit =>
	(user, key) => {
		if (user !== "pine") return undefined;
		const device = store.find(key.data);
		return device && { id: device.id, pine: true };
	};

/** A session that began or ended, for a list that says "connected now". `tag` is what `accept` was handed. */
export interface SessionEvent {
	kind: "connected" | "left";
	id: string;
	at: Date;
	tag?: unknown;
}

export interface AccessServerOptions {
	/** The host key, OpenSSH private key format (`AccessStore.hostKey()`). */
	hostKey: string;
	admit: Admit;
	/**
	 * This computer's daemon: `pine service`'s one line of JSON. Asked for by every remote command
	 * (one call for those asking at the same time), so it should reuse a daemon that still answers.
	 */
	daemon: () => Promise<string>;
	authTimeoutMs?: number;
	maxConnections?: number;
	report?: (event: SessionEvent) => void;
}

export interface AccessServer {
	/** Serves one connection over a byte stream. False when it was turned away (too many). */
	accept(stream: Duplex, tag?: unknown): boolean;
	/** Ends every live session of `id` (a device that was removed). How many there were. */
	cut(id: string): number;
	/** The sessions that are authenticated now. */
	connected(): Array<{ id: string; tag?: unknown }>;
	/** Ends every connection. The daemon is not the server's to stop. */
	close(): void;
}

interface Live {
	stream: Duplex;
	client?: Connection;
	admission?: Admission;
	tag?: unknown;
	/** The decision said no and close: nothing more is asked on this connection. */
	shut?: boolean;
}

/** Where the daemon answers, taken from its service line, and the line as it is passed on. */
interface Known {
	line: string;
	host: string;
	port: number;
}

/** The daemon's service line, checked: one line of JSON that names a loopback address. */
function known(text: string): Known {
	const line = text.replace(/\r?\n$/, "");
	if (line.includes("\n")) throw new Error("pine service answered more than one line.");
	const said = JSON.parse(line);
	if (typeof said?.error === "string") throw new Error(said.error);
	const end = loopbackEnd(String(said?.base));
	const colon = end.lastIndexOf(":");
	return { line, host: end.slice(0, colon).replace(/^\[(.*)\]$/, "$1"), port: Number(end.slice(colon + 1)) };
}

const ED25519 = "ssh-ed25519";

export function createAccessServer(options: AccessServerOptions): AccessServer {
	const authTimeoutMs = options.authTimeoutMs ?? AUTH_TIMEOUT_MS;
	const maxConnections = options.maxConnections ?? MAX_CONNECTIONS;
	const command = remoteCommand();
	const live = new Set<Live>();

	// The daemon belongs to the app, not to a session. Every remote command asks for it again, since
	// it may have stopped or moved since the last one; the caller's function reuses one that still
	// answers. Commands that ask at the same time share one call.
	let asking: Promise<Known> | undefined;
	/** The latest answer: what a channel to the daemon may reach. */
	let daemonKnown: Known | undefined;
	const getDaemon = () => {
		if (asking) return asking;
		const call = options.daemon().then(known);
		asking = call;
		// Settled either way, the next command asks anew: a failure is not kept either.
		call
			.then(
				(k) => void (daemonKnown = k),
				() => {},
			)
			.finally(() => void (asking = undefined));
		return call;
	};

	const end = (entry: Live) => {
		try {
			entry.client?.end();
		} catch {}
		entry.stream.destroy();
	};

	function serve(entry: Live, client: Connection) {
		entry.client = client;
		client.on("error", () => {});
		client.on("authentication", (ctx: AuthContext) => {
			// Public keys only, and only Ed25519 ones: no password, no keyboard-interactive, no host-based.
			if (ctx.method !== "publickey") return ctx.reject(["publickey"]);
			const key = ssh2.utils.parseKey(ctx.key.data);
			if (key instanceof Error || key.type !== ED25519) return ctx.reject(["publickey"]);
			// Without a signature the client only asks whether the key would do: say yes, and it signs.
			if (!ctx.signature || !ctx.blob) return ctx.accept();
			if (key.verify(ctx.blob, ctx.signature, ctx.hashAlgo) !== true) return ctx.reject(["publickey"]);
			// A connection that was refused for good asks nothing more, even what it sent before it heard.
			if (entry.shut) return ctx.reject(["publickey"]);
			const proved = { algo: ED25519, data: Buffer.from(ctx.key.data) };
			Promise.resolve()
				.then(() => options.admit(ctx.username, proved))
				.then(
					(admission) => {
						if (admission === false) {
							entry.shut = true;
							ctx.reject(["publickey"]);
							return end(entry);
						}
						if (!admission || !live.has(entry)) return ctx.reject(["publickey"]);
						entry.admission = admission;
						ctx.accept();
					},
					() => ctx.reject(["publickey"]),
				);
		});
		client.once("ready", () => {
			const admission = entry.admission!;
			options.report?.({ kind: "connected", id: admission.id, at: new Date(), tag: entry.tag });
			client.on("session", (accept) => session(admission, accept()));
			client.on("tcpip", (accept, reject, info) => {
				const to = daemonKnown;
				const host = info.destIP.replace(/^\[(.*)\]$/, "$1");
				if (!admission.pine || !to || host !== to.host || info.destPort !== to.port) return reject();
				const socket = net.connect(to.port, to.host);
				socket.once("error", () => reject());
				socket.once("connect", () => {
					const channel = accept();
					socket.removeAllListeners("error");
					socket.on("error", () => channel.destroy());
					channel.on("error", () => socket.destroy());
					channel.pipe(socket).pipe(channel);
				});
			});
			// Remote forwarding and every other global request.
			client.on("request", (_accept, reject) => reject?.());
		});
	}

	function session(admission: Admission, session: ssh2.Session) {
		for (const refused of ["pty", "shell", "subsystem", "sftp", "env", "auth-agent", "x11", "signal", "window-change"] as const) {
			session.on(refused as any, (_accept: unknown, reject?: () => void) => reject?.());
		}
		session.on("exec", (accept, reject, info) => {
			if (admission.pine && info.command === command) return answer(accept());
			if (admission.exec?.(info.command, accept)) return;
			reject();
		});
	}

	/** The remote command, as `pine service && exec cat >/dev/null` would answer it. */
	function answer(channel: ServerChannel) {
		channel.on("error", () => {});
		getDaemon().then(
			(k) => {
				channel.write(`${k.line}\n`);
				// `cat` reads stdin to its end and then exits: the channel ends with the client's input.
				channel.on("data", () => {});
				channel.once("end", () => {
					channel.exit(0);
					channel.end();
				});
			},
			(e) => {
				channel.write(`${JSON.stringify({ error: e instanceof Error ? e.message : String(e) })}\n`);
				channel.exit(1);
				channel.end();
			},
		);
	}

	return {
		accept(stream, tag) {
			if (live.size >= maxConnections) {
				stream.destroy();
				return false;
			}
			const entry: Live = { stream, tag };
			live.add(entry);
			const timer = setTimeout(() => {
				if (!entry.admission) end(entry);
			}, authTimeoutMs);
			let reported = false;
			const gone = () => {
				clearTimeout(timer);
				if (!live.delete(entry)) return;
				entry.admission?.left?.();
				if (entry.admission && reported) options.report?.({ kind: "left", id: entry.admission.id, at: new Date(), tag });
			};
			stream.once("close", gone);
			stream.on("error", () => {});
			const server = new ssh2.Server({ hostKeys: [options.hostKey], algorithms: ALGORITHMS as any, ident: "pine" });
			server.on("connection", (client) => {
				client.once("ready", () => {
					reported = true;
					clearTimeout(timer);
				});
				client.once("close", () => {
					gone();
					stream.destroy();
				});
				serve(entry, client);
			});
			server.injectSocket(stream as any);
			return true;
		},
		cut(id) {
			let n = 0;
			for (const entry of [...live]) {
				if (entry.admission?.id !== id) continue;
				n++;
				end(entry);
			}
			return n;
		},
		connected() {
			return [...live].filter((e) => e.admission && e.client?.authenticated).map((e) => ({ id: e.admission!.id, tag: e.tag }));
		},
		close() {
			for (const entry of [...live]) end(entry);
		},
	};
}
