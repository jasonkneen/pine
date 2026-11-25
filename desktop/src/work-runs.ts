import type { Part } from "./model.ts";

/** A run of a turn's work: one thing said, or the steps taken between two things said. `at` is a part's place in the whole turn. */
export type Run = { key: string; words: Part; at: number; steps?: undefined } | { key: string; words?: undefined; steps: Array<{ part: Part; at: number }> };

/**
 * The turn's `parts` from `from` on, cut into runs of steps at what was said between them.
 * A run of words is keyed by its place in the turn (`w<at>`); a run of steps by the place of the
 * words before it, searched in the whole turn (`s<said>`, -1 when nothing was said before it).
 * Only words end a run of steps, so two runs never share that place, and a run keeps its key while
 * the window of a folded turn slides over its first steps: what it holds (an open thought, a
 * thought's scroll) is not drawn anew.
 */
export function runs(parts: Part[], from: number): Run[] {
	const out: Run[] = [];
	for (let at = from; at < parts.length; at++) {
		const part = parts[at];
		const last = out.at(-1);
		if (part.p === "words") out.push({ key: `w${at}`, at, words: part });
		else if (last?.steps) last.steps.push({ part, at });
		else out.push({ key: `s${saidBefore(parts, at)}`, steps: [{ part, at }] });
	}
	return out;
}

/** Where the last words before `at` stand in the turn, -1 when there are none. */
function saidBefore(parts: Part[], at: number): number {
	for (let i = at - 1; i >= 0; i--) if (parts[i].p === "words") return i;
	return -1;
}
