// The runs a turn's work is drawn in (`runs`, desktop/src/work-runs.ts): while a running turn is folded,
// its last lines slide as parts come, and a run of steps must keep its key so that what it holds
// (an open thought, a thought's scroll) is not drawn anew.
import assert from "node:assert/strict";
import { test } from "node:test";
import type { Part } from "../src/model.ts";
import { runs } from "../src/work-runs.ts";

const tool = (n: number): Part => ({ p: "tool", key: `t${n}`, tool: "bash", status: "ok", depth: 0 });
const words = (text: string): Part => ({ p: "words", text });

test("a run of steps keeps its key while the folded window slides over it", () => {
	const parts: Part[] = [words("first"), tool(1), tool(2), tool(3), tool(4), tool(5), tool(6), tool(7)];
	const keysOf = (all: Part[]) => {
		const from = Math.max(0, all.length - 6);
		const shown = runs(all, from);
		return shown.map((r) => r.key);
	};
	const before = keysOf(parts);
	const after = keysOf([...parts, tool(8)]);
	assert.deepEqual(after, before);
	// Words and the steps after them never share a key.
	const both = runs([words("a"), tool(1), words("b"), tool(2)], 0).map((r) => r.key);
	assert.equal(new Set(both).size, both.length);
	// The steps keep their places in the turn.
	assert.deepEqual(runs([...parts, tool(8)], 3).flatMap((r) => (r.steps ?? []).map((s) => s.at)), [3, 4, 5, 6, 7, 8]);
});
