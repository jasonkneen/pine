// `pine/view`: what a view imports. A view is a script of the owner's in <home>/views that draws pine
// in the panel of the Pine app (docs/references/views.md). It is written against this module:
//
//   import { defineView, seeded } from "pine/view";
//   export default defineView((host) => { ... });
//
// This one file is both sides of that import. The app's view frame resolves "pine/view" to it at run
// time, and pine copies it as it is into <home>/views/.pine/view.ts, where views/tsconfig.json points
// the owner's editor at it. So it holds only types, `defineView` and helpers that need nothing but the
// language: no Node, no DOM, no import.
//
// What a view is told is the shape of pine and nothing of its content: which agents there are and how
// they work, what each piece of work is doing and where it came from, which tools, MCP servers, skills
// and sources are in use, and how the boards stand. Never a prompt, an answer, a tool's arguments, a path, a conversation's name
// or what an event said. A view can draw all of pine and read none of it.

/** An agent, as a view knows it. */
export interface ViewAgent {
	id: string;
	/** The agent the owner talks to first, which runs pine. */
	main: boolean;
	/** Its color, as #rrggbb. */
	color: string;
	/** How it works: "manual", "safe" (a sandbox), "auto" (the owner's account), "bypass" (asks nothing), "plan". */
	mode: string;
	/** The names of the MCP servers it has, of the skills it has, of the event sources it listens to, of its schedules. */
	mcp: string[];
	skills: string[];
	sources: string[];
	schedules: string[];
	/** Its conversations with the owner: the main one first, then the one used last. Their shape, never their names. */
	conversations: ViewConversation[];
}

/** A conversation of an agent, as a view knows it: a number and its shape. */
export interface ViewConversation {
	/** A number for it, the same for as long as the panel is open. */
	id: number;
	/** The agent's main conversation. */
	main: boolean;
	/** A branch: the number of the conversation it was branched from. */
	branchOf?: number;
	/** It works in a worktree: a checkout of its own of its folder's repository, on a git branch of its own. */
	worktree: boolean;
	/** Work runs in it now. */
	busy: boolean;
	/** It has read content from outside. */
	outside: boolean;
	/** It has a goal (goal mode), and where that stands. */
	goal?: "active" | "paused" | "met" | "blocked" | "limit";
	/**
	 * It has a swarm (its agent leads a job that sub-agents work through on the conversation's board), and where that
	 * stands: "active" while it works, "waiting" for the owner's answer, "done", "paused", or at its "limit" of
	 * rounds. `round` of `until` is the lead's turn it is in; `checking` while a sub-agent checks the lead's answer.
	 */
	swarm?: { status: "active" | "waiting" | "done" | "paused" | "limit"; round: number; until: number; checking: boolean };
}

/** Where a piece of work came from. */
export type ViewFrom =
	| { k: "you" }
	| { k: "clock"; name?: string }
	| { k: "source"; name: string }
	| { k: "outside"; name: string }
	| { k: "agent"; id: string }
	| { k: "copy"; id: string }
	| { k: "pine" };

/** What a piece of work is doing. */
export type ViewDoing = "thinking" | "tool" | "writing" | "waiting" | "asking" | "done" | "failed" | "cancelled";

/** A piece of work: a task an agent does. Times are the page's clock, in milliseconds. */
export interface ViewWork {
	id: number;
	agent: string;
	/** A copy of the agent at work for its conversation (a sub-agent). */
	copy: boolean;
	/** The work that started it, if any, and how deep it is under the work the owner or an event started. */
	parent?: number;
	depth: number;
	from: ViewFrom;
	doing: ViewDoing;
	/** The tool it is in, while it is in one: its name only. */
	tool?: string;
	/** The MCP server of that tool, for a tool of an MCP server. */
	mcp?: string;
	/** The agents and copies it waits for, by their work's id. */
	waitingOn: number[];
	started: number;
	finished?: number;
	tools: number;
	/** Its last tool calls, the newest last (a dozen at most): names, times and how each went, never what a call was about. */
	calls?: ViewCall[];
	/** It waits for the owner's answer. */
	asking: boolean;
	/** The mode it runs in now, and whether that is stricter than its agent's own (handed on from a stricter mode). */
	mode?: string;
	held: boolean;
	/** Its conversation read content from outside: from now on, sending something out asks the owner. */
	outside: boolean;
	/** The conversation it runs in or for (`ViewConversation.id`), where it is one of the owner's. */
	conversation?: number;
	/** That conversation is a branch of another; it works in a worktree. */
	branch: boolean;
	worktree: boolean;
	/** The skill it is reading now, for a skill its agent has: its name. */
	skill?: string;
	/** Its to-do list, once it keeps one: how many steps are done, of how many. */
	steps?: { done: number; total: number };
	/** The round of its conversation's goal it is (goal mode: pine calls the agent again until the goal is met). */
	round?: number;
	/** The board whose task it has taken (`ViewBoard.id`), while it has one. */
	board?: number;
	/** Its part in its conversation's swarm: "lead" for a turn of the agent that leads it, "check" for the sub-agent that checks the lead's answer. */
	swarm?: "lead" | "check";
}

/**
 * A task of a board: its number, where it stands, what it comes after and who has it. Never what it says.
 */
export interface ViewTask {
	/** Its number on the board, which is also its place in the order the tasks were posted in. */
	id: number;
	/**
	 * Where it stands. "open": anyone can take it. "waiting": it comes after tasks that are not done yet.
	 * "taken": somebody works on it. "blocked": its worker asked a question and it waits for the answer.
	 */
	state: "open" | "waiting" | "taken" | "blocked" | "done" | "failed";
	/** The tasks it comes after (their numbers): a check comes after the work it checks. */
	after: number[];
	/** The piece of work that has it (`ViewWork.id`) and that work's agent, while somebody has it. */
	worker?: number;
	agent?: string;
	/** Who put it on the board: an agent's id, or "you". */
	by?: string;
	/** When it was posted, and since when it stands as it does now (taken, done, waiting for an answer). */
	posted?: number;
	since?: number;
	/** How many notes are about it. */
	notes?: number;
	/** It asked something: "open" while it waits for the answer, "answered" once it had one. */
	asked?: "open" | "answered";
	/** It was posted by work that had read outside content. */
	outside?: boolean;
}

/**
 * A board: the tasks of a job that several work on at once, an agent and its sub-agents or several
 * agents. A view is told where each task stands and who works on it, never what a task or a note says.
 */
export interface ViewBoard {
	id: number;
	/** Whom it is for: one conversation, every conversation of an agent, or all agents. */
	scope: "conversation" | "agent" | "all";
	/** Its name, for a board that has one. A conversation's own board has none. */
	name?: string;
	/** The agent it belongs to (none for a board for all agents), and its conversation (`ViewConversation.id`). */
	agent?: string;
	conversation?: number;
	/** Its tasks: nobody has them yet, somebody works on them, done, failed, and waiting for the owner's answer. */
	open: number;
	taken: number;
	done: number;
	failed: number;
	blocked: number;
	/** The notes left on it. */
	notes: number;
	/** The pieces of work that have one of its tasks now (`ViewWork.id`). */
	workers: number[];
	/** Its tasks in the order they were posted, the newest 200. (`open` above counts the waiting ones too.) */
	tasks: ViewTask[];
}

/** A way work comes in: the owner, the clock, an event source, another way. */
export interface ViewInput {
	/** "you", "clock", "source:<name>" or "outside:<name>". */
	id: string;
	kind: "you" | "clock" | "source" | "outside";
	name: string;
	/** An event source's type ("mail", "webhook", ...). */
	type?: string;
	count: number;
	/** When it last brought something in. */
	last?: number;
	/** The agents that listen to it (an event source). */
	agents: string[];
	/** An event source that could not start or lost its connection. */
	failing: boolean;
}

/** A schedule: the clock wakes an agent with a task, at a time or again and again. */
export interface ViewSchedule {
	name: string;
	/** The agent it wakes; none for one that publishes an event for all. */
	agent?: string;
	/** When, as it was set: a cron line ("0 9 * * 1-5"), an interval ("every 30m") or a time. */
	when?: string;
	/** When it runs next, and when it last ran while the panel was open: the page's clock. */
	next?: number;
	last?: number;
}

/** What is chosen in the panel. */
export type ViewTarget = { agent: string } | { work: number } | { board: number; task?: number };

/** One of a piece of work's last tool calls: the tool's name, when it began, and once it ended how long it took and whether it went well. */
export interface ViewCall {
	tool: string;
	mcp?: string;
	at: number;
	ms?: number;
	ok?: boolean;
}

/** All of pine, as a view sees it. */
export interface ViewState {
	/** The page's clock when this was made. */
	at: number;
	/** The main agent first, then by name. */
	agents: ViewAgent[];
	/** What runs now, and what ended in the last half hour. */
	work: ViewWork[];
	inputs: ViewInput[];
	/** Every schedule, the one that runs next first. */
	schedules: ViewSchedule[];
	/** Every board, the ones with work on them first. */
	boards: ViewBoard[];
	selected?: ViewTarget;
	/** Whether the app is drawn dark. */
	dark: boolean;
	/** Whether the app's window is in front. A view that animates can draw seldom while it is not: it saves the battery. */
	focused: boolean;
}

/** Something that just happened, as it happens: for a view that animates. */
export type ViewHappening =
	| { k: "started"; work: number; agent: string }
	| { k: "ended"; work: number; agent: string; failed: boolean }
	| { k: "tool"; work: number; agent: string; tool: string; mcp?: string }
	| { k: "toolEnded"; work: number; agent: string; tool: string; ok: boolean }
	| { k: "skill"; work: number; agent: string; skill: string }
	| { k: "steps"; work: number; agent: string; done: number; total: number }
	| { k: "event"; input: string }
	| { k: "scheduled"; name?: string; agent?: string }
	| { k: "said"; work: number; agent: string }
	| { k: "branched"; agent: string; conversation: number; from?: number; worktree: boolean }
	| { k: "worktree"; agent: string; conversation: number; made: boolean }
	| { k: "goal"; agent: string; conversation?: number; status: "active" | "paused" | "met" | "blocked" | "limit" }
	/** A conversation's swarm changed: it started, its lead was called again, its answer is being checked, it is done or it stopped. */
	| { k: "swarm"; agent: string; conversation?: number; status: "active" | "waiting" | "done" | "paused" | "limit"; checking: boolean }
	| { k: "outside"; agent: string; conversation?: number }
	| { k: "handed"; work: number; from: string; to: string }
	| { k: "answered"; work: number; from: string; to: string }
	| { k: "copied"; work: number; agent: string }
	| { k: "asked"; work: number; agent: string }
	| { k: "decided"; work?: number; agent?: string; allowed: boolean }
	| { k: "sent"; work: number; agent: string; tool: string }
	/** Something changed on a board: a task or a note was posted, a task was taken, given back or settled, or something was removed. */
	| { k: "board"; board: number; change: "posted" | "taken" | "released" | "settled" | "removed"; agent?: string; task?: number; state?: ViewTask["state"] };

/** How much a view shows of a thing: little from far away, more from where it is usually looked at, everything from close by. */
export type Detail = "far" | "mid" | "near";

/**
 * The level of detail for a zoom, where 1 is the size a view was drawn for: `far` below `at.far`, `near` above
 * `at.near`. Give the level the view is at as `was`: it is kept until the zoom is clearly past a limit, so that
 * a hand that rests at one does not make the picture flicker between two.
 */
export function detailAt(zoom: number, was?: Detail, at: { far: number; near: number } = { far: 0.5, near: 1.2 }): Detail {
	const far = at.far * (was === "far" ? 1.1 : 1);
	const near = at.near * (was === "near" ? 0.9 : 1);
	return zoom < far ? "far" : zoom > near ? "near" : "mid";
}

/** What the panel gives a view. */
export interface ViewHost {
	/** The element to draw in: the whole panel's lens, empty. */
	root: HTMLElement;
	/** pine as it is now. */
	state(): ViewState;
	/** Called with every new state (several times a second while work runs), and with what just happened. Returns a function that stops it. */
	on(what: "state", fn: (state: ViewState) => void): () => void;
	on(what: "happening", fn: (h: ViewHappening) => void): () => void;
	/** Shows an agent, a piece of work, or a board or one of its tasks in the panel, under the view (there the panel says what a task is, in its words); nothing for none. */
	select(target?: ViewTarget): void;
	/** Opens an agent's conversation, or a piece of work by itself. A board cannot be opened this way. */
	open(target: ViewTarget): void;
}

export interface View {
	readonly pineView: 1;
	start(host: ViewHost): void | (() => void);
}

/** A view: called once with the panel, it draws there and follows `host`; what it returns is called when the panel closes. */
export function defineView(start: (host: ViewHost) => void | (() => void)): View {
	return { pineView: 1, start };
}

// ---- helpers ---------------------------------------------------------------------------------------------------------

export interface Pt {
	x: number;
	y: number;
}
export interface Box {
	x: number;
	y: number;
	w: number;
	h: number;
}
/** A camera: the drawing's point in the middle of the view, and how many screen pixels a drawing pixel is. */
export interface Cam {
	x: number;
	y: number;
	z: number;
}

/** The tasks of a board that are not settled yet: open, taken, or waiting for an answer. */
export const unsettled = (b: ViewBoard) => b.open + b.taken + b.blocked;

/** A board's tasks. (An app older than this kit tells a view none.) */
export const tasksOf = (b: ViewBoard): ViewTask[] => b.tasks ?? [];

/** How far a board is, from 0 to 1: the part of its tasks that is done. A board without tasks is at 0. */
export function progress(b: ViewBoard): number {
	const all = b.open + b.taken + b.blocked + b.failed + b.done;
	return all ? b.done / all : 0;
}

/** A task's tile in a picture of a board, from the left edge and the top of the tiles. */
export interface TaskTile {
	task: ViewTask;
	x: number;
	y: number;
}

/**
 * A board's tasks as square tiles in a box `width` wide and at most `height` high: one column for each
 * task that comes after nothing, in the order they were posted, and under it whatever comes after it (a
 * check under the work it checks). The columns wrap into bands. `sizes` are the tiles a view can draw,
 * the largest first, each with the gap beside it: the largest is taken with which all fit (one a little
 * smaller, if that keeps every column in one band), else the smallest, and the tasks that do not fit even
 * then are counted in `more`. `between` is the room between two bands where a band is more than one row.
 */
export function tiling(b: ViewBoard, width: number, height: number, sizes: Array<[size: number, gap: number]>, between = 0): { size: number; gap: number; tiles: TaskTile[]; height: number; more: number } {
	const tasks = tasksOf(b);
	if (!tasks.length || !sizes.length) return { size: 0, gap: 0, tiles: [], height: 0, more: 0 };
	// Which column a task is in, and how far down: under the first task it comes after.
	const place = new Map<number, { col: number; row: number }>();
	const depth: number[] = [];
	for (const t of tasks) {
		const parent = t.after.map((a) => place.get(a)).find(Boolean);
		const col = parent ? parent.col : depth.length;
		const row = parent ? Math.max(parent.row + 1, depth[col]) : 0;
		depth[col] = row + 1;
		place.set(t.id, { col, row });
	}
	const cols = depth.length;
	const deep = Math.max(1, ...depth);
	const room = deep > 1 ? between : 0;
	const fit = ([size, gap]: [number, number]) => {
		const per = Math.max(1, Math.floor((width + gap) / (size + gap)));
		const band = deep * (size + gap) + room;
		// How many bands the box takes, and how many the tasks need.
		const bands = Math.max(1, Math.floor((height + gap + room) / band));
		return { size, gap, per, band, bands, needs: Math.ceil(cols / per) };
	};
	const all = sizes.map(fit);
	// The largest that fits; a little smaller where that keeps everything in one band, since a band with one column in it reads badly.
	const fits = all.filter((f) => f.needs <= f.bands);
	const pick = (fits[0] && fits[0].needs > 1 ? fits.find((f) => f.needs === 1 && f.size >= fits[0].size * 0.75) : undefined) ?? fits[0] ?? all[all.length - 1];
	const shown = Math.min(cols, pick.per * pick.bands);
	const tiles: TaskTile[] = [];
	let more = 0;
	for (const t of tasks) {
		const at = place.get(t.id)!;
		if (at.col >= shown) more++;
		else tiles.push({ task: t, x: (at.col % pick.per) * (pick.size + pick.gap), y: Math.floor(at.col / pick.per) * pick.band + at.row * (pick.size + pick.gap) });
	}
	return { size: pick.size, gap: pick.gap, tiles, height: Math.ceil(shown / pick.per) * pick.band - pick.gap - room, more };
}

/**
 * A board's tasks in rows that follow one another: a task is in the row after the last task it comes
 * after. Work is in the first row, a check of it in the second. For a view that draws what waits for what.
 */
export function stages(b: ViewBoard): ViewTask[][] {
	const depth = new Map<number, number>();
	const rows: ViewTask[][] = [];
	for (const t of tasksOf(b)) {
		const d = Math.min(8, Math.max(0, ...t.after.map((a) => (depth.get(a) ?? -1) + 1)));
		depth.set(t.id, d);
		(rows[d] ??= []).push(t);
	}
	return rows.filter(Boolean);
}

/** The working pieces among `work`: not ended. */
export const running = (work: ViewWork[]) => work.filter((w) => w.doing !== "done" && w.doing !== "failed" && w.doing !== "cancelled");

export function union(boxes: Box[]): Box {
	const x0 = Math.min(...boxes.map((b) => b.x));
	const y0 = Math.min(...boxes.map((b) => b.y));
	const x1 = Math.max(...boxes.map((b) => b.x + b.w));
	const y1 = Math.max(...boxes.map((b) => b.y + b.h));
	return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
}

export const inside = (p: Pt, b: Box) => p.x >= b.x && p.x < b.x + b.w && p.y >= b.y && p.y < b.y + b.h;

/**
 * Where a camera goes to show `aim` in a view of `view`: the box with a margin, never smaller than `min`,
 * never closer than `zMax`, never further out than `whole` needs, and never showing more of what lies
 * outside `whole` than it has to. The zoom comes in steps of a quarter, so that pixels stay even; `step`
 * says another (1 for pixel art that is to keep whole pixels), `zMin` the furthest out it goes.
 */
export function frame(aim: Box, view: { w: number; h: number }, whole: Box, o: { zMax: number; min: { w: number; h: number }; step?: number; zMin?: number }): Cam {
	const vw = Math.max(1, view.w);
	const vh = Math.max(1, view.h);
	const zAll = Math.min(vw / (whole.w + 8), vh / (whole.h + 8));
	const w = Math.max(aim.w + 16, o.min.w);
	const h = Math.max(aim.h + 16, o.min.h);
	const z = Math.max(Math.min(zAll, o.zMax), Math.min(o.zMax, vw / w, vh / h));
	const step = o.step && o.step > 0 ? o.step : 0.25;
	const zz = Math.max(o.zMin ?? step, Math.floor(z / step + 1e-9) * step);
	const keep = (c: number, half: number, size: number, start: number) => (half * 2 >= size ? start + size / 2 : Math.min(start + size - half, Math.max(start + half, c)));
	return { x: keep(aim.x + aim.w / 2, vw / zz / 2, whole.w, whole.x), y: keep(aim.y + aim.h / 2, vh / zz / 2, whole.h, whole.y), z: zz };
}

/** A camera moved a frame of `dt` milliseconds towards `target`: most of the way in a third of a second, the zoom on a log scale. */
export function ease(cam: Cam, target: Cam, dt: number): Cam {
	const k = dt ? 1 - Math.exp(-dt / 320) : 1;
	const next = { x: cam.x + (target.x - cam.x) * k, y: cam.y + (target.y - cam.y) * k, z: Math.exp(Math.log(cam.z) + (Math.log(target.z) - Math.log(cam.z)) * k) };
	return Math.abs(next.z - target.z) < 0.002 && Math.abs(next.x - target.x) < 0.05 && Math.abs(next.y - target.y) < 0.05 ? { ...target } : next;
}

/** A point along a path of straight pieces, `t` from 0 to 1. */
export function along(path: Pt[], t: number): Pt {
	const lens = path.slice(1).map((p, i) => Math.hypot(p.x - path[i].x, p.y - path[i].y));
	let left = lens.reduce((a, b) => a + b, 0) * Math.max(0, Math.min(1, t));
	for (let i = 0; i < lens.length; i++) {
		if (left <= lens[i]) {
			const k = lens[i] ? left / lens[i] : 0;
			return { x: path[i].x + (path[i + 1].x - path[i].x) * k, y: path[i].y + (path[i + 1].y - path[i].y) * k };
		}
		left -= lens[i];
	}
	return path[path.length - 1] ?? { x: 0, y: 0 };
}

export const lengthOf = (path: Pt[]) => path.slice(1).reduce((n, p, i) => n + Math.hypot(p.x - path[i].x, p.y - path[i].y), 0);

/** Random numbers that are the same for the same seed. */
export function seeded(seed: number): () => number {
	let a = seed >>> 0;
	return () => {
		a = (a + 0x6d2b79f5) >>> 0;
		let t = a;
		t = Math.imul(t ^ (t >>> 15), t | 1);
		t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};
}

/** A number from a name, the same every time. */
export function hashOf(s: string): number {
	let h = 2166136261;
	for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619);
	return h >>> 0;
}

export function rgb(hex: string): [number, number, number] {
	const h = hex.replace("#", "");
	return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16)];
}

/** Between two #rrggbb colors: `t` 0 is `a`, 1 is `b`. */
export function mix(a: string, b: string, t: number): string {
	const x = rgb(a);
	const y = rgb(b);
	return `#${x.map((v, i) => Math.max(0, Math.min(255, Math.round(v + (y[i] - v) * t))).toString(16).padStart(2, "0")).join("")}`;
}

/** Lighter (amount > 0) or darker (amount < 0). */
export const shade = (color: string, amount: number) => mix(color, amount > 0 ? "#ffffff" : "#000000", Math.abs(amount));
