// What the meeting's tests stand in for: a computer with an Ed25519 key, and sockets that note what
// they were sent and how they were closed.
import { createHash, generateKeyPairSync, sign, type KeyObject } from "node:crypto";
import type { Plain } from "../src/meet.ts";

export const ORIGIN = "https://pine.example";

/** An SSH public key blob for an Ed25519 key: string "ssh-ed25519", string key (RFC 8709). */
function blobOf(raw: Buffer) {
	const name = Buffer.from("ssh-ed25519");
	const out = Buffer.alloc(4 + name.length + 4 + raw.length);
	out.writeUInt32BE(name.length, 0);
	name.copy(out, 4);
	out.writeUInt32BE(raw.length, 4 + name.length);
	raw.copy(out, 8 + name.length);
	return out;
}

/** A computer's key: its blob, its machine id, and a way to sign the meeting's challenge. */
export function computerKey() {
	const { publicKey, privateKey } = generateKeyPairSync("ed25519");
	const raw = Buffer.from(publicKey.export({ format: "jwk" }).x!, "base64url");
	const blob = blobOf(raw);
	const id = createHash("sha256").update(blob).digest("base64url");
	return { blob, id, privateKey, proof: (nonce: string, origin = ORIGIN, key: KeyObject = privateKey) => proofOf(blob, nonce, origin, key) };
}

function proofOf(blob: Buffer, nonce: string, origin: string, key: KeyObject) {
	const sig = sign(null, Buffer.from(`pine-meet-v1\n${nonce}\n${origin}`), key);
	return JSON.stringify({ t: "proof", key: blob.toString("base64"), sig: sig.toString("base64") });
}

/** A socket as the meeting sees it, which keeps what it was sent and how it was closed. */
export class Sock implements Plain {
	sent: any[] = [];
	closed: { code: number; reason: string } | null = null;
	send(text: string) {
		if (this.closed) throw new Error("sent on a closed socket");
		this.sent.push(JSON.parse(text));
	}
	close(code: number, reason: string) {
		this.closed ??= { code, reason };
	}
	last() {
		return this.sent.at(-1);
	}
	/** The first message of type `t`, waited for a little. */
	async got(t: string, ms = 1000) {
		const until = Date.now() + ms;
		for (;;) {
			const found = this.sent.find((m) => m.t === t);
			if (found) return found;
			if (Date.now() > until) throw new Error(`never got ${t}; got ${JSON.stringify(this.sent)}`);
			await new Promise((resolve) => setTimeout(resolve, 5));
		}
	}
	async closes(ms = 1000) {
		const until = Date.now() + ms;
		while (!this.closed) {
			if (Date.now() > until) throw new Error(`still open after ${ms} ms; got ${JSON.stringify(this.sent)}`);
			await new Promise((resolve) => setTimeout(resolve, 5));
		}
		return this.closed;
	}
}
