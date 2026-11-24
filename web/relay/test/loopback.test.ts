// The one way the relay reaches this computer: `RELAY_ALLOW_LOOPBACK`, which only the web client's
// smoke sets, on the command line of `wrangler dev`. It opens the loopback and nothing else, only
// for a relay that is itself served on the loopback, and no configuration that is deployed sets it.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { relay } from "../src/relay.ts";
import { limiter, names, pairs } from "./support.ts";

/** A request for the relay, as a browser opens it from the deployment at `origin`. */
const ask = (origin: string, host: string) => new Request(`${origin}/ssh?host=${encodeURIComponent(host)}&port=2222`, { headers: { Upgrade: "websocket", "CF-Connecting-IP": "127.0.0.1" } });

async function tried(origin: string, host: string, allow?: string) {
	const { clients, upgrade } = pairs();
	const handle = relay({
		connect: () => {
			throw new Error("not reached in this test");
		},
		resolve: names({ localhost: ["127.0.0.1"] }),
		upgrade,
		timeoutMs: 1000,
	});
	const response = await handle(ask(origin, host), { LIMITER: limiter(), RELAY_ALLOW_LOOPBACK: allow });
	for (const client of clients) client.end.close(1000);
	return response.status === 403 ? "refused" : clients.length === 1 ? "let through" : `status ${response.status}`;
}

test("with the switch, a relay served on the loopback reaches the loopback", async () => {
	for (const origin of ["http://127.0.0.1:8787", "http://localhost:8787", "http://[::1]:8787"]) {
		for (const host of ["127.0.0.1", "::1", "localhost"]) assert.equal(await tried(origin, host, "1"), "let through", `${origin} -> ${host}`);
	}
});

test("the switch opens nothing but the loopback", async () => {
	for (const host of ["10.0.0.5", "192.168.1.10", "169.254.169.254", "fd12::1", "0.0.0.0", "104.16.0.1"]) {
		assert.equal(await tried("http://127.0.0.1:8787", host, "1"), "refused", host);
	}
});

test("the switch does nothing for a relay served under any other name", async () => {
	for (const origin of ["https://pine.example", "https://pine-main.someone.workers.dev", "https://pine-pr-12.someone.workers.dev", "http://198.51.100.7:8787"]) {
		assert.equal(await tried(origin, "127.0.0.1", "1"), "refused", origin);
	}
});

test("without the switch, or with another value, the loopback stays refused", async () => {
	for (const allow of [undefined, "", "0", "true", "yes"]) assert.equal(await tried("http://127.0.0.1:8787", "127.0.0.1", allow), "refused", String(allow));
});

test("the configuration that is deployed never sets the switch", () => {
	const config = readFileSync(path.join(import.meta.dirname, "..", "wrangler.jsonc"), "utf8");
	assert.doesNotMatch(config, /RELAY_ALLOW_LOOPBACK/);
	for (const file of [".dev.vars", ".env"]) {
		let text = "";
		try {
			text = readFileSync(path.join(import.meta.dirname, "..", file), "utf8");
		} catch {}
		assert.doesNotMatch(text, /RELAY_ALLOW_LOOPBACK/, file);
	}
});
