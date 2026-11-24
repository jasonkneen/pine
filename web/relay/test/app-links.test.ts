// The statement file Android's App Links read (/.well-known/assetlinks.json): with it, a pairing
// link of this service opens the Pine app signed with the key it names, and the browser otherwise.
// It is served only where the configuration names that key's fingerprint (ANDROID_CERT_SHA256).
import assert from "node:assert/strict";
import { test } from "node:test";
import { site } from "../src/site.ts";

const FINGERPRINT = "14:6D:E9:83:C5:73:06:50:D8:EE:B9:95:2F:34:FC:64:16:A0:83:42:E6:1D:BE:A8:8A:04:96:B2:3F:CF:44:E5";
const ASSETS = { fetch: async () => new Response("not found", { status: 404 }) };
const handle = site({ relay: async () => assert.fail("no relay here"), upgrade: () => assert.fail("no meeting here") });
const get = (vars: Record<string, unknown>) =>
	handle(new Request("https://pine.example/.well-known/assetlinks.json"), { ASSETS, LIMITER: { limit: async () => ({ success: true }) }, RELAY: "on", ...vars } as any);

test("with the release key's fingerprint, the statement names the Pine app and that key, for every link of the service", async () => {
	const r = await get({ ANDROID_CERT_SHA256: FINGERPRINT });
	assert.equal(r.status, 200);
	assert.match(r.headers.get("content-type") ?? "", /^application\/json/);
	assert.deepEqual(await r.json(), [
		{
			relation: ["delegate_permission/common.handle_all_urls"],
			target: { namespace: "android_app", package_name: "dev.pmndre.pine", sha256_cert_fingerprints: [FINGERPRINT] },
		},
	]);
});

test("a fingerprint written in lower case or with spaces around it is the same key", async () => {
	const r = await get({ ANDROID_CERT_SHA256: ` ${FINGERPRINT.toLowerCase()}\n` });
	assert.deepEqual(((await r.json()) as any)[0].target.sha256_cert_fingerprints, [FINGERPRINT]);
});

test("without a fingerprint, or with one that is not a SHA-256 fingerprint, there is no statement: the link opens the browser", async () => {
	for (const value of [undefined, "", "on", FINGERPRINT.slice(3), FINGERPRINT.replace(/:/g, ""), `${FINGERPRINT},${FINGERPRINT}`]) {
		const r = await get(value === undefined ? {} : { ANDROID_CERT_SHA256: value });
		assert.equal(r.status, 404, String(value));
	}
});
