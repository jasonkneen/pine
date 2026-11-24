// What the access server keeps: this computer's SSH host key and the devices that were paired with it.
// It is one JSON text handed to a vault the caller gives: the app's vault encrypts it with the
// system's keychain and writes it into the app's own data folder; a test's keeps it in memory.
// No Electron here, so that it runs under plain Node.
import { createHash, generateKeyPairSync, randomBytes } from "node:crypto";
import ssh2 from "ssh2";

/** Where the kept text lies. Encryption is the vault's business. */
export interface Vault {
	load(): Promise<string | undefined>;
	save(text: string): Promise<void>;
}

/** A vault in memory, for tests and for the web client's smoke. */
export function memoryVault(): Vault & { text?: string } {
	const vault: Vault & { text?: string } = {
		load: async () => vault.text,
		save: async (text) => void (vault.text = text),
	};
	return vault;
}

/** A device that was paired: its key, the name it gave (plain text), and when. */
export interface Device {
	/** The SHA-256 of its public key blob in base64url: the same form as a machine id. */
	id: string;
	/** Its SSH public key blob, in base64. */
	key: string;
	name: string;
	/** When it was paired, as an ISO date. */
	paired: string;
	/** When it was last connected, as an ISO date. */
	seen?: string;
}

interface Kept {
	/** The host key, OpenSSH private key format. */
	hostKey: string;
	devices: Device[];
	/** The password of the owner's relay server: kept here, encrypted with the host key, and never in the app's preferences. */
	relayPassword?: string;
}

/** The SHA-256 of an SSH public key blob in base64url without padding: a machine id, or a device's id. */
export const keyId = (blob: Buffer) => createHash("sha256").update(blob).digest("base64url");

/** The longest name a device may give itself. */
export const NAME_LENGTH = 60;

/** A device's name as plain text: no control characters, and short enough to show in a list. */
export const cleanName = (name: string) => [...name.replace(/\u001b\[[0-9;?]*[ -/]*[@-~]/g, "").replace(/[\p{Cc}\p{Cf}]/gu, "")].slice(0, NAME_LENGTH).join("").trim();

const ED25519 = "ssh-ed25519";

const sshString = (data: Buffer | string) => {
	const bytes = typeof data === "string" ? Buffer.from(data, "latin1") : data;
	const length = Buffer.alloc(4);
	length.writeUInt32BE(bytes.length);
	return Buffer.concat([length, bytes]);
};
const uint32 = (n: number) => {
	const out = Buffer.alloc(4);
	out.writeUInt32BE(n);
	return out;
};

/**
 * A new Ed25519 key: the private key in OpenSSH's format, as ssh2 reads it, and the public key
 * blob. Made with Node's crypto and written out here, because ssh2's own generator drops a
 * leading zero byte of the public key (about one key in 128 comes out unreadable), and ssh2 does
 * not read Node's PKCS#8 export of an Ed25519 key.
 */
export function newEd25519Key(): { private: string; public: Buffer } {
	const jwk = generateKeyPairSync("ed25519").privateKey.export({ format: "jwk" });
	const seed = Buffer.from(jwk.d!, "base64url");
	const pub = Buffer.from(jwk.x!, "base64url");
	const blob = Buffer.concat([sshString(ED25519), sshString(pub)]);
	const check = randomBytes(4);
	let secret = Buffer.concat([check, check, sshString(ED25519), sshString(pub), sshString(Buffer.concat([seed, pub])), sshString("")]);
	const padding = (8 - (secret.length % 8)) % 8;
	secret = Buffer.concat([secret, Buffer.from(Array.from({ length: padding }, (_, i) => i + 1))]);
	const body = Buffer.concat([Buffer.from("openssh-key-v1\0", "latin1"), sshString("none"), sshString("none"), sshString(""), uint32(1), sshString(blob), sshString(secret)]);
	const lines = body.toString("base64").match(/.{1,70}/g)!.join("\n");
	return { private: `-----BEGIN OPENSSH PRIVATE KEY-----\n${lines}\n-----END OPENSSH PRIVATE KEY-----\n`, public: blob };
}

/** The algorithm named at the start of a public key blob. */
function algorithmOf(blob: Buffer): string | undefined {
	if (blob.length < 4) return undefined;
	const length = blob.readUInt32BE(0);
	if (length > blob.length - 4) return undefined;
	return blob.subarray(4, 4 + length).toString("latin1");
}

/** This computer's host key and its paired devices, read once and written through the vault on every change. */
export class AccessStore {
	private kept: Kept;
	private vault: Vault;
	private publicBlob: Buffer;

	private constructor(vault: Vault, kept: Kept) {
		this.vault = vault;
		this.kept = kept;
		const key = ssh2.utils.parseKey(kept.hostKey);
		if (key instanceof Error) throw new Error(`The access server's host key cannot be read: ${key.message}`);
		this.publicBlob = key.getPublicSSH();
	}

	/** Reads what the vault holds; makes the host key the first time, and keeps it at once. */
	static async open(vault: Vault): Promise<AccessStore> {
		const text = await vault.load();
		if (text !== undefined) {
			const kept = JSON.parse(text) as Kept;
			return new AccessStore(vault, { hostKey: kept.hostKey, devices: Array.isArray(kept.devices) ? kept.devices : [], ...(typeof kept.relayPassword === "string" && kept.relayPassword ? { relayPassword: kept.relayPassword } : {}) });
		}
		const store = new AccessStore(vault, { hostKey: newEd25519Key().private, devices: [] });
		await store.write();
		return store;
	}

	/** The host key in OpenSSH private key format, as ssh2's server takes it. */
	hostKey(): string {
		return this.kept.hostKey;
	}

	/** The SHA-256 fingerprint of the host key's public blob, in base64url: what a pairing link names. */
	machineId(): string {
		return keyId(this.publicBlob);
	}

	devices(): Device[] {
		return this.kept.devices.map((device) => ({ ...device }));
	}

	/** The paired device with exactly this public key blob. */
	find(blob: Buffer): Device | undefined {
		const id = keyId(blob);
		const device = this.kept.devices.find((d) => d.id === id && Buffer.from(d.key, "base64").equals(blob));
		return device && { ...device };
	}

	/** Pairs a device's Ed25519 key under a name. A key that is already paired keeps its entry and gets the new name. */
	async add({ key, name, now = new Date() }: { key: Buffer; name: string; now?: Date }): Promise<Device> {
		if (algorithmOf(key) !== ED25519) throw new Error("Only an Ed25519 key can be paired.");
		const id = keyId(key);
		const device: Device = { id, key: key.toString("base64"), name: cleanName(name), paired: now.toISOString() };
		this.kept.devices = [...this.kept.devices.filter((d) => d.id !== id), device];
		await this.write();
		return { ...device };
	}

	/** Forgets a device. Its live sessions are the server's to cut (`AccessServer.cut`). */
	async remove(id: string): Promise<boolean> {
		const before = this.kept.devices.length;
		this.kept.devices = this.kept.devices.filter((d) => d.id !== id);
		if (this.kept.devices.length === before) return false;
		await this.write();
		return true;
	}

	/** Notes when a device was last connected. */
	async seen(id: string, when = new Date()): Promise<void> {
		const device = this.kept.devices.find((d) => d.id === id);
		if (!device) return;
		device.seen = when.toISOString();
		await this.write();
	}

	/** The relay server's password, when one is kept. */
	relayPassword(): string | undefined {
		return this.kept.relayPassword;
	}

	/** Keeps the relay server's password, or forgets it (`undefined` or empty). */
	async setRelayPassword(password: string | undefined): Promise<void> {
		if ((password || undefined) === this.kept.relayPassword) return;
		if (password) this.kept.relayPassword = password;
		else delete this.kept.relayPassword;
		await this.write();
	}

	private write(): Promise<void> {
		return this.vault.save(JSON.stringify(this.kept));
	}
}
