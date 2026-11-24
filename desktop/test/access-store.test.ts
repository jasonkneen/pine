// What the access server keeps (electron/access/store.ts): this computer's host key and the paired
// devices, through a vault the caller hands in. The test's vault is memory; the app's encrypts.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";
import ssh2 from "ssh2";
import { AccessStore, keyId, memoryVault, newEd25519Key } from "../electron/access/store.ts";

/** A key pair as OpenSSH writes it. */
const ed25519 = () => {
	const made = newEd25519Key();
	return { private: made.private, public: `ssh-ed25519 ${made.public.toString("base64")}` };
};

const blobOf = (publicKey: string) => {
	const key = ssh2.utils.parseKey(publicKey);
	if (key instanceof Error) throw key;
	return key.getPublicSSH();
};

test("access store: a host key is made on first use and kept; the machine id is its SHA-256 in base64url", async () => {
	const vault = memoryVault();
	const store = await AccessStore.open(vault);
	const host = store.hostKey();
	const parsed = ssh2.utils.parseKey(host);
	assert.ok(!(parsed instanceof Error));
	assert.equal(parsed.type, "ssh-ed25519");
	const expected = createHash("sha256").update(parsed.getPublicSSH()).digest("base64url");
	assert.equal(store.machineId(), expected);
	assert.match(store.machineId(), /^[A-Za-z0-9_-]{43}$/);
	assert.ok(vault.text, "the key was handed to the vault");

	const again = await AccessStore.open(vault);
	assert.equal(again.machineId(), store.machineId(), "the same key the next time");
});

test("access store: every Ed25519 key it makes is one ssh2 reads and signs with, a leading zero byte included", () => {
	// ssh2's own generator gets about one key in 128 wrong: a thousand makes that certain to show.
	for (let i = 0; i < 1000; i++) {
		const made = newEd25519Key();
		const key = ssh2.utils.parseKey(made.private);
		assert.ok(!(key instanceof Error), `key ${i}: ${key instanceof Error ? key.message : ""}`);
		assert.equal(key.type, "ssh-ed25519");
		assert.ok(key.getPublicSSH().equals(made.public), `key ${i}: the public blob`);
		const data = Buffer.from(`data ${i}`);
		assert.equal(key.verify(data, key.sign(data) as Buffer), true);
	}
});

test("access store: a paired device is found by its key, and once removed it is not", async () => {
	const vault = memoryVault();
	const store = await AccessStore.open(vault);
	const phone = ed25519();
	const other = ed25519();
	const device = await store.add({ key: blobOf(phone.public), name: "Chrome on Android", now: new Date("2026-11-20T10:00:00Z") });
	assert.equal(device.id, keyId(blobOf(phone.public)));
	assert.equal(device.name, "Chrome on Android");
	assert.equal(device.paired, "2026-11-20T10:00:00.000Z");
	assert.equal(store.find(blobOf(phone.public))?.id, device.id);
	assert.equal(store.find(blobOf(other.public)), undefined);

	const reopened = await AccessStore.open(vault);
	assert.deepEqual(reopened.devices(), [device], "the list is kept");

	assert.equal(await reopened.remove(device.id), true);
	assert.equal(reopened.find(blobOf(phone.public)), undefined);
	assert.deepEqual((await AccessStore.open(vault)).devices(), []);
});

test("access store: only Ed25519 keys are paired, and a name is plain text of 60 characters at most", async () => {
	const store = await AccessStore.open(memoryVault());
	const rsa = ssh2.utils.generateKeyPairSync("ecdsa", { bits: 256 });
	await assert.rejects(store.add({ key: blobOf(rsa.public), name: "x" }));
	const phone = ed25519();
	const device = await store.add({ key: blobOf(phone.public), name: `a\u001b[31mb\n${"c".repeat(100)}` });
	assert.equal(device.name, `ab${"c".repeat(58)}`);
});

test("access store: when a device was last seen is kept", async () => {
	const vault = memoryVault();
	const store = await AccessStore.open(vault);
	const phone = ed25519();
	const device = await store.add({ key: blobOf(phone.public), name: "phone" });
	await store.seen(device.id, new Date("2026-11-21T08:00:00Z"));
	assert.equal((await AccessStore.open(vault)).devices()[0].seen, "2026-11-21T08:00:00.000Z");
});
