import assert from "node:assert/strict";
import { test } from "node:test";
import { classify } from "../src/actions.ts";
import { harness, mockMsg, until } from "./support/harness.ts";

const owner = { trust: "owner" as const };
const call = (name: string, args: any = {}) => ({ name, args });

test("board_remove: a board of the conversation goes without a question, one that others use only after the owner's yes", async () => {
	const h = await harness({ agents: { main: {}, helper: {} } });
	const asked: any[] = [];
	let answer = false;
	h.pine.bus.subscribe("approval/requested", (e) => {
		asked.push(e.payload);
		h.pine.approvals.decide((e.payload as any).id, answer, "test");
	});
	const boards = h.pine.agents.boards;
	const names = () => boards.list().map((b) => `${b.scope}:${b.agent}:${b.name}`);
	await h.pine.agents.run({
		agent: "main",
		prompt: mockMsg([{ tools: [call("board_post", { type: "task", text: "own" }), call("board_post", { type: "note", board: "scratch", scope: "local", text: "n" }), call("board_post", { board: "kept", scope: "agent", type: "task", text: "a" }), call("board_post", { type: "note", board: "all", scope: "global", text: "c" })] }]),
		...owner,
	});
	assert.deepEqual(names(), ["local:main:", "local:main:scratch", "agent:main:kept", "global::all"]);

	// The conversation's own boards: removed, nobody asked.
	let r = await h.pine.agents.run({ agent: "main", prompt: mockMsg([{ tools: [call("board_remove"), call("board_remove", { board: "scratch" })] }]), ...owner });
	assert.match(r.text, /The board of this conversation is removed, with 1 task and 0 notes\./);
	assert.match(r.text, /The board "scratch" \(of this conversation\) is removed, with 0 tasks and 1 note\./);
	assert.equal(asked.length, 0);
	assert.deepEqual(names(), ["agent:main:kept", "global::all"]);

	// One that every conversation of the agent uses: put to the owner, and a no keeps it.
	r = await h.pine.agents.run({ agent: "main", prompt: mockMsg([{ tools: [call("board_remove", { board: "kept" })] }]), ...owner });
	assert.equal(asked.length, 1);
	assert.equal(asked[0].tool, "board_remove");
	assert.match(asked[0].summary, /^remove the board "kept" \(of main, in all of the agent's conversations\) with everything on it\n1 open/);
	assert.match(r.text, /not removed \(test\)\. Do not retry; tell your owner\./);
	assert.deepEqual(names(), ["agent:main:kept", "global::all"]);

	// One task of it, with a yes.
	answer = true;
	const task = boards.items(boards.find("agent", "main", "", "kept")!.id)[0];
	r = await h.pine.agents.run({ agent: "main", prompt: mockMsg([{ tools: [call("board_remove", { board: "kept", id: task.id })] }]), ...owner });
	assert.match(asked.at(-1).summary, new RegExp(`^remove task #${task.id} from the board "kept"`));
	assert.match(r.text, new RegExp(`Your owner confirmed it\\. Task #${task.id} is removed from the board "kept" .*, with the notes about it\\.`));
	assert.equal(boards.item(task.id), undefined);

	// A board for all agents: only the main agent's to remove, and another agent is not even asked about.
	const before = asked.length;
	r = await h.pine.agents.run({ agent: "helper", prompt: mockMsg([{ tools: [call("board_remove", { board: "all" })] }]), ...owner });
	assert.match(r.text, /Only the main agent \(main\) can remove a board for all agents/);
	assert.equal(asked.length, before);
	r = await h.pine.agents.run({ agent: "main", prompt: mockMsg([{ tools: [call("board_remove", { board: "all" }), call("board_remove", { board: "nope" })] }]), ...owner });
	assert.match(r.text, /Your owner confirmed it\. The board "all" \(for all agents\) is removed/);
	assert.match(r.text, /there is no board "nope" that you can use/);
	assert.deepEqual(names(), ["agent:main:kept"]);
	await h.close();
});

test("board_remove: a sub-agent and a run from outside are never given it, and a call to it is never only a look", async () => {
	const h = await harness({ agents: { main: {}, open: { agent: { untrusted: { tools: ["read"], board: true } } } } });
	h.mock.state.scripts.sub = [{ tools: [call("pine_board", { action: "board_remove" })] }];
	// A sub-agent is declared what its conversation is (for the model server's cache), and is told it is not its to do.
	const r = await h.pine.agents.run({ agent: "main", prompt: mockMsg([{ tools: [call("board_post", { type: "note", text: "keep me" }), call("subagent", { tasks: ["@@REF:sub@@"] })] }]), ...owner });
	assert.match(r.text, /You are a sub-agent: this is not yours to do/);
	assert.equal(h.pine.agents.boards.list().length, 1);
	await h.pine.agents.run({ agent: "open", prompt: mockMsg([{ tools: [call("board_post", { type: "note", text: "x" }), call("board_remove")] }]), trust: "untrusted" });
	const outside = h.mock.state.requests.at(-1);
	assert.ok(h.toolsOffered(outside).includes("board_post") && !h.toolsOffered(outside).includes("board_remove"), "a run from outside has a board, but not this");
	assert.equal(h.pine.agents.boards.list().length, 2, "its board is still there");

	// It cannot be undone: a call to it is never just a look, whatever board it names (asked in manual mode, refused in plan mode).
	const ctx: any = { sends: false };
	assert.equal(classify("board_remove", {}, ctx).cls, "local");
	assert.equal(classify("board_remove", { board: "kept", id: 3 }, ctx).cls, "local");
	await h.close();
});

test("board_remove: a pool's sub-agent at work on what goes is stopped, by the tool and by the owner's hand", async () => {
	const h = await harness({ pine: { limits: { maxConcurrentRuns: 4 } }, agents: { main: { agent: { subagents: { maxParallel: 2 } } } } });
	const boards = h.pine.agents.boards;
	h.mock.state.scripts.asks = [{ tools: [call("board_done", { id: 1, outcome: "blocked", result: "WHICH?" })] }, { text: "stopped" }];
	h.mock.state.scripts.long = [{ delayMs: 20_000, text: "never" }];
	// The pool comes back with the question while the other sub-agent works on; the conversation removes its board.
	const r = await h.pine.agents.run({
		agent: "main",
		session: "job",
		prompt: mockMsg([{ tools: [call("subagent", { pool: true, tasks: ["first @@REF:asks@@", "second @@REF:long@@"] })] }, { tools: [call("board_remove")] }]),
		...owner,
	});
	assert.match(r.text, /The board of this conversation is removed, with 2 tasks/);
	const worker = () => h.pine.tasks.list({ limit: 50 }).find((t) => t.meta.boardTask === 2)!;
	await until(() => worker().status === "cancelled", 5000, "the sub-agent of the removed task to be stopped");
	assert.equal(boards.list().length, 0);

	// The owner's hand on a whole board does the same.
	h.mock.state.scripts.asks2 = [{ tools: [call("board_done", { id: 3, outcome: "blocked", result: "WHICH?" })] }, { text: "stopped" }];
	const run = h.pine.agents.submit({ agent: "main", session: "job2", prompt: mockMsg([{ tools: [call("subagent", { pool: true, tasks: ["third @@REF:asks2@@", "fourth @@REF:long@@"] })] }, { text: "seen" }]), ...owner });
	await h.pine.agents.wait(run.id);
	const fourth = () => h.pine.tasks.list({ limit: 50 }).find((t) => t.meta.boardTask === 4)!;
	assert.equal(fourth().status, "running");
	h.pine.agents.boardRemove(boards.find("local", "main", "job2", "")!.id);
	await until(() => fourth().status === "cancelled", 5000, "the owner's removal to stop the sub-agent");
	await h.close();
});
