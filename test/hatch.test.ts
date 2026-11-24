import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { NO_MODEL } from "../src/agents.ts";
import { INTRODUCE, introducedKey } from "../src/hatch.ts";
import { type Harness, harness, rawTextOf, until } from "./support/harness.ts";

// Agents introduce themselves once (src/hatch.ts), in their answer to the owner's first message.
// No agent writes first.

const owner = { trust: "owner" as const };
const introduce = { defaults: { introduce: true } };
/** What the model was sent in a request, notes included (the harness strips them from `body`). */
const sent = (req: any) => (req.wire ?? req.body).messages.map((m: any) => rawTextOf(m.content)).join("\n");
/** What the owner's message of a request said, its note included: the history repeats older notes. */
const last = (req: any) => rawTextOf((req.wire ?? req.body).messages.at(-1).content);
const told = (h: Harness, words: string) => h.mock.state.requests.filter((r: any) => last(r).includes(words)).length;
const tmp = (t: { after(fn: () => void): void }, name: string) => {
	const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), name)));
	t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
	return dir;
};

test("no agent writes first: the main agent introduces itself in its answer to the owner's first message, once", async () => {
	const h = await harness({ pine: introduce, agents: { main: {} } });
	await h.restart();
	await new Promise((r) => setTimeout(r, 200));
	assert.equal(h.pine.tasks.list({ agent: "main" }).length, 0, "pine started no turn by itself");
	assert.equal(h.mock.state.requests.length, 0, "and sent the model nothing");

	await h.pine.agents.run({ agent: "main", session: "main", prompt: "FIRST hi", ...owner });
	const intro = h.mock.state.requests.filter((r: any) => last(r).includes(INTRODUCE));
	assert.equal(intro.length, 1);
	assert.ok(last(intro[0]).includes("FIRST hi"), "said in front of the owner's message");
	assert.ok(h.pine.agents.kv.get(introducedKey("main")), "it has met its owner");

	await h.restart();
	await h.pine.agents.run({ agent: "main", session: "main", prompt: "SECOND hi", ...owner });
	assert.equal(told(h, INTRODUCE), 1, "once");
	await h.close();
});

test("an agent that answered its owner before this existed does not introduce itself", async () => {
	const h = await harness({ agents: { main: {}, books: {} } });
	await h.pine.agents.run({ agent: "main", session: "main", prompt: "hello", ...owner });
	await h.pine.agents.run({ agent: "books", session: "main", prompt: "hello", ...owner });
	fs.writeFileSync(path.join(h.home, "pine.json"), JSON.stringify({ ...JSON.parse(fs.readFileSync(path.join(h.home, "pine.json"), "utf8")), defaults: { model: "mock/m", mode: "safe", introduce: true } }));
	await h.restart();
	assert.ok(h.pine.agents.kv.get(introducedKey("main")) && h.pine.agents.kv.get(introducedKey("books")));
	await h.pine.agents.run({ agent: "books", session: "other", prompt: "and again", ...owner });
	assert.equal(told(h, INTRODUCE), 0);
	await h.close();
});

test("another agent introduces itself in its answer to the owner's first message; an event from outside and a failure do not count", async () => {
	const h = await harness({ pine: introduce, agents: { main: {}, books: { agent: { description: "Keeps the books" } } } });

	// An event from outside wakes it first: no introduction to a stranger, and it has met nobody.
	await h.pine.agents.run({ agent: "books", session: "main", prompt: "a mail arrived", trust: "untrusted", kind: "event" });
	assert.equal(told(h, INTRODUCE), 0);
	assert.equal(h.pine.agents.kv.get(introducedKey("books")), undefined);

	// The owner's first message, but the model fails: it is said again with the next one.
	h.mock.state.failNext.push({ status: 400 });
	assert.equal((await h.pine.agents.run({ agent: "books", session: "main", prompt: "FIRST hello", ...owner })).status, "failed");
	assert.equal(h.pine.agents.kv.get(introducedKey("books")), undefined);

	await h.pine.agents.run({ agent: "books", session: "main", prompt: "SECOND hello", ...owner });
	const intro = h.mock.state.requests.filter((r: any) => sent(r).includes(INTRODUCE));
	assert.ok(intro.length >= 1 && sent(intro.at(-1)).includes("SECOND hello"));
	assert.ok(h.pine.agents.kv.get(introducedKey("books")));
	const before = told(h, INTRODUCE);
	await h.pine.agents.run({ agent: "books", session: "other", prompt: "THIRD hello", ...owner });
	assert.equal(told(h, INTRODUCE), before, "once per agent, not per conversation");

	// Switched off: a new agent does not introduce itself.
	h.pine.cfg.defaults.introduce = false;
	await h.pine.agents.run({ agent: "main", session: "x", prompt: "hi", ...owner });
	assert.equal(told(h, INTRODUCE), before);
	await h.close();
});

test("a new home has no model: an agent says so instead of answering, and pine starts all the same", async () => {
	const h = await harness({ pine: { defaults: { model: undefined } }, agents: { main: {} }, start: false });
	fs.writeFileSync(path.join(h.home, "models.json"), JSON.stringify({ providers: {} }));
	await h.restart();
	assert.equal(h.pine.cfg.defaults.model, undefined);
	assert.equal((await h.pine.agents.modelProblems()).main, NO_MODEL);
	const run = await h.pine.agents.run({ agent: "main", session: "main", prompt: "hello?", ...owner });
	assert.equal(run.status, "failed");
	assert.match(run.error ?? "", /No model yet/);
	await h.close();
});

test("where the agents' model cannot answer, pine runs on one that can: at the start, and after a sign-in, and says which", async (t) => {
	// A new home: no model at all.
	const h = await harness({ pine: { http: { port: 0 }, defaults: { model: undefined, introduce: true } }, agents: { main: {} }, start: false });
	const file = path.join(h.home, "models.json");
	const models = JSON.parse(fs.readFileSync(file, "utf8"));
	models.providers.dev = { name: "claude -p", baseUrl: "http://127.0.0.1:9/v1", api: "openai-completions", apiKey: "none", models: [{ id: "claude-haiku", name: "Claude Haiku", contextWindow: 180000, maxTokens: 8192, input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }] };
	fs.writeFileSync(file, JSON.stringify(models));
	// No `claude` command: a model of the claude -p stand-in cannot answer here.
	const before = process.env.PATH;
	t.after(() => void (process.env.PATH = before));
	process.env.PATH = [tmp(t, "pine-path-"), "/usr/bin", "/bin", "/usr/sbin", "/sbin"].join(path.delimiter);

	await h.restart();
	await until(() => h.pine.cfg.defaults.model === "mock/m", 5000, "the one model that answers");
	assert.equal(JSON.parse(fs.readFileSync(path.join(h.home, "pine.json"), "utf8")).defaults.model, "mock/m", "kept in pine.json");
	assert.equal(h.pine.tasks.list({ agent: "main" }).length, 0, "and nobody is written to");

	// A default that answers is the owner's choice: a sign-in leaves it.
	const call = async (url: string, body?: unknown) => (await (await fetch(`http://127.0.0.1:${h.pine.http!.port}${url}`, { method: body ? "POST" : "GET", headers: { authorization: `Bearer ${h.pine.token}`, "content-type": "application/json" }, body: body ? JSON.stringify(body) : undefined })).json()) as any;
	const signIn = async () => {
		const { id } = await call("/models/login", { provider: "opencode", type: "api_key" });
		let view: any;
		await until(async () => (view = await call(`/models/login/${id}`)).question || view.done, 5000, "pi's question for the key");
		await call(`/models/login/${id}`, { answer: "sk-opencode-test-61377" });
		await until(async () => (view = await call(`/models/login/${id}`)).done, 5000, "the sign-in to end");
		return view;
	};
	assert.equal((await signIn()).chosen, undefined);
	assert.equal(h.pine.cfg.defaults.model, "mock/m");

	// One that cannot answer is replaced by the provider just signed in to.
	await call("/settings", { key: "defaults.model", value: "dev/claude-haiku" });
	await call("/models/logout", { provider: "opencode" });
	const view = await signIn();
	assert.match(view.chosen ?? "", /^opencode\//);
	assert.equal(h.pine.cfg.defaults.model, view.chosen);
	await call("/models/logout", { provider: "opencode" });
	await h.close();
});
