// `pine service` says the version of the daemon it hands on, not its own: the Pine app compares
// it with the pine it carries to say that an older one runs. Here the daemon that runs is a
// stand-in on this home's port that takes this home's token, so that its version can differ from
// the checkout's.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import type { AddressInfo } from "node:net";
import path from "node:path";
import { test } from "node:test";
import { harness, until } from "./support/harness.ts";

const CLI = path.resolve(import.meta.dirname, "../src/cli.ts");

/** A daemon that answers /health and, with the token, /status; `version` is what /status says, if anything. */
async function standIn(token: string, version: string | undefined) {
	const server = http.createServer((req, res) => {
		const send = (code: number, body: unknown) => res.writeHead(code, { "content-type": "application/json" }).end(JSON.stringify(body));
		if (req.url === "/health") return send(200, { ok: true });
		if (req.headers.authorization !== `Bearer ${token}`) return send(401, { error: "unauthorized" });
		if (req.url === "/status") return send(200, { agents: ["main"], ...(version === undefined ? {} : { version }) });
		send(404, { error: "not found" });
	});
	await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
	return { port: (server.address() as AddressInfo).port, close: () => new Promise<void>((r) => server.close(() => r())) };
}

/** Runs `pine service` and resolves with its one line, and with how it ended. */
async function service(home: string) {
	const child = spawn(process.execPath, [CLI, "service", "--home", home], { stdio: ["pipe", "pipe", "pipe"] });
	let out = "";
	child.stdout!.on("data", (d) => (out += d));
	const exit = new Promise<number | null>((r) => child.once("exit", (code) => r(code)));
	await until(() => out.includes("\n"), 10_000, "pine service to answer");
	return { said: JSON.parse(out.split("\n")[0]), exit: await exit };
}

const ownVersion = String(JSON.parse(fs.readFileSync(path.resolve(import.meta.dirname, "../package.json"), "utf8")).version);

for (const [what, version] of [["an older pine", "0.0.1"], ["a newer pine", "99.0.0"]] as const) {
	test(`pine service attached to ${what} says that daemon's version`, async () => {
		const daemon = await standIn("the-token", version);
		const h = await harness({ pine: { http: { port: daemon.port, token: "the-token" }, logLevel: "warn" }, agents: { main: {} }, start: false });
		try {
			const { said, exit } = await service(h.home);
			assert.equal(said.mode, "attached");
			assert.equal(said.version, version);
			assert.notEqual(said.version, ownVersion);
			assert.equal(exit, 0);
		} finally {
			await h.close();
			await daemon.close();
		}
	});
}

test("pine service attached to a pine too old to say its version says none, not its own", async () => {
	const daemon = await standIn("the-token", undefined);
	const h = await harness({ pine: { http: { port: daemon.port, token: "the-token" }, logLevel: "warn" }, agents: { main: {} }, start: false });
	try {
		const { said } = await service(h.home);
		assert.equal(said.mode, "attached");
		assert.equal("version" in said, false, `no version: ${JSON.stringify(said)}`);
	} finally {
		await h.close();
		await daemon.close();
	}
});

test("a daemon says its own version in /status", async () => {
	const h = await harness({ pine: { http: { port: 0 } }, agents: { main: {} } });
	try {
		const status = await (await fetch(`http://127.0.0.1:${h.pine.http!.port}/status`, { headers: { authorization: `Bearer ${h.pine.token}` } })).json();
		assert.equal(status.version, ownVersion);
	} finally {
		await h.close();
	}
});
