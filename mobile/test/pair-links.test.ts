// The page's reading of a pairing link (desktop/src/machines.ts `readPairLink`, which the mobile
// bridge checks before the plugin is asked) replays the cases both native cores replay, so that the
// page never offers a link the core refuses, nor names a service the core does not use.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { httpService, otherService, readPairLink } from "../../desktop/src/machines.ts";

const file = JSON.parse(readFileSync(new URL("../cases/pair-links.json", import.meta.url), "utf8")) as {
	cases: Array<{ name: string; input: string | null; expect: null | { service: string; host: string; official: boolean; id: string; code: string } }>;
};

for (const c of file.cases) {
	test(`pair-links: ${c.name}`, () => {
		const read = c.input === null ? undefined : readPairLink(c.input);
		if (c.expect === null) return assert.equal(read, undefined);
		assert.ok(read, "read");
		const other = otherService(read);
		assert.deepEqual({ service: read.service, host: other ?? new URL(read.service).host, official: other === undefined, id: read.id, code: read.code }, c.expect);
	});
}

// A link whose service is on http (the web client of a test deployment offers the app one) is
// refused like any other, and the page can name that service to say why, plainly.
test("pair-links: a service on http is named, so that the refusal can say why", () => {
	const id = "EKN2VkO6uLv7SOTEAyIGDru_1I_cTOGadqwTlLFm-qs";
	const code = "a1B2c3D4e5F6g7H8i9-_Jk";
	assert.equal(httpService(`pine://pair?service=http%3A%2F%2F127.0.0.1%3A8787&id=${id}&code=${code}`), "127.0.0.1:8787");
	assert.equal(httpService(`http://pine.example.com/#pair=${id}.${code}`), "pine.example.com");
	for (const other of [`pine://pair?service=https%3A%2F%2Fpine.example.com&id=${id}&code=${code}`, `https://pine.example.com/#pair=${id}.${code}`, `pine://pair?service=javascript%3Aalert(1)&id=${id}&code=${code}`, "", "not a link", "pine://pair?service=%zz"])
		assert.equal(httpService(other), undefined, other);
});
