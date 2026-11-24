// The web client's SSH core: the browser's own Ed25519 key, held by WebCrypto and never
// exported, and an SSH session over a WebSocket with @microsoft/dev-tunnels-ssh, to which we
// add Ed25519 (the library ships none).

import {
	CommandRequestMessage,
	PublicKeyAlgorithm,
	SshAuthenticationType,
	SshClientSession,
	SshDisconnectReason,
	SshSessionConfiguration,
	BaseStream,
	type KeyPair,
	type SshChannel,
	type Signer,
	type Verifier,
} from "@microsoft/dev-tunnels-ssh";
import { PortForwardChannelOpenMessage } from "@microsoft/dev-tunnels-ssh-tcp";
import { Buffer } from "buffer";

/** Bytes on an ArrayBuffer of their own, as WebCrypto takes them. */
type Bytes = Uint8Array<ArrayBuffer>;

/** The SSH wire form of a string: its length as four bytes, then its bytes. */
function sshString(bytes: Uint8Array): Bytes {
	const out = new Uint8Array(4 + bytes.length);
	new DataView(out.buffer).setUint32(0, bytes.length);
	out.set(bytes, 4);
	return out;
}

export function concat(...parts: Uint8Array[]): Bytes {
	const out = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0));
	let at = 0;
	for (const part of parts) {
		out.set(part, at);
		at += part.length;
	}
	return out;
}

/** In pieces of 32 KB: `String.fromCharCode` takes its bytes as arguments, and a whole picture would be too many. */
export function base64(bytes: Uint8Array): string {
	let binary = "";
	for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
	return btoa(binary);
}

const ED25519 = "ssh-ed25519";
const ascii = (text: string) => new TextEncoder().encode(text);

/** The public key blob of SSH: the algorithm's name, then the 32 bytes of the key. */
export function publicKeyBlob(raw: Uint8Array): Bytes {
	return concat(sshString(ascii(ED25519)), sshString(raw));
}

/**
 * A new Ed25519 key pair. The private key is not extractable: it signs, and no script, ours
 * included, can read or export it.
 */
export async function generateKey(): Promise<CryptoKeyPair> {
	return (await crypto.subtle.generateKey({ name: "Ed25519" }, false, ["sign", "verify"])) as CryptoKeyPair;
}

/** The public key as a line of `authorized_keys`: `ssh-ed25519 <base64> <comment>`. */
export async function publicKeyLine(publicKey: CryptoKey, comment = ""): Promise<string> {
	const raw = new Uint8Array(await crypto.subtle.exportKey("raw", publicKey));
	return `${ED25519} ${base64(publicKeyBlob(raw))}${comment ? ` ${comment}` : ""}`;
}

/** A host key's fingerprint as OpenSSH prints it: `SHA256:` and the unpadded base64 of the digest. */
export async function fingerprint(blob: Bytes): Promise<string> {
	const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", blob));
	return `SHA256:${base64(digest).replace(/=+$/, "")}`;
}

/** The 32 bytes of an Ed25519 key out of its SSH blob; anything else is refused. */
function rawFromBlob(blob: Bytes): Bytes {
	const view = new DataView(blob.buffer, blob.byteOffset, blob.byteLength);
	const nameLength = view.getUint32(0);
	const name = new TextDecoder().decode(blob.subarray(4, 4 + nameLength));
	const keyLength = view.getUint32(4 + nameLength);
	if (name !== ED25519 || keyLength !== 32 || blob.length !== 8 + nameLength + keyLength) throw new Error(`Not an ${ED25519} key.`);
	return blob.slice(8 + nameLength);
}

/**
 * An Ed25519 key in the library's terms. It holds CryptoKeys: the browser's own pair, or the
 * public half of a server's host key. It has no way to generate, import or export a private key.
 */
class Ed25519Key implements KeyPair {
	readonly keyAlgorithmName = ED25519;
	comment: string | null = null;
	publicKey: CryptoKey | null;
	readonly privateKey: CryptoKey | null;
	private blob: Bytes | null = null;

	constructor(pair?: CryptoKeyPair) {
		this.publicKey = pair?.publicKey ?? null;
		this.privateKey = pair?.privateKey ?? null;
	}

	get hasPublicKey() {
		return this.publicKey !== null;
	}

	get hasPrivateKey() {
		return this.privateKey !== null;
	}

	async setPublicKeyBytes(keyBytes: Buffer): Promise<void> {
		const blob = new Uint8Array(keyBytes);
		this.publicKey = await crypto.subtle.importKey("raw", rawFromBlob(blob), { name: "Ed25519" }, true, ["verify"]);
		this.blob = blob;
	}

	async getPublicKeyBytes(): Promise<Buffer | null> {
		if (!this.blob && this.publicKey) this.blob = publicKeyBlob(new Uint8Array(await crypto.subtle.exportKey("raw", this.publicKey)));
		return this.blob ? Buffer.from(this.blob) : null;
	}

	async generate(): Promise<void> {
		throw new Error("Ed25519 keys are made by generateKey(), which keeps the private key unextractable.");
	}

	async importParameters(): Promise<void> {
		throw new Error("Ed25519 keys cannot be imported.");
	}

	async exportParameters(): Promise<object> {
		throw new Error("Ed25519 keys cannot be exported.");
	}

	dispose(): void {}
}

/** `ssh-ed25519` for the library: signs and verifies with WebCrypto. */
class Ed25519Algorithm extends PublicKeyAlgorithm {
	constructor() {
		super(ED25519, ED25519, "SHA2-512");
	}

	createKeyPair(): KeyPair {
		return new Ed25519Key();
	}

	async generateKeyPair(): Promise<KeyPair> {
		return new Ed25519Key(await generateKey());
	}

	createSigner(keyPair: KeyPair): Signer {
		const key = (keyPair as Ed25519Key).privateKey;
		if (!key) throw new Error("An Ed25519 key without its private half cannot sign.");
		return {
			digestLength: 64,
			sign: async (data) => Buffer.from(await crypto.subtle.sign("Ed25519", key, new Uint8Array(data))),
			dispose() {},
		};
	}

	createVerifier(keyPair: KeyPair): Verifier {
		const key = (keyPair as Ed25519Key).publicKey;
		if (!key) throw new Error("An Ed25519 key without its public half cannot verify.");
		return {
			digestLength: 64,
			verify: (data, signature) => crypto.subtle.verify("Ed25519", key, new Uint8Array(signature), new Uint8Array(data)),
			dispose() {},
		};
	}
}

/** One channel of the connection: what the other end sends, and a way to send to it. */
export type Channel = {
	/** Receives what the other end sends: a command's standard output, or a port's bytes. */
	onData(listener: (bytes: Uint8Array) => void): void;
	/** Receives a command's standard error. */
	onStderr(listener: (bytes: Uint8Array) => void): void;
	send(bytes: Uint8Array | string): Promise<void>;
	close(): Promise<void>;
	/** Settles when the channel is closed, with the command's exit status when it had one. */
	closed: Promise<{ exitStatus?: number; exitSignal?: string }>;
};

/**
 * Bytes that arrived before a listener was there are kept for it: a command can write before
 * the caller has had a turn to listen.
 */
function stream() {
	let listener: ((bytes: Uint8Array) => void) | null = null;
	const waiting: Uint8Array[] = [];
	return {
		push(bytes: Uint8Array) {
			if (listener) listener(bytes);
			else waiting.push(bytes);
		},
		listen(next: (bytes: Uint8Array) => void) {
			listener = next;
			for (const bytes of waiting.splice(0)) next(bytes);
		},
	};
}

function wrap(channel: SshChannel): Channel {
	const out = stream();
	const err = stream();
	channel.onDataReceived((data) => {
		out.push(new Uint8Array(data));
		channel.adjustWindow(data.length);
	});
	channel.onExtendedDataReceived((event) => {
		err.push(new Uint8Array(event.data));
		channel.adjustWindow(event.data.length);
	});
	const closed = new Promise<{ exitStatus?: number; exitSignal?: string }>((resolve) => {
		channel.onClosed((event) => resolve({ exitStatus: event.exitStatus, exitSignal: event.exitSignal }));
	});
	return {
		onData: out.listen,
		onStderr: err.listen,
		send: (bytes) => channel.send(Buffer.from(typeof bytes === "string" ? new TextEncoder().encode(bytes) : bytes)),
		close: () => channel.close(),
		closed,
	};
}

/**
 * A duplex byte stream that carries the SSH bytes, open: the WebSocket to the relay
 * (`relayStream`), or a data channel to a paired computer. The SSH code after it is the same for both.
 */
export type Transport = {
	/** Sends bytes; settles when the transport took them (one that waits for room settles later). */
	write(bytes: Uint8Array): Promise<void>;
	/** Receives what the other end sends. Given once, as soon as the transport is open: bytes that arrive before are the transport's to keep. */
	onData(listener: (bytes: Uint8Array) => void): void;
	/**
	 * Settles when the transport ended, whoever ended it. With an error that says why when the
	 * transport knows (the relay's close code, the meeting's refusal): `connect` throws it when SSH
	 * could not get going, in place of the library's own error.
	 */
	ended: Promise<Error | undefined>;
	close(): void;
};

/** Opens a transport: what `connect` is given in place of an address. It throws when none can be had, with an error that says why. */
export type OpenStream = () => Promise<Transport>;

export type ConnectOptions = {
	/** Opens the stream that carries the SSH bytes. */
	open: OpenStream;
	user: string;
	key: CryptoKeyPair;
	/** The host key fingerprint the owner confirmed, `SHA256:...`. Any other key is refused. */
	hostFingerprint: string;
};

export type Connection = {
	/** Runs a command in an exec channel. */
	exec(command: string): Promise<Channel>;
	/** A direct-tcpip channel to a port as the server reaches it. */
	forward(host: string, port: number): Promise<Channel>;
	close(): Promise<void>;
	/** Settles when the connection ended, whoever ended it: the relay, the network, the server or `close()`. */
	closed: Promise<void>;
};

/**
 * The relay's WebSocket closed before SSH got going. `code` is the relay's close code
 * (web/relay/src/relay.ts `CLOSE`), or 0 when the WebSocket never opened: the relay refused it
 * (a private address, a name with no address, too many connections) or could not be reached, and a
 * browser is not told which.
 */
export class RelayClosed extends Error {
	readonly code: number;
	constructor(code: number, reason: string) {
		super(reason || (code ? `The relay closed the connection (${code}).` : "The relay did not open a connection."));
		this.name = "RelayClosed";
		this.code = code;
	}
}

/**
 * The way to a paired computer could not be opened: no computer waits at the meeting service under
 * its id ("absent"), the computer is there but no direct connection could be made from this network
 * ("no-path"), or the meeting service is over its limits ("limits"). Thrown by the peer transport's
 * opener (peer.ts); the bridge tells the owner each in words of its own.
 */
export class PeerClosed extends Error {
	readonly reason: "absent" | "no-path" | "limits";
	constructor(reason: "absent" | "no-path" | "limits", message?: string) {
		super(message ?? `The way to the paired computer could not be opened (${reason}).`);
		this.name = "PeerClosed";
		this.reason = reason;
	}
}

/** Why a connection was refused: a host key other than the one confirmed, or a key not authorised. */
export class SshRefused extends Error {
	readonly reason: "host-key" | "not-authorized";
	/** With "host-key": the fingerprint of the key the server showed. */
	readonly hostFingerprint?: string;

	constructor(reason: "host-key" | "not-authorized", message: string, hostFingerprint?: string) {
		super(message);
		this.name = "SshRefused";
		this.reason = reason;
		this.hostFingerprint = hostFingerprint;
	}
}

/** The relay's WebSocket, open. A relay that never answers counts as one that did not open it: a browser has no time limit of its own for this. */
function openSocket(url: string, ms: number): Promise<WebSocket> {
	return new Promise((resolve, reject) => {
		const socket = new WebSocket(url);
		socket.binaryType = "arraybuffer";
		const timer = setTimeout(() => {
			socket.close();
			reject(new RelayClosed(0, `The relay did not open a connection within ${Math.round(ms / 1000)} seconds.`));
		}, ms);
		socket.onopen = () => {
			clearTimeout(timer);
			resolve(socket);
		};
		socket.onerror = () => {
			clearTimeout(timer);
			reject(new RelayClosed(0, ""));
		};
	});
}

/**
 * The WebSocket to the relay at `url` as a transport. `openMs`: how long the relay has to open
 * it; none: 20 seconds (the tests make it short). It ends with `RelayClosed` when the relay closed
 * it with a code of its own (4000 and up), which says why.
 */
export function relayStream(url: string, openMs = 20_000): OpenStream {
	return async () => {
		const socket = await openSocket(url, openMs);
		let listener: ((bytes: Uint8Array) => void) | undefined;
		socket.onmessage = (e) => listener?.(new Uint8Array(e.data as ArrayBuffer));
		const ended = new Promise<Error | undefined>((resolve) => {
			socket.addEventListener("close", (e) => resolve(e.code >= 4000 ? new RelayClosed(e.code, e.reason) : undefined));
		});
		return {
			write: async (bytes) => socket.send(bytes as Uint8Array<ArrayBuffer>),
			onData: (next) => void (listener = next),
			ended,
			close: () => socket.close(),
		};
	};
}

/** A transport in the library's terms. */
class TransportStream extends BaseStream {
	private readonly transport: Transport;

	constructor(transport: Transport) {
		super();
		this.transport = transport;
		transport.onData((bytes) => this.onData(Buffer.from(bytes)));
		void transport.ended.then(() => {
			this.onEnd();
			this.fireOnClose();
		});
	}

	async write(data: Buffer): Promise<void> {
		await this.transport.write(new Uint8Array(data));
	}

	async close(): Promise<void> {
		this.transport.close();
	}

	dispose(): void {
		this.transport.close();
		super.dispose();
	}
}

/**
 * An SSH connection over the transport `options.open` opens. The server's host key is checked against the confirmed
 * fingerprint before anything of ours is sent: on a mismatch the browser's key is never offered.
 */
export async function connect(options: ConnectOptions): Promise<Connection> {
	const config = new SshSessionConfiguration();
	config.publicKeyAlgorithms.splice(0, config.publicKeyAlgorithms.length, new Ed25519Algorithm());
	const session = new SshClientSession(config);
	let seen: string | undefined;
	session.onAuthenticating((event) => {
		if (event.authenticationType !== SshAuthenticationType.serverPublicKey || !event.publicKey) return;
		const hostKey = event.publicKey;
		event.authenticationPromise = (async () => {
			const blob = await hostKey.getPublicKeyBytes();
			seen = blob ? await fingerprint(new Uint8Array(blob)) : undefined;
			return seen === options.hostFingerprint ? {} : null;
		})();
	});
	const transport = await options.open();
	// Why the transport ended, if it did and knows: read when the session fails, so that its reason is said.
	let why: Error | undefined;
	const closed = new Promise<void>((resolve) => {
		void transport.ended.then((error) => {
			why = error;
			resolve();
		});
		session.onClosed(() => resolve());
	});
	try {
		await session.connect(new TransportStream(transport));
		if (!(await session.authenticateServer())) {
			throw new SshRefused("host-key", `The server's host key is ${seen ?? "unknown"}, not the confirmed ${options.hostFingerprint}.`, seen);
		}
		if (!(await session.authenticateClient({ username: options.user, publicKeys: [new Ed25519Key(options.key)] }))) {
			throw new SshRefused("not-authorized", `The server did not accept this browser's key for ${options.user}: add its public key to ~/.ssh/authorized_keys there.`);
		}
	} catch (error) {
		await session.close(SshDisconnectReason.byApplication).catch(() => {});
		transport.close();
		if (!(error instanceof SshRefused) && why) throw why;
		throw error;
	}
	return {
		async exec(command) {
			const channel = await session.openChannel();
			const request = new CommandRequestMessage();
			request.command = command;
			request.wantReply = true;
			const wrapped = wrap(channel);
			if (!(await channel.request(request))) {
				await channel.close();
				throw new Error(`The server refused to run ${command}. Check that the account there may run commands (no forced command or "restrict" on this key in ~/.ssh/authorized_keys) and that pine is installed there.`);
			}
			return wrapped;
		},
		async forward(host, port) {
			const message = new PortForwardChannelOpenMessage();
			message.channelType = "direct-tcpip";
			message.host = host;
			message.port = port;
			message.originatorIPAddress = "127.0.0.1";
			message.originatorPort = 0;
			return wrap(await session.openChannel(message));
		},
		async close() {
			await session.close(SshDisconnectReason.byApplication);
			transport.close();
		},
		closed,
	};
}
