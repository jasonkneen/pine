// workshop: pine as Santa's workshop at the North Pole, cut open, seen from the snow. A view for the panel of
// the Pine app (docs/references/views.md); it draws what "pine/view" tells it and nothing else.
//
//   the main agent      Santa, in his room under the roof: a fire, a tree, presents. At rest he checks his list
//   an agent            an elf in a bay of the workshop, made from the agent's name: its own face, its own
//                       pointed cap in the agent's color. Each bay is another kind of workshop (a joiner's bench,
//                       a paint shop, a bakery, a sewing room, clockwork, sweets, wrapping, ice). The plate at
//                       the door says the agent's name and its mode: a snow globe for a sandbox (safe), a cookie
//                       jar (manual), a wind-up key (auto), a sparkler, tape and a beacon (bypass), a
//                       gingerbread house yet to be built (plan)
//   at rest             the elf potters about: a cocoa, a look out of the window, the plant; at night it sleeps
//   at work             the bay lights up and a bubble says what it does: it paces while it thinks, reads at the
//                       shelf, works at its bench with its tool, turns the sweet machine for an MCP server, takes
//                       a starred book for a skill, wraps the present while it writes its answer, waits on its
//                       stool while others work for it, and jumps with a red ! when it asks you. On the bench:
//                       the toy, a plan on blue paper, a glass of sand, the parcel, a jack-in-the-box with a !
//   a to-do list        pips under the bubble: how many steps are done
//   a board             while its sub-agents work through a board, a cork board on a trolley stands in the bay:
//                       a card for each task, in the order they were posted, what comes after a task (a check
//                       of it) under it. Paper is one to do, the agent's color one in progress, green one that
//                       is done, amber one whose worker asked a question (a ? over the board), red one that
//                       failed; the strip on top says how far the board is, and so do the pips under the
//                       bubble. A board for all agents hangs in the mail room, with its name. A word at a
//                       board says what just happened on it
//   a copy (sub-agent)  a small elf that pops up beside it, for as long as the copy works
//   a task handed on    a present flies from elf to elf and a dotted line joins the two bays while the work
//                       lasts; the answer flies back with a tick, or a cross
//   events              sweets in the glass chute: from your counter and the letter boxes in the mail room up to
//                       the bay, and from the clock in the tower down when a schedule is due
//   what an agent has   in its machine a gumball for each MCP server (on Santa's tree a bauble), on its shelf a
//                       starred book for each skill (Santa's stand on the mantel), on its wall a bell for each
//                       schedule, on its board its conversations: a line for each, a fork for a branch, a leaf
//                       for a worktree; a little tree with a star on the bench for a goal
//   sent out            a present flies up to the sleigh on the roof, and the reindeer's nose lights up
//   outside content     an amber lantern in the bay, and the bobble of the cap glows amber: sending something
//                       out asks you from now on
//   outside             your local time in the sky, the moon in tonight's phase, the northern lights at night,
//                       reindeer flying a sleigh, elves on skis, a polar bear with its cub, snow that never stops
//
// The signs are sweets: a cookie reads, a candy cane runs a command, a lollipop searches. The ? shows them all.
// Pixels are whole: the camera zooms in whole steps, and words are set in a pixel font of the view's own.
// A camera goes where agents work. Scroll, drag or pinch to look yourself; the eye button follows again.
// Click a bay or an elf to see it under the view; double-click to open it.

import { along, type Box, type Cam, defineView, ease, frame, hashOf, inside, lengthOf, mix, type Pt, rgb, seeded, tasksOf, tiling, union, unsettled, type ViewAgent, type ViewBoard, type ViewHappening, type ViewHost, type ViewInput, type ViewSchedule, type ViewState, type ViewWork } from "pine/view";

// ---- what is there, each frame ----------------------------------------------------------------------------------------

/** The state, with the lookups the drawing needs. */
export interface Now {
	agents: ViewAgent[];
	agent: Map<string, ViewAgent>;
	work: Map<number, ViewWork>;
	running: ViewWork[];
	inputs: ViewInput[];
	input: Map<string, ViewInput>;
	schedules: ViewSchedule[];
	boards: ViewBoard[];
	dark: boolean;
	focused: boolean;
}

const ENDED = ["done", "failed", "cancelled"];
const ended = (w: ViewWork) => ENDED.includes(w.doing);

export function nowOf(s: ViewState): Now {
	const running = s.work.filter((w) => !ended(w)).sort((a, b) => a.started - b.started);
	return { agents: s.agents, agent: new Map(s.agents.map((a) => [a.id, a])), work: new Map(s.work.map((w) => [w.id, w])), running, inputs: s.inputs, input: new Map(s.inputs.map((i) => [i.id, i])), schedules: s.schedules ?? [], boards: s.boards ?? [], dark: s.dark, focused: s.focused !== false };
}

/** The way in a piece of work came through, if it came through one. */
function portOf(w: ViewWork): string | undefined {
	const f = w.from;
	return f.k === "you" ? "you" : f.k === "clock" ? "clock" : f.k === "source" ? `source:${f.name}` : f.k === "outside" ? `outside:${f.name}` : undefined;
}

// ---- what an elf says ------------------------------------------------------------------------------------------------

/** The signs of the view: each a small picture of its own (ICONS). */
export type Sign = "think" | "read" | "write" | "term" | "find" | "web" | "plug" | "star" | "wait" | "ask" | "hand" | "copy" | "clock" | "mail" | "branch" | "tick" | "cross" | "shield" | "lock" | "bolt" | "warn" | "plan" | "list" | "flag" | "send" | "gear" | "folder" | "dish" | "chat" | "day" | "you" | "leaf" | "zzz" | "heart" | "note" | "eye" | "down";

/** What the bubble of somebody at work says: a sign, a few words, a color. */
export interface Say {
	sign: Sign;
	text: string;
	color: string;
	/** A second, smaller line: who it works for, what holds it. */
	note?: string;
	steps?: { done: number; total: number };
	loud?: boolean;
}

const HUE = { think: "#8b6cf0", read: "#2f9e8f", tool: "#d9822b", mcp: "#1f8fc4", write: "#3b74e0", wait: "#7c8799", ask: "#e5484d", hand: "#2fa868", skill: "#c99a1e", setup: "#9b59c7" };

/** What pine's own tools do, in a few words of a view's own: the name of a tool says nothing of what it was given. */
const TOOLS: Record<string, [Sign, string, string?]> = {
	read: ["read", "reading a file", HUE.read],
	grep: ["find", "searching files", HUE.read],
	find: ["find", "looking for files", HUE.read],
	ls: ["folder", "listing a folder", HUE.read],
	manual: ["read", "reading the manual", HUE.read],
	bash: ["term", "running a command"],
	edit: ["write", "editing a file", HUE.write],
	write: ["write", "writing a file", HUE.write],
	download: ["down", "downloading a file", HUE.mcp],
	todo: ["list", "planning next steps", HUE.think],
	question: ["ask", "asking a question", HUE.ask],
	delegate: ["hand", "delegating a task", HUE.hand],
	subagent: ["copy", "starting sub-agents", HUE.hand],
	send: ["send", "sending a message", HUE.hand],
	publish_event: ["send", "publishing an event", HUE.hand],
	read_source: ["mail", "reading from a source", HUE.read],
	request_access: ["lock", "requesting access", HUE.ask],
	stop_program: ["term", "stopping a program"],
	state_get: ["eye", "reading shared state", HUE.read],
	state_set: ["write", "writing shared state", HUE.write],
	boards: ["list", "listing boards", HUE.read],
	board_read: ["read", "reading the board", HUE.read],
	board_post: ["note", "posting on the board", HUE.hand],
	board_claim: ["hand", "taking a task", HUE.hand],
	board_done: ["tick", "settling a task", HUE.hand],
	board_answer: ["tick", "answering a sub-agent", HUE.hand],
	subscribe: ["mail", "subscribing to events", HUE.setup],
	unsubscribe: ["mail", "unsubscribing", HUE.setup],
	add_source: ["dish", "adding a source", HUE.setup],
	remove_source: ["dish", "removing a source", HUE.setup],
	add_schedule: ["clock", "adding a schedule", HUE.setup],
	remove_schedule: ["clock", "removing a schedule", HUE.setup],
	add_mcp_server: ["plug", "adding an MCP server", HUE.setup],
	remove_mcp_server: ["plug", "removing an MCP server", HUE.setup],
	add_skill: ["star", "adding a skill", HUE.skill],
	remove_skill: ["star", "removing a skill", HUE.skill],
	create_agent: ["heart", "creating an agent", HUE.setup],
	update_agent: ["gear", "updating an agent", HUE.setup],
	rename_agent: ["gear", "renaming an agent", HUE.setup],
	remove_agent: ["gear", "removing an agent", HUE.setup],
	set_setting: ["gear", "changing a setting", HUE.setup],
	add_route: ["gear", "adding a route", HUE.setup],
	remove_route: ["gear", "removing a route", HUE.setup],
	find_tools: ["find", "finding a tool", HUE.read],
	read_conversation: ["read", "reading a conversation", HUE.read],
	set_conversation: ["gear", "updating a conversation", HUE.setup],
	sources: ["list", "listing sources", HUE.read],
	schedules: ["list", "listing schedules", HUE.read],
	mcp_servers: ["list", "listing MCP servers", HUE.read],
	skills: ["list", "listing skills", HUE.read],
	agents: ["list", "listing agents", HUE.read],
	settings: ["list", "listing settings", HUE.read],
	conversations: ["list", "listing conversations", HUE.read],
	models: ["list", "listing models", HUE.read],
	pine_list: ["list", "checking its setup", HUE.read],
};

/** What a tool's name says it does, for a bubble and a tip. */
export function toolSay(tool: string | undefined, mcp?: string): { sign: Sign; text: string; color: string } {
	const t = tool ?? "";
	if (mcp) {
		const what = t.replace(/^mcp__[^_]+(?:_[^_]+)*?__/, "").replace(new RegExp(`^${mcp}_`), "").replace(/_/g, " ");
		const sign: Sign = /search|fetch|navigate|web|browser|page/.test(`${mcp} ${what}`) ? "web" : "plug";
		return { sign, text: `${mcp}: ${what || "a tool"}`.slice(0, 34), color: HUE.mcp };
	}
	const known = TOOLS[t];
	if (known) return { sign: known[0], text: known[1], color: known[2] ?? HUE.tool };
	if (t.startsWith("pine_")) return { sign: "gear", text: `pine: ${t.slice(5).replace(/_/g, " ")}`, color: HUE.setup };
	return { sign: "gear", text: t ? t.replace(/_/g, " ").slice(0, 30) : "using a tool", color: HUE.tool };
}

/** What a piece of work is doing, for its bubble: no words of its own, only what the state says. */
export function sayOf(w: ViewWork, s: Now, now: number): Say {
	const note = w.from.k === "agent" && !w.copy ? `for ${w.from.id}` : w.round ? `goal, round ${w.round}` : w.held && w.mode ? `limited to ${w.mode} mode` : undefined;
	// The board its sub-agents work through counts like a list of steps: a pip for each task, lit when it is done.
	const board = !w.copy && w.conversation !== undefined ? s.boards.find((b) => b.scope === "conversation" && b.agent === w.agent && b.conversation === w.conversation && b.open + b.taken + b.blocked > 0) : undefined;
	const tasks = board ? board.open + board.taken + board.done + board.failed + board.blocked : 0;
	const more = { note: note ?? (w.copy && w.board !== undefined ? `task ${tasksOf(s.boards.find((b) => b.id === w.board) ?? ({} as ViewBoard)).find((t) => t.worker === w.id)?.id ?? ""} of the board`.replace("task  of", "a task of") : board ? `board: ${board.done} of ${tasks} done` : undefined), steps: w.steps ?? (board ? { done: board.done, total: tasks } : undefined) };
	if (w.asking) return { sign: "ask", text: "needs your answer", color: HUE.ask, loud: true, ...more };
	if (w.doing === "tool" && w.skill) return { sign: "star", text: `skill: ${w.skill}`.slice(0, 34), color: HUE.skill, ...more };
	if (w.doing === "tool") return { ...toolSay(w.tool, w.mcp), ...more };
	if (w.doing === "writing") return { sign: "write", text: "writing an answer", color: HUE.write, ...more };
	if (w.doing === "waiting") {
		const on = w.waitingOn.map((id) => s.work.get(id)).filter((x): x is ViewWork => Boolean(x && !ended(x)));
		const copies = on.filter((x) => x.copy).length;
		const others = [...new Set(on.filter((x) => !x.copy).map((x) => x.agent))];
		const who = [...others, ...(copies ? [copies === 1 ? "a sub-agent" : `${copies} sub-agents`] : [])];
		return { sign: "wait", text: who.length ? `waiting for ${who.join(", ")}`.slice(0, 38) : "waiting", color: HUE.wait, ...more };
	}
	return { sign: "think", text: `thinking${".".repeat(1 + (Math.floor(now / 400) % 3))}`, color: HUE.think, ...more };
}

/** The same in plain words, for a tip and for the words a screen reader reads. */
export function doingOf(w: ViewWork): string {
	if (w.asking) return "needs your answer";
	if (w.doing === "tool") return w.skill ? `reading the skill ${w.skill}` : toolSay(w.tool, w.mcp).text;
	if (w.doing === "waiting") return "waiting for others";
	if (w.doing === "writing") return "writing an answer";
	return w.doing;
}

// ---- color -----------------------------------------------------------------------------------------------------------

const clamp = (v: number, a = 0, b = 1) => Math.max(a, Math.min(b, v));
const smooth = (a: number, b: number, v: number) => {
	const t = clamp((v - a) / (b - a));
	return t * t * (3 - 2 * t);
};
const lerp = (a: number, b: number, t: number) => a + (b - a) * t;

/** The darkest color there is: a deep plum, never black. Every outline is this or a shade of what it outlines. */
const INK = "#2b2140";
const PAPER = "#fff8ea";

function toHsl(hex: string): [number, number, number] {
	const [r, g, b] = rgb(hex).map((v) => v / 255);
	const max = Math.max(r, g, b);
	const min = Math.min(r, g, b);
	const l = (max + min) / 2;
	if (max === min) return [0, 0, l];
	const d = max - min;
	const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
	const h = max === r ? (g - b) / d + (g < b ? 6 : 0) : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
	return [h * 60, s, l];
}

function fromHsl(h: number, s: number, l: number): string {
	const f = (n: number) => {
		const k = (n + h / 30) % 12;
		const a = s * Math.min(l, 1 - l);
		return Math.round(255 * (l - a * Math.max(-1, Math.min(k - 3, 9 - k, 1))));
	};
	return `#${[f(0), f(8), f(4)].map((v) => clamp(v, 0, 255).toString(16).padStart(2, "0")).join("")}`;
}

const TONES = new Map<string, string>();
/**
 * A color `k` steps up (lighter) or down (darker) its ramp. A ramp is not a color with white or black
 * mixed in: its shadows turn towards blue and gain color, its lights turn towards yellow and lose some.
 */
export function tone(c: string, k: number): string {
	if (!k) return c;
	const key = `${c}${k}`;
	let v = TONES.get(key);
	if (v) return v;
	const [h, s, l] = toHsl(c);
	const n = Math.abs(k);
	const to = k < 0 ? 255 : 48;
	const dh = ((to - h + 540) % 360) - 180;
	const nh = (h + dh * Math.min(0.6, n * (k < 0 ? 0.14 : 0.1)) + 360) % 360;
	v = k < 0 ? fromHsl(nh, clamp(Math.max(s, 0.1) * (1 + 0.12 * n)), l * (1 - 0.19) ** n) : fromHsl(nh, s * (1 - 0.1 * n), l + (1 - l) * (1 - 0.74 ** n));
	TONES.set(key, v);
	return v;
}

/** A light a part of the picture stands in: every color drawn there is multiplied by it. The night, a lamp. */
interface Tint {
	key: string;
	mul: [number, number, number];
	map: Map<string, string>;
}
const TINTS = new Map<string, Tint>();
const PLAIN: Tint = { key: "", mul: [1, 1, 1], map: new Map() };
function tintOf(mul: [number, number, number]): Tint {
	const q = mul.map((v) => Math.round(v * 24));
	if (q[0] === 24 && q[1] === 24 && q[2] === 24) return PLAIN;
	const key = q.join(",");
	let t = TINTS.get(key);
	if (!t) {
		if (TINTS.size > 64) TINTS.clear(), SPRITES.clear();
		TINTS.set(key, (t = { key, mul: [q[0] / 24, q[1] / 24, q[2] / 24], map: new Map() }));
	}
	return t;
}
let T: Tint = PLAIN;
/** A color as it looks in the light that is on. */
function C(c: string): string {
	if (T === PLAIN) return c;
	let v = T.map.get(c);
	if (!v) {
		const [r, g, b] = rgb(c);
		const m = T.mul;
		v = `#${[r * m[0], g * m[1], b * m[2]].map((x) => clamp(Math.round(x), 0, 255).toString(16).padStart(2, "0")).join("")}`;
		T.map.set(c, v);
	}
	return v;
}
const mulMix = (a: [number, number, number], b: [number, number, number], t: number): [number, number, number] => [lerp(a[0], b[0], t), lerp(a[1], b[1], t), lerp(a[2], b[2], t)];

// ---- the brush -------------------------------------------------------------------------------------------------------

type Ctx = CanvasRenderingContext2D;
type Canvas = HTMLCanvasElement;
/** The canvas that is drawn on. Everything is drawn in whole pixels of the picture; the camera makes them big. */
let g: Ctx;
const paper = (w: number, h: number): Canvas => Object.assign(document.createElement("canvas"), { width: Math.max(1, Math.ceil(w)), height: Math.max(1, Math.ceil(h)) });
const penOf = (c: Canvas): Ctx => {
	const p = c.getContext("2d")!;
	p.imageSmoothingEnabled = false;
	return p;
};

function R(x: number, y: number, w: number, h: number, c: string): void {
	g.fillStyle = C(c);
	g.fillRect(Math.round(x), Math.round(y), Math.round(w), Math.round(h));
}

/** A rectangle with its corners cut by `r`, like a rounded one at this size. */
function slab(x: number, y: number, w: number, h: number, c: string, r = 1): void {
	g.fillStyle = C(c);
	x = Math.round(x);
	y = Math.round(y);
	for (let j = 0; j < h; j++) {
		const d = Math.min(j, h - 1 - j);
		const cut = d < r ? Math.max(0, Math.round(r - Math.sqrt(Math.max(0, r * r - (r - d - 0.5) ** 2)))) : 0;
		g.fillRect(x + cut, y + j, w - 2 * cut, 1);
	}
}

/** A solid thing with light from the upper left: an outline, a lit top and left, a shaded bottom and right. */
function block(x: number, y: number, w: number, h: number, c: string, o: { r?: number; ink?: string | false; flat?: boolean } = {}): void {
	const r = o.r ?? 1;
	if (o.ink !== false) slab(x - 1, y - 1, w + 2, h + 2, o.ink ?? INK, r + 1);
	slab(x, y, w, h, c, r);
	if (o.flat || w < 3 || h < 3) return;
	R(x + r, y, w - 2 * r, 1, tone(c, 1));
	R(x, y + r, 1, h - 2 * r, tone(c, 1));
	R(x + r, y + h - 1, w - 2 * r, 1, tone(c, -1));
	R(x + w - 1, y + r, 1, h - 2 * r, tone(c, -1));
}

const CANDY = new Map<string, CanvasPattern>();
/** Stripes on the slant, as on a candy cane: `band` pixels of each color, in the light that is on. */
function candy(x: number, y: number, w: number, h: number, a: string, b: string, band = 4): void {
	const key = `${a}${b}${band}${T.key}`;
	let p = CANDY.get(key);
	if (!p) {
		if (CANDY.size > 200) CANDY.clear();
		const n = band * 2;
		const c = paper(n, n);
		const pen = penOf(c);
		for (let j = 0; j < n; j++)
			for (let i = 0; i < n; i++) {
				pen.fillStyle = C(Math.floor((i + j) / band) % 2 ? a : b);
				pen.fillRect(i, j, 1, 1);
			}
		p = g.createPattern(c, "repeat")!;
		CANDY.set(key, p);
	}
	g.save();
	g.translate(Math.round(x), Math.round(y));
	g.fillStyle = p;
	g.fillRect(0, 0, Math.round(w), Math.round(h));
	g.restore();
}

const BAYER = [0, 8, 2, 10, 12, 4, 14, 6, 3, 11, 1, 9, 15, 7, 13, 5];
/** A color laid over an area as an even scatter of pixels: `level` of 16. How two colors meet without a third. */
function dither(x: number, y: number, w: number, h: number, c: string, level: number): void {
	g.fillStyle = C(c);
	x = Math.round(x);
	y = Math.round(y);
	for (let j = 0; j < h; j++) for (let i = 0; i < w; i++) if (BAYER[((x + i) & 3) + ((y + j) & 3) * 4] < level) g.fillRect(x + i, y + j, 1, 1);
}

/** A filled circle, in rows. */
export function disc(cx: number, cy: number, r: number, c: string): void {
	g.fillStyle = C(c);
	cx = Math.round(cx);
	cy = Math.round(cy);
	for (let dy = -r; dy <= r; dy++) {
		const half = Math.floor(Math.sqrt(r * r + r - dy * dy));
		g.fillRect(cx - half, cy + dy, half * 2 + 1, 1);
	}
}

/** A straight line of pixels. */
function line(x0: number, y0: number, x1: number, y1: number, c: string): void {
	g.fillStyle = C(c);
	x0 = Math.round(x0);
	y0 = Math.round(y0);
	x1 = Math.round(x1);
	y1 = Math.round(y1);
	const n = Math.max(Math.abs(x1 - x0), Math.abs(y1 - y0));
	for (let i = 0; i <= n; i++) g.fillRect(Math.round(x0 + ((x1 - x0) * i) / (n || 1)), Math.round(y0 + ((y1 - y0) * i) / (n || 1)), 1, 1);
}

// ---- pictures drawn by hand ---------------------------------------------------------------------------------------------

/** A small picture, a letter for each pixel; a palette says which color a letter is. "." is nothing. */
interface Sprite {
	id: number;
	w: number;
	h: number;
	rows: string[];
}
let spriteIds = 0;
function spr(src: string): Sprite {
	const rows = src
		.split(/[\n/]/)
		.map((r) => r.trim())
		.filter(Boolean);
	return { id: spriteIds++, w: Math.max(...rows.map((r) => r.length)), h: rows.length, rows };
}
const SPRITES = new Map<string, Canvas>();
/** Draws a picture with its upper left at (`x`, `y`), in the light that is on; `flip` mirrors it. */
function stamp(s: Sprite, pal: Record<string, string>, x: number, y: number, flip = false): void {
	let key = `${s.id}|${flip ? 1 : 0}|${T.key}|`;
	for (const k in pal) key += pal[k];
	let c = SPRITES.get(key);
	if (!c) {
		if (SPRITES.size > 1500) SPRITES.clear();
		c = paper(s.w, s.h);
		const p = penOf(c);
		for (let j = 0; j < s.h; j++) {
			const row = s.rows[j];
			for (let i = 0; i < row.length; i++) {
				const col = pal[row[i]];
				if (!col) continue;
				p.fillStyle = C(col);
				p.fillRect(flip ? s.w - 1 - i : i, j, 1, 1);
			}
		}
		SPRITES.set(key, c);
	}
	g.drawImage(c, Math.round(x), Math.round(y));
}

// ---- the letters -------------------------------------------------------------------------------------------------------

/** The view's own letters: five pixels wide at most, seven high, with two more below the line. */
const GLYPHS: Record<string, string> = {
	A: ".###./#...#/#...#/#####/#...#/#...#/#...#",
	B: "####./#...#/#...#/####./#...#/#...#/####.",
	C: ".###./#...#/#..../#..../#..../#...#/.###.",
	D: "####./#...#/#...#/#...#/#...#/#...#/####.",
	E: "####/#.../#.../###./#.../#.../####",
	F: "####/#.../#.../###./#.../#.../#...",
	G: ".###./#...#/#..../#.###/#...#/#...#/.###.",
	H: "#...#/#...#/#...#/#####/#...#/#...#/#...#",
	I: "###/.#./.#./.#./.#./.#./###",
	J: "..##/...#/...#/...#/...#/#..#/.##.",
	K: "#..#/#..#/#.#./##../#.#./#..#/#..#",
	L: "#.../#.../#.../#.../#.../#.../####",
	M: "#...#/##.##/#.#.#/#.#.#/#...#/#...#/#...#",
	N: "#...#/##..#/#.#.#/#..##/#...#/#...#/#...#",
	O: ".###./#...#/#...#/#...#/#...#/#...#/.###.",
	P: "####./#...#/#...#/####./#..../#..../#....",
	Q: ".###./#...#/#...#/#...#/#.#.#/#..#./.##.#",
	R: "####./#...#/#...#/####./#.#../#..#./#...#",
	S: ".###/#.../#.../.##./...#/...#/###.",
	T: "#####/..#../..#../..#../..#../..#../..#..",
	U: "#...#/#...#/#...#/#...#/#...#/#...#/.###.",
	V: "#...#/#...#/#...#/#...#/.#.#./.#.#./..#..",
	W: "#...#/#...#/#...#/#.#.#/#.#.#/##.##/#...#",
	X: "#...#/#...#/.#.#./..#../.#.#./#...#/#...#",
	Y: "#...#/#...#/.#.#./..#../..#../..#../..#..",
	Z: "#####/....#/...#./..#../.#.../#..../#####",
	a: "..../..../.##./...#/.###/#..#/.###",
	b: "#.../#.../###./#..#/#..#/#..#/###.",
	c: ".../.../.##/#../#../#../.##",
	d: "...#/...#/.###/#..#/#..#/#..#/.###",
	e: "..../..../.##./#..#/####/#.../.###",
	f: ".##/#../###/#../#../#../#..",
	g: "..../..../.###/#..#/#..#/.###/...#/.##.",
	h: "#.../#.../###./#..#/#..#/#..#/#..#",
	i: "#/./#/#/#/#/#",
	j: ".#/../.#/.#/.#/.#/.#/#.",
	k: "#.../#.../#..#/#.#./##../#.#./#..#",
	l: "#/#/#/#/#/#/#",
	m: "...../...../####./#.#.#/#.#.#/#.#.#/#.#.#",
	n: "..../..../###./#..#/#..#/#..#/#..#",
	o: "..../..../.##./#..#/#..#/#..#/.##.",
	p: "..../..../###./#..#/#..#/###./#.../#...",
	q: "..../..../.###/#..#/#..#/.###/...#/...#",
	r: ".../.../#.#/##./#../#../#..",
	s: "..../..../.###/#.../.##./...#/###.",
	t: ".#./.#./###/.#./.#./.#./..#",
	u: "..../..../#..#/#..#/#..#/#..#/.###",
	v: "...../...../#...#/#...#/.#.#./.#.#./..#..",
	w: "...../...../#...#/#.#.#/#.#.#/#.#.#/.#.#.",
	x: "..../..../#..#/#..#/.##./#..#/#..#",
	y: "..../..../#..#/#..#/#..#/.###/...#/.##.",
	z: "..../..../####/...#/.##./#.../####",
	"0": ".##./#..#/#..#/#..#/#..#/#..#/.##.",
	"1": ".#./##./.#./.#./.#./.#./###",
	"2": ".##./#..#/...#/..#./.#../#.../####",
	"3": "###./...#/...#/.##./...#/...#/###.",
	"4": "#..#/#..#/#..#/####/...#/...#/...#",
	"5": "####/#.../###./...#/...#/#..#/.##.",
	"6": ".##./#.../#.../###./#..#/#..#/.##.",
	"7": "####/...#/...#/..#./.#../.#../.#..",
	"8": ".##./#..#/#..#/.##./#..#/#..#/.##.",
	"9": ".##./#..#/#..#/.###/...#/...#/.##.",
	" ": "../../../../../../..",
	".": "././././././#",
	",": "../../../../../../.#/#.",
	":": "././#/./././#",
	"!": "#/#/#/#/#/./#",
	"?": ".##./#..#/...#/..#./.#../..../.#..",
	"-": ".../.../.../###/.../.../...",
	"+": ".../.../.#./###/.#./.../...",
	"/": "..#/..#/.#./.#./.#./#../#..",
	"(": ".#/#./#./#./#./#./.#",
	")": "#./.#/.#/.#/.#/.#/#.",
	"'": "#/#/./././././.",
	_: "..../..../..../..../..../..../####",
	"=": ".../.../###/.../###/.../...",
	">": ".../#../.#./..#/.#./#../...",
	"<": ".../..#/.#./#../.#./..#/...",
	"%": "#..#/...#/..#./..#./.#../#.../#..#",
	"&": ".#../#.#./#.#./.#../#.#.#/#..#./.##.#",
	"*": ".../#.#/.#./#.#/.../.../...",
	"#": ".#.#./#####/.#.#./.#.#./#####/.#.#./.....",
	"·": "./././#/././.",
};
const RUNS = new Map<string, { w: number; runs: Array<[number, number, number]> }>();
function glyph(ch: string): { w: number; runs: Array<[number, number, number]> } {
	let v = RUNS.get(ch);
	if (v) return v;
	const rows = (GLYPHS[ch] ?? GLYPHS[ch.toLowerCase()] ?? "###/#.#/#.#/#.#/#.#/#.#/###").split("/");
	const runs: Array<[number, number, number]> = [];
	rows.forEach((row, j) => {
		for (let i = 0; i < row.length; i++) {
			if (row[i] !== "#") continue;
			let n = 1;
			while (row[i + n] === "#") n++;
			runs.push([i, j, n]);
			i += n;
		}
	});
	RUNS.set(ch, (v = { w: rows[0].length, runs }));
	return v;
}
/** How wide a line of text is, in pixels of the letters. */
export function widthOf(text: string): number {
	let w = 0;
	for (const ch of text) w += glyph(ch).w + 1;
	return Math.max(0, w - 1);
}
/** Writes text with its upper left at (`x`, `y`); a capital is seven pixels high. */
function write(text: string, x: number, y: number, c: string): void {
	g.fillStyle = c;
	let at = Math.round(x);
	y = Math.round(y);
	for (const ch of text) {
		const gl = glyph(ch);
		for (const [i, j, n] of gl.runs) g.fillRect(at + i, y + j, n, 1);
		at += gl.w + 1;
	}
}
/** A text cut to what fits in `max` pixels. */
function fit(text: string, max: number): string {
	if (widthOf(text) <= max) return text;
	let t = text;
	while (t.length > 1 && widthOf(`${t}..`) > max) t = t.slice(0, -1);
	return `${t}..`;
}

// ---- the signs ---------------------------------------------------------------------------------------------------------

/** Nine pixels square each, one color, and nearly all of them sweets: what a bubble, a door plate, a letter box and the key show. */
const ICONS: Record<Sign, Sprite> = {
	// Candy floss on its stick: a thought.
	think: spr("..##.##../.#######./#########/#########/.#######./..#####../....#..../....#..../....#...."),
	// A cookie with chips.
	read: spr("..#####../.#######./###.#####/#######.#/##.######/#####.###/###.#####/.#######./..#####.."),
	// A piping bag, and the icing it writes.
	write: spr("#######../.#####.../.#####.../..###..../..###..../...#...../...#.#.#./....#.#../........."),
	// A candy cane.
	term: spr("..####.../.######../.##..##../.#...##../.....##../.....##../.....##../.....##../.....##.."),
	// A lollipop, to look through.
	find: spr("..###..../.#...#.../#..#..#../#.#.#.#../#..#..#../.#...#.../..####.../.....##../......##."),
	// A peppermint.
	web: spr("..#####../.##.####./###.##..#/####.#.##/#...#...#/##.#.####/#..##.###/.####.##./..#####.."),
	// A gumball machine.
	plug: spr("..#####../.#######./.##.#.##./.#######./..#####../...###.../..#####../..##.##../.#######."),
	// A star cookie.
	star: spr("....#..../....#..../...###.../#########/.#######./..#####../..#####../.##...##./.#.....#."),
	// A mug of cocoa that steams.
	wait: spr("..#..#.../...#..#../..#..#.../........./######.../########./######.#./########./.####...."),
	ask: spr("...###.../...###.../...###.../...###.../...###.../....#..../........./...###.../...###..."),
	// A present.
	hand: spr(".##...##./..##.##../#########/####.####/........./.###.###./.###.###./.###.###./.###.###."),
	// A gingerbread man: cut with the same cutter.
	copy: spr("...###.../...###.../.#######./#.#####.#/..#####../...###.../..##.##../.##...##./.##...##."),
	// A bell.
	clock: spr("....#..../...###.../..#####../..#####../..#####../.#######./#########/....#..../...###..."),
	// A wrapped sweet.
	mail: spr("........./#.......#/##.###.##/#.#####.#/..#####../#.#####.#/##.###.##/#.......#/........."),
	// A sprig with berries.
	branch: spr(".##....../.##...##./.#....##./.#....#../.#...#.../.####..../.#......./.##....../.##......"),
	tick: spr("........./.......##/......##./.....##../##..##.../.####..../..##...../........./........."),
	cross: spr("........./.##...##./..##.##../...###.../...###.../..##.##../.##...##./........./........."),
	// A snow globe: all of it stays inside the glass.
	shield: spr("..#####../.#.....#./#...#...#/#..###..#/#...#...#/#..###..#/.#######./..#####../.#######."),
	// A cookie jar with its lid on: it asks first.
	lock: spr("...###.../..#####../.#######./#########/###.#.###/#########/###.#.###/#########/.#######."),
	// A wind-up key: it runs by itself.
	bolt: spr(".##...##./#..#.#..#/#..#.#..#/.##.#.##./....#..../....#..../....#..../...###.../...###..."),
	// A sparkler: mind the sparks.
	warn: spr("#...#...#/.#..#..#./..#.#.#../...###.../#########/...###.../..#.#.#../.#..#..#./#...#...#"),
	// A gingerbread house, before it is built.
	plan: spr("....#..../...#.#.../..#...#../.#.....#./#########/#.......#/#.##.##.#/#.##.#..#/#########"),
	list: spr("........./#..#####./........./#..#####./........./#..#####./........./#..###.../........."),
	// A little tree with its star: what is aimed at.
	flag: spr("....#..../...###.../....#..../...###.../..#####../...###.../..#####../.#######./....#...."),
	// A sleigh.
	send: spr("........./##.....#./.#....##./.#######./.#######./..#####../..#...#.#/########./........."),
	// A ring biscuit.
	gear: spr("...###.../.#.###.#./.#######./###...###/###...###/###...###/.#######./.#.###.#./...###..."),
	// A sack.
	folder: spr("...#.#.../....#..../...###.../..#####../.#######./#########/#########/#########/.#######."),
	// An ice cream cone.
	dish: spr("..#####../.#######./#########/#########/.#.#.#.#./..#.#.#../...#.#.../....#..../....#...."),
	// A speech bubble with a heart in it.
	chat: spr(".#######./#########/##.#.#.##/##.....##/###...###/####.####/.#######./..##...../.##......"),
	// A snowflake.
	day: spr("....#..../.#.###.#./..#.#.#../.#..#..#./#########/.#..#..#./..#.#.#../.#.###.#./....#...."),
	// You, in a bobble hat.
	you: spr("....#..../...###.../..#####../..#####../...###.../.#######./#########/#########/........."),
	// A holly leaf.
	leaf: spr("......##./....####./...#####./..######./.######../.#####.../.###...../#......../........."),
	// A crescent biscuit: the moon.
	zzz: spr("...###.../..###..../.###...../.###...../.###...../.###...../..###...#/...#####./....###.."),
	// A gingerbread heart.
	heart: spr("........./.##...##./#########/###.#.###/#########/.#######./..#####../...###.../....#...."),
	note: spr("#######../#.....##./#.###.#.#/#.....###/#.#####.#/#.......#/#.#####.#/#.......#/#########"),
	eye: spr("........./..#####../.#.....#./#..###..#/#..###..#/#..###..#/.#.....#./..#####../........."),
	// A stocking: things drop into it.
	down: spr("..####.../..####.../..####.../..####.../..####.../..#####../..#######/...######/....####."),
};
/** Draws a sign in one color. */
function sign(name: Sign, x: number, y: number, c: string): void {
	const was = T;
	T = PLAIN;
	stamp(ICONS[name] ?? ICONS.gear, { "#": c }, x, y);
	T = was;
}

/** The sign of an event source, by its type. */
export function sourceSign(type: string | undefined, kind: ViewInput["kind"]): Sign {
	if (kind === "you") return "you";
	if (kind === "clock") return "clock";
	const t = type ?? "";
	if (/mail|smtp|imap/.test(t)) return "mail";
	if (/telegram|slack|matrix|discord|chat/.test(t)) return "chat";
	if (/folder|ftp|file/.test(t)) return "folder";
	if (/calendar/.test(t)) return "clock";
	if (/command|system|serial/.test(t)) return "term";
	if (/feed|http/.test(t)) return "web";
	return "dish";
}

// ---- the sky ---------------------------------------------------------------------------------------------------------

/** A soft light over the picture: drawn last, in flat rings. */
export interface Glow {
	x: number;
	y: number;
	r: number;
	color: string;
	a: number;
}

export type Season = "spring" | "summer" | "autumn" | "winter";

export interface Sky {
	/** 1 by day, 0 at night; how much of dusk or dawn there is. */
	day: number;
	dusk: number;
	sun?: { across: number; up: number };
	moon: { across: number; up: number; phase: number };
	/** The color at the top of the sky and at the horizon. */
	top: string;
	bottom: string;
	stars: number;
	hour: number;
	/** How high the sun stands: 1 at noon, 0 at the horizon, -1 deep in the night. Before noon or after. */
	e: number;
	am: boolean;
	/** The sky from the top down to the horizon, in four colors; a cloud's light, body and shade. */
	stops: [string, string, string, string];
	cloud: [string, string, string];
	/** What the light of the hour does to everything that stands outside. */
	grade: [number, number, number];
	season: Season;
	key: string;
}

/** The clock the sky follows: the owner's own. A test or a demo may set another. */
let clock = () => new Date();
export const setClock = (fn: () => Date) => void (clock = fn);

interface Hour {
	s: [string, string, string, string];
	c: [string, string, string];
	g: [number, number, number];
}
/** The sky by the height of the sun, in the evening; a morning is pinker and clearer (`am`). */
const HOURS: Array<{ e: number; pm: Hour; am?: Hour }> = [
	{ e: -0.7, pm: { s: ["#0a0e2c", "#121947", "#1d2563", "#2a337c"], c: ["#3d4784", "#2b3269", "#1c2251"], g: [0.4, 0.44, 0.74] } },
	{ e: -0.3, pm: { s: ["#10163f", "#1f2a6b", "#3d3f8a", "#6b4f96"], c: ["#6f5fa4", "#484183", "#2d2b60"], g: [0.5, 0.5, 0.8] }, am: { s: ["#111a45", "#22306f", "#44508f", "#7a6a9e"], c: ["#7a70aa", "#4d4a88", "#2f2f64"], g: [0.52, 0.54, 0.82] } },
	{ e: -0.07, pm: { s: ["#1f2a66", "#4a4390", "#b0608a", "#f58a5a"], c: ["#ffb48c", "#cc6c8c", "#5e4686"], g: [0.74, 0.6, 0.76] }, am: { s: ["#243270", "#56589e", "#d48aa6", "#ffbf8f"], c: ["#ffd2b2", "#e29cb2", "#6e5a96"], g: [0.76, 0.68, 0.82] } },
	{ e: 0.1, pm: { s: ["#3b56a6", "#7a7cc2", "#f0a078", "#ffd070"], c: ["#fff0c8", "#ffb890", "#b07a9c"], g: [1, 0.86, 0.72] }, am: { s: ["#4a78c8", "#8cb2e2", "#f8cdb0", "#ffe6b0"], c: ["#fffbe6", "#ffd9c0", "#b8a0c0"], g: [1, 0.93, 0.86] } },
	{ e: 0.32, pm: { s: ["#3688dc", "#62aeea", "#9ed4f5", "#d2eefb"], c: ["#ffffff", "#e6f1fb", "#b9d0ea"], g: [1, 1, 1] } },
	{ e: 1, pm: { s: ["#2a78d4", "#55a4e8", "#96cff4", "#c8eafb"], c: ["#ffffff", "#eaf4fd", "#c2d7ee"], g: [1, 1, 1] } },
];

/** The sky at a time. The view knows the time and not where the owner is: the day is as long as at a middle northern latitude. */
export function skyAt(date: Date): Sky {
	const hour = date.getHours() + date.getMinutes() / 60 + date.getSeconds() / 3600;
	const doy = (date.getTime() - new Date(date.getFullYear(), 0, 0).getTime()) / 86_400_000;
	const length = 12 + 4 * Math.sin((2 * Math.PI * (doy - 80)) / 365.25);
	const rise = 12.5 - length / 2;
	const set = 12.5 + length / 2;
	const across = (hour - rise) / length;
	const e = across > 0 && across < 1 ? Math.sin(Math.PI * across) : -Math.min(1, Math.min(Math.abs(hour - rise), Math.abs(hour - set), Math.abs(hour + 24 - rise), Math.abs(hour - 24 - set)) / 2);
	const am = ((hour - rise + 24) % 24) < length / 2 || ((rise - hour + 24) % 24) < (24 - length) / 2;
	const day = smooth(-0.12, 0.18, e);
	const dusk = clamp(1 - Math.abs(e) / 0.45) * 0.85;
	const phase = ((((date.getTime() - Date.UTC(2000, 0, 6, 18, 14)) / 86_400_000 / 29.530588) % 1) + 1) % 1;
	const intoNight = ((hour - set + 24) % 24) / (24 - length);
	const moon = { across: clamp(intoNight), up: intoNight < 1 ? Math.sin(Math.PI * clamp(intoNight)) : 0, phase };
	let i = 0;
	while (i < HOURS.length - 2 && e > HOURS[i + 1].e) i++;
	const a = HOURS[i];
	const b = HOURS[i + 1];
	const t = clamp((e - a.e) / (b.e - a.e));
	const ka = (am && a.am) || a.pm;
	const kb = (am && b.am) || b.pm;
	const stops = ka.s.map((c, n) => mix(c, kb.s[n], t)) as Sky["stops"];
	const cloud = ka.c.map((c, n) => mix(c, kb.c[n], t)) as Sky["cloud"];
	const grade = mulMix(ka.g, kb.g, t);
	// At the North Pole it is winter all year.
	const season: Season = "winter";
	// The picture is made anew only when the light has changed enough to see: a few times an hour by day, each minute at dusk.
	const key = `${Math.round(e * 60)}${am ? "a" : "p"}${season}`;
	return { day, dusk, sun: e > -0.06 ? { across: clamp(across), up: Math.max(0, e) } : undefined, moon, top: stops[0], bottom: stops[3], stars: clamp(1 - day * 1.6), hour, e, am, stops, cloud, grade, season, key };
}

/** The sky's color at a height: 0 at the top, 1 at the horizon. */
function skyColor(sky: Sky, v: number): string {
	const s = sky.stops;
	return v < 0.45 ? mix(s[0], s[1], v / 0.45) : v < 0.8 ? mix(s[1], s[2], (v - 0.45) / 0.35) : mix(s[2], s[3], clamp((v - 0.8) / 0.2));
}

const SKY_H = 208;
const BANDS = 16;
let skyStrip: { key: string; c: Canvas } | undefined;
/** The sky from top to horizon as a strip of bands, each scattered into the next: made when the light changes. */
function skyBands(sky: Sky): Canvas {
	if (skyStrip?.key === sky.key) return skyStrip.c;
	const c = paper(4, SKY_H);
	const was = g;
	g = penOf(c);
	const bh = SKY_H / BANDS;
	for (let b = 0; b < BANDS; b++) {
		const y = Math.round(b * bh);
		const col = skyColor(sky, b / (BANDS - 1));
		R(0, y, 4, Math.ceil(bh), col);
		// The band before reaches into this one in three thinning rows.
		if (b) {
			const prev = skyColor(sky, (b - 1) / (BANDS - 1));
			dither(0, y, 4, 2, prev, 10);
			dither(0, y + 2, 4, 2, prev, 6);
			dither(0, y + 4, 4, 2, prev, 2);
		}
	}
	g = was;
	skyStrip = { key: sky.key, c };
	return c;
}

const STARS = (() => {
	const r = seeded(7);
	// Most of them thin out towards the horizon; a band of them runs across the sky, as the Milky Way does.
	return Array.from({ length: 260 }, (_, i) => {
		const x = Math.floor(r() * 512);
		const y = i % 3 === 0 ? Math.floor(clamp(40 + (x - 256) * 0.22 + (r() - 0.5) * 46, 0, 190)) : Math.floor(r() ** 1.5 * 190);
		return { x, y, b: i % 3 === 0 ? r() * 0.7 : r(), hue: r() };
	});
})();

const HALOS = new Map<string, Canvas>();
/** A light as flat rings, each fainter than the one inside it: made once for a size and a color. */
function haloOf(r: number, color: string): Canvas {
	const key = `${r}${color}`;
	let c = HALOS.get(key);
	if (c) return c;
	if (HALOS.size > 120) HALOS.clear();
	c = paper(r * 2 + 1, r * 2 + 1);
	const p = penOf(c);
	p.fillStyle = color;
	for (let y = -r; y <= r; y++)
		for (let x = -r; x <= r; x++) {
			const d = Math.hypot(x, y) / r;
			if (d > 1) continue;
			p.globalAlpha = d < 0.2 ? 0.8 : d < 0.38 ? 0.46 : d < 0.58 ? 0.26 : d < 0.8 ? 0.13 : 0.06;
			p.fillRect(x + r, y + r, 1, 1);
		}
	HALOS.set(key, c);
	return c;
}
function halo(x: number, y: number, r: number, color: string, alpha = 1): void {
	g.globalAlpha = alpha;
	g.drawImage(haloOf(Math.round(r), color), Math.round(x - r), Math.round(y - r));
	g.globalAlpha = 1;
}

const CLOUDS = new Map<number, Sprite>();
/** A cloud of its own shape: bumps on a flat bottom, lit from the upper left, shaded underneath. */
function cloudOf(seed: number, width: number): Sprite {
	let s = CLOUDS.get(seed);
	if (s) return s;
	const r = seeded(seed);
	const n = Math.max(3, Math.round(width / 9) + Math.floor(r() * 2));
	const lumps = Array.from({ length: n }, (_, i) => {
		const u = (i + 0.5) / n;
		const big = 1 - Math.abs(u - 0.45 - r() * 0.1) * 1.5;
		return { cx: u * width + (r() - 0.5) * 3, rad: Math.max(2.5, width * (0.1 + 0.14 * big + r() * 0.05)) };
	});
	// The picture is as wide as its bumps reach, so that none is cut off at its edge.
	const from = Math.floor(Math.min(...lumps.map((l) => l.cx - l.rad))) - 1;
	const w = Math.ceil(Math.max(...lumps.map((l) => l.cx + l.rad))) + 1 - from;
	for (const l of lumps) l.cx -= from;
	const hgt = Array.from({ length: w }, (_, x) => {
		let top = 0;
		let side = 0;
		for (const l of lumps) {
			const d = l.rad * l.rad - (x - l.cx) ** 2;
			const y = d > 0 ? Math.sqrt(d) + l.rad * 0.25 : 0;
			if (y > top) (top = y), (side = x - l.cx);
		}
		return { top: Math.round(top), side };
	});
	const H = Math.max(...hgt.map((v) => v.top)) + 2;
	const rows = Array.from({ length: H }, () => Array<string>(w).fill("."));
	for (let x = 0; x < w; x++) {
		const { top, side } = hgt[x];
		if (top < 1) continue;
		const under = (x * 7 + seed) % 11 < 3 || x < 2 || x > w - 3 ? 1 : 0;
		const y0 = H - 1 - top;
		const y1 = H - 1 - under;
		for (let y = y0; y <= y1; y++) {
			const fromTop = y - y0;
			const fromBottom = y1 - y;
			// Lit on top and on the left shoulder of each bump; shaded along the bottom, deeper under its right side.
			const lit = fromTop < Math.max(1, top * (side < 0 ? 0.42 : 0.24));
			const shade = fromBottom < Math.max(1, top * (side > 0 ? 0.36 : 0.22));
			rows[y][x] = shade ? ((x + y) % 2 && fromBottom === Math.floor(top * 0.22) ? "b" : "c") : lit ? "a" : fromTop === Math.floor(top * 0.42) && (x + y) % 2 ? "a" : "b";
		}
	}
	s = { id: spriteIds++, w, h: H, rows: rows.map((row) => row.join("")) };
	CLOUDS.set(seed, s);
	return s;
}

const TILE = 512;
interface Land {
	key: string;
	far: Canvas;
	mid: Canvas;
	near: Canvas;
	colors: { far: string; mid: string; near: string };
}
let land: Land | undefined;

/** A height along a line that comes round again after TILE pixels: waves of whole counts, some of them sharp. */
function ridge(seed: number, parts: Array<[number, number, boolean?]>): (x: number) => number {
	const r = seeded(seed);
	const ph = parts.map(() => r() * Math.PI * 2);
	return (x) => {
		let h = 0;
		parts.forEach(([n, amp, sharp], i) => {
			const v = Math.sin((2 * Math.PI * n * x) / TILE + ph[i]);
			h += amp * (sharp ? 1 - 2 * Math.abs(v) : v);
		});
		return h;
	};
}

/** A small pine as it stands on a far hill: tiers that widen downwards, lit on the left. */
function farPine(x: number, base: number, h: number, c: string): void {
	for (let j = 0; j < h; j++) {
		const half = Math.floor(((j % 3) + 1 + j / 3) * 0.7);
		R(x - half, base - h + j, half * 2 + 1, 1, c);
		if (half) R(x - half, base - h + j, 1, 1, tone(c, 1));
	}
	R(x, base, 1, 1, tone(c, -2));
}

const PINE = "#4a8580";
const SNOW = "#f2f7fd";

/** The land behind the workshop, in three depths: peaks of ice, snowy hills with a hut or two, the near snowfield. Made when the light changes. */
function landOf(sky: Sky): Land {
	if (land?.key === sky.key) return land;
	const out = tintOf(sky.grade);
	const haze = sky.stops[3];
	const was = g;
	const wasT = T;
	T = PLAIN;
	const light = (c: string) => {
		T = out;
		const v = C(c);
		T = PLAIN;
		return v;
	};
	const dark = sky.day < 0.45;
	const farC = mix(light("#7f97dc"), haze, 0.34);
	const midC = mix(light("#cfdcf0"), haze, 0.28);
	const nearC = mix(light("#e9f1fb"), haze, 0.08);

	// Peaks of ice: steep, white from the top far down, blue where the rock and the old ice show.
	const FH = 150;
	const far = paper(TILE, FH);
	g = penOf(far);
	const fh = ridge(11, [[2, 20], [3, 30, true], [7, 16, true], [13, 7, true], [29, 2]]);
	const snow = mix(light("#ffffff"), haze, 0.2);
	const ice = mix(light("#bfe3f6"), haze, 0.3);
	for (let x = 0; x < TILE; x++) {
		const h = Math.round(88 + fh(x));
		const rising = fh(x + 1) > fh(x);
		R(x, FH - h, 1, h, rising ? tone(farC, 1) : farC);
		if (!rising) R(x, FH - h, 1, 1 + ((x + h) % 2), tone(farC, 1));
		if (rising && (x * 7) % 13 < 5) R(x, FH - h + 30 + ((x * 3) % 9), 1, 5, farC);
		if (!rising && (x * 5) % 11 < 3) R(x, FH - h + 34 + ((x * 3) % 12), 1, 6, tone(farC, -1));
		// The snow: its lower edge ragged, the shaded side a little blue.
		const cap = h - 42 + ((x * 5) % 7) - (rising ? 0 : 5);
		if (cap > 0) R(x, FH - h, 1, Math.min(cap, 46), rising ? snow : tone(snow, -1));
		// A glacier's blue cracks in it.
		if (cap > 12 && (x * 11) % 17 < 2) R(x, FH - h + 6 + ((x * 7) % 9), 1, 4, ice);
		if ((x + 1) % 2) R(x, FH - 16 - ((x * 3) % 5), 1, 16 + ((x * 3) % 5), mix(farC, haze, 0.4));
		R(x, FH - 9, 1, 9, mix(farC, haze, 0.65));
	}

	// Hills of snow: frosted pines, a hut with a light in its window, an igloo.
	const mid = paper(TILE, 64);
	g = penOf(mid);
	const mh = ridge(23, [[1, 6], [3, 7], [5, 4], [11, 2]]);
	const wood = mix(light(PINE), haze, 0.3);
	const frost = mix(light("#ffffff"), haze, 0.22);
	const rm = seeded(5);
	const top = (x: number) => 64 - Math.round(26 + mh(x));
	for (let x = 0; x < TILE; x++) R(x, top(x), 1, 64, midC), R(x, top(x), 1, 1, frost);
	for (let x = 0; x < TILE; x += 3) dither(x, top(x) + 6 + ((x * 7) % 9), 3, 1, tone(midC, -1), 8);
	for (let x = 2; x < TILE - 2; x += 2 + Math.floor(rm() * 4)) {
		const base = top(x) + 1;
		const what = rm();
		if (what < 0.62) {
			const h = 5 + Math.floor(rm() * 5);
			farPine(x, base, h, wood);
			R(x, base - h, 1, 1, frost);
			if (h > 6) R(x - 1, base - h + 3, 2, 1, frost);
		} else if (what < 0.68 && x > 8 && x < TILE - 10) {
			// A hut: a snowed-in roof, a chimney, one window.
			const hut = mix(light("#9a5a3c"), haze, 0.25);
			R(x - 3, base - 4, 7, 5, hut);
			R(x - 4, base - 6, 9, 2, frost);
			R(x - 3, base - 7, 7, 1, frost);
			R(x + 2, base - 9, 1, 2, tone(hut, -1));
			R(x - 1, base - 3, 2, 2, dark ? "#ffd98a" : tone(hut, -2));
			x += 6;
		} else if (what < 0.72 && x > 8 && x < TILE - 10) {
			disc(x, base, 3, frost);
			R(x - 4, base + 1, 9, 4, midC);
			R(x, base - 1, 1, 2, tone(midC, -2));
			x += 5;
		}
	}

	// The near snowfield: drifts, pines under their load, blocks of ice.
	const near = paper(TILE, 44);
	g = penOf(near);
	const nh = ridge(41, [[1, 4], [2, 5], [5, 2.5], [9, 1]]);
	const rn = seeded(9);
	const ntop = (x: number) => 44 - Math.round(20 + nh(x));
	for (let x = 0; x < TILE; x++) {
		R(x, ntop(x), 1, 44, nearC);
		R(x, ntop(x), 1, 1, light("#ffffff"));
	}
	for (let i = 0; i < 110; i++) {
		const x = Math.floor(rn() * TILE);
		const y = ntop(x) + 3 + Math.floor(rn() * 16);
		R(x, y, 2 + Math.floor(rn() * 5), 1, rn() < 0.7 ? tone(nearC, -1) : light("#ffffff"));
	}
	const pineC = light(PINE);
	for (let x = 14; x < TILE - 10; x += 16 + Math.floor(rn() * 30)) {
		const base = ntop(x) + 2;
		const what = rn();
		if (what < 0.62) {
			const h = 9 + Math.floor(rn() * 7);
			farPine(x, base, h, pineC);
			R(x - 1, base - h, 3, 1, light("#ffffff"));
			R(x - 2, base - h + 4, 3, 1, light("#ffffff"));
			R(x, base - h + 7, 3, 1, light("#eaf2fb"));
		} else if (what < 0.8) {
			// Ice, pushed up in blocks.
			const c = light("#a8dcf2");
			R(x - 3, base - 4, 5, 5, c);
			R(x - 3, base - 4, 5, 1, light("#ffffff"));
			R(x + 2, base - 2, 4, 3, tone(c, -1));
			R(x + 2, base - 3, 3, 1, light("#e6f6fd"));
			R(x - 3, base - 3, 1, 4, light("#d8f0fb"));
		} else {
			// A candy cane somebody stuck into the snow as a mark.
			for (let j = 0; j < 7; j++) R(x, base - 7 + j, 1, 1, j % 2 ? light("#e5484d") : light("#ffffff"));
			R(x + 1, base - 8, 2, 1, light("#e5484d"));
			R(x + 3, base - 7, 1, 2, light("#ffffff"));
		}
	}
	g = was;
	T = wasT;
	land = { key: sky.key, far, mid, near, colors: { far: farC, mid: midC, near: nearC } };
	return land;
}

const BIRD_FAR = [spr("#...#/.#.#./..#.."), spr("...../##.##/..#.."), spr("...../..#../##.##")];
/** A reindeer at the gallop, in two beats; the sleigh it pulls, with its sack. */
const REINDEER = [
	spr(`
........y.y.
.........yy.
........bbb.
t.bbbbbbbben
.bbbbbbbbb..
.bccccccb...
.b.b...b.b..
b...b.b...b.
`),
	spr(`
........y.y.
.........yy.
........bbb.
t.bbbbbbbben
.bbbbbbbbb..
.bccccccb...
..bb...bb...
...b...b....
`),
];
const SLEIGH = spr(`
....ggg........
...gggggpq.....
r..ggggppqq....
rr.rrrrrrrrrr..
rwwwwwwwwwwwr.k
.rrrrrrrrrrr.k.
..k.......k.k..
kkkkkkkkkkkk...
`);
/** Where things stand on the screen for a depth: how far a layer moves when the camera does. */
interface Depth {
	vw: number;
	vh: number;
	/** The camera's middle, in the world: a layer stays where it is around it when the camera zooms. */
	cx: number;
	/** The ground's line on the screen, and where it is when the camera stands on the ground. */
	ground: number;
	home: number;
}
const baseOf = (d: Depth, f: number) => Math.round(d.home + (d.ground - d.home) * f);

/** A strip that comes round again, drawn across the screen at a depth; what lies below it is filled with its color. */
function strip(c: Canvas, d: Depth, f: number, fill: string, lift = 0): number {
	const base = baseOf(d, f) - lift;
	const off = ((Math.floor(d.vw / 2 - d.cx * f) % TILE) + TILE) % TILE;
	for (let x = off - TILE; x < d.vw; x += TILE) g.drawImage(c, x, base - c.height);
	if (base < d.vh) {
		g.fillStyle = fill;
		g.fillRect(0, base, d.vw, d.vh - base);
	}
	return base;
}

/** The sky and the land behind the workshop: bands of color, stars, the sun or the moon, clouds, the hills, what flies. */
function drawBackdrop(d: Depth, sky: Sky, t: number, glows: Glow[]): void {
	const horizon = baseOf(d, 0.1) - 8;
	g.fillStyle = sky.stops[0];
	g.fillRect(0, 0, d.vw, d.vh);
	const top = horizon - SKY_H;
	g.save();
	g.translate(0, top);
	g.fillStyle = g.createPattern(skyBands(sky), "repeat")!;
	g.fillRect(0, 0, d.vw, SKY_H);
	g.restore();
	if (horizon < d.vh) {
		g.fillStyle = sky.stops[3];
		g.fillRect(0, horizon, d.vw, d.vh - horizon);
	}
	const night = 1 - sky.day;

	if (sky.stars > 0.03) {
		const off = Math.floor(d.vw / 2 - d.cx * 0.02);
		for (const s of STARS)
			for (let x = ((((s.x + off) % 512) + 512) % 512) - 512; x < d.vw; x += 512) {
			if (x < 0) continue;
			const y = top + 4 + s.y;
			if (y < 0 || y > horizon - 6) continue;
			// A star is on or off or half: it twinkles in steps, as pixels do.
			const tw = Math.floor(t / 420 + s.b * 37) % 7;
			const level = sky.stars * (s.b > 0.8 ? 1 : 0.4 + s.b * 0.55) * (tw === 0 ? 0.4 : tw === 3 ? 0.75 : 1);
			if (level < 0.2) continue;
			g.globalAlpha = level > 0.75 ? 1 : level > 0.5 ? 0.7 : 0.4;
			g.fillStyle = s.hue > 0.85 ? "#ffe9b8" : s.hue < 0.12 ? "#b8d0ff" : "#f2f4ff";
			g.fillRect(x, y, 1, 1);
			if (s.b > 0.9 && tw !== 0) {
				g.globalAlpha *= 0.55;
				g.fillRect(x - 1, y, 3, 1);
				g.fillRect(x, y - 1, 1, 3);
			}
		}
		g.globalAlpha = 1;
		// A shooting star now and then.
		const cycle = 23_000;
		const k = (t % cycle) / 700;
		if (k < 1 && sky.stars > 0.6) {
			const r = seeded(Math.floor(t / cycle) + 3);
			const sx = Math.round(d.vw * (0.2 + r() * 0.6) + k * 46);
			const sy = Math.round(top + 20 + r() * 60 + k * 22);
			for (let i = 0; i < 9; i++) {
				g.globalAlpha = (1 - i / 9) * (1 - k * 0.5);
				g.fillStyle = i < 2 ? "#ffffff" : "#bcd0ff";
				g.fillRect(sx - i * 2, sy - i, 2, 1);
			}
			g.globalAlpha = 1;
		}
	}

	// The northern lights: curtains of rays that sway, brightest along their lower edge.
	if (sky.stars > 0.35) {
		const a = (sky.stars - 0.35) / 0.65;
		const HUES = ["#5cf2b0", "#58d8ff", "#b48cff"];
		for (let band = 0; band < 3; band++) {
			const hue = HUES[band];
			const edge = mix(hue, "#ffffff", 0.35);
			for (let x = 0; x < d.vw; x += 3) {
				const u = (x - d.vw / 2 + d.cx * 0.02) / 84 + band * 1.7;
				const strength = 0.5 + 0.5 * Math.sin(u * 1.3 + t / 4300 + band * 2.1);
				if (strength < 0.12) continue;
				const base = Math.round(top + SKY_H * (0.16 + band * 0.15) + Math.sin(u + t / 9000) * 16 + Math.sin(u * 2.3 - t / 6100 + band) * 7);
				const len = Math.round(34 + Math.sin(u * 3.1 + t / 2700) * 12 + Math.sin(u * 7.7 - t / 1900) * 6);
				if (base > horizon - 10) continue;
				g.fillStyle = hue;
				for (let k = 0; k < 3; k++) {
					g.globalAlpha = a * strength * [0.5, 0.3, 0.14][k];
					g.fillRect(x, base - Math.round(((k + 1) * len) / 3), 3, Math.ceil(len / 3));
				}
				g.globalAlpha = a * strength * 0.85;
				g.fillStyle = edge;
				g.fillRect(x, base, 3, 2);
			}
		}
		g.globalAlpha = 1;
	}

	// The sun and the moon cross the whole sky that shows: high over the roof at noon, down behind the hills at dusk.
	const arc = (across: number, up: number) => ({ x: Math.round(d.vw * (0.06 + 0.88 * across)), y: Math.round(horizon - 4 - up * Math.max(40, horizon - 30)) });
	if (sky.sun) {
		const p = arc(sky.sun.across, sky.sun.up);
		const low = 1 - smooth(0, 0.3, sky.e);
		const rad = 8 + Math.round(low * 3);
		const core = mix("#fff6c8", "#ffb45e", low);
		const rim = mix("#ffe07a", "#ff7a4a", low);
		halo(p.x, p.y, rad * 5, mix("#fff6c8", "#ffb070", low), 0.55);
		// Rays that breathe: every second one longer, and they change places.
		const beat = Math.floor(t / 700) % 2;
		g.fillStyle = rim;
		for (let i = 0; i < 8; i++) {
			const a = (i * Math.PI) / 4;
			const len = (i + beat) % 2 ? 3 : 5;
			for (let k = 0; k < len; k++) g.fillRect(Math.round(p.x + Math.cos(a) * (rad + 3 + k)), Math.round(p.y + Math.sin(a) * (rad + 3 + k)), 1, 1);
		}
		disc(p.x, p.y, rad, rim);
		disc(p.x, p.y, rad - 2, core);
		disc(p.x - 2, p.y - 2, Math.max(1, rad - 6), mix(core, "#ffffff", 0.6));
		if (low > 0.3) glows.push({ x: p.x, y: p.y, r: 60, color: mix("#ffe9a0", "#ff8a4a", low), a: 0.5 * low });
	}
	if (sky.moon.up > 0 && sky.day < 0.75) {
		const p = arc(sky.moon.across, sky.moon.up);
		const rad = 7;
		halo(p.x, p.y, 26, "#c4d0ff", 0.5 * night);
		disc(p.x, p.y, rad, "#f6f1dc");
		disc(p.x - 1, p.y - 1, rad - 2, "#fffbea");
		g.fillStyle = "#d6cfb4";
		g.fillRect(p.x - 3, p.y - 2, 2, 2);
		g.fillRect(p.x + 1, p.y + 2, 2, 1);
		g.fillRect(p.x + 2, p.y - 3, 1, 1);
		g.fillRect(p.x - 2, p.y + 3, 1, 1);
		// Waxing, it is lit from the right and the shadow moves off to the left; waning, the other way round.
		const ph = sky.moon.phase;
		const off = Math.round(2 * rad * (ph < 0.5 ? ph / 0.5 : (1 - ph) / 0.5)) * (ph < 0.5 ? -1 : 1);
		if (Math.abs(ph - 0.5) > 0.03) disc(p.x + off, p.y, rad, skyColor(sky, clamp((p.y - top) / SKY_H)));

	}

	// Clouds drift over a stretch of sky that comes round again; where each is does not depend on how much shows.
	const SPAN = 640;
	const clouds = (layer: number, count: number, f: number, speed: number, size: [number, number], band: [number, number]) => {
		for (let i = 0; i < count; i++) {
			const r = seeded(layer * 100 + i);
			const w = Math.round(size[0] + r() * (size[1] - size[0]));
			const s = cloudOf(layer * 1000 + i, w);
			const at = (((r() * SPAN + (t / 1000) * speed * (0.7 + r() * 0.6) - d.cx * f) % SPAN) + SPAN) % SPAN;
			const y = Math.round(top + SKY_H * (band[0] + r() * (band[1] - band[0])) - s.h);
			for (let x = Math.floor(d.vw / 2 + at - SPAN / 2) - SPAN; x < d.vw; x += SPAN) if (x + s.w > 0) stamp(s, { a: sky.cloud[0], b: sky.cloud[1], c: sky.cloud[2] }, x, y);
		}
	};
	T = PLAIN;
	clouds(1, 7, 0.04, 0.5, [22, 46], [0.6, 0.86]);

	const l = landOf(sky);
	strip(l.far, d, 0.1, l.colors.far);
	clouds(2, 4, 0.08, 1.1, [40, 70], [0.3, 0.62]);

	// Reindeer in harness, a sleigh behind them, across the whole sky: by day and by night, in bounds.
	{
		const cycle = 64_000;
		const k = (t % cycle) / 30_000;
		if (k < 1) {
			const n = Math.floor(t / cycle);
			const r = seeded(n + 77);
			const dir = n % 2 ? -1 : 1;
			const y0 = top + SKY_H * (0.34 + r() * 0.2);
			const lead = dir > 0 ? -70 + k * (d.vw + 150) : d.vw + 70 - k * (d.vw + 150);
			const yAt = (x: number) => Math.round(y0 + Math.sin(x / 38 + n) * 9 - Math.sin(k * Math.PI) * 14);
			T = tintOf(mulMix(sky.grade, [1, 1, 1], 0.35));
			const coat = { b: "#9a6540", c: "#c08a5c", e: INK, y: "#e2c08a", t: "#fff6e6" };
			const beat = Math.floor(t / 150);
			const sx = Math.round(lead - dir * 52);
			// The traces, then the sleigh, then the three that pull it.
			line(sx + dir * 6, yAt(sx) + 4, Math.round(lead - dir * 8), yAt(lead - dir * 8) + 4, "#6b4a3a");
			stamp(SLEIGH, { r: "#d8362f", w: "#fff6e6", k: "#f2c84a", g: "#7a8a4a", p: "#4a90d9", q: "#f2b33d" }, sx - 7, yAt(sx) - 2, dir < 0);
			for (let i = 2; i >= 0; i--) {
				const x = Math.round(lead - dir * i * 15);
				stamp(REINDEER[(beat + i) % 2], { ...coat, n: i === 0 ? "#ff4d4d" : "#3a2a2a" }, x - 6, yAt(x) - 3 - ((beat + i) % 2), dir < 0);
			}
			T = PLAIN;
			// The first one's nose shows the way.
			const nx = Math.round(lead) + dir * 5;
			const ny = yAt(lead) - (beat % 2);
			// Its light is drawn here and not with the lamps, which shine over everything: the workshop hides it as it hides the team.
			halo(nx, ny, 6, "#ff5a4a", 0.35 + 0.5 * night);
			g.fillStyle = "#ff4d4d";
			g.fillRect(nx, ny, 1, 1);
			// What the runners leave in the air.
			for (let i = 0; i < 12; i++) {
				const x = sx - dir * (9 + i * 5);
				const tw = Math.floor(t / 110 + i * 1.7) % 4;
				if (tw === 3) continue;
				g.globalAlpha = 1 - i / 13;
				g.fillStyle = i % 3 === 0 ? "#fff6c8" : i % 3 === 1 ? "#ffe27a" : "#ffffff";
				g.fillRect(Math.round(x), yAt(x) + 5 + ((i * 7) % 5) - 2, tw === 0 ? 2 : 1, 1);
			}
			g.globalAlpha = 1;
		}
	}
	// Geese in a wedge, far away.
	if (sky.day > 0.35) {
		const cycle = 31_000;
		const k = (t % cycle) / 19_000;
		if (k < 1) {
			const r = seeded(Math.floor(t / cycle) + 5);
			const dir = r() > 0.5 ? 1 : -1;
			const y0 = top + SKY_H * (0.3 + r() * 0.35);
			const n = 5 + Math.floor(r() * 4);
			const c = mix(sky.stops[0], "#1d2238", 0.75);
			for (let b = 0; b < n; b++) {
				const rank = Math.ceil(b / 2) * (b % 2 ? 1 : -1);
				const bx = Math.round((dir > 0 ? -30 + k * (d.vw + 60) : d.vw + 30 - k * (d.vw + 60)) - dir * Math.abs(rank) * 6);
				const by = Math.round(y0 + rank * 3 + Math.sin(t / 500 + b) * 1.2);
				stamp(BIRD_FAR[Math.floor(t / 150 + b * 1.7) % 3], { "#": c }, bx - 2, by);
			}
		}
	}

	strip(l.mid, d, 0.26, l.colors.mid);
	clouds(3, 3, 0.14, 2, [64, 104], [0.08, 0.4]);
	strip(l.near, d, 0.5, l.colors.near);
}

// ---- Santa and his elves -----------------------------------------------------------------------------------------------

export interface Look {
	/** Its pointed cap: one that flops, one that stands with a bell, a long striped one, one bent forward with a star. */
	hat: number;
	hair: number;
	extra: number;
	skin: string;
	hairC: string;
	tunic: string;
	seed: number;
}

/** What somebody is doing with their body. */
export type Pose = "stand" | "walk" | "sit" | "type" | "read" | "think" | "wait" | "ask" | "cheer" | "sad" | "sleep" | "sip" | "rack" | "hand" | "water" | "look" | "skill" | "list" | "wrap";

const ELF_SKINS = ["#f6cfae", "#eeb98f", "#d69a6e", "#a8703f", "#fbe2cc", "#8a5a3c"];
const ELF_HAIRS = ["#33241a", "#7a4a2a", "#e2b04a", "#d8642e", "#f2efe6", "#1c1a22"];
const TUNICS = ["#2f8a58", "#c0392b", "#2b6fb8", "#7a4fb0", "#d08a1e", "#1f8f8f", "#8a5a3a", "#c2528a"];
const BLUSH = "#ff8fa0";
const GOLD = "#f2cf6a";
const FUR = "#fff6e6";
const GINGER = "#b5713c";
const ICING = "#fffaf0";
const ROOF_RED = "#b8473c";
const BRICK = "#c8775a";
const SANTA_RED = "#d8362f";
const BOOT = "#2a2430";

/** The elf of an agent, from its name: different for each, the same every time. */
export function lookOf(id: string): Look {
	const seed = hashOf(id);
	const r = seeded(seed);
	const pick = (n: number) => Math.floor(r() * n);
	return { hat: pick(4), hair: pick(5), extra: pick(4), skin: ELF_SKINS[pick(ELF_SKINS.length)], hairC: ELF_HAIRS[pick(ELF_HAIRS.length)], tunic: TUNICS[pick(TUNICS.length)], seed };
}

const BOOK = spr("aaaaaaa/abbcbba/abbcbba/abbcbba/aaaaaaa");
const MUG = spr("aaa./aaab/aaab/aaa.");
const CAN = spr("...a.../aaaa..b/aaaaab./aaaa.../aaaa...");
/** A present: a box with a ribbon round it and a bow on top. Small, as an elf holds it; bigger, as it flies. */
const PRESENT = spr(".rr.rr./..rrr../aaaraab/aaaraab/rrrrrrs/aaaraab/bbbsbbb");
const GIFT = spr("..rr.rr../...rrr.../aaaaraaab/aaaaraaab/rrrrrrrrs/aaaaraaab/aaaaraaab/bbbbsbbbb");

/** The colors of a present for its box: a ribbon that shows on it. */
function wrapOf(c: string): Record<string, string> {
	const [r, gg, b] = rgb(c);
	const pale = r * 0.299 + gg * 0.587 + b * 0.114 > 170;
	const ribbon = pale ? "#d8362f" : "#fff6e6";
	return { a: c, b: tone(c, -1), r: ribbon, s: tone(ribbon, -1) };
}

/** Rows of pixels in one color with a dark edge all round them: [x, y, width] each. */
function rowsOf(rows: Array<[number, number, number]>, c: string): void {
	for (const [x, y, w] of rows) R(x - 1, y - 1, w + 2, 3, INK);
	for (const [x, y, w] of rows) R(x, y, w, 1, c);
}

export interface FolkArgs {
	pose: Pose;
	t: number;
	/** Which way it faces: 1 right, -1 left. */
	dir?: 1 | -1;
	small?: boolean;
	/** Santa. */
	main?: boolean;
	/** Set after outside content: the bobble of its cap glows in this color. */
	eye?: string;
	shield?: boolean;
	lit?: boolean;
	/** The color of what it holds: a book, a present. */
	prop?: string;
	/** What it works with at its bench: a hammer, a brush, a wrench. */
	tool?: number;
}

/** A pointed cap on a head whose top is at `top` and whose middle is `cx`; its tip falls to the side `back`. */
function drawCap(kind: number, c: string, cx: number, top: number, back: 1 | -1, o: { small: boolean; santa: boolean; sway: number; glow?: string; lit: boolean; t: number }): void {
	const at = (off: number, w: number) => (back < 0 ? cx + off : cx - off - w + 1);
	const rows = (list: Array<[number, number, number]>): Array<[number, number, number]> => list.map(([off, dy, w]) => [at(off, w), top + dy, w]);
	const blink = Math.floor(o.t / 260) % 2 === 0;
	const tipC = o.glow ? (blink ? o.glow : tone(o.glow, -1)) : o.lit && Math.floor(o.t / 300) % 3 === 0 ? "#ffffff" : undefined;
	const bobble = (off: number, dy: number, size: number, base: string) => {
		const x = at(off, size);
		R(x - 1, top + dy - 1, size + 2, size + 2, INK);
		R(x, top + dy, size, size, tipC ?? base);
		if (!tipC && size > 2) R(x + size - 1, top + dy + size - 1, 1, 1, tone(base, -1));
	};
	if (o.small) {
		rowsOf(rows([[-3, -2, 7], [-3, -3, 6], [-4, -4, 4], [-5, -5, 3]]), c);
		R(at(-3, 2), top - 3, 2, 1, tone(c, 1));
		bobble(-7, -4 + o.sway, 2, FUR);
		rowsOf(rows([[-4, -1, 9]]), FUR);
		return;
	}
	if (o.santa) {
		rowsOf(rows([[-6, -2, 13], [-6, -3, 12], [-6, -4, 10], [-7, -5, 8], [-7, -6, 6], [-8, -7, 4], [-9, -6, 2], [-10, -5, 2]]), c);
		for (const [off, dy, w] of [[-6, -3, 3], [-6, -4, 3], [-7, -5, 2], [-7, -6, 2]]) R(at(off, w), top + dy, w, 1, tone(c, 1));
		R(at(3, 4), top - 2, 4, 1, tone(c, -1));
		bobble(-12, -4 + o.sway, 3, FUR);
		rowsOf(rows([[-7, -1, 15], [-7, 0, 15]]), FUR);
		R(at(-7, 15), top, 15, 1, tone(FUR, -1));
		return;
	}
	if (kind === 0) {
		// The cap of caps: it flops over, a bobble at its end.
		rowsOf(rows([[-5, -2, 11], [-5, -3, 10], [-5, -4, 8], [-6, -5, 7], [-6, -6, 5], [-7, -7, 4], [-8, -6, 2], [-9, -5, 2]]), c);
		for (const [off, dy, w] of [[-5, -3, 3], [-5, -4, 2], [-6, -5, 2], [-6, -6, 2]]) R(at(off, w), top + dy, w, 1, tone(c, 1));
		R(at(3, 3), top - 2, 3, 1, tone(c, -1));
		bobble(-11, -4 + o.sway, 3, FUR);
	} else if (kind === 1) {
		// It stands up, a little bell on top.
		rowsOf(rows([[-5, -2, 11], [-4, -3, 9], [-3, -4, 7], [-3, -5, 7], [-2, -6, 5], [-1, -7, 3], [-1, -8, 3], [0, -9, 1]]), c);
		for (const [off, dy] of [[-4, -3], [-3, -4], [-3, -5], [-2, -6], [-1, -7]]) R(at(off, 2), top + dy, 2, 1, tone(c, 1));
		R(at(0, 1) + o.sway, top - 11, 1, 1, INK);
		bobble(-1 + (back < 0 ? o.sway : -o.sway), -12, 2, GOLD);
	} else if (kind === 2) {
		// A long one in stripes that hangs down the back.
		const list: Array<[number, number, number]> = [[-5, -2, 11], [-5, -3, 10], [-6, -4, 9], [-7, -5, 7], [-8, -4, 2], [-9, -3, 3], [-9, -2, 3], [-9, -1, 3], [-9, 0, 2], [-9, 1, 2]];
		rowsOf(rows(list), c);
		list.forEach(([off, dy, w], i) => i % 2 === 1 && R(at(off, w), top + dy, w, 1, FUR));
		bobble(-10, 3 + o.sway, 3, FUR);
	} else {
		// Its tip leans forward, and a star sits on it.
		rowsOf(rows([[-5, -2, 11], [-4, -3, 10], [-3, -4, 8], [-1, -5, 6], [0, -6, 5], [2, -7, 3], [3, -8, 2]]), c);
		for (const [off, dy] of [[-4, -3], [-3, -4], [-1, -5], [0, -6]]) R(at(off, 2), top + dy, 2, 1, tone(c, 1));
		const sx = at(4, 3);
		const star = tipC ?? GOLD;
		R(sx, top - 11 + o.sway, 3, 3, INK);
		R(sx - 1, top - 10 + o.sway, 5, 1, INK);
		R(sx + 1, top - 12 + o.sway, 1, 5, INK);
		R(sx + 1, top - 11 + o.sway, 1, 3, star);
		R(sx, top - 10 + o.sway, 3, 1, star);
	}
	// The band of the cap, all round the brow.
	rowsOf(rows([[-6, -1, 13], [-6, 0, 13]]), FUR);
	R(at(-6, 13), top, 13, 1, tone(FUR, -1));
}

/** An elf, or Santa, with their feet on (`x`, `y`), `x` their middle; seated, `y` is the seat. Returns the box they take. */
function drawFolk(look: Look, color: string, x: number, y: number, o: FolkArgs): Box {
	const s = Boolean(o.small);
	const santa = Boolean(o.main) && !s;
	const HW = santa ? 13 : s ? 7 : 11;
	const HH = santa ? 9 : s ? 6 : 8;
	const BW = santa ? 13 : s ? 5 : 9;
	const BH = santa ? 8 : s ? 4 : 6;
	const LEG = s ? 2 : 3;
	const t = o.t + (look.seed % 977);
	const dir = o.dir ?? 1;
	const pose = o.pose;
	const seated = pose === "sit" || pose === "type" || pose === "wait" || pose === "sleep" || pose === "wrap";
	const f4 = Math.floor(t / 130) % 4;
	const hop = pose === "cheer" ? [0, 2, 3, 2][Math.floor(t / 110) % 4] : pose === "ask" ? [0, 1, 2, 1][Math.floor(t / 140) % 4] : 0;
	const step = pose === "walk" && f4 % 2 === 1 ? 1 : 0;
	const cx = Math.round(x);
	const feet = Math.round(y) - hop;
	const bodyBottom = seated ? feet : feet - LEG;
	const bodyTop = bodyBottom - BH - step;
	const breathe = pose === "type" || pose === "wrap" ? Math.floor(t / 170) % 2 : pose === "sleep" ? (Math.floor(t / 1100) % 2 ? 1 : 0) : Math.floor(t / 650) % 2;
	const droop = pose === "sad" || pose === "sleep" ? 1 : 0;
	const headBottom = bodyTop + droop + (pose === "sleep" ? breathe : 0);
	const headTop = headBottom - HH - (pose === "sleep" || pose === "sad" ? 0 : breathe);
	const hx = cx - Math.floor(HW / 2) + (pose === "sleep" ? dir : 0);
	const hcx = hx + Math.floor(HW / 2);
	const bx = cx - Math.floor(BW / 2);
	const skin = santa ? "#f6cfae" : look.skin;
	const coat = santa ? SANTA_RED : look.tunic;
	const stripe = santa ? BOOT : color;
	const shoe = santa ? BOOT : tone(coat, -2);
	const lw = santa ? 3 : s ? 1 : 2;
	const sw = santa ? 4 : s ? 2 : 3;

	// Legs: striped stockings and shoes with a curl at the toe; Santa's are boots. Seated, they stick out in front and swing.
	const stocking = (lx: number, top: number, h: number) => {
		for (let j = 0; j < h; j++) R(lx, top + j, lw, 1, santa ? (j === 0 ? FUR : BOOT) : j % 2 ? stripe : "#ffffff");
	};
	const foot = (lx: number, fy: number) => {
		R(lx - (dir < 0 ? sw - lw : 0), fy, sw, 1, shoe);
		if (!santa && !s) R(dir > 0 ? lx + sw : lx - (sw - lw) - 1, fy - 1, 1, 1, GOLD);
	};
	if (seated) {
		const swing = pose === "wait" ? Math.floor(t / 320) % 2 : 0;
		for (const k of [0, 1]) {
			const lx = dir > 0 ? bx + BW - 2 : bx + 1;
			const len = s ? 3 : 4;
			for (let i = 0; i < len; i++) R(dir > 0 ? lx + i : lx - i, bodyBottom - 2 + k, 1, 1, santa ? SANTA_RED : i % 2 ? stripe : "#ffffff");
			const fx = dir > 0 ? lx + len - 1 : lx - len + 1;
			const drop = (s ? 2 : 3) - (k === swing ? 1 : 0);
			R(fx, bodyBottom - 2 + k, 1, drop, santa ? BOOT : "#ffffff");
			R(fx + (dir > 0 ? 0 : -1), bodyBottom - 2 + k + drop, 2, 1, shoe);
			if (!santa && !s && k) R(fx + (dir > 0 ? 2 : -2), bodyBottom - 3 + k + drop, 1, 1, GOLD);
		}
	} else {
		const lift = pose === "walk" ? [0, 1, 0, 0][f4] : 0;
		const lift2 = pose === "walk" ? [0, 0, 0, 1][f4] : 0;
		const stride = pose === "walk" ? [0, 1, 0, -1][f4] * dir : 0;
		const l1 = bx + 1;
		const l2 = bx + BW - 1 - lw;
		stocking(l1 + stride, bodyBottom, LEG - lift);
		stocking(l2 - stride, bodyBottom, LEG - lift2);
		foot(l1 + stride, feet - 1 - lift);
		foot(l2 - stride, feet - 1 - lift2);
	}

	// The body.
	if (santa) {
		// A red coat with fur down its front and round its hem, a black belt, a belly.
		block(bx, bodyTop, BW, BH, coat, { r: 2 });
		R(bx - 1, bodyTop + 2, 1, BH - 4, coat);
		R(bx + BW, bodyTop + 2, 1, BH - 4, tone(coat, -1));
		R(bx - 2, bodyTop + 2, 1, BH - 4, INK);
		R(bx + BW + 1, bodyTop + 2, 1, BH - 4, INK);
		if (pose !== "look") R(cx - 1, bodyTop, 2, BH, FUR), R(cx, bodyTop, 1, BH, tone(FUR, -1));
		R(bx + 1, bodyTop + BH - 2, BW - 2, 2, FUR);
		R(bx + 1, bodyTop + BH - 1, BW - 2, 1, tone(FUR, -1));
		R(bx - 1, bodyTop + 4, BW + 2, 1, BOOT);
		if (pose !== "look") {
			R(cx - 2, bodyTop + 3, 4, 3, o.lit && Math.floor(t / 240) % 4 === 0 ? "#ffffff" : GOLD);
			R(cx - 1, bodyTop + 4, 2, 1, BOOT);
		}
		if (o.shield && pose !== "look") R(bx + 2, bodyTop + 1, 2, 2, "#4aa8f0"), R(bx + 2, bodyTop + 1, 1, 1, "#c8ecff");
	} else {
		// A tunic: a collar in the agent's color, a belt with a buckle.
		block(bx, bodyTop, BW, BH, coat, { r: 1 });
		if (s) {
			R(bx + 1, bodyTop, BW - 2, 1, color);
			if (pose !== "look") R(cx, bodyTop + 2, 1, 1, o.lit ? "#ffffff" : GOLD);
		} else {
			R(bx, bodyTop + BH - 3, BW, 1, "#3a2a2a");
			if (look.extra === 3) {
				// A scarf instead, its end hanging.
				for (let i = 0; i < BW; i++) R(bx + i, bodyTop, 1, 1, i % 2 ? color : FUR);
				for (let j = 0; j < 4; j++) R(bx + (dir > 0 ? 1 : BW - 3), bodyTop + 1 + j, 2, 1, j % 2 ? FUR : color);
			} else {
				R(bx + 1, bodyTop, BW - 2, 1, color);
				for (const px of [bx + 2, cx, bx + BW - 3]) R(px, bodyTop + 1, 1, 1, color);
				R(bx + 1, bodyTop, 2, 1, tone(color, 1));
			}
			if (pose !== "look") {
				R(cx - 1, bodyTop + BH - 3, 2, 1, o.lit && Math.floor(t / 240) % 4 === 0 ? "#ffffff" : GOLD);
				if (o.shield) R(bx + 1, bodyTop + 2, 2, 1, "#4aa8f0"), R(bx + 1, bodyTop + 2, 1, 1, "#c8ecff");
			}
		}
	}
	// The neck, where the head has risen off the shoulders.
	if (headTop + HH < bodyTop) R(hcx - 1, headTop + HH, 3, bodyTop - headTop - HH, tone(skin, -1));

	// The head.
	const hr = s ? 1 : santa ? 3 : 2;
	const perk = pose === "cheer" || pose === "ask" ? -(Math.floor(t / 150) % 2) : droop;
	block(hx, headTop, HW, HH, skin, { r: hr });
	if (!santa) {
		// Long ears, pointed, out to both sides: they prick up when it is glad and hang when it is not.
		for (const k of [-1, 1]) {
			const base = k < 0 ? hx - 1 : hx + HW;
			const px = (off: number, w: number) => (k < 0 ? base - off - w + 1 : base + off);
			const ey = headTop + (s ? 1 : 1) + perk;
			const rows: Array<[number, number, number]> = s ? [[px(1, 1), ey, 1], [px(0, 2), ey + 1, 2], [px(0, 1), ey + 2, 1]] : [[px(3, 1), ey, 1], [px(1, 3), ey + 1, 3], [px(0, 3), ey + 2, 3], [px(0, 2), ey + 3, 2]];
			rowsOf(rows, skin);
			if (!s) R(px(1, 1), ey + 2, 1, 1, mix(skin, BLUSH, 0.6)), R(px(0, 1), ey + 3, 1, 1, tone(skin, -1));
		}
		R(hx, headTop + 2, 1, HH - 4, skin);
		R(hx + HW - 1, headTop + 2, 1, HH - 4, tone(skin, -1));
	}
	const back = pose === "look";
	const gaze = back ? 0 : pose === "think" ? 0 : pose === "read" || pose === "skill" || pose === "list" ? (Math.floor(t / 300) % 3) - 1 : dir > 0 ? 1 : -1;
	const ey = headTop + 3 + (pose === "read" || pose === "skill" || pose === "type" || pose === "list" || pose === "wrap" ? 1 : 0) - (pose === "think" ? 1 : 0);
	const ew = s ? 1 : 2;
	const e1 = hx + (s ? 1 : santa ? 3 : 2) + (s ? (gaze > 0 ? 1 : 0) : gaze);
	const e2 = hx + HW - (s ? 3 : santa ? 5 : 4) + (s ? (gaze > 0 ? 1 : 0) : gaze);
	if (back) {
		// From behind: its hair, or Santa's, under the cap.
		const hair = santa ? FUR : look.hair ? look.hairC : tone(skin, -1);
		slab(hx, headTop, HW, HH - (santa ? 0 : 2), hair, hr);
		R(hx + 1, headTop + 1, HW - 2, 1, tone(hair, -1));
		R(hx + 1, headTop + 2, 1, HH - 5, tone(hair, 1));
		if (!santa) R(hx + 2, headTop + HH - 2, HW - 4, 1, tone(skin, -1));
	} else {
		if (!santa && !s) {
			const h = look.hairC;
			if (look.hair === 1) R(hx + 1, headTop + 1, HW - 2, 1, h), R(hx + 1, headTop + 2, 1, 1, h), R(hx + 4, headTop + 2, 2, 1, h), R(hx + HW - 2, headTop + 2, 1, 1, h);
			else if (look.hair === 2) R(hx, headTop + 1, 2, 3, h), R(hx + HW - 2, headTop + 1, 2, 3, h), R(hx + 2, headTop + 1, 1, 1, h), R(hx + HW - 3, headTop + 1, 1, 1, h);
			else if (look.hair === 3) {
				// Two braids, tied in the agent's color.
				R(hx + 1, headTop + 1, HW - 2, 1, h);
				for (const px of [hx - 1, hx + HW - 1]) R(px, headTop + 5, 2, 5, h), R(px, headTop + 7, 2, 1, tone(h, -1)), R(px, headTop + 10, 2, 1, color);
			}
		}
		const blink = t % 3900 < 130 || (t + 700) % 7100 < 110;
		const lid = tone(skin, -2);
		const eyes = (fn: (ex: number) => void) => (fn(e1), fn(e2));
		if (pose === "sleep") eyes((ex) => R(ex, ey + 1, ew, 1, lid));
		else if (pose === "cheer") eyes((ex) => (R(ex, ey, ew, 1, INK), s || (R(ex - 1, ey + 1, 1, 1, INK), R(ex + ew, ey + 1, 1, 1, INK))));
		else if (pose === "sad") eyes((ex) => (R(ex, ey + 1, ew, 1, INK), R(ex + (ex === e1 ? 0 : ew - 1), ey + 2 + (Math.floor(t / 300) % 2), 1, 1, "#7ad0ff")));
		else if (pose === "ask") eyes((ex) => (R(ex, ey - (s ? 0 : 1), ew, s ? 2 : 3, INK), R(ex, ey - (s ? 0 : 1), 1, 1, "#ffffff")));
		else if (blink) eyes((ex) => R(ex, ey + 1, ew, 1, lid));
		else eyes((ex) => (R(ex, ey, ew, 2, INK), s || R(ex, ey, 1, 1, "#ffffff")));
		if (santa) {
			// Brows, half-moon glasses, a red nose, and the beard: over the cheeks, the chin and half the coat.
			if (pose !== "sleep") eyes((ex) => R(ex - (pose === "sad" ? 0 : 0), headTop + 2 + (pose === "ask" ? -1 : 0), 2, 1, FUR));
			eyes((ex) => R(ex, ey + 2, 2, 1, "#d9a84a"));
			R(e1 + 2, ey + 2, e2 - e1 - 2, 1, mix(skin, "#d9a84a", 0.5));
			const beard: Array<[number, number, number]> = [[hx, headTop + 5, 2], [hx + HW - 2, headTop + 5, 2], [hx, headTop + 6, HW], [hx, headTop + 7, HW], [hx, headTop + 8, HW], [hx + 1, headTop + 9, HW - 2], [hx + 2, headTop + 10, HW - 4], [hx + 3, headTop + 11, HW - 6], [hx + 5, headTop + 12, HW - 10]];
			for (const [px, py, w] of beard) R(px, py, w, 1, FUR);
			R(hx - 1, headTop + 6, 1, 3, FUR);
			R(hx + HW, headTop + 6, 1, 3, tone(FUR, -1));
			for (const [px, py, w] of beard.slice(4)) R(px + w - 1, py, 1, 1, tone(FUR, -1));
			for (const [dx, dy] of [[2, 8], [5, 10], [8, 8], [9, 9], [4, 7], [6, 11]]) R(hx + dx, headTop + dy, 1, 1, tone(FUR, -1));
			R(hcx - 1 + gaze, headTop + 4, 2, 2, "#f08a8a");
			R(hcx - 1 + gaze, headTop + 4, 1, 1, "#ffb0b0");
			R(hx + 1, headTop + 5, 2, 1, mix(skin, BLUSH, 0.7));
			R(hx + HW - 3, headTop + 5, 2, 1, mix(skin, BLUSH, 0.7));
			// The moustache, and under it a mouth when he laughs or asks.
			R(hcx - 3 + gaze, headTop + 6, 3, 1, "#ffffff");
			R(hcx + 1 + gaze, headTop + 6, 3, 1, "#ffffff");
			if (pose === "cheer" || pose === "ask") R(hcx - 1, headTop + 7, 3, pose === "cheer" ? 2 : 1, "#8a2a2a");
			else if (pose === "sad") R(hcx - 1, headTop + 7, 3, 1, tone(FUR, -2));
		} else if (!s) {
			if (look.extra === 1) eyes((ex) => R(ex, ey - 1, 2, 1, "#d9a84a")), R(e1 + 2, ey, e2 - e1 - 2, 1, "#d9a84a");
			const cheek = look.extra === 2 ? tone(skin, -1) : mix(skin, BLUSH, 0.65);
			if (pose !== "sad") {
				R(hx + 1, headTop + 5, look.extra === 2 ? 1 : 2, 1, cheek);
				R(hx + HW - 3 + (look.extra === 2 ? 1 : 0), headTop + 5, look.extra === 2 ? 1 : 2, 1, cheek);
				if (look.extra === 2) R(hx + 2, headTop + 6, 1, 1, cheek), R(hx + HW - 3, headTop + 6, 1, 1, cheek);
			}
			R(hcx + gaze, headTop + 5, 1, 1, tone(skin, -1));
			if (look.hair === 4) {
				// An old elf's beard.
				const b = "#f4f1ea";
				R(hx, headTop + 5, 1, 1, b), R(hx + HW - 1, headTop + 5, 1, 1, b);
				R(hx, headTop + 6, HW, 2, b);
				R(hx + 1, headTop + 8, HW - 2, 1, b);
				R(hx + 3, headTop + 9, HW - 6, 1, b);
				R(hx + 2, headTop + 7, 1, 1, tone(b, -1)), R(hx + 7, headTop + 8, 1, 1, tone(b, -1));
				if (pose === "cheer" || pose === "ask") R(hcx - 1, headTop + 6, 2, 1, "#8a2a2a");
			} else if (pose === "cheer") R(hcx - 1, headTop + 6, 3, 1, "#8a2a2a"), R(hcx, headTop + 7, 1, 1, "#e06a6a");
			else if (pose === "ask") R(hcx, headTop + 6, 1, 1, INK);
			else if (pose === "sad") R(hcx - 1, headTop + 6, 3, 1, tone(skin, -2));
			else R(hcx - 1 + (gaze > 0 ? 1 : 0), headTop + 6, 2, 1, tone(skin, -2));
		} else if (pose === "cheer" || pose === "ask") R(hcx, headTop + 4, 1, 1, "#8a2a2a");
	}
	const sway = pose === "walk" ? [0, 1, 0, -1][f4] : pose === "cheer" || pose === "ask" ? -(Math.floor(t / 110) % 2) : Math.floor(t / 900) % 5 === 0 ? 1 : 0;
	drawCap(look.hat, santa ? SANTA_RED : color, hcx, headTop, dir > 0 ? -1 : 1, { small: s, santa, sway, glow: o.eye, lit: Boolean(o.lit), t });

	// Arms: a sleeve with a hand at its end, wherever the hand is. Santa's have a cuff of fur and a mitten.
	const shL = bx - 1 - (santa ? 1 : 0);
	const shR = bx + BW + (santa ? 1 : 0);
	const shY = bodyTop + 1 + (santa ? 1 : 0);
	const sleeve = santa ? SANTA_RED : tone(coat, -1);
	const hand = santa ? color : skin;
	const arm = (sx: number, hx2: number, hy2: number) => {
		line(sx, shY, hx2, hy2, sleeve);
		if (santa) line(sx, shY + 1, hx2, hy2 + 1, tone(sleeve, -1));
		const px = hx2 - (hx2 < sx ? 1 : 0);
		if (santa) R(px, hy2 - 1, 2, 1, FUR);
		R(px, hy2, 2, 2, hand);
		R(px, hy2 + 1, 2, 1, tone(hand, -1));
	};
	const down = BH - 1 - (santa ? 2 : 0);
	const front = dir > 0 ? shR : shL;
	const backArm = dir > 0 ? shL : shR;
	const tap = Math.floor(t / 100) % 2;
	if (s) {
		// A small one has stubs.
		const up = pose === "ask" || pose === "cheer" ? -3 - (tap ? 1 : 0) : pose === "type" || pose === "read" ? 0 : 2;
		R(shL, shY + Math.min(0, up), 1, Math.abs(up) + 1, sleeve);
		R(shR, shY + Math.min(0, up - (pose === "type" ? tap : 0)), 1, Math.abs(up) + 1, sleeve);
		if (pose === "read") stamp(BOOK, { a: tone(o.prop ?? "#c96a4a", -1), b: PAPER, c: tone(PAPER, -1) }, cx - 3, bodyTop);
		if (pose === "type") R(shR + 1, shY - 2 + tap * 2, 2, 2, "#9aa6b8"), R(shR, shY - 1 + tap * 2, 1, 2, "#8a5a3a");
	} else if (pose === "type") {
		// At the bench with a tool: a hammer that comes down, a brush that goes to and fro, a wrench that turns.
		const beat = Math.floor(t / 140) % 4;
		const tool = (o.tool ?? 0) % 3;
		arm(backArm, backArm + dir * 4, shY + 2);
		if (tool === 0) {
			const up = [4, 5, 0, 1][beat];
			const hx2 = front + dir * 3;
			const hy = shY + 2 - up;
			arm(front, hx2, hy);
			line(hx2 + (dir > 0 ? 1 : -1), hy, hx2 + dir * 2, hy - 3, "#8a5a3a");
			R(hx2 + (dir > 0 ? 1 : -3), hy - 5, 4, 2, "#9aa6b8");
			R(hx2 + (dir > 0 ? 1 : -3), hy - 5, 4, 1, "#cfd8e2");
			if (beat === 2) {
				const wasT = T;
				T = PLAIN;
				R(hx2 + dir * 4, hy - 1, 1, 1, "#ffffff"), R(hx2 + dir * 5, hy - 3, 1, 1, "#ffe27a"), R(hx2 + dir * 2, hy - 7, 1, 1, "#ffe27a");
				T = wasT;
			}
		} else if (tool === 1) {
			const go = [0, 1, 2, 1][beat];
			const hx2 = front + dir * (2 + go);
			arm(front, hx2, shY + 1);
			line(hx2 + dir, shY + 1, hx2 + dir * 3, shY + 3, "#8a5a3a");
			R(hx2 + dir * 3 + (dir > 0 ? 0 : -1), shY + 3, 2, 2, o.prop ?? color);
		} else {
			const hx2 = front + dir * 3;
			arm(front, hx2, shY + 2);
			const turn = beat % 2;
			R(hx2 + (dir > 0 ? 2 : -2), shY + (turn ? 0 : 2), 1, 3, "#9aa6b8");
			R(hx2 + (dir > 0 ? 1 : -3), shY + (turn ? 0 : 4), 3, 1, "#cfd8e2");
		}
	} else if (pose === "wrap") {
		// Both hands at the ribbon: one pulls, one holds.
		const pull = Math.floor(t / 180) % 4;
		const h1 = front + dir * (3 + [0, 1, 2, 1][pull]);
		const h2 = backArm + dir * 4;
		arm(backArm, h2, shY + 2);
		arm(front, h1, shY + 1 - (pull === 2 ? 1 : 0));
		line(h2 + dir * 2, shY + 3, h1, shY + 1 - (pull === 2 ? 1 : 0), GOLD);
	} else if (pose === "read" || pose === "skill") {
		const c = o.prop ?? "#c96a4a";
		arm(shL, cx - 4, shY + 2);
		arm(shR, cx + 3, shY + 2);
		stamp(BOOK, { a: tone(c, -1), b: PAPER, c: Math.floor(t / 900) % 4 === 0 ? PAPER : tone(PAPER, -1) }, cx - 3, shY);
		if (pose === "skill") {
			const tw = Math.floor(t / 160) % 4;
			R(cx - 6 + tw * 4, shY - 3 - (tw % 2), 1, 1, "#ffe27a");
			R(cx + 5 - tw * 3, shY - 1 + (tw % 2), 1, 1, "#fff6c8");
		}
	} else if (pose === "list") {
		// The list: a long roll of paper that reaches the floor, a quill that ticks a name off now and then.
		const lx = front + dir * 2;
		const px = dir > 0 ? lx - 1 : lx - 5;
		const top = shY - 1;
		const bottom = Math.round(y) - 2;
		const at = Math.floor(t / 650);
		R(px - 1, top - 1, 9, bottom - top + 3, INK);
		R(px, top, 7, bottom - top + 1, PAPER);
		R(px + 6, top, 1, bottom - top + 1, tone(PAPER, -1));
		R(px - 2, bottom, 11, 3, INK);
		R(px - 1, bottom + 1, 9, 1, PAPER);
		R(px + 1, top - 1, 5, 1, tone(PAPER, -1));
		// What he has been through lies on the floor, rolled up at its end: it is a long list.
		const tx = dir > 0 ? px + 8 : px - 16;
		R(tx - 1, bottom, 17, 3, INK);
		R(tx, bottom + 1, 15, 1, PAPER);
		for (let i = 2; i < 13; i += 3) R(tx + i, bottom + 1, 2, 1, "#a89c8a");
		const ex = dir > 0 ? tx + 14 : tx - 2;
		R(ex - 1, bottom - 3, 5, 5, INK);
		R(ex, bottom - 2, 3, 3, PAPER);
		R(ex + 1, bottom - 1, 1, 1, tone(PAPER, -2));
		const lines = Math.floor((bottom - top - 1) / 2);
		const cur = at % (lines + 2);
		for (let i = 0; i < lines; i++) {
			const ly = top + 1 + i * 2;
			R(px + 2, ly, 2 + ((i * 7 + look.seed) % 3), 1, i === cur ? INK : "#a89c8a");
			if (i < cur) R(px + 1, ly, 1, 1, (i * 5 + look.seed) % 7 === 0 ? "#e5484d" : "#3fbf6f");
		}
		arm(front, lx, top + 1);
		const qx = cx - dir;
		const qy = shY + 3 - (t % 650 < 160 ? 1 : 0);
		arm(backArm, qx, qy);
		line(qx + dir, qy - 1, qx + dir * 3, qy - 5, "#ffffff");
		R(qx + dir * 2, qy - 4, 1, 1, "#cfd8e2");
	} else if (pose === "think") {
		arm(front, cx + dir * 3, headBottom - (santa ? 2 : 1));
		arm(backArm, backArm, shY + down);
	} else if (pose === "ask" || pose === "cheer") {
		const w = Math.floor(t / 160) % 2;
		arm(shL, shL - 2 - w, headTop + 1 - (pose === "cheer" ? 2 : 0) + w);
		arm(shR, shR + 2 + (1 - w), headTop + 1 - (pose === "cheer" ? 2 : 0) + (1 - w));
	} else if (pose === "sip") {
		const lifted = Math.floor(t / 1400) % 3 === 0;
		arm(backArm, backArm, shY + down);
		const hy = lifted ? headBottom - 3 : shY + 2;
		arm(front, front + dir * 2, hy);
		stamp(MUG, { a: "#e05a47", b: tone("#e05a47", -1) }, front + dir * 2 + (dir > 0 ? 1 : -4), hy - 2, dir < 0);
		R(front + dir * 2 + (dir > 0 ? 1 : -3), hy - 2, 3, 1, "#fff6e6");
		const st = Math.floor(t / 260) % 3;
		if (!lifted) R(front + dir * 3 + (st === 1 ? 1 : 0), hy - 4 - st, 1, 1, "#e8eef5");
	} else if (pose === "rack") {
		arm(backArm, backArm, shY + down);
		arm(front, front + dir * 4, shY - 1 + tap);
	} else if (pose === "hand") {
		arm(backArm, backArm, shY + down);
		arm(front, front + dir * 3, headTop);
		const px = front + dir * 3 - 3;
		R(px - 1, headTop - 6, 9, 7, INK);
		stamp(PRESENT, wrapOf(o.prop ?? color), px, headTop - 8);
	} else if (pose === "water") {
		arm(backArm, backArm, shY + down);
		arm(front, front + dir * 3, shY + 1);
		stamp(CAN, { a: "#6fb7d8", b: "#4a90b8" }, front + dir * 3 + (dir > 0 ? 0 : -6), shY - 2, dir < 0);
		const dr = Math.floor(t / 120) % 4;
		R(front + dir * 10, shY + dr * 2, 1, 1, "#8fd4f2");
	} else {
		const sw2 = pose === "walk" ? [1, 0, -1, 0][f4] : 0;
		arm(shL, shL + (pose === "walk" ? sw2 : 0), shY + down - Math.abs(sw2));
		arm(shR, shR - (pose === "walk" ? sw2 : 0), shY + down - Math.abs(sw2));
	}

	if (pose === "sleep") {
		const z = Math.floor(t / 700) % 3;
		const zx = hx + HW + 2 + z * 2;
		const zy = headTop - 3 - z * 3;
		R(zx, zy, 3, 1, "#cfd8ff");
		R(zx + 1, zy + 1, 1, 1, "#cfd8ff");
		R(zx, zy + 2, 3, 1, "#cfd8ff");
	}
	if (pose === "sad") {
		const k = Math.floor(t / 200) % 4;
		R(cx - 1 + (k % 2), headTop - 12 - k, 2, 2, "#8a8fa6");
		R(cx + 2 - (k % 2), headTop - 14 - k, 1, 1, "#b4b8c8");
	}
	const top = headTop - (s ? 6 : santa ? 9 : 10);
	return { x: hx - 4, y: top, w: HW + 8, h: Math.round(y) - top + 1 };
}

/**
 * An agent's elf by itself (Santa, with `main`), drawn into a canvas of the picture's own pixels: for a picture
 * of one outside the workshop. Its feet stand on (`x`, `y`). Returns the box it takes.
 */
export function drawPortrait(ctx: CanvasRenderingContext2D, id: string, color: string, x: number, y: number, o: FolkArgs): Box {
	const was = g;
	const light = T;
	g = ctx;
	T = PLAIN;
	const box = drawFolk(lookOf(id), color, x, y, o);
	g = was;
	T = light;
	return box;
}
// ---- who else lives here -----------------------------------------------------------------------------------------------

/** You, at the counter of the mail room, in a bobble hat and a scarf: head and shoulders. */
const YOU = spr(`
.....w.....
....www....
...ohhho...
..ohhhhho..
.ohhhhhhho.
.owwwwwwwo.
.ossesseso.
.osssssss..
..ossmsso..
..occcccc..
.ojccjjjjo.
ojjccjjjjjo
ojjjjjjjjjo
`);
const YOU_GLAD = spr(`
.....w.....
....www....
...ohhho...
..ohhhhho..
.ohhhhhhho.
.owwwwwwwo.
.oseseseso.
.osssssss..
..osmmmso..
..occcccc..
.ojccjjjjo.
ojjccjjjjjo
ojjjjjjjjjo
`);

const CAT_SIT = spr(`
.a...a...
.aa.aa...
.aaaaa...
.aeaea...
.aanaa...
..aaaa..a
.aawaaa.a
.aawaaaa.
.aa.aa...
`);
const CAT_NAP = spr(`
...........
.a...a.....
.aaaaaaaa..
aaeaaaaaaa.
aaaaaaaaaaa
.aaaaaaaaa.
`);
const CAT_WALK = [
	spr(`
.a..a.....a
.aaaa....a.
.aeaaaaaaa.
.aaaaaaaaa.
..aaaaaaaa.
..a.a..a.a.
`),
	spr(`
.a..a....a.
.aaaa....a.
.aeaaaaaaa.
.aaaaaaaaa.
..aaaaaaaa.
...aa..aa..
`),
];

const BIRD_SIT = spr("..aaa../.aaeab./aaaaa../aawwa../.aaa.../..l.l..");
const BIRD_PECK = spr("......./..aaa../aaaaa../aawwaa./.aaaeab/..l.l..");
const BIRD_FLY = [spr(".a...a../.aa.aa../..aaaeb./.aaaaa../..www..."), spr("......../..aaaeb./aaaaaa../a.www.a./........")];
/** Robins, mostly. */
const BIRDS = [
	{ a: "#8a6a4a", w: "#f0603a" },
	{ a: "#7a5a40", w: "#f27a3a" },
	{ a: "#4a8fd8", w: "#f2d84a" },
	{ a: "#6b5a4a", w: "#e8d8c0" },
];

/** An elf on skis, in two beats: a push with the poles, a glide. */
const SKIER = [
	spr(`
.b.........
..hhh......
.hhhhh.....
.wwwww.....
.essse.....
..sss......
.ccccs.....
.cccc.p....
.cccc..p...
.l..l...p..
l....l...p.
kkkkkkkkkkk
`),
	spr(`
b..........
.hhhh......
.hhhhh.....
.wwwww.....
.essse.....
..sss......
scccc......
pcccc......
.pccc......
..pll......
...pll.....
kkkkkkkkkkk
`),
];
/** A polar bear on its way, and its cub. */
const BEAR = [
	spr(`
....wwwwwww.........
..wwwwwwwwwwww.w....
.wwwwwwwwwwwwwwwww..
.wwwwwwwwwwwwwwewwn.
.wwwwwwwwwwwwwwwww..
.wwwwwwwwwwwwww.....
.wwwwwsssswwwww.....
.www..ww...ww.ww....
.ww...ww...ww..ww...
.ww...ww...ww..ww...
`),
	spr(`
....wwwwwww.........
..wwwwwwwwwwww.w....
.wwwwwwwwwwwwwwwww..
.wwwwwwwwwwwwwwewwn.
.wwwwwwwwwwwwwwwww..
.wwwwwwwwwwwwww.....
.wwwwwsssswwwww.....
..www.ww..ww.ww.....
...ww.ww..ww.ww.....
...ww..ww.ww..ww....
`),
];
const CUB = [
	spr(`
..wwww.w..
.wwwwwwww.
.wwwwwwewn
.wwwwwww..
.ww..ww...
.ww..ww...
`),
	spr(`
..wwww.w..
.wwwwwwww.
.wwwwwwewn
.wwwwwww..
..ww.ww...
..ww..ww..
`),
];
const COATS = ["#e05a47", "#3d7dd8", "#f2b134", "#4caf7a", "#9b59b6", "#ec7fa9", "#1abc9c", "#d8362f", "#2f8a58"];
const TOYS = ["#e05a47", "#3d7dd8", "#f2b134", "#4caf7a", "#9b59b6", "#ec7fa9", "#34506e", "#f2efe6", "#1abc9c"];

/** A sprite with a soft dark edge all round it: for white things on snow. */
function edged(s: Sprite, pal: Record<string, string>, edge: string, x: number, y: number, flip = false): void {
	const dark: Record<string, string> = {};
	for (const k in pal) dark[k] = edge;
	for (const [dx, dy] of [[-1, 0], [1, 0], [0, -1], [0, 1]]) stamp(s, dark, x + dx, y + dy, flip);
	stamp(s, pal, x, y, flip);
}

/** What grows in a pot in a bay: a poinsettia, a little tree with baubles, holly, candy canes. */
function drawPlant(x: number, floor: number, kind: number, t: number, lit: boolean): void {
	const sway = Math.round(Math.sin(t / 900 + kind) * 0.6);
	const pot = ["#c9744e", "#d8362f", "#e0c06a", "#6d8fb5"][kind % 4];
	block(x - 3, floor - 5, 6, 5, pot, { r: 1 });
	R(x - 3, floor - 5, 6, 1, tone(pot, 1));
	R(x - 3, floor - 3, 6, 1, FUR);
	const leaf = "#2f8a58";
	if (kind % 4 === 0) {
		// A poinsettia: green below, a red star of leaves on top.
		R(x, floor - 9, 1, 4, "#3f8f52");
		R(x - 3, floor - 8, 7, 2, leaf);
		R(x - 4 + sway, floor - 9, 2, 1, tone(leaf, 1));
		const red = "#d8362f";
		R(x - 3 + sway, floor - 12, 7, 1, red);
		R(x - 2 + sway, floor - 13, 5, 3, red);
		R(x - 1 + sway, floor - 14, 3, 5, tone(red, 1));
		R(x - 4 + sway, floor - 11, 1, 1, red), R(x + 4 + sway, floor - 11, 1, 1, red);
		R(x + sway, floor - 12, 1, 1, GOLD);
	} else if (kind % 4 === 1) {
		// A little tree, its baubles bright when work runs.
		R(x, floor - 7, 1, 2, "#7a5a3a");
		for (let i = 0; i < 4; i++) {
			R(x - 3 + i + (i > 1 ? sway : 0), floor - 8 - i * 2, 7 - i * 2, 2, i % 2 ? leaf : "#3fa468");
			R(x - 3 + i + (i > 1 ? sway : 0), floor - 8 - i * 2, 1, 1, "#5cc27e");
		}
		const wasT = T;
		if (lit) T = PLAIN;
		R(x - 2, floor - 8, 1, 1, "#ff5a5a"), R(x + 2, floor - 9, 1, 1, "#7ad0ff"), R(x - 1, floor - 11, 1, 1, GOLD), R(x + 1, floor - 12, 1, 1, "#ff8fb4");
		R(x + sway, floor - 16, 1, 1, lit && Math.floor(t / 300) % 2 ? "#ffffff" : GOLD);
		T = wasT;
	} else if (kind % 4 === 2) {
		// Holly, with its berries.
		disc(x + sway, floor - 9, 3, tone(leaf, -1));
		disc(x - 1 + sway, floor - 10, 2, leaf);
		R(x - 4 + sway, floor - 10, 1, 1, leaf), R(x + 4 + sway, floor - 8, 1, 1, leaf), R(x + sway, floor - 13, 1, 1, leaf), R(x - 3 + sway, floor - 12, 1, 1, leaf), R(x + 3 + sway, floor - 12, 1, 1, tone(leaf, -1));
		R(x - 2 + sway, floor - 11, 2, 1, tone(leaf, 1));
		for (const [dx, dy] of [[1, 10], [-2, 8], [2, 7]]) R(x + dx + sway, floor - dy, 1, 1, "#e5484d");
	} else {
		// Candy canes, stuck in like flowers.
		for (const [dx, h, c] of [[-2, 9, "#e5484d"], [1, 12, "#3fa468"], [3, 8, "#e5484d"]] as Array<[number, number, string]>) {
			for (let j = 0; j < h; j++) R(x + dx, floor - 5 - j, 1, 1, j % 2 ? c : "#ffffff");
			R(x + dx - 1, floor - 6 - h, 2, 1, c);
			R(x + dx - 2, floor - 5 - h, 1, 2, "#ffffff");
		}
	}
}

/** A big pine in the snow: tiers of boughs, lit on the left, a load of snow on each, and a string of little lights. */
function drawPine(x: number, base: number, h: number, sky: Sky, t: number, lights: boolean, glows: Glow[]): void {
	const c = PINE;
	R(x - 1, base - 5, 3, 5, "#6b4a3a");
	R(x - 1, base - 5, 1, 5, "#8a6248");
	const tiers = Math.floor(h / 7);
	const sway = Math.round(Math.sin(t / 1300 + x) * 0.7);
	for (let i = 0; i < tiers; i++) {
		const w = 5 + (tiers - i) * 3;
		const ty = base - 6 - i * 6;
		const dx = i > tiers / 2 ? sway : 0;
		for (let j = 0; j < 8; j++) {
			const half = Math.round((w * (j + 1)) / 16);
			R(x - half + dx, ty - 7 + j, half * 2 + 1, 1, j > 5 ? tone(c, -1) : c);
			R(x - half + dx, ty - 7 + j, Math.max(1, Math.round(half * 0.5)), 1, tone(c, j % 2 ? 1 : 0));
			if (j === 7) for (let k = -half; k <= half; k += 2) R(x + k + dx, ty + 1, 1, 1, tone(c, -1));
		}
		// Snow lies on every tier, thicker on the lit side.
		R(x - 2 + dx, ty - 7, 4, 1, "#ffffff");
		R(x - Math.round(w / 3) + dx, ty - 4, Math.round(w / 2.4), 1, "#ffffff");
		R(x - Math.round(w / 2.2) + dx, ty - 1, Math.round(w / 3), 1, SNOW);
		R(x + 1 + dx, ty - 2, Math.round(w / 4), 1, SNOW);
		if (lights)
			for (let k = 0; k < 3; k++) {
				const lx = x - Math.round(w / 3) + k * Math.round(w / 3) + dx + ((i * 2) % 3) - 1;
				const on = Math.floor(t / 500 + i + k) % 3 !== 0;
				const col = ["#ffd75a", "#ff7a7a", "#7ad0ff", "#9ff0a0"][(i + k) % 4];
				const wasT = T;
				T = PLAIN;
				R(lx, ty - 1 - k, 1, 1, on ? col : tone(col, -2));
				T = wasT;
				if (on) glows.push({ x: lx, y: ty - 1 - k, r: 4, color: col, a: 0.7 });
			}
	}
	R(x + sway, base - 6 - tiers * 6 - 3, 1, 3, c);
	R(x + sway, base - 6 - tiers * 6 - 4, 1, 1, "#ffffff");
	void sky;
}

/** A lollipop as tall as a tree: a striped stick, a swirl of sugar, snow on top of it. */
function drawLolly(x: number, base: number, size: number, t: number, seed: number): void {
	const r = seeded(seed);
	const [a, b] = [["#e5484d", "#ffffff"], ["#3fa468", "#ffffff"], ["#ec7fa9", "#fff6e6"], ["#f2b134", "#ffffff"], ["#4a90d9", "#e6f6fd"]][Math.floor(r() * 5)];
	const rad = Math.round(size * 0.38);
	const cy = base - size - rad + 3;
	for (let j = 0; j < size; j++) R(x, base - 1 - j, 2, 1, Math.floor(j / 2) % 2 ? a : "#ffffff"), R(x + 1, base - 1 - j, 1, 1, Math.floor(j / 2) % 2 ? tone(a, -1) : "#dfe6f0");
	disc(x, cy, rad + 1, INK);
	disc(x, cy, rad, b);
	// The swirl turns, slowly, a step at a time.
	const turn = Math.floor(t / 900 + seed) % 8;
	for (let i = 0; i < rad * 26; i++) {
		const k = i / (rad * 26);
		const ang = k * Math.PI * 5 + (turn * Math.PI) / 4;
		R(x + Math.round(Math.cos(ang) * k * rad), cy + Math.round(Math.sin(ang) * k * rad), 1, 1, a);
	}
	R(x - rad + 2, cy - rad + 1, Math.max(2, rad - 2), 1, "#ffffff");
	R(x - Math.round(rad * 0.6), cy - rad, Math.round(rad * 1.3), 1, "#ffffff");
	R(x - Math.round(rad * 0.3), cy - rad - 1, Math.round(rad * 0.7), 1, "#ffffff");
}

/** A snowman: three balls, a carrot, a hat, a scarf that moves in the wind. */
function drawSnowman(x: number, base: number, t: number, seed: number): void {
	const scarf = COATS[seed % COATS.length];
	const body = "#f6f9fd";
	const shade = "#cfdcee";
	disc(x, base - 5, 6, shade);
	disc(x - 1, base - 6, 5, body);
	disc(x, base - 14, 4, shade);
	disc(x - 1, base - 15, 3, body);
	disc(x, base - 21, 3, shade);
	disc(x, base - 22, 3, body);
	R(x - 1, base - 23, 1, 1, INK), R(x + 1, base - 23, 1, 1, INK);
	R(x, base - 22, 3, 1, "#f08a2e");
	R(x - 1, base - 20, 1, 1, INK), R(x, base - 19, 1, 1, INK), R(x + 1, base - 20, 1, 1, INK);
	for (const dy of [16, 13, 6]) R(x - 1, base - dy, 1, 1, INK);
	// Arms of twig, a hat, the scarf.
	line(x - 4, base - 15, x - 9, base - 19, "#6b4a3a"), R(x - 9, base - 21, 1, 2, "#6b4a3a");
	line(x + 4, base - 15, x + 9, base - 18, "#6b4a3a"), R(x + 9, base - 20, 1, 2, "#6b4a3a");
	R(x - 4, base - 25, 9, 1, INK);
	R(x - 2, base - 30, 5, 5, INK);
	R(x - 2, base - 27, 5, 1, scarf);
	R(x - 3, base - 19, 7, 2, scarf);
	const wave = Math.floor(t / 400 + seed) % 2;
	R(x + 3, base - 18, 2, 3 + wave, scarf), R(x + 3, base - 15 + wave, 2, 1, tone(scarf, -1));
}

/** An igloo: blocks of snow in a dome, a way in, a light inside at night. */
function drawIgloo(x: number, base: number, night: number, glows: Glow[]): void {
	const rad = 12;
	for (let dy = 0; dy <= rad; dy++) {
		const half = Math.round(Math.sqrt(rad * rad - dy * dy));
		R(x - half, base - dy, half * 2 + 1, 1, dy % 4 === 0 ? "#cfdcee" : "#f2f7fd");
		R(x - half, base - dy, Math.max(1, Math.round(half * 0.3)), 1, dy % 4 === 0 ? "#dfe9f6" : "#ffffff");
		R(x + half - 1, base - dy, 2, 1, "#b8cbe6");
		if (dy % 4) for (let k = -half + 3 + ((dy >> 2) % 2) * 4; k < half - 1; k += 8) R(x + k, base - dy, 1, 1, "#cfdcee");
	}
	block(x - 4, base - 8, 9, 9, "#dfe9f6", { r: 2, ink: "#9fb4d4" });
	const wasT = T;
	if (night > 0.45) T = PLAIN;
	R(x - 2, base - 6, 5, 7, night > 0.45 ? "#ffd98a" : "#4a5a7a");
	R(x - 1, base - 7, 3, 1, night > 0.45 ? "#ffe9b0" : "#4a5a7a");
	T = wasT;
	if (night > 0.45) glows.push({ x, y: base - 3, r: 14, color: "#ffc870", a: 0.7 });
}
/** The kinds of workshop there are, a bay of each before one comes twice: its walls, its wood, its windows. */
interface Bay {
	wall: string;
	dado: string;
	floor: string;
	wood: string;
	win: "square" | "arch" | "round";
	curtains: boolean;
	accent: string;
}
const BAYS: Bay[] = [
	// The joiner's bench: boards, tools on a rail, a train.
	{ wall: "#ecd5ac", dado: "#b98a62", floor: "#d9a56e", wood: "#8a5f44", win: "square", curtains: false, accent: "#d8362f" },
	// The paint shop: splashes on the wall, a rocking horse.
	{ wall: "#f6efe0", dado: "#d8dfe8", floor: "#c9b08a", wood: "#8a6a55", win: "arch", curtains: false, accent: "#4a90d9" },
	// The bakery: tiles, a gingerbread house.
	{ wall: "#fbeed8", dado: "#eef4f8", floor: "#e8c9a0", wood: "#a8744e", win: "round", curtains: false, accent: "#e0a030" },
	// The sewing room: dotted paper, spools, a bear.
	{ wall: "#f7d9de", dado: "#e2a9b8", floor: "#c99a6e", wood: "#9a6a55", win: "square", curtains: true, accent: "#c2528a" },
	// The clockwork room: plates of tin, wheels, a tin man.
	{ wall: "#86b5ad", dado: "#5f8f8a", floor: "#7a7a8a", wood: "#4f5f6a", win: "round", curtains: false, accent: "#d9a84a" },
	// The sweet kitchen: stripes, a jar of sweets.
	{ wall: "#dff3e6", dado: "#f7c9d6", floor: "#f6d6de", wood: "#c98aa0", win: "arch", curtains: false, accent: "#ec7fa9" },
	// The wrapping room: stars, rolls of paper, parcels.
	{ wall: "#d9cbee", dado: "#a98ad0", floor: "#c9a877", wood: "#7a5a8a", win: "square", curtains: true, accent: "#7a4fb0" },
	// The room of ice: blocks of it, paper snowflakes, a snow globe.
	{ wall: "#d6ecf8", dado: "#a9d0ea", floor: "#d6e2ee", wood: "#7a9ab8", win: "round", curtains: false, accent: "#58b8e8" },
];

/** A toy on a shelf: a ball, blocks, a bear, a drum, a boat, a parcel. Its feet at `base`, five pixels wide at most. */
function drawToy(type: number, x: number, base: number, c: string): void {
	if (type === 0) {
		disc(x + 2, base - 3, 2, c);
		R(x, base - 3, 5, 1, FUR);
		R(x + 1, base - 5, 2, 1, tone(c, 1));
	} else if (type === 1) {
		R(x, base - 4, 4, 4, c);
		R(x, base - 4, 4, 1, tone(c, 1));
		R(x + 1, base - 7, 3, 3, tone(c, -1));
		R(x + 2, base - 6, 1, 1, FUR);
		R(x + 1, base - 2, 1, 1, FUR);
	} else if (type === 2) {
		const b = "#b07a4a";
		R(x + 1, base - 4, 3, 4, b);
		R(x, base - 3, 5, 2, b);
		R(x + 1, base - 7, 3, 3, b);
		R(x, base - 8, 1, 1, b), R(x + 4, base - 8, 1, 1, b);
		R(x + 1, base - 6, 1, 1, INK), R(x + 3, base - 6, 1, 1, INK);
		R(x + 2, base - 3, 1, 2, "#e0b88a");
		R(x + 1, base - 4, 3, 1, c);
	} else if (type === 3) {
		R(x, base - 5, 5, 5, c);
		R(x, base - 5, 5, 1, FUR);
		R(x, base - 1, 5, 1, GOLD);
		R(x + 1, base - 3, 1, 1, FUR), R(x + 2, base - 4, 1, 1, FUR), R(x + 3, base - 3, 1, 1, FUR);
		R(x + 1, base - 7, 1, 2, "#8a5a3a"), R(x + 3, base - 7, 1, 2, "#8a5a3a");
	} else if (type === 4) {
		R(x, base - 2, 5, 2, c);
		R(x + 1, base - 1, 3, 1, tone(c, -1));
		R(x + 2, base - 8, 1, 6, "#8a5a3a");
		R(x + 3, base - 7, 1, 1, FUR), R(x + 3, base - 6, 2, 1, FUR), R(x + 3, base - 5, 2, 2, FUR);
		R(x + 1, base - 8, 1, 1, "#e5484d");
	} else {
		R(x, base - 5, 5, 5, c);
		R(x + 2, base - 5, 1, 5, FUR);
		R(x, base - 3, 5, 1, FUR);
		R(x + 1, base - 6, 1, 1, FUR), R(x + 3, base - 6, 1, 1, FUR);
	}
}

const TRAIN = spr(`
.......k....
......kkk...
..yyyy.kk...
..ybby.kk...
rrrrrrrrrr..
rggggggggrg.
rrrrrrrrrrg.
.ww..ww.ww..
.ww..ww.ww..
`);
const HORSE = spr(`
........hh..
.......hhhe.
..t...hmhh..
.tt.hhhm....
.thhhhhh....
..hsshhh....
..h....h....
..h....h....
r.h....h.r..
.rrrrrrrr...
`);
const GHOUSE = spr(`
.....w.....
....www....
...wwgww...
..wwgggww..
.wwgggggww.
..ggggggg..
..gwgggwg..
..gggdggg..
..gggdggg..
`);
const TEDDY = spr(`
.b.....b.
bbb...bbb
.bbbbbbb.
.bebbbeb.
.bbbnbbb.
..bbbbb..
.bbbtbbb.
bbbtttbbb
.bbbtbbb.
.bb...bb.
`);
const TINMAN = spr(`
....r....
....k....
.sssssss.
.sbsssbs.
.sssssss.
..ccccc..
k.ccycc.k
k.ccccc.k
..ccccc..
..k...k..
`);

/** What a bay makes, as it stands on the bench: its feet at `base`, its left at `x`, about twelve pixels wide. */
function benchToy(kind: number, x: number, base: number, t: number, color: string): void {
	const put = (s: Sprite, pal: Record<string, string>, dx = 0) => {
		const dark: Record<string, string> = {};
		for (const k in pal) dark[k] = INK;
		for (const [ox, oy] of [[-1, 0], [1, 0], [0, -1]]) stamp(s, dark, x + dx + ox, base - s.h + oy);
		stamp(s, pal, x + dx, base - s.h);
	};
	if (kind === 0) put(TRAIN, { r: "#d8362f", g: GOLD, y: "#3fa468", b: "#bfe6f2", k: "#3a3340", w: "#3a3340" });
	else if (kind === 1) put(HORSE, { h: "#f6efe0", m: "#8a5a3a", t: "#8a5a3a", e: INK, s: color, r: "#d8362f" });
	else if (kind === 2) put(GHOUSE, { w: "#ffffff", g: GINGER, d: "#8a2a2a" }, 1);
	else if (kind === 3) put(TEDDY, { b: "#b07a4a", e: INK, n: INK, t: "#e0b88a" }, 1);
	else if (kind === 4) put(TINMAN, { r: "#e5484d", k: "#4a4763", s: "#f4f1ea", b: Math.floor(t / 1900) % 6 === 0 ? "#1d2440" : "#58d8e8", c: "#5a9aa8", y: GOLD }, 1);
	else if (kind === 5) {
		// A jar of sweets.
		R(x, base - 10, 11, 10, INK);
		R(x + 1, base - 9, 9, 9, "#d8f0f8");
		R(x + 2, base - 12, 7, 2, INK), R(x + 3, base - 12, 5, 1, GOLD);
		const c = ["#e5484d", "#3fa468", "#f2b134", "#4a90d9", "#ec7fa9"];
		for (let j = 0; j < 4; j++) for (let i = 0; i < 4; i++) R(x + 2 + i * 2 + (j % 2), base - 2 - j * 2, 1, 1, c[(i + j * 2) % 5]);
		R(x + 2, base - 8, 1, 5, "#ffffff");
	} else if (kind === 6) {
		// Parcels, one on the other.
		R(x, base - 6, 11, 6, INK);
		stamp(GIFT, wrapOf("#3fa468"), x + 1, base - 8);
		R(x + 2, base - 12, 9, 6, INK);
		stamp(PRESENT, wrapOf(color), x + 3, base - 14);
	} else if (kind === 7) {
		// A snow globe: a tree in it, and snow that never settles.
		const cx = x + 5;
		R(x, base - 3, 11, 3, INK), R(x + 1, base - 2, 9, 2, "#8a5a3a"), R(x + 1, base - 2, 9, 1, GOLD);
		disc(cx, base - 8, 5, INK);
		disc(cx, base - 8, 4, "#cfeaf6");
		R(cx - 3, base - 5, 7, 1, "#ffffff");
		R(cx, base - 10, 1, 5, PINE), R(cx - 1, base - 8, 3, 1, PINE), R(cx - 2, base - 6, 5, 1, PINE);
		for (let i = 0; i < 4; i++) R(cx - 3 + ((i * 3 + Math.floor(t / 300)) % 7), base - 11 + ((Math.floor(t / 180) + i * 2) % 6), 1, 1, "#ffffff");
		R(cx - 3, base - 11, 2, 1, "#ffffff");
	} else {
		// On Santa's desk: the globe, that he turns with a finger.
		const cx = x + 5;
		R(cx - 3, base - 2, 7, 2, INK), R(cx - 2, base - 1, 5, 1, GOLD), R(cx, base - 3, 1, 2, GOLD);
		disc(cx, base - 8, 5, INK);
		disc(cx, base - 8, 4, "#4a90d9");
		const turn = Math.floor(t / 600) % 8;
		for (const [lx, ly, lw] of [[0, -11, 3], [-1, -10, 3], [4, -9, 2], [1, -7, 3], [5, -6, 2], [2, -5, 2]]) {
			const px = ((lx + turn + 8) % 8) - 4;
			if (px + lw <= 4) R(cx + px, base + ly, lw, 1, "#3fa468");
		}
		R(cx - 3, base - 11, 2, 1, "#bfe0ff");
	}
}

// ---- the workshop -------------------------------------------------------------------------------------------------------

/** What in a room stands for something the agent has. */
export type Part = "rack" | "shelf" | "clocks" | "board" | "tasks";
export type Hit = { k: "agent"; id: string; part?: Part } | { k: "work"; id: number } | { k: "port"; id: string } | undefined;

export const ROOM_W = 120;
const ROOM_IN = 56;
const SLAB = 6;
const ROOM_H = ROOM_IN + SLAB;
const PENT_IN = 62;
const PENT_H = PENT_IN + SLAB;
const WALL = 7;
const TUBE = 12;
const HALL_IN = 46;
const HALL_H = HALL_IN + SLAB;
const GROUND_H = 44;
const SKY_ROOM = 70;
const ROOF_H = 30;
const SIDE = 60;
const WALK = 0.03;
const CAPSULE = 0.2;
const LINGER = 2600;
export const Z_MAX = 4;
const MIN = { w: ROOM_W * 1.25, h: ROOM_H * 1.9 };

export interface Room {
	agent: string;
	main: boolean;
	x: number;
	y: number;
	w: number;
	h: number;
	floorY: number;
	/** Where its things stand: the left edge of each. */
	shelf: number;
	win: Box[];
	board: Box;
	/** Where the task board stands while the agent has one with work on it: a cork board on a trolley, under the window. */
	tasks: Box;
	rack: number;
	desk: number;
	seat: Pt;
	plant: number;
	clocks: Pt;
	outlet: Pt;
	lamp: number;
	/** The main agent's wall screen, where its room is wide enough: a light for each agent. */
	screen?: Box;
	look: Look;
	/** The toys on its shelf, each its left, its feet, its kind and its color; its plant; which kind of workshop it is. */
	toys: Array<[number, number, number, string]>;
	bay: number;
	kind: number;
	/** How bright it is: it eases up when work starts. */
	lit: number;
}

interface Port {
	id: string;
	kind: ViewInput["kind"];
	name: string;
	type?: string;
	box: Box;
	mouth: Pt;
}

export type Act = "sit" | "type" | "wrap" | "read" | "skill" | "rack" | "think" | "wait" | "ask" | "hand" | "cheer" | "sad" | "sleep" | "sip" | "look" | "water" | "stand" | "list";

interface Worker {
	key: string;
	agent: string;
	work?: number;
	small: boolean;
	extra: boolean;
	x: number;
	dir: 1 | -1;
	act: Act;
	walking: boolean;
	until: number;
	idle: Act;
	/** Where it paces to while it thinks. */
	pace: number;
	/** A moment of its own: glad that work is done, sorry that it failed, holding up a present. */
	mood?: { act: Act; until: number };
	born: number;
	goneAt?: number;
	rand: () => number;
	box?: Box;
}

interface Capsule {
	path: Pt[];
	at: number;
	ms: number;
	color: string;
	sign?: Sign;
	to?: string;
}

/** A present on its way: a task handed on, its answer, something sent out. From an elf to an elf, or up to the sleigh. */
interface Letter {
	from: string;
	to?: string;
	at: number;
	ms: number;
	color: string;
	mark?: "tick" | "cross";
}

/** Something small that happens at a place and is over: a puff, sparks, a ring, confetti. */
interface Pop {
	x: number;
	y: number;
	at: number;
	color: string;
	kind: "poof" | "spark" | "ring" | "confetti";
}

/** A few words that rise from a place and fade: what just happened there. */
export interface Float {
	x: number;
	y: number;
	at: number;
	text: string;
	sign?: Sign;
	color: string;
}

interface Walker {
	x: number;
	dir: 1 | -1;
	speed: number;
	kind: "ski" | "bear";
	hat: string;
	coat: string;
	skin: string;
	cub: boolean;
}

interface Bird {
	x: number;
	y: number;
	home: Pt;
	kind: number;
	state: "sit" | "peck" | "away" | "back";
	until: number;
	dir: 1 | -1;
}

/** What is written over the picture, in the letters of the view: a door plate, a bubble, a name, a few rising words. */
export type Tag =
	| { k: "plate"; x: number; y: number; agent: string; mode: string; main: boolean; busy: boolean; outside: boolean }
	| { k: "say"; x: number; y: number; say: Say; small: boolean; work?: number }
	| { k: "label"; x: number; y: number; text: string; sign?: Sign; hot: boolean; bad?: boolean }
	| { k: "float"; x: number; y: number; text: string; sign?: Sign; color: string; age: number };

const READS = new Set(["read", "grep", "find", "ls", "manual", "read_source", "read_conversation", "find_tools", "state_get", "sources", "schedules", "mcp_servers", "skills", "agents", "settings", "conversations", "models", "pine_list"]);
const KIND_COLOR: Record<ViewInput["kind"], string> = { you: "#4ade80", clock: "#c084fc", source: "#4ea3ff", outside: "#f59e0b" };

export class Workshop {
	rooms = new Map<string, Room>();
	ports = new Map<string, Port>();
	workers = new Map<string, Worker>();
	width = 300;
	height = 300;
	perFloor = 1;
	cam: Cam = { x: 150, y: 150, z: 1 };
	aim: Box = { x: 0, y: 0, w: 300, h: 300 };
	glows: Glow[] = [];
	sky: Sky = skyAt(new Date());
	/** The steps the camera zooms in: 1 keeps every pixel of the picture a whole number of the screen's. */
	zoomStep = 1;
	private key = "";
	inner = { x: 0, w: 0 };
	shaftX = 0;
	hallTop = 0;
	ground = 0;
	pentTop = 0;
	roofTop = 0;
	turret: Box = { x: 0, y: 0, w: 0, h: 0 };
	dish: Pt = { x: 0, y: 0 };
	chimney: Pt = { x: 0, y: 0 };
	you: Box = { x: 0, y: 0, w: 0, h: 0 };
	vacant: Box[] = [];
	capsules: Capsule[] = [];
	letters: Letter[] = [];
	pops: Pop[] = [];
	floats: Float[] = [];
	walkers: Walker[] = [];
	birds: Bird[] = [];
	cat = { x: 0, dir: 1 as 1 | -1, state: "sit" as "sit" | "walk" | "nap", until: 0 };
	/** When something last happened at a thing: a gumball of a machine, a letter box, a bell, a board. */
	hotAt = new Map<string, number>();
	/** The board that stands in an agent's room, and when it last had work on it: it stays a moment after the last task is done. */
	private boardShown = new Map<string, { id: number; at: number }>();
	/** The agents whose task board was drawn in this frame, and the notice boards in the hall: what the pointer can be over. */
	private trolleys = new Set<string>();
	private notices: Array<{ id: number; name: string; box: Box }> = [];
	/** How you feel at your counter: asked, or glad of an answer. */
	youMood?: { kind: "asked" | "glad"; until: number };
	private nextWalker = 0;
	private seen = new Set<string>();
	private asking = new Set<number>();
	private hot: Array<{ box: Box; until: number }> = [];
	private aimedAt = 0;
	private last = 0;
	private fresh = true;
	/** Whether the camera has arrived where it goes: while it moves, it is drawn often. */
	settled = true;

	/** Builds the workshop for the agents there are, about as wide for its height as the view. Returns whether it changed. */
	layout(s: Now, view: { w: number; h: number }): boolean {
		const agents = s.agents;
		const main = agents.find((a) => a.main) ?? agents[0];
		const others = agents.filter((a) => a !== main);
		const ports = s.inputs;
		const boxes = ports.filter((p) => p.kind !== "clock" && p.kind !== "you");
		const aspect = view.w > 0 && view.h > 0 ? view.w / view.h : 0.8;
		const need = Math.ceil((48 + Math.ceil(boxes.length / 2) * 17) / ROOM_W);
		let perFloor = 1;
		let best = Infinity;
		for (let p = 1; p <= 5; p++) {
			const floors = Math.ceil(others.length / p);
			const w = SIDE * 2 + WALL * 2 + TUBE + p * ROOM_W;
			const h = SKY_ROOM + ROOF_H + PENT_H + floors * ROOM_H + HALL_H + GROUND_H;
			const off = Math.abs(Math.log(w / h / aspect));
			if (off < best - 0.05) (best = off), (perFloor = p);
		}
		perFloor = Math.max(perFloor, Math.min(2, others.length || 1), need);
		// Floors as full as they can be: four rooms on two floors are two and two, not three and one.
		const floors = Math.ceil(others.length / perFloor);
		if (floors > 0) perFloor = Math.max(Math.ceil(others.length / floors), need);
		const innerW = perFloor * ROOM_W;
		const key = `${perFloor}|${agents.map((a) => `${a.id}:${a.main}`).join(",")}|${ports.map((p) => p.id).join(",")}`;
		if (key === this.key) return false;
		this.key = key;
		this.perFloor = perFloor;
		this.width = SIDE * 2 + WALL * 2 + TUBE + innerW;
		this.roofTop = SKY_ROOM;
		this.pentTop = SKY_ROOM + ROOF_H;
		this.hallTop = this.pentTop + PENT_H + floors * ROOM_H;
		this.ground = this.hallTop + HALL_H;
		this.height = this.ground + GROUND_H;
		this.inner = { x: SIDE + WALL, w: innerW };
		this.shaftX = SIDE + WALL + innerW + TUBE / 2;
		const lit = new Map([...this.rooms.values()].map((r) => [r.agent, r.lit]));
		this.rooms.clear();
		if (main) this.rooms.set(main.id, this.room(main.id, true, this.inner.x, this.pentTop, innerW, PENT_IN, 0));
		others.forEach((a, i) => {
			const floor = Math.floor(i / perFloor);
			this.rooms.set(a.id, this.room(a.id, false, this.inner.x + (i % perFloor) * ROOM_W, this.hallTop - (floor + 1) * ROOM_H, ROOM_W, ROOM_IN, i));
		});
		for (const r of this.rooms.values()) r.lit = lit.get(r.agent) ?? 0;
		this.vacant = [];
		for (let i = others.length; i < floors * perFloor; i++) this.vacant.push({ x: this.inner.x + (i % perFloor) * ROOM_W, y: this.hallTop - (Math.floor(i / perFloor) + 1) * ROOM_H, w: ROOM_W, h: ROOM_IN });
		// The clock tower stands on the chute's shaft; the sleigh and the chimney on the roof.
		this.turret = { x: this.shaftX - 10, y: this.roofTop - 14, w: 20, h: ROOF_H + 14 };
		this.dish = { x: this.inner.x + Math.round(innerW * 0.55), y: this.roofTop - 6 };
		this.chimney = { x: this.inner.x + 9, y: this.roofTop - 4 };
		this.ports.clear();
		this.you = { x: this.inner.x + 5, y: this.hallTop + HALL_IN - 26, w: 34, h: 26 };
		let n = 0;
		for (const p of ports) {
			if (p.kind === "clock") this.ports.set(p.id, { id: p.id, kind: p.kind, name: p.name, box: { x: this.turret.x + 3, y: this.turret.y + 6, w: 14, h: 14 }, mouth: { x: this.shaftX, y: this.turret.y + 24 } });
			else if (p.kind === "you") this.ports.set(p.id, { id: p.id, kind: p.kind, name: p.name, box: this.you, mouth: { x: this.you.x + 31, y: this.you.y + 10 } });
			else {
				// One row of boxes where they fit, with their names under them; two rows where they do not.
				const rows = 48 + boxes.length * 22 + 20 <= innerW ? 1 : 2;
				const bx = this.inner.x + 48 + Math.floor(n / rows) * (rows === 1 ? 22 : 17);
				const by = this.hallTop + (rows === 1 ? 14 : 9 + (n % 2) * 16);
				this.ports.set(p.id, { id: p.id, kind: p.kind, name: p.name, type: p.type, box: { x: bx, y: by, w: 13, h: 11 }, mouth: { x: bx + 6, y: by } });
				n++;
			}
		}
		for (const w of this.workers.values()) {
			const room = this.rooms.get(w.agent);
			if (!room) this.workers.delete(w.key);
			else w.x = this.spot(room, w, w.act);
		}
		this.capsules = [];
		this.letters = [];
		// Birds on the roof, a cat on the ridge.
		const r = seeded(hashOf(key));
		const perches: Pt[] = [
			{ x: this.dish.x - 24, y: this.roofTop - 2 },
			{ x: this.chimney.x + 16, y: this.roofTop - 2 },
			{ x: this.inner.x + innerW - 16, y: this.roofTop - 2 },
			{ x: SIDE - 14, y: this.ground - 2 },
			{ x: this.width - SIDE + 20, y: this.ground - 2 },
		];
		this.birds = perches.map((home, i) => ({ x: home.x, y: home.y, home, kind: Math.floor(r() * BIRDS.length), state: "sit", until: 3000 + r() * 9000 + i * 1700, dir: r() < 0.5 ? 1 : -1 }));
		this.cat = { x: this.inner.x + innerW * 0.45, dir: 1, state: "sit", until: 0 };
		return true;
	}

	private room(agent: string, main: boolean, x: number, y: number, w: number, h: number, bay: number): Room {
		const floorY = y + h;
		const desk = x + w - 38;
		const rack = desk - (main ? 38 : 22);
		const board: Box = { x: rack - 9, y: y + 6, w: 23, h: 15 };
		const win: Box[] = [{ x: x + 24, y: y + 8, w: 24, h: 22 }];
		// A wide room has more windows, and the main agent's a wall screen with a light for each agent.
		let screen: Box | undefined;
		let free = board.x - 6 - (x + 52);
		if (main && free >= 48) {
			screen = { x: board.x - 6 - 44, y: y + 8, w: 44, h: 20 };
			free -= 50;
		}
		for (let i = 0; free >= 30; i++, free -= 34) win.push({ x: x + 54 + i * 34, y: y + 8, w: 24, h: 22 });
		const look = lookOf(agent);
		const r = seeded(look.seed);
		const toys: Room["toys"] = [];
		for (let k = 0; k < 2; k++) for (let n = 0; n < 3; n++) if (r() < 0.85) toys.push([x + 5 + n * 5, floorY - 25 + k * 11, Math.floor(r() * 6), TOYS[Math.floor(r() * TOYS.length)]]);
		return { agent, main, x, y, w, h, floorY, shelf: x + 3, win, board, tasks: { x: x + 24, y: floorY - 25, w: 26, h: 17 }, rack, desk, seat: { x: desk - 4, y: floorY - 6 }, plant: rack - 8, clocks: { x: desk + 2, y: y + 9 }, outlet: { x: x + w - 7, y: y + 8 }, lamp: x + 51, screen, look, toys, bay, kind: Math.floor(r() * 16), lit: 0 };
	}

	whole(): Box {
		return { x: 0, y: 0, w: this.width, h: this.height };
	}

	/** The workshop without the snow around it. */
	house(): Box {
		return { x: SIDE - 4, y: this.roofTop - 22, w: this.width - SIDE * 2 + 8, h: this.ground - this.roofTop + 34 };
	}

	private spot(room: Room, w: Worker, act: Act): number {
		const k = w.extra || w.small ? (hashOf(w.key) % 5) * 7 : 0;
		const row = room.x + 30 + k;
		if (w.small || w.extra) return act === "read" || act === "skill" ? room.shelf + 25 + (k % 14) : row;
		switch (act) {
			case "read":
			case "skill":
				return room.shelf + 25;
			case "rack":
				return room.rack - 6;
			case "sip":
			case "look":
				return room.win[0].x + 12;
			case "water":
				return room.plant - 9;
			case "ask":
			case "hand":
				return room.x + 44;
			case "list":
				return room.x + 40;
			case "think":
				return w.pace || room.x + 44;
			case "cheer":
			case "sad":
			case "stand":
				return w.x;
			default:
				return room.seat.x;
		}
	}

	/** The way of a sweet from a letter box, or from the clock, through the chute to a bay. */
	private pipe(port: Port, room: Room): Pt[] {
		const run = room.y + 4;
		const end = [{ x: this.shaftX, y: run }, { x: room.outlet.x, y: run }, room.outlet, { x: room.outlet.x, y: room.floorY - 14 }];
		if (port.kind === "clock") return [port.mouth, ...end];
		const manifold = this.hallTop + 4;
		return [port.mouth, { x: port.mouth.x, y: manifold }, { x: this.shaftX, y: manifold }, ...end];
	}

	private colorOf(s: Now, agent: string): string {
		return s.agent.get(agent)?.color ?? "#8899aa";
	}

	/** Elves for work, sweets for what came in, presents for what was handed on. */
	sync(s: Now, now: number): void {
		const first = this.fresh;
		this.fresh = false;
		const primary = new Map<string, ViewWork>();
		for (const w of s.running) if (!w.copy && !primary.has(w.agent)) primary.set(w.agent, w);
		for (const room of this.rooms.values()) {
			const key = `a:${room.agent}`;
			let w = this.workers.get(key);
			if (!w) {
				const rand = seeded(hashOf(key));
				w = { key, agent: room.agent, small: false, extra: false, x: room.seat.x, dir: 1, act: "sit", walking: false, until: now + (room.main ? 1500 + rand() * 2500 : 3000 + rand() * 14_000), idle: "sit", pace: 0, born: now, rand };
				this.workers.set(key, w);
			}
			w.work = primary.get(room.agent)?.id;
		}
		for (const j of s.running) {
			if (primary.get(j.agent)?.id === j.id) continue;
			const key = `j:${j.id}`;
			const room = this.rooms.get(j.agent);
			if (this.workers.has(key) || !room) continue;
			const parent = this.workers.get(`a:${j.agent}`);
			const w: Worker = { key, agent: j.agent, work: j.id, small: j.copy, extra: !j.copy, x: parent?.x ?? room.seat.x, dir: 1, act: "stand", walking: false, until: 0, idle: "stand", pace: 0, born: now, rand: seeded(j.id) };
			this.workers.set(key, w);
			if (!first) this.pops.push({ x: w.x, y: room.floorY - 8, at: now, color: this.colorOf(s, j.agent), kind: "poof" });
		}
		for (const w of this.workers.values()) {
			if (!w.key.startsWith("j:") || w.goneAt !== undefined) continue;
			const j = w.work !== undefined ? s.work.get(w.work) : undefined;
			// Its work is over; or the agent's own elf has taken it over, the work before it having ended.
			if (!j || ended(j) || primary.get(w.agent)?.id === j.id) w.goneAt = now;
		}
		const you = this.ports.get("you");
		for (const j of s.work.values()) {
			const room = this.rooms.get(j.agent);
			if (!room) continue;
			const recent = now - j.started < 8000;
			const parent = j.parent !== undefined ? s.work.get(j.parent) : undefined;
			const handed = parent && parent.agent !== j.agent && this.rooms.has(parent.agent);
			if (!this.seen.has(`s${j.id}`)) {
				this.seen.add(`s${j.id}`);
				if (!first && recent && !j.copy) {
					if (handed) {
						this.fly(parent.agent, j.agent, now, this.colorOf(s, parent.agent));
						const giver = this.workers.get(`a:${parent.agent}`);
						if (giver) giver.mood = { act: "hand", until: now + 900 };
					} else {
						const id = portOf(j);
						const port = id ? this.ports.get(id) : undefined;
						if (port) this.send(this.pipe(port, room), now, KIND_COLOR[port.kind], sourceSign(port.type, port.kind), room.agent);
					}
				}
			}
			// A question goes down to your desk.
			if (j.asking && !this.asking.has(j.id)) {
				this.asking.add(j.id);
				if (!first && you) {
					this.send(this.pipe(you, room).reverse(), now, "#ff5a5f", "ask");
					this.youMood = { kind: "asked", until: now + 60_000 };
				}
			} else if (!j.asking && this.asking.delete(j.id) && this.youMood?.kind === "asked" && !this.asking.size) this.youMood = undefined;
			if (ended(j) && !this.seen.has(`e${j.id}`)) {
				this.seen.add(`e${j.id}`);
				this.asking.delete(j.id);
				if (first || j.finished === undefined || now - j.finished > 8000) continue;
				const failed = j.doing === "failed";
				const mine = this.workers.get(`a:${j.agent}`);
				if (!j.copy && mine && (mine.work === undefined || mine.work === j.id)) {
					mine.mood = { act: failed ? "sad" : "cheer", until: now + (failed ? 2400 : 1500) };
					this.pops.push({ x: mine.x, y: room.floorY - 22, at: now, color: failed ? "#e5484d" : this.colorOf(s, j.agent), kind: failed ? "poof" : "confetti" });
				}
				if (j.copy) continue;
				if (handed) this.fly(j.agent, parent.agent, now, this.colorOf(s, j.agent), failed ? "cross" : "tick");
				else if (j.depth === 0 && j.from.k === "you" && you) {
					this.send(this.pipe(you, room).reverse(), now, failed ? "#ff5a5f" : "#4ade80", failed ? "cross" : "tick");
					if (!failed) this.youMood = { kind: "glad", until: now + 5000 };
				}
			}
		}
	}

	/** What just happened, as the panel says it: the small things the state alone does not show. */
	hear(h: ViewHappening, s: Now, now: number): void {
		const at = (agent: string, dx: number, dy: number): Pt | undefined => {
			const r = this.rooms.get(agent);
			return r && { x: r.x + dx, y: r.y + dy };
		};
		const say = (p: Pt | undefined, text: string, sign: Sign, color: string) => p && this.floats.push({ x: p.x, y: p.y, at: now, text, sign, color });
		switch (h.k) {
			case "skill": {
				this.hotAt.set(`skill:${h.agent}:${h.skill}`, now);
				const r = this.rooms.get(h.agent);
				if (r) say({ x: r.shelf + 9, y: r.floorY - 40 }, h.skill, "star", HUE.skill), this.pops.push({ x: r.shelf + 9, y: r.floorY - 8, at: now, color: "#ffe27a", kind: "spark" });
				break;
			}
			case "tool":
				if (h.mcp) this.hotAt.set(`mcp:${h.agent}:${h.mcp}`, now);
				break;
			case "toolEnded": {
				const w = this.workers.get(`j:${h.work}`) ?? this.workers.get(`a:${h.agent}`);
				const r = this.rooms.get(h.agent);
				if (!h.ok && w && r) this.pops.push({ x: w.x, y: r.floorY - 20, at: now, color: "#e5484d", kind: "spark" });
				break;
			}
			case "event":
				this.hotAt.set(`port:${h.input}`, now);
				break;
			case "scheduled":
				this.hotAt.set("clock", now);
				if (h.agent) this.hotAt.set(`clocks:${h.agent}`, now);
				if (h.name) say({ x: this.turret.x + 10, y: this.turret.y - 4 }, h.name, "clock", KIND_COLOR.clock);
				this.pops.push({ x: this.turret.x + 10, y: this.turret.y + 13, at: now, color: KIND_COLOR.clock, kind: "ring" });
				break;
			case "sent":
				if (this.rooms.has(h.agent)) this.letters.push({ from: h.agent, at: now, ms: 1500, color: this.colorOf(s, h.agent) });
				break;
			case "branched": {
				this.hotAt.set(`board:${h.agent}`, now);
				const r = this.rooms.get(h.agent);
				if (r) say({ x: r.board.x + 11, y: r.board.y - 2 }, h.worktree ? "new branch in a worktree" : "new branch", "branch", "#2fa868"), this.pops.push({ x: r.board.x + 11, y: r.board.y + 7, at: now, color: "#7ee0a0", kind: "spark" });
				break;
			}
			case "worktree": {
				this.hotAt.set(`board:${h.agent}`, now);
				const r = this.rooms.get(h.agent);
				if (r) say({ x: r.board.x + 11, y: r.board.y - 2 }, h.made ? "new worktree" : "worktree removed", "leaf", "#2fa868");
				break;
			}
			case "goal": {
				const r = this.rooms.get(h.agent);
				if (r) say({ x: r.board.x + 11, y: r.board.y - 2 }, `goal ${h.status === "met" ? "met!" : h.status}`, "flag", h.status === "met" ? "#2fa868" : h.status === "active" ? HUE.write : HUE.wait);
				if (r && h.status === "met") this.pops.push({ x: r.board.x + 11, y: r.board.y + 4, at: now, color: "#ffe27a", kind: "confetti" });
				break;
			}
			case "board": {
				// Something happened on a board: its cards change by themselves. A word says what, at the board it happened
				// on, and not for every one of forty tasks; a question and a failure are always said.
				const r = h.agent ? this.rooms.get(h.agent) : undefined;
				const notice = this.notices.find((n) => n.id === h.board);
				const at = notice ? { x: notice.box.x + notice.box.w / 2, y: notice.box.y - 2 } : r ? { x: r.tasks.x + r.tasks.w / 2, y: r.tasks.y - 2 } : undefined;
				const key = notice ? `notice:${h.board}` : `tasks:${h.agent}`;
				const said: readonly [string, Sign, string] | undefined =
					h.state === "blocked" ? ["a question", "ask", HUE.ask] : h.state === "failed" ? ["task failed", "cross", "#e5484d"] : h.state === "done" ? ["task done", "tick", "#2fa868"] : h.change === "taken" ? ["task taken", "hand", HUE.hand] : h.change === "posted" ? [h.task !== undefined ? "new task" : "new note", "note", HUE.hand] : h.change === "released" ? ["task open again", "note", HUE.hand] : undefined;
				if (!at || !said) break;
				this.hotAt.set(key, now);
				const loud = h.state === "blocked" || h.state === "failed";
				if (!loud && now - (this.hotAt.get(`said:${key}`) ?? 0) < 1200) break;
				this.hotAt.set(`said:${key}`, now);
				say(at, said[0], said[1], said[2]);
				break;
			}
			case "steps": {
				const w = this.workers.get(`a:${h.agent}`);
				const r = this.rooms.get(h.agent);
				if (w && r && h.done) this.pops.push({ x: w.x, y: r.floorY - 24, at: now, color: "#7ee0a0", kind: "spark" });
				break;
			}
			case "decided": {
				// Your yes or no goes up from your desk to whoever asked.
				const you = this.ports.get("you");
				const j = [...this.asking].map((id) => s.work.get(id)).find(Boolean) ?? (h.work !== undefined ? s.work.get(h.work) : undefined);
				const room = j && this.rooms.get(j.agent);
				if (you && room) this.send(this.pipe(you, room), now, h.allowed ? "#4ade80" : "#ff5a5f", h.allowed ? "tick" : "cross", room.agent);
				break;
			}
			case "said": {
				const you = this.ports.get("you");
				const room = this.rooms.get(h.agent);
				if (you && room) this.send(this.pipe(you, room), now, KIND_COLOR.you, "chat", room.agent);
				break;
			}
			case "outside":
				say(at(h.agent, 44, 16), "read outside content", "warn", "#d9822b");
				break;
			default:
				break;
		}
		if (this.floats.length > 24) this.floats.splice(0, this.floats.length - 24);
	}

	private send(path: Pt[], now: number, color: string, sign?: Sign, to?: string): void {
		this.capsules.push({ path, at: now, ms: Math.max(700, lengthOf(path) / CAPSULE), color, sign, to });
	}

	private fly(from: string, to: string, now: number, color: string, mark?: "tick" | "cross"): void {
		const a = this.centerOf(from);
		const b = this.centerOf(to);
		this.letters.push({ from, to, at: now, ms: clamp(a && b ? Math.hypot(a.x - b.x, a.y - b.y) / 0.085 : 1200, 1100, 2600), color, mark });
	}

	/** Where somebody holds their head: where presents leave from and land. */
	headOf(agent: string): Pt | undefined {
		const w = this.workers.get(`a:${agent}`);
		const r = this.rooms.get(agent);
		return w && r ? { x: w.x, y: r.floorY - 24 } : undefined;
	}

	/** Where a present is now, and which way it flies. */
	letterAt(l: Letter, now: number): { x: number; y: number; k: number; dir: 1 | -1 } | undefined {
		const a = this.headOf(l.from);
		const b = l.to ? this.headOf(l.to) : { x: this.dish.x, y: this.dish.y - 6 };
		if (!a || !b) return undefined;
		const k = clamp((now - l.at) / l.ms);
		const e = k * k * (3 - 2 * k);
		// It rises out of the hand, flies a bow and comes down.
		const lift = Math.min(46, 16 + Math.hypot(b.x - a.x, b.y - a.y) * 0.18);
		return { x: lerp(a.x, b.x, e), y: lerp(a.y, b.y, e) - Math.sin(Math.PI * e) * lift, k, dir: b.x >= a.x ? 1 : -1 };
	}

	/** Who works for whom right now: a line from the room that waits to the room that works. */
	links(s: Now): Array<{ from: string; to: string; color: string }> {
		const out: Array<{ from: string; to: string; color: string }> = [];
		for (const j of s.running) {
			const parent = j.parent !== undefined ? s.work.get(j.parent) : undefined;
			if (!parent || j.copy || parent.agent === j.agent || !this.rooms.has(parent.agent) || !this.rooms.has(j.agent)) continue;
			if (!out.some((l) => l.from === parent.agent && l.to === j.agent)) out.push({ from: parent.agent, to: j.agent, color: this.colorOf(s, parent.agent) });
		}
		return out;
	}

	/** Moves everything on by the time since the last frame, and the camera towards what happens. */
	step(s: Now, now: number, view: { w: number; h: number }, o: { focus?: Hit; follow: boolean }): void {
		const dt = this.last ? Math.min(100, now - this.last) : 0;
		this.last = now;
		this.sky = skyAt(clock());
		for (const c of this.capsules) if (now - c.at >= c.ms) this.pops.push({ ...c.path[c.path.length - 1], at: now, color: c.color, kind: "spark" });
		this.capsules = this.capsules.filter((c) => now - c.at < c.ms);
		for (const l of this.letters) {
			if (now - l.at < l.ms) continue;
			const p = this.letterAt(l, now);
			if (p) this.pops.push({ x: p.x, y: p.y, at: now, color: l.mark === "cross" ? "#e5484d" : l.color, kind: l.to ? "spark" : "ring" });
			if (!l.to) this.hotAt.set("dish", now);
		}
		this.letters = this.letters.filter((l) => now - l.at < l.ms);
		this.pops = this.pops.filter((p) => now - p.at < 900);
		this.floats = this.floats.filter((f) => now - f.at < 2600);
		if (this.youMood && now > this.youMood.until) this.youMood = undefined;
		const working = new Set(s.running.map((j) => j.agent));
		for (const r of this.rooms.values()) r.lit = clamp(r.lit + (working.has(r.agent) ? 1 : -1) * (dt / 500));
		for (const w of this.workers.values()) {
			if (w.goneAt !== undefined && now - w.goneAt > 500) {
				const room = this.rooms.get(w.agent);
				if (room) this.pops.push({ x: w.x, y: room.floorY - 8, at: now, color: this.colorOf(s, w.agent), kind: "poof" });
				this.workers.delete(w.key);
				continue;
			}
			this.move(s, w, now, dt);
		}
		this.life(now, dt);
		const add = (box: Box | undefined) => box && this.hot.push({ box, until: now + LINGER });
		const roomBox = (a: string) => {
			const r = this.rooms.get(a);
			return r && { x: r.x, y: r.y - 14, w: r.w, h: r.h + 16 };
		};
		for (const j of s.running) add(roomBox(j.agent));
		for (const c of this.capsules) {
			const p = along(c.path, (now - c.at) / c.ms);
			add({ x: p.x - 10, y: p.y - 10, w: 20, h: 20 });
			if (c.to) add(roomBox(c.to));
		}
		for (const l of this.letters) add(roomBox(l.from)), l.to && add(roomBox(l.to));
		for (const i of s.inputs) if (i.last !== undefined && now - i.last < 1500) add(this.ports.get(i.id)?.box);
		this.hot = this.hot.filter((h) => h.until > now);
		if (now - this.aimedAt > 400 || o.focus) {
			this.aimedAt = now;
			this.aim = this.aimFor(s, o.focus);
		}
		if (o.follow) {
			const target = this.framed(this.aim, view);
			this.cam = ease(this.cam, target, dt);
			this.settled = this.cam.x === target.x && this.cam.y === target.y && this.cam.z === target.z;
		} else this.settled = true;
	}

	/**
	 * How long to wait between frames: thirty a second while something travels (a sweet, a present, the
	 * camera on its way), twenty while an elf walks, fifteen while agents work in their bays, ten at rest,
	 * when only the snow and the sky move, and four while the app's window is not in front. What draws less
	 * costs the battery less.
	 */
	pace(s: Now): number {
		if (!s.focused) return 250;
		if (this.capsules.length || this.letters.length || this.pops.length || !this.settled) return 33;
		if ([...this.workers.values()].some((w) => w.walking || w.goneAt !== undefined || w.mood)) return 50;
		return s.running.length ? 66 : 100;
	}

	/** What the camera should show: what is chosen, else what happened lately, else all of it. */
	aimFor(s: Now, focus?: Hit): Box {
		const boxes: Box[] = [];
		const roomBox = (a: string) => {
			const r = this.rooms.get(a);
			if (r) boxes.push({ x: r.x, y: r.y - 14, w: r.w, h: r.h + 16 });
		};
		if (focus?.k === "agent") roomBox(focus.id);
		else if (focus?.k === "work") {
			const j = s.work.get(focus.id);
			if (j) roomBox(j.agent);
		} else for (const h of this.hot) boxes.push(h.box);
		return boxes.length ? union(boxes) : this.whole();
	}

	/**
	 * Where the camera stands to show a box: in whole steps of the zoom, so that every pixel of the picture is a
	 * whole number of the screen's. A workshop too big for that is shown at a half, a third, a quarter.
	 */
	framed(box: Box, view: { w: number; h: number }): Cam {
		const whole = this.whole();
		const all = Math.min(view.w / (whole.w + 8), view.h / (whole.h + 8));
		const want = Math.max(Math.min(all, Z_MAX), Math.min(Z_MAX, view.w / Math.max(box.w + 16, MIN.w), view.h / Math.max(box.h + 16, MIN.h)));
		const step = want >= this.zoomStep ? this.zoomStep : this.zoomStep / Math.ceil(this.zoomStep / Math.max(0.05, want));
		return frame(box, view, whole, { zMax: Z_MAX, min: MIN, step, zMin: step });
	}

	private move(s: Now, w: Worker, now: number, dt: number): void {
		const room = this.rooms.get(w.agent);
		if (!room) return;
		const j = w.work !== undefined ? s.work.get(w.work) : undefined;
		const busy = j && !ended(j);
		if (w.mood && now > w.mood.until) w.mood = undefined;
		let act: Act;
		if (w.mood && (w.mood.act !== "hand" || !j?.asking)) act = w.mood.act;
		else if (busy) {
			if (j.asking) act = "ask";
			else if (j.doing === "tool") act = j.skill ? "skill" : j.mcp ? "rack" : READS.has(j.tool ?? "") ? "read" : "type";
			else if (j.doing === "writing") act = "wrap";
			else if (j.doing === "waiting") act = "wait";
			else act = "think";
			if (w.small || w.extra) act = act === "wait" || act === "rack" ? "stand" : act === "skill" ? "read" : act === "wrap" ? "type" : act;
			if (act === "think" && !w.small && !w.extra && (!w.pace || (Math.abs(w.x - w.pace) < 1 && now > w.until))) {
				// It paces while it thinks: across the room and back, a pause at each end.
				w.pace = w.pace > room.x + 44 ? room.x + 30 + w.rand() * 8 : room.x + 50 + w.rand() * 8;
				w.until = now + 500 + w.rand() * 900;
			}
		} else {
			// At rest: at night it sleeps at its desk; by day it potters about.
			const night = this.sky.day < 0.25;
			if (now > w.until) {
				const r = w.rand();
				const was = w.idle;
				// Santa checks his list, and now and then does something else for a moment; an elf potters about.
				if (room.main) w.idle = was !== "list" ? "list" : r < 0.3 ? "sip" : r < 0.55 ? "look" : r < 0.75 ? "read" : "sit";
				else w.idle = was !== "sit" ? "sit" : r < 0.3 ? "sip" : r < 0.5 ? "look" : r < 0.68 ? "water" : r < 0.82 ? "read" : "sit";
				w.until = now + (w.idle === "list" ? 14_000 + w.rand() * 18_000 : w.idle === "sit" ? 9000 + w.rand() * 16_000 : 4500 + w.rand() * 4500);
			}
			act = w.small || w.extra ? "stand" : night ? "sleep" : w.idle;
		}
		const to = this.spot(room, w, act);
		const d = to - w.x;
		w.walking = Math.abs(d) > 0.5;
		if (w.walking) {
			w.x += Math.sign(d) * Math.min(Math.abs(d), dt * WALK * (w.small ? 1.3 : 1));
			w.dir = d > 0 ? 1 : -1;
		} else {
			w.x = to;
			w.dir = act === "read" || act === "skill" || act === "wait" ? -1 : act === "think" ? w.dir : 1;
			if (act === "list") w.dir = 1;
		}
		w.act = act;
	}

	/** The life outside: skiers and bears on the track, robins on the roof, the cat. */
	private life(now: number, dt: number): void {
		const night = 1 - this.sky.day;
		const r = Math.random;
		if (now > this.nextWalker && this.walkers.length < 5) {
			const dir = r() < 0.5 ? 1 : -1;
			const bear = r() < 0.22 && !this.walkers.some((p) => p.kind === "bear");
			this.walkers.push({ x: dir > 0 ? -44 : this.width + 44, dir, speed: bear ? 0.006 + r() * 0.003 : 0.02 + r() * 0.014, kind: bear ? "bear" : "ski", hat: COATS[Math.floor(r() * COATS.length)], coat: TUNICS[Math.floor(r() * TUNICS.length)], skin: ELF_SKINS[Math.floor(r() * ELF_SKINS.length)], cub: r() < 0.5 });
			this.nextWalker = now + (5000 + r() * 9000) * (1 + night * 3);
		}
		for (const p of this.walkers) p.x += p.dir * p.speed * dt;
		this.walkers = this.walkers.filter((p) => p.x > -70 && p.x < this.width + 70);
		for (const b of this.birds) {
			if (b.state === "away") {
				b.x += b.dir * dt * 0.05;
				b.y -= dt * 0.022;
				if (now > b.until) (b.state = "back"), (b.x = b.home.x - b.dir * 70), (b.y = b.home.y - 40);
			} else if (b.state === "back") {
				const dx = b.home.x - b.x;
				const dy = b.home.y - b.y;
				const d = Math.hypot(dx, dy);
				if (d < 1.5) (b.state = "sit"), (b.x = b.home.x), (b.y = b.home.y), (b.until = now + 5000 + r() * 15_000);
				else (b.x += (dx / d) * dt * 0.05), (b.y += (dy / d) * dt * 0.05), (b.dir = dx > 0 ? 1 : -1);
			} else if (now > b.until || (b.home.y > this.ground - 6 && this.walkers.some((p) => Math.abs(p.x - b.x) < 14))) {
				if (b.state === "sit" && r() < 0.5 && now > b.until) (b.state = "peck"), (b.until = now + 1200 + r() * 1500);
				else if (night > 0.7) (b.state = "sit"), (b.until = now + 20_000);
				else (b.state = "away"), (b.until = now + 4000 + r() * 9000), (b.dir = r() < 0.5 ? 1 : -1);
			} else if (b.state === "sit" && r() < dt / 4000) b.dir = b.dir > 0 ? -1 : 1;
		}
		const c = this.cat;
		if (now > c.until) {
			const was = c.state;
			c.state = night > 0.6 ? "nap" : was === "walk" ? (r() < 0.5 ? "sit" : "nap") : "walk";
			c.until = now + (c.state === "walk" ? 3000 + r() * 4000 : 7000 + r() * 14_000);
			if (c.state === "walk") c.dir = c.x > this.inner.x + this.inner.w * 0.5 ? -1 : 1;
		}
		if (c.state === "walk") {
			c.x += c.dir * dt * 0.012;
			const lo = this.inner.x + 10;
			const hi = this.inner.x + this.inner.w - 26;
			if (c.x < lo || c.x > hi) (c.dir = c.x < lo ? 1 : -1), (c.x = clamp(c.x, lo, hi));
		}
	}

	hit(p: Pt): Hit {
		for (const w of [...this.workers.values()].reverse()) if (w.box && inside(p, w.box)) return w.work !== undefined ? { k: "work", id: w.work } : { k: "agent", id: w.agent };
		for (const room of this.rooms.values()) {
			if (!inside(p, { x: room.x, y: room.y, w: room.w, h: room.h + SLAB })) continue;
			const part: Part | undefined = this.trolleys.has(room.agent) && inside(p, { x: room.tasks.x - 1, y: room.tasks.y - 1, w: room.tasks.w + 2, h: room.tasks.h + 2 }) ? "tasks" : inside(p, { x: room.rack - 1, y: room.floorY - 34, w: 12, h: 34 }) ? "rack" : inside(p, { x: room.shelf, y: room.floorY - 37, w: 19, h: 37 }) ? "shelf" : inside(p, { x: room.board.x - 1, y: room.board.y - 1, w: room.board.w + 2, h: room.board.h + 2 }) ? "board" : inside(p, { x: room.clocks.x - 1, y: room.clocks.y - 2, w: 30, h: 11 }) ? "clocks" : undefined;
			return { k: "agent", id: room.agent, ...(part ? { part } : {}) };
		}
		for (const port of this.ports.values()) if (inside(p, { x: port.box.x - 2, y: port.box.y - 2, w: port.box.w + 4, h: port.box.h + 4 })) return { k: "port", id: port.id };
		return undefined;
	}

	centerOf(agent: string): Pt | undefined {
		const r = this.rooms.get(agent);
		return r && { x: r.x + r.w / 2, y: r.y + r.h / 2 };
	}

	elfOf(agent: string): { x: number; act: Act; walking: boolean } | undefined {
		const w = this.workers.get(`a:${agent}`);
		return w && { x: w.x, act: w.act, walking: w.walking };
	}

	elves(): Array<{ agent: string; work?: number; small: boolean }> {
		return [...this.workers.values()].filter((w) => w.goneAt === undefined).map((w) => ({ agent: w.agent, work: w.work, small: w.small }));
	}

	traffic(): { capsules: number; letters: number } {
		return { capsules: this.capsules.length, letters: this.letters.length };
	}

	/** What to write over the picture: door plates, bubbles, the names of the letter boxes, what just happened. */
	tags(s: Now, now: number): Tag[] {
		const out: Tag[] = [];
		const busy = new Set(s.running.map((j) => j.agent));
		const outside = new Set(s.running.filter((j) => j.outside).map((j) => j.agent));
		for (const r of this.rooms.values()) out.push({ k: "plate", x: r.x + 2, y: r.y + 1, agent: r.agent, mode: s.agent.get(r.agent)?.mode ?? "", main: r.main, busy: busy.has(r.agent), outside: outside.has(r.agent) });
		for (const p of this.ports.values()) {
			const hot = now - (this.hotAt.get(`port:${p.id}`) ?? -1e9) < 2500;
			const input = s.input.get(p.id);
			if (p.kind === "clock") {
				const next = s.schedules.find((x) => x.next !== undefined && x.next > now - 1000);
				out.push({ k: "label", x: this.turret.x + this.turret.w / 2, y: this.turret.y - 9, text: next ? `${next.name} ${untilText(next.next! - now)}` : s.schedules.length ? `${s.schedules.length} schedule${s.schedules.length === 1 ? "" : "s"}` : "", sign: "clock", hot: now - (this.hotAt.get("clock") ?? -1e9) < 3000 });
			} else if (p.kind === "you") out.push({ k: "label", x: p.box.x + 13, y: p.box.y + p.box.h + 1, text: "you", hot: Boolean(this.youMood) });
			else if (hot || p.box.y === this.hallTop + 14) out.push({ k: "label", x: p.box.x + p.box.w / 2, y: p.box.y + p.box.h + (Math.round((p.box.x - this.inner.x - 48) / 22) % 2 ? 10 : 0), text: p.name, hot, bad: input?.failing });
		}
		this.placeNotices(s);
		for (const n of this.notices) out.push({ k: "label", x: n.box.x + n.box.w / 2, y: n.box.y + n.box.h + 1, text: n.name, hot: now - (this.hotAt.get(`notice:${n.id}`) ?? -1e9) < 2500 });
		for (const w of this.workers.values()) {
			if (w.goneAt !== undefined) continue;
			const j = w.work !== undefined ? s.work.get(w.work) : undefined;
			const room = this.rooms.get(w.agent);
			if (!j || ended(j) || !room) continue;
			// Over its head: where it was last drawn, or where it stands.
			out.push({ k: "say", x: w.box ? w.box.x + w.box.w / 2 : w.x, y: w.box ? w.box.y : room.floorY - (w.small ? 16 : 26), say: sayOf(j, s, now), small: w.small || w.extra, work: j.id });
		}
		for (const f of this.floats) out.push({ k: "float", x: f.x, y: f.y, text: f.text, sign: f.sign, color: f.color, age: (now - f.at) / 2600 });
		return out;
	}

	// ---- drawing --------------------------------------------------------------------------------------------------------

	/**
	 * Draws what the camera sees into `ctx`, a canvas of the picture's own pixels: `v` says which part of
	 * the world it shows (`ox`, `oy` its upper left, `cx` the camera's middle, for the depths behind).
	 */
	draw(ctx: Ctx, s: Now, now: number, v: { ox: number; oy: number; w: number; h: number; cx: number }, o: { selected?: Hit; hover?: Hit }): void {
		g = ctx;
		T = PLAIN;
		this.glows = [];
		const sky = this.sky;
		const night = 1 - sky.day;
		const home = v.h - Math.min(40, Math.round(v.h * 0.2));
		drawBackdrop({ vw: v.w, vh: v.h, cx: v.cx, ground: this.ground - v.oy, home }, sky, now, this.glows);
		const out = tintOf(sky.grade);
		const x0 = v.ox - 2;
		const x1 = v.ox + v.w + 2;
		const sees = (b: Box) => b.x < x1 && b.x + b.w > x0 && b.y < v.oy + v.h + 2 && b.y + b.h > v.oy - 2;
		g.save();
		g.translate(-v.ox, -v.oy);
		const glowAt = (x: number, y: number, r: number, color: string, a: number) => this.glows.push({ x: x - v.ox, y: y - v.oy, r, color, a });
		const worldGlows: Glow[] = [];

		// Behind the workshop: pines, lollipops as tall as trees, a snowman, an igloo; a fence of candy canes.
		T = out;
		const houseL = SIDE - 10;
		const houseR = this.width - SIDE + 10;
		for (let cell = Math.floor((x0 - 40) / 46); cell <= Math.floor((x1 + 40) / 46); cell++) {
			const r = seeded(cell * 7919 + 13);
			const cx = cell * 46 + 12 + Math.floor(r() * 22);
			const what = r();
			if (cx > houseL - 6 && cx < houseR + 6) continue;
			if (what < 0.4) drawPine(cx, this.ground + 3, 46 + Math.floor(r() * 26), sky, now, what < 0.26, worldGlows);
			else if (what < 0.56) drawLolly(cx, this.ground + 3, 24 + Math.floor(r() * 12), now, cell);
			else if (what < 0.68) drawSnowman(cx, this.ground + 4, now, cell & 0xffff);
			else if (what < 0.76 && (cx < houseL - 24 || cx > houseR + 24)) drawIgloo(cx, this.ground + 4, night, worldGlows);
		}
		this.garden(sky, now, x0, x1, v.oy + v.h);
		T = out;
		for (let x = Math.floor(x0 / 6) * 6; x < x1; x += 6) {
			if (x > houseL && x < houseR) continue;
			for (let j = 0; j < 7; j++) R(x, this.ground - 6 + j, 1, 1, j % 2 ? "#e5484d" : "#ffffff");
			R(x + 1, this.ground - 7, 1, 1, "#e5484d");
			R(x + 1, this.ground - 4, 5, 1, "#f4efe6");
			R(x + 1, this.ground - 5, 5, 1, "#ffffff");
		}

		if (sees(this.house())) {
			this.shell(s, now, sky, worldGlows);
			const working = new Map<string, ViewWork[]>();
			for (const j of s.running) working.set(j.agent, [...(working.get(j.agent) ?? []), j]);
			for (const room of this.rooms.values()) {
				// (Which board stands in a room is found for every room, seen or not: the pointer asks for it.)
				this.boardOf(s, room.agent, now);
				if (!sees({ x: room.x, y: room.y, w: room.w, h: room.h + SLAB })) continue;
				this.drawRoom(s, room, working.get(room.agent) ?? [], now, night, worldGlows);
			}
			for (const b of this.vacant) if (sees(b)) this.drawVacant(b, night);
			this.hall(s, now, night, worldGlows);
			T = out;
			this.tube(now, worldGlows);
			this.trim(now, sky, worldGlows);
		}

		// In front of the workshop: lamp posts, bushes, who goes by, the robins, the cat.
		T = out;
		for (let cell = Math.floor((x0 - 30) / 58); cell <= Math.floor((x1 + 30) / 58); cell++) {
			const r = seeded(cell * 104_729 + 7);
			const cx = cell * 58 + 8 + Math.floor(r() * 30);
			const what = r();
			const inFront = cx > houseL && cx < houseR;
			if (what < 0.3 && !inFront) this.lantern(cx, this.ground + 9, night, now, worldGlows);
			else if (what < 0.75) this.shrub(cx, this.ground + (inFront ? 11 : 8), sky, r);
		}
		this.lantern(SIDE - 34, this.ground + 9, night, now, worldGlows);
		this.lantern(this.width - SIDE + 22, this.ground + 9, night, now, worldGlows);
		for (const p of this.walkers) this.person(p, this.ground + (p.kind === "bear" ? 25 : p.dir > 0 ? 21 : 27), now);
		this.critters(now, night);

		// What travels and what just happened, in its own bright colors.
		T = PLAIN;
		for (const l of this.links(s)) {
			const a = this.headOf(l.from);
			const b = this.headOf(l.to);
			if (!a || !b) continue;
			const lift = Math.min(46, 16 + Math.hypot(b.x - a.x, b.y - a.y) * 0.18);
			// Dashes that march from the one who waits to the one who works.
			const n = Math.max(8, Math.round(Math.hypot(b.x - a.x, b.y - a.y) / 2));
			const march = Math.floor(now / 70);
			const at = (i: number) => ({ x: Math.round(lerp(a.x, b.x, i / n)), y: Math.round(lerp(a.y, b.y, i / n) - Math.sin((Math.PI * i) / n) * lift) });
			for (let i = 2; i < n - 1; i++) if (((i - march) % 6 + 6) % 6 < 3) R(at(i).x, at(i).y + 1, 1, 1, INK);
			for (let i = 2; i < n - 1; i++) if (((i - march) % 6 + 6) % 6 < 3) R(at(i).x, at(i).y, 1, 1, ((i - march) % 6 + 6) % 6 === 2 ? "#ffffff" : tone(l.color, 2));
		}
		for (const l of this.letters) {
			const p = this.letterAt(l, now);
			if (!p) continue;
			const flap = Math.floor(now / 90) % 3;
			for (let i = 1; i <= 3; i++) {
				const q = this.letterAt(l, now - i * 70);
				if (q) R(q.x, q.y + 2, 1, 1, i === 1 ? "#ffffff" : tone(l.color, 2));
			}
			// A present, tumbling a little as it flies, stardust behind it.
			const bob = flap === 1 ? 1 : 0;
			R(p.x - 5, p.y - 2 + bob, 11, 8, INK);
			R(p.x - 3, p.y - 4 + bob, 7, 2, INK);
			stamp(GIFT, wrapOf(l.color), p.x - 4, p.y - 4 + bob);
			if (l.mark) {
				disc(p.x + 5, p.y - 3, 3, INK);
				disc(p.x + 5, p.y - 3, 2, l.mark === "tick" ? "#3fbf6f" : "#e5484d");
				R(p.x + 4, p.y - 3, 3, 1, "#ffffff");
				if (l.mark === "tick") R(p.x + 6, p.y - 4, 1, 1, "#ffffff"), R(p.x + 4, p.y - 3, 1, 1, "#3fbf6f"), R(p.x + 4, p.y - 2, 1, 1, "#ffffff");
				else R(p.x + 5, p.y - 4, 1, 3, "#ffffff");
			}
			glowAt(p.x, p.y + 2, 9, l.color, 0.5);
		}
		for (const p of this.pops) this.pop(p, now);
		const mark = (h: Hit, strong: boolean) => {
			const r = h?.k === "agent" ? this.rooms.get(h.id) : h?.k === "work" ? this.rooms.get(s.work.get(h.id)?.agent ?? "") : undefined;
			const b = r ? { x: r.x, y: r.y, w: r.w, h: r.h } : h?.k === "port" ? this.ports.get(h.id)?.box : undefined;
			if (!b) return;
			const c = strong ? "#ffffff" : "#fff6c8";
			const len = strong ? 7 + (Math.floor(now / 300) % 2) : 5;
			for (const [cx, cy, dx, dy] of [[b.x, b.y, 1, 1], [b.x + b.w - 1, b.y, -1, 1], [b.x, b.y + b.h - 1, 1, -1], [b.x + b.w - 1, b.y + b.h - 1, -1, -1]]) {
				R(dx > 0 ? cx : cx - len + 1, cy, len, 1, c);
				R(cx, dy > 0 ? cy : cy - len + 1, 1, len, c);
				if (strong) R(dx > 0 ? cx + 1 : cx - len + 2, cy + dy, len - 1, 1, INK), R(cx + dx, dy > 0 ? cy + 1 : cy - len + 2, 1, len - 1, INK);
			}
		};
		mark(o.hover, false);
		mark(o.selected, true);
		g.restore();
		for (const w of worldGlows) this.glows.push({ ...w, x: w.x - v.ox, y: w.y - v.oy });

		// The season in the air, in front of everything; fireflies on a summer night.
		this.air(sky, now, v, night);

		// What shines: light added over the picture in flat rings. Hardly any by day, much at night.
		g.globalCompositeOperation = "lighter";
		for (const gl of this.glows) {
			const a = Math.min(1, gl.a * (0.05 + 0.75 * night * night));
			if (a < 0.03 || gl.x < -gl.r || gl.y < -gl.r || gl.x > v.w + gl.r || gl.y > v.h + gl.r) continue;
			halo(gl.x, gl.y, gl.r, gl.color, a);
		}
		g.globalCompositeOperation = "source-over";
		g.globalAlpha = 1;
	}

	/** The snow, the track through it that the skis have packed, and what lies on them. */
	private garden(sky: Sky, now: number, x0: number, x1: number, bottom: number): void {
		T = tintOf(sky.grade);
		const y = this.ground;
		const snow = "#eef4fc";
		R(x0, y, x1 - x0, 13, snow);
		R(x0, y, x1 - x0, 1, "#ffffff");
		R(x0, y + 12, x1 - x0, 1, tone(snow, -1));
		const lane = "#d5e2f4";
		R(x0, y + 13, x1 - x0, 17, lane);
		R(x0, y + 13, x1 - x0, 1, tone(lane, -1));
		R(x0, y + 29, x1 - x0, 1, "#ffffff");
		R(x0, y + 30, x1 - x0, Math.max(0, bottom - y - 30), snow);
		this.sea(now, x0, x1, y + 40, bottom);
		// Two pairs of ski tracks, one each way.
		for (const ty of [18, 20, 24, 26]) R(x0, y + ty, x1 - x0, 1, tone(lane, -1));
		for (let cx = Math.floor(x0 / 7) * 7; cx < x1; cx += 7) {
			const h = (Math.imul(cx, 2654435761) >>> 0) / 4294967296;
			// Drifts and hollows, the prints of a bear now and then, and a glint where the light catches.
			R(cx + Math.floor(h * 6), y + 2 + (Math.floor(h * 37) % 9), 3 + (Math.floor(h * 11) % 4), 1, h < 0.5 ? tone(snow, -1) : "#ffffff");
			R(cx + (Math.floor(h * 29) % 7), y + 33 + (Math.floor(h * 53) % 8), 2 + (Math.floor(h * 17) % 4), 1, h < 0.4 ? tone(snow, -1) : "#ffffff");
			if (h < 0.5) R(cx, y + 1 + (Math.floor(h * 41) % 9), 5, 1, "#ffffff");
			if (h > 0.86) R(cx + 2, y + 15 + (Math.floor(h * 97) % 2) * 13, 2, 1, tone(lane, -1)), R(cx + 1, y + 14 + (Math.floor(h * 97) % 2) * 13, 1, 1, tone(lane, -1)), R(cx + 4, y + 14 + (Math.floor(h * 97) % 2) * 13, 1, 1, tone(lane, -1));
			if (h > 0.3 && h < 0.42 && Math.floor(now / 500 + cx) % 5 === 0) {
				const wasT = T;
				T = PLAIN;
				R(cx + 3, y + 3 + (Math.floor(h * 71) % 36), 1, 1, "#ffffff");
				T = wasT;
			}
		}
	}

	/** Where the snow ends: the edge of the ice, dark water, floes that drift by, a seal on one of them. */
	private sea(now: number, x0: number, x1: number, y: number, bottom: number): void {
		if (bottom <= y) return;
		const water = "#2c5f9e";
		const edge = (x: number) => y + Math.round(Math.sin(x / 9) * 1.5 + Math.sin(x / 23 + 1) * 2.5);
		for (let x = Math.floor(x0 / 2) * 2; x < x1; x += 2) {
			const e = edge(x);
			R(x, e, 2, bottom - e, water);
			R(x, e, 2, 1, "#9fc0e6");
			R(x, e + 1, 2, 2, "#bfe3f6");
			R(x, e + 3, 2, 1, "#4a7fb8");
		}
		// Bands of lighter water further out, and the light on the swell.
		for (let by = y + 14, n = 0; by < bottom; by += 22, n++) {
			for (let x = Math.floor(x0 / 16) * 16; x < x1; x += 16) {
				const h = (Math.imul(x + n * 7919, 2654435761) >>> 0) / 4294967296;
				const on = Math.floor(now / 700 + h * 9) % 3;
				if (on) R(x + Math.floor(h * 10) + (on === 2 ? 1 : 0), by + Math.floor(h * 18), 3 + Math.floor(h * 4), 1, "#5a90c8");
			}
		}
		// Floes: each row of them drifts at its own pace.
		for (let row = 0, fy = y + 10; fy < bottom + 8; row++, fy += 20) {
			const span = 52 + row * 6;
			const drift = (now / 1000) * (1.2 + row * 0.5) * (row % 2 ? -1 : 1);
			for (let cell = Math.floor((x0 - drift) / span) - 1; cell <= Math.floor((x1 - drift) / span) + 1; cell++) {
				const r = seeded(cell * 7919 + row * 131 + 3);
				if (r() < 0.25) continue;
				const fx = Math.round(cell * span + drift + r() * (span - 30));
				const w = 10 + Math.floor(r() * 18);
				const h = 3 + Math.floor(r() * 3);
				const py = fy + Math.floor(r() * 8) + Math.round(Math.sin(now / 1400 + cell) * 0.6);
				R(fx + 1, py + h, w - 2, 2, "#7fb0dc");
				R(fx, py, w, h, "#f6f9fd");
				R(fx + 2, py - 1, w - 5, 1, "#ffffff");
				R(fx, py + h - 1, w, 1, "#cfe2f4");
				R(fx + w - 3, py + 1, 2, 1, "#dfeaf6");
				if (w > 20 && r() < 0.4) {
					// A seal, that lifts its head now and then.
					const up = Math.floor(now / 1300 + cell) % 4 === 0 ? 1 : 0;
					const sx = fx + 6;
					R(sx, py - 3, 9, 3, "#5a6478");
					R(sx + 1, py - 4, 6, 1, "#5a6478");
					R(sx + 8, py - 4 - up, 3, 3, "#5a6478");
					R(sx + 10, py - 3 - up, 1, 1, INK);
					R(sx - 2, py - 2, 2, 1, "#5a6478"), R(sx - 3, py - 3, 1, 1, "#5a6478");
					R(sx + 2, py - 1, 5, 1, "#7a8498");
				}
			}
		}
	}

	/** A lamp post that is a candy cane: its lamp hangs from the crook. */
	private lantern(x: number, y: number, night: number, now: number, glows: Glow[]): void {
		const red = "#e5484d";
		for (let j = 0; j < 27; j++) {
			const c = Math.floor((j + 1) / 3) % 2 ? red : "#ffffff";
			R(x, y - 1 - j, 2, 1, c);
			R(x + 1, y - 1 - j, 1, 1, tone(c, -1));
		}
		// The crook, over to the right.
		R(x, y - 29, 3, 2, red), R(x + 3, y - 30, 3, 2, "#ffffff"), R(x + 6, y - 29, 2, 2, red), R(x + 7, y - 27, 2, 2, "#ffffff");
		R(x - 1, y - 1, 4, 1, "#ffffff");
		R(x - 1, y - 2, 1, 1, "#ffffff");
		R(x, y - 30, 3, 1, "#ffffff");
		const on = night > 0.45;
		R(x + 7, y - 25, 1, 2, "#59657a");
		block(x + 5, y - 23, 5, 6, "#59657a", { r: 1, flat: true });
		const wasT = T;
		if (on) T = PLAIN;
		R(x + 6, y - 22, 3, 4, on ? "#ffe9a8" : "#dfe9ee");
		R(x + 7, y - 21, 1, 2, on ? "#fffbe0" : "#f4f8fa");
		T = wasT;
		R(x + 5, y - 24, 5, 1, "#ffffff");
		if (on) {
			const flick = Math.floor(now / 900 + x) % 9 === 0 ? 0.8 : 1;
			glows.push({ x: x + 7, y: y - 20, r: 20, color: "#ffd98a", a: 0.8 * flick }, { x: x + 4, y: y - 2, r: 16, color: "#ffc870", a: 0.35 });
		}
	}

	/** A bush under its snow, a berry or two showing; or a present somebody left out. */
	private shrub(x: number, y: number, sky: Sky, r: () => number): void {
		const w = 5 + Math.floor(r() * 4);
		const what = r();
		if (what < 0.22) {
			const c = COATS[Math.floor(r() * COATS.length)];
			block(x, y - 6, 7, 6, c, { r: 0 });
			R(x + 3, y - 6, 1, 6, FUR), R(x, y - 4, 7, 1, FUR);
			R(x + 2, y - 8, 2, 1, FUR), R(x + 4, y - 8, 2, 1, FUR), R(x + 3, y - 7, 1, 1, FUR);
			R(x, y - 7, 3, 1, "#ffffff");
			return;
		}
		const green = "#3f8f6a";
		disc(x, y - 3, 4, tone(green, -1));
		disc(x + w, y - 2, 3, tone(green, -1));
		disc(x, y - 3, 3, green);
		disc(x + w, y - 2, 2, green);
		// Its load of snow, with a blue edge under it so that it shows on the snow around.
		R(x - 3, y - 6, 7, 1, "#b8cbe6"), R(x + w - 2, y - 4, 5, 1, "#b8cbe6");
		R(x - 3, y - 8, 7, 2, "#ffffff"), R(x - 2, y - 9, 5, 1, "#ffffff");
		R(x + w - 2, y - 6, 5, 2, "#ffffff"), R(x + w - 1, y - 7, 3, 1, "#ffffff");
		R(x - 5, y, w + 10, 1, "#cfdcee");
		if (what > 0.5) R(x + 1, y - 2, 1, 1, "#e5484d"), R(x + w + 1, y - 2, 1, 1, "#e5484d"), R(x - 2, y - 3, 1, 1, "#e5484d");
		void sky;
	}

	/** Who goes by on the track: an elf on skis, a polar bear with its cub. */
	private person(p: Walker, feet: number, now: number): void {
		const x = Math.round(p.x);
		if (p.kind === "bear") {
			const f = Math.floor((now + p.x * 30) / 260) % 2;
			const pal = { w: "#fbfcfe", s: "#dbe5f2", e: INK, n: INK };
			if (p.cub) edged(CUB[1 - f], pal, "#8fa3c4", x - p.dir * 20 - 5, feet - 6, p.dir < 0);
			edged(BEAR[f], pal, "#8fa3c4", x - 10, feet - 10, p.dir < 0);
			return;
		}
		const f = Math.floor((now + p.x * 40) / 420) % 2;
		stamp(SKIER[f], { b: FUR, h: p.hat, w: FUR, e: p.skin, s: p.skin, c: p.coat, l: "#ffffff", k: "#8a5a3a", p: "#59657a" }, x - 5, feet - 12 + (p.dir > 0 ? 0 : 0), p.dir < 0);
		// The snow a ski throws up.
		if (f === 0) R(x - p.dir * 7, feet - 1, 1, 1, "#ffffff"), R(x - p.dir * 9, feet - 2, 1, 1, "#ffffff");
	}
	/** The birds where they sit or fly, the cat on the ridge of the roof. */
	private critters(now: number, night: number): void {
		for (const b of this.birds) {
			const pal = { a: BIRDS[b.kind].a, w: BIRDS[b.kind].w, e: INK, b: "#f2a03a", l: "#8a5a3a" };
			if (b.state === "away" || b.state === "back") stamp(BIRD_FLY[Math.floor(now / 110) % 2], pal, b.x - 4, b.y - 5, b.dir < 0);
			else if (b.state === "peck" && Math.floor(now / 260) % 2) stamp(BIRD_PECK, pal, b.x - 3, b.y - 5, b.dir < 0);
			else stamp(BIRD_SIT, pal, b.x - 3, b.y - 5 - (b.state === "sit" && (now + b.x * 50) % 2600 < 140 ? 1 : 0), b.dir < 0);
		}
		const c = this.cat;
		const fur = { a: "#f2a65a", e: INK, n: "#ff8fb4", w: "#fff1d8" };
		const y = this.roofTop - 2;
		if (c.state === "walk") stamp(CAT_WALK[Math.floor(now / 200) % 2], fur, c.x - 5, y - 6, c.dir < 0);
		else if (c.state === "nap") {
			stamp(CAT_NAP, fur, c.x - 5, y - 6);
			if (night > 0.3 || Math.floor(now / 900) % 2) R(c.x + 7, y - 9 - (Math.floor(now / 900) % 2), 2, 1, "#cfd8ff");
		} else {
			stamp(CAT_SIT, fur, c.x - 4, y - 9, c.dir < 0);
			// Its tail, now and then.
			if (Math.floor(now / 700) % 3 === 0) R(c.x + (c.dir < 0 ? -5 : 5), y - 4, 1, 1, fur.a);
		}
	}

	private pop(p: Pop, now: number): void {
		const k = (now - p.at) / (p.kind === "confetti" ? 900 : 550);
		if (k >= 1) return;
		if (p.kind === "poof") {
			const r = 2 + k * 8;
			for (let i = 0; i < 7; i++) {
				const a = (i / 7) * Math.PI * 2 + 0.3;
				const size = k < 0.4 ? 3 : k < 0.7 ? 2 : 1;
				R(p.x + Math.cos(a) * r - 1, p.y + Math.sin(a) * r * 0.7 - 1, size, size, i % 2 ? "#ffffff" : tone(p.color, 2));
			}
		} else if (p.kind === "spark") {
			const r = Math.round(1 + k * 5);
			for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) R(p.x + dx * r, p.y + dy * r, 1, 1, k < 0.5 ? "#ffffff" : p.color);
			if (k < 0.6) for (const [dx, dy] of [[1, 1], [-1, 1], [1, -1], [-1, -1]]) R(p.x + dx * (r - 1), p.y + dy * (r - 1), 1, 1, p.color);
			if (k < 0.3) R(p.x - 1, p.y - 1, 3, 3, "#ffffff");
		} else if (p.kind === "ring") {
			for (const span of [k, Math.max(0, k - 0.35)]) {
				if (!span) continue;
				const r = Math.round(3 + span * 14);
				for (let i = 0; i < 28; i++) {
					if (i % 2 && span > 0.5) continue;
					const a = (i / 28) * Math.PI * 2;
					R(p.x + Math.cos(a) * r, p.y + Math.sin(a) * r, 1, 1, span < 0.5 ? "#ffffff" : p.color);
				}
			}
		} else {
			const r = seeded(Math.floor(p.at) % 100_000);
			const cols = [p.color, "#ffe27a", "#ff8fb4", "#7ad0ff", "#ffffff", "#9ff0a0"];
			for (let i = 0; i < 14; i++) {
				const a = -Math.PI / 2 + (r() - 0.5) * 2.4;
				const sp = 14 + r() * 22;
				const px = p.x + Math.cos(a) * sp * k;
				const py = p.y + Math.sin(a) * sp * k + 30 * k * k;
				R(px, py, i % 3 === 0 ? 2 : 1, i % 3 === 1 ? 2 : 1, cols[i % cols.length]);
			}
		}
	}

	/** Snow in the air, in front of everything: it never stops here. */
	private air(sky: Sky, now: number, v: { ox: number; oy: number; w: number; h: number }, night: number): void {
		T = PLAIN;
		const n = 52;
		const floor = this.ground - v.oy + 30;
		// The flakes fall through a stretch of air that comes round again, so that zooming does not deal them anew.
		const SPAN = 300;
		const wrap = (x: number, span: number) => ((x % span) + span) % span;
		const dim = night > 0.6 ? "#c9d6f2" : "#dfe9f8";
		for (let i = 0; i < n * Math.ceil(v.w / SPAN); i++) {
			const r = seeded((i % n) * 31 + 5);
			const lane = Math.floor(i / n) * SPAN;
			const sx = r() * SPAN;
			const sy = r() * 400;
			const fall = 0.008 + r() * 0.014;
			const drift = 0.004 + r() * 0.01;
			const y = wrap(sy + now * fall * 1.4 - v.oy * 0.8, 420) - 20;
			const x = wrap(sx + now * drift + Math.sin(now / 900 + i) * 3 - v.ox * 0.8, SPAN) + lane;
			if (y > floor) continue;
			const big = i % 5 === 0;
			R(x, y, big ? 2 : 1, big ? 2 : 1, i % 3 ? "#ffffff" : dim);
			// A big flake now and then shows its arms.
			if (i % 17 === 0) R(x - 1, y, 3, 1, "#ffffff"), R(x, y - 1, 1, 3, "#ffffff");
		}
		void sky;
	}

	/** The workshop without its bays: the roof under its snow and what stands on it, the candy-cane walls, the gingerbread beams. */
	private shell(s: Now, now: number, sky: Sky, glows: Glow[]): void {
		const out = tintOf(sky.grade);
		T = out;
		const night = 1 - sky.day;
		const L = SIDE;
		const Rr = this.width - SIDE;
		const busy = s.running.length;
		const top = this.roofTop;
		const base = this.pentTop;
		const e0 = L - 6;
		const e1 = Rr + 6;

		// The big wheel on the left wall: it turns while anybody works, and a belt takes its turning up under the roof.
		const wx = L - 8;
		const wy = this.ground - 36;
		const a0 = Math.floor(now / (busy ? 110 : 900)) * (Math.PI / 24);
		const px = L - 4;
		const py = base + 14;
		line(wx - 12, wy, px - 4, py, "#3a2a2a");
		line(wx + 12, wy, px + 4, py, "#3a2a2a");
		for (let k = 0; k < 10; k++) {
			const u = ((k + Math.floor(now / (busy ? 110 : 900)) * 0.25) % 10) / 10;
			R(lerp(wx - 12, px - 4, u), lerp(wy, py, u), 1, 2, "#6a5a5a");
		}
		disc(px, py, 5, INK);
		disc(px, py, 4, "#9aa6b8");
		disc(px, py, 1, "#59657a");
		for (let k = 0; k < 12; k++) {
			const a = a0 + (k * Math.PI) / 6;
			R(wx + Math.cos(a) * 13 - 1, wy + Math.sin(a) * 13 - 1, 3, 3, INK);
		}
		disc(wx, wy, 12, INK);
		for (let k = 0; k < 12; k++) {
			const a = a0 + (k * Math.PI) / 6;
			R(wx + Math.cos(a) * 12.5 - 0.5, wy + Math.sin(a) * 12.5 - 0.5, 2, 2, "#b98a62");
		}
		disc(wx, wy, 11, "#b98a62");
		disc(wx, wy, 8, "#6a4632");
		for (let k = 0; k < 6; k++) {
			const a = a0 + (k * Math.PI) / 3;
			line(wx, wy, wx + Math.cos(a) * 9, wy + Math.sin(a) * 9, "#d9a56e");
		}
		disc(wx, wy, 2, GOLD);
		R(wx - 1, wy - 1, 1, 1, "#fff6c8");

		// The chimney of Santa's fire, behind the ridge, and its smoke: more of it the more agents work.
		const ch = this.chimney;
		const smoke = (x: number, y: number, n: number, ms: number, lean: number) => {
			for (let i = 0; i < n; i++) {
				const p = (now / ms + i / n) % 1;
				const sx = x + Math.sin(p * 5 + i) * 3 + p * lean;
				const sy = y - p * 30;
				const rad = p < 0.2 ? 1 : p < 0.6 ? 2 : 3;
				const c = mix(sky.cloud[1], sky.cloud[2], p * 0.5);
				T = PLAIN;
				if (p > 0.8) dither(sx - rad, sy - rad, rad * 2 + 1, rad * 2 + 1, c, 6);
				else disc(sx, sy, rad, c), R(sx - rad, sy - rad, rad, 1, sky.cloud[0]);
				T = out;
			}
		};
		smoke(ch.x + 4, ch.y - 10, busy ? 6 : 3, busy ? 2600 : 4200, 9);
		block(ch.x, ch.y - 8, 9, 24, BRICK, { r: 0 });
		for (let j = 0; j < 6; j++) R(ch.x, ch.y - 5 + j * 4, 9, 1, tone(BRICK, -1)), R(ch.x + 2 + (j % 2) * 3, ch.y - 8 + j * 4, 1, 3, tone(BRICK, -1));
		block(ch.x - 1, ch.y - 10, 11, 3, "#b8ada0", { r: 0 });
		R(ch.x - 2, ch.y - 12, 13, 2, "#ffffff");
		R(ch.x - 1, ch.y - 13, 9, 1, "#ffffff");
		// A tall striped stack on a workshop that is wide enough: it puffs when work runs.
		if (this.inner.w >= 200) {
			const kx = this.inner.x + Math.round(this.inner.w * 0.8);
			if (busy) smoke(kx + 3, top - 30, 5, 2000, 14);
			R(kx - 1, top - 27, 9, 34, INK);
			candy(kx, top - 26, 7, 32, "#e5484d", "#ffffff");
			R(kx + 6, top - 26, 1, 32, "#b8473c");
			block(kx - 1, top - 29, 9, 3, "#59657a", { r: 0 });
			R(kx - 1, top - 30, 9, 1, "#ffffff");
		}

		// The roof: tiles with round ends, row over row, and on it snow like icing, running down in lumps.
		for (let j = 0; j < ROOF_H; j++) {
			const inset = Math.max(0, ROOF_H - 6 - j);
			const band = Math.floor(j / 5);
			const c = j % 5 === 0 ? tone(ROOF_RED, 1) : ROOF_RED;
			R(e0 + inset, top + j, e1 - e0 - inset * 2, 1, c);
			if (j % 5 >= 3) for (let x = e0 + inset + ((band % 2) * 4 + 1); x < e1 - inset - 2; x += 8) R(x, top + j, j % 5 === 4 ? 3 : 1, 1, tone(ROOF_RED, -2));
			R(e0 + inset, top + j, 1, 1, tone(ROOF_RED, -2));
			R(e1 - inset - 1, top + j, 1, 1, tone(ROOF_RED, -2));
		}
		for (let x = e0 + 1; x < e1 - 1; x++) {
			const surf = top + Math.max(0, ROOF_H - 6 - (x - e0), ROOF_H - 6 - (e1 - 1 - x));
			const lump = [1, 2, 4, 5, 5, 3, 1, 0, 0, 1, 3, 3, 2, 0][(x - e0) % 14];
			const depth = Math.min(3 + lump, top + ROOF_H - 3 - surf);
			if (depth < 1) continue;
			R(x, surf - 2, 1, depth + 2, "#ffffff");
			R(x, surf + depth, 1, 1, "#cfdcee");
			if ((x - e0) % 14 === 6) R(x, surf + 1, 1, depth - 1, "#e6eef8");
		}
		R(e0 + ROOF_H - 6, top - 3, e1 - e0 - (ROOF_H - 6) * 2, 1, "#ffffff");
		R(e0 - 1, base - 2, e1 - e0 + 2, 3, GINGER);
		R(e0 - 1, base - 2, e1 - e0 + 2, 1, tone(GINGER, 1));
		R(e0 + 1, base + 1, e1 - e0 - 2, 1, tone(GINGER, -2));
		for (let x = e0; x < e1; x += 4) R(x, base - 1, 3, 1, ICING), R(x + 1, base, 1, 1, ICING);

		// A dormer with a window: its light is on when Santa works at night.
		const main = [...this.rooms.values()].find((r) => r.main);
		const dx = this.inner.x + Math.round(this.inner.w * 0.42);
		const glowing = Boolean(main && main.lit > 0.4 && night > 0.3);
		block(dx - 8, top + 12, 16, 14, GINGER, { r: 0, ink: tone(ROOF_RED, -2) });
		for (let j = 0; j < 9; j++) {
			R(dx - 1 - j - 2, top + 4 + j, (j + 2) * 2 + 2, 1, j < 3 ? "#ffffff" : j === 3 ? "#e6eef8" : ROOF_RED);
			R(dx - 1 - j - 2, top + 4 + j, 1, 1, j < 4 ? "#cfdcee" : tone(ROOF_RED, -2));
			R(dx + j + 2, top + 4 + j, 1, 1, j < 4 ? "#cfdcee" : tone(ROOF_RED, -2));
		}
		R(dx - 5, top + 15, 10, 9, ICING);
		T = glowing ? PLAIN : out;
		R(dx - 4, top + 16, 8, 7, glowing ? "#ffe9a8" : mix(sky.stops[1], "#ffffff", 0.25));
		if (!glowing) R(dx - 3, top + 17, 2, 3, mix(sky.stops[1], "#ffffff", 0.7));
		T = out;
		R(dx - 1, top + 16, 1, 7, ICING);
		R(dx - 4, top + 19, 8, 1, ICING);
		R(dx - 6, top + 24, 12, 1, "#ffffff");
		if (glowing) glows.push({ x: dx, y: top + 19, r: 11, color: "#ffd98a", a: 0.8 });

		// The sleigh on the roof, a reindeer in harness: what agents send out leaves on it.
		const d = this.dish;
		const sent = now - (this.hotAt.get("dish") ?? -1e9);
		const going = sent < 1500;
		const nod = going ? Math.floor(now / 120) % 2 : Math.floor(now / 1700) % 4 === 0 ? 1 : 0;
		stamp(SLEIGH, { r: "#d8362f", w: FUR, k: GOLD, g: "#7a8a4a", p: "#4a90d9", q: "#f2b33d" }, d.x - 12, top - 11 - (going ? Math.floor(now / 90) % 2 : 0));
		line(d.x + 2, top - 7, d.x + 8, top - 8, "#6b4a3a");
		stamp(REINDEER[1], { b: "#9a6540", c: "#c08a5c", e: INK, y: "#e2c08a", t: FUR, n: "#3a2a2a" }, d.x + 6, top - 11 + nod);
		T = PLAIN;
		R(d.x + 17, top - 8 + nod, 1, 1, going || Math.floor(now / 700) % 2 ? "#ff5a5a" : "#b83a3a");
		if (going) {
			glows.push({ x: d.x + 17, y: top - 8, r: 8, color: "#ff5a4a", a: 1 });
			for (let i = 0; i < 9; i++) {
				const k = (sent / 1500 + i / 9) % 1;
				const a = -Math.PI / 2 + (i - 4) * 0.32;
				R(d.x - 4 + Math.cos(a) * (4 + k * 16), top - 12 + Math.sin(a) * (4 + k * 16), 1, 1, k < 0.5 ? "#ffffff" : i % 2 ? GOLD : "#ffb0b0");
			}
		}
		T = out;

		// The walls: two candy canes as thick as trees. The shaft of the chute is dark between them.
		for (const wx2 of [L, Rr - WALL]) {
			R(wx2 - 1, base, WALL + 2, this.ground - base, INK);
			candy(wx2, base, WALL, this.ground - base, "#e5484d", "#ffffff");
			R(wx2, base, 1, this.ground - base, "#ffffff");
			R(wx2 + WALL - 1, base, 1, this.ground - base, "#b8473c");
		}
		const sx = this.inner.x + this.inner.w;
		R(sx, base, TUBE, this.ground - base, "#4a3140");
		R(sx, base, 1, this.ground - base, tone("#4a3140", -1));
		R(sx + TUBE - 1, base, 1, this.ground - base, tone("#4a3140", 1));

		// The beams the floors lie on: gingerbread, a line of icing piped along each, a gumdrop here and there.
		const floors = new Set<number>([this.hallTop - SLAB, this.ground - SLAB]);
		for (const r of this.rooms.values()) floors.add(r.floorY);
		const DROPS = ["#e5484d", "#3fa468", "#f2b134", "#4a90d9", "#ec7fa9"];
		for (const y of floors) {
			R(L - 2, y + 2, Rr - L + 4, SLAB - 2, GINGER);
			R(L - 2, y + 2, Rr - L + 4, 1, tone(GINGER, 1));
			R(L - 2, y + SLAB - 1, Rr - L + 4, 1, tone(GINGER, -2));
			for (let x = L + 1; x < Rr - 2; x += 6) R(x, y + 3, 3, 1, ICING), R(x + 3, y + 4, 3, 1, ICING);
			for (let x = L + 10, i = 0; x < Rr - 6; x += 24, i++) R(x, y + 3, 2, 2, DROPS[(i + y) % 5]), R(x, y + 3, 1, 1, tone(DROPS[(i + y) % 5], 2));
			for (const bx of [L - 5, Rr + 1]) {
				disc(bx + 2, y + 3, 3, INK);
				disc(bx + 2, y + 3, 2, "#ffffff");
				R(bx + 2, y + 1, 1, 5, "#e5484d"), R(bx, y + 3, 5, 1, "#e5484d");
			}
		}
		// The footing of stone, and the snow that has drifted against it.
		R(L - 3, this.ground - 2, Rr - L + 6, 3, "#a9a094");
		R(L - 3, this.ground - 2, Rr - L + 6, 1, "#c9c0b2");
		for (let x = L; x < Rr; x += 9) R(x, this.ground - 1, 1, 2, "#8a8276");
		for (const [bx, r] of [[L - 6, 5], [L - 13, 3], [Rr + 6, 5], [Rr + 13, 3], [L + 2, 3], [Rr - 3, 3]]) disc(bx, this.ground + 2, r, "#ffffff"), R(bx - r + 1, this.ground + 2, r * 2 - 1, 2, "#eef4fc");

		// The clock tower over the chute, with the clock that tells your time; its bell rings when a schedule is due.
		const t = this.turret;
		const rang = now - (this.hotAt.get("clock") ?? -1e9);
		block(t.x, t.y + 4, t.w, t.h - 4, GINGER, { r: 0, ink: tone(GINGER, -2) });
		R(t.x, t.y + 26, t.w, 2, ICING);
		R(t.x, t.y + 4, 2, t.h - 4, ICING);
		R(t.x + t.w - 2, t.y + 4, 2, t.h - 4, tone(ICING, -1));
		for (let j = 0; j < 12; j++) {
			const half = Math.round(((j + 1) * (t.w / 2 + 3)) / 12);
			R(t.x + t.w / 2 - half, t.y - 8 + j, half * 2, 1, j < 5 ? "#ffffff" : j === 5 ? "#e6eef8" : j % 4 === 0 ? tone(ROOF_RED, 1) : ROOF_RED);
			R(t.x + t.w / 2 - half, t.y - 8 + j, 1, 1, j < 6 ? "#cfdcee" : tone(ROOF_RED, -2));
			R(t.x + t.w / 2 + half - 1, t.y - 8 + j, 1, 1, j < 6 ? "#cfdcee" : tone(ROOF_RED, -2));
		}
		// A star on its tip, that shines.
		const stx = t.x + t.w / 2;
		R(stx - 1, t.y - 13, 1, 5, "#d9a84a");
		T = PLAIN;
		const tw = Math.floor(now / 500) % 2;
		R(stx - 1, t.y - 19, 1, 7, GOLD), R(stx - 4, t.y - 16, 7, 1, GOLD), R(stx - 2, t.y - 17, 3, 3, tw ? "#fff6c8" : GOLD);
		if (tw) R(stx - 3, t.y - 18, 1, 1, "#fff6c8"), R(stx + 1, t.y - 18, 1, 1, "#fff6c8"), R(stx - 3, t.y - 14, 1, 1, "#fff6c8"), R(stx + 1, t.y - 14, 1, 1, "#fff6c8");
		glows.push({ x: stx - 1, y: t.y - 16, r: 12, color: "#ffe27a", a: 0.8 });
		T = out;
		const cx = t.x + 10;
		const cy = t.y + 14;
		disc(cx, cy, 8, tone(GINGER, -2));
		T = night > 0.5 ? tintOf(mulMix(sky.grade, [1, 0.96, 0.8], 0.75)) : out;
		disc(cx, cy, 7, rang < 3000 && Math.floor(now / 160) % 2 ? "#f3e2ff" : "#fffaf0");
		for (let i = 0; i < 12; i++) R(cx + Math.round(Math.sin((i * Math.PI) / 6) * 6), cy - Math.round(Math.cos((i * Math.PI) / 6) * 6), 1, 1, i % 3 === 0 ? "#d8362f" : "#b8ada0");
		const time = clock();
		const ha = ((time.getHours() % 12) + time.getMinutes() / 60) * (Math.PI / 6);
		const ma = (time.getMinutes() + time.getSeconds() / 60) * (Math.PI / 30);
		line(cx, cy, cx + Math.sin(ha) * 3, cy - Math.cos(ha) * 3, INK);
		line(cx, cy, cx + Math.sin(ma) * 5, cy - Math.cos(ma) * 5, "#2f8a58");
		R(cx, cy, 1, 1, "#d9a84a");
		T = out;
		if (night > 0.5) glows.push({ x: cx, y: cy, r: 12, color: "#ffe9a8", a: 0.5 });
		// The bell under the eave.
		const swing = rang < 3000 ? [-1, 0, 1, 0][Math.floor(now / 110) % 4] : 0;
		R(t.x + t.w + 1, t.y + 5, 3, 1, tone(GINGER, -2));
		R(t.x + t.w + 3 + swing, t.y + 6, 3, 3, GOLD);
		R(t.x + t.w + 2 + swing, t.y + 9, 5, 1, "#d9a84a");
		R(t.x + t.w + 4 + swing * 2, t.y + 10, 1, 1, "#8a6a2a");
	}

	/** What hangs from the eaves, in front of everything under them: a string of lights, and icicles. */
	private trim(now: number, sky: Sky, glows: Glow[]): void {
		const out = tintOf(sky.grade);
		T = out;
		const base = this.pentTop;
		const e0 = SIDE - 6;
		const e1 = this.width - SIDE + 6;
		for (let x = e0 + 2; x < e1 - 2; x++) {
			const h = (Math.imul(x, 2654435761) >>> 0) % 11;
			if (h > 4) continue;
			const len = 1 + (h % 4);
			R(x, base + 1, 1, len, "#dff1fb");
			R(x, base + 1 + len, 1, 1, "#ffffff");
			// A drop falls from one of them now and then.
			if (h === 0 && sky.day > 0.4) {
				const k = ((now + x * 137) % 4200) / 600;
				if (k < 1) R(x, base + 3 + len + k * k * 20, 1, 1, "#bfe3f6");
			}
		}
		for (let x = e0 + 3, i = 0; x < e1 - 2; x += 7, i++) {
			const col = ["#ffd75a", "#ff7a7a", "#7ad0ff", "#9ff0a0", "#ffa0e0"][i % 5];
			const on = Math.floor(now / 600 + i * 0.7) % 4 !== 0;
			R(x, base + 1, 1, 1, tone(GINGER, -2));
			T = on ? PLAIN : out;
			R(x - 1 + (i % 2), base + 2, 2, 2, on ? col : tone(col, -1));
			T = out;
			if (on) glows.push({ x, y: base + 3, r: 5, color: col, a: 0.75 });
		}
	}

	/** The chute: a pipe of glass up the shaft from the mail room, along each ceiling to each bay; and the sweets that ride in it. */
	private tube(now: number, glows: Glow[]): void {
		const glass = "#bfe6f2";
		const top = this.turret.y + 24;
		const collar = (x: number, y: number, w: number, h: number) => {
			R(x - 1, y - 1, w + 2, h + 2, INK);
			candy(x, y, w, h, "#e5484d", "#ffffff", 2);
		};
		R(this.shaftX - 2, top, 5, this.hallTop + 6 - top, tone(glass, -1));
		R(this.shaftX - 1, top, 3, this.hallTop + 6 - top, glass);
		R(this.shaftX - 1, top, 1, this.hallTop + 6 - top, "#ffffff");
		for (let y = top + 6; y < this.hallTop; y += 18) collar(this.shaftX - 3, y, 7, 3);
		const runs = new Map<number, number>();
		for (const r of this.rooms.values()) runs.set(r.y + 3, Math.min(runs.get(r.y + 3) ?? Infinity, r.outlet.x));
		for (const [y, x] of runs) {
			R(x, y, this.shaftX - x, 3, tone(glass, -1));
			R(x, y + 1, this.shaftX - x, 1, glass);
			for (let jx = x + 10; jx < this.shaftX - 6; jx += 24) collar(jx, y - 1, 3, 5);
		}
		for (const r of this.rooms.values()) {
			collar(r.outlet.x - 2, r.y + 3, 5, 3);
			R(r.outlet.x - 1, r.y + 6, 3, 3, tone(glass, -1));
			R(r.outlet.x, r.y + 6, 1, 3, glass);
			R(r.outlet.x - 2, r.y + 9, 5, 1, GOLD);
		}
		// The manifold along the mail room's ceiling, a riser from each letter box.
		const my = this.hallTop + 3;
		const firstX = Math.min(...[...this.ports.values()].filter((p) => p.kind !== "clock").map((p) => p.mouth.x), this.shaftX);
		R(firstX, my, this.shaftX - firstX, 3, tone(glass, -1));
		R(firstX, my + 1, this.shaftX - firstX, 1, glass);
		for (const p of this.ports.values()) {
			if (p.kind === "clock") continue;
			R(p.mouth.x - 1, my + 2, 3, p.mouth.y - my - 2, tone(glass, -1));
			R(p.mouth.x, my + 2, 1, p.mouth.y - my - 2, glass);
			R(p.mouth.x - 2, p.mouth.y - 1, 5, 1, GOLD);
		}
		T = PLAIN;
		for (const c of this.capsules) {
			const k = (now - c.at) / c.ms;
			const p = along(c.path, k);
			const q = along(c.path, Math.max(0, k - 0.02));
			const upright = Math.abs(p.y - q.y) > Math.abs(p.x - q.x);
			// A sweet in its wrapper, the ends twisted: it rides lengthwise.
			const [w, h] = upright ? [5, 5] : [5, 5];
			const [ex, ey] = upright ? [0, 1] : [1, 0];
			for (const k2 of [-1, 1]) {
				R(p.x + ex * k2 * 4 - 1 - (upright ? 1 : 0), p.y + ey * k2 * 4 - 1 - (upright ? 0 : 1), upright ? 5 : 3, upright ? 3 : 5, INK);
				R(p.x + ex * k2 * 4 - (upright ? 1 : 0), p.y + ey * k2 * 4 - (upright ? 0 : 1), upright ? 3 : 1, upright ? 1 : 3, "#ffffff");
			}
			slab(p.x - Math.floor(w / 2) - 1, p.y - Math.floor(h / 2) - 1, w + 2, h + 2, INK, 2);
			slab(p.x - Math.floor(w / 2), p.y - Math.floor(h / 2), w, h, c.color, 2);
			R(p.x - 1, p.y - 2, 2, 1, "#ffffff");
			R(p.x - 1, p.y, 3, 1, tone(c.color, 2));
			glows.push({ x: p.x, y: p.y, r: 10, color: c.color, a: 0.9 });
		}
	}
	/** The light a bay stands in: warm when work runs, dim by day when none does, blue and dark at night. */
	private roomTint(lit: number, night: number): Tint {
		return tintOf(mulMix(mulMix([0.9, 0.9, 0.93], [0.36, 0.38, 0.62], night), [1, 0.99, 0.95], lit));
	}

	/** The walls of a bay, each kind of workshop its own: boards, splashes of paint, tiles, plates of tin, stripes, stars, ice. */
	private walls(room: Room, bay: Bay, kind: number): void {
		const { x, y, w, h, floorY } = room;
		const wall = bay.wall;
		const soft = tone(wall, -1);
		const faint = mix(wall, soft, 0.5);
		R(x, y, w, h, wall);
		// The lamp's light on the wall: a cone of the wall's own lighter shade, with a clean edge.
		if (room.lit > 0.3) {
			const lc = mix(wall, "#fffbe6", 0.5);
			for (let j = 0; j < h - 28; j++) {
				const half = 7 + Math.round(j * 0.95);
				const lx = Math.max(x, room.lamp - half);
				R(lx, y + 12 + j, Math.min(x + w, room.lamp + half + 1) - lx, 1, lc);
			}
		}
		const r = seeded(room.look.seed + 5);
		if (kind === 0) {
			// Boards, with a knot here and there.
			for (let i = x + 7; i < x + w; i += 8) R(i, y, 1, h - 16, faint);
			for (let i = 0; i < 6; i++) R(x + 4 + Math.floor(r() * (w - 8)), y + 6 + Math.floor(r() * (h - 28)), 2, 1, soft);
		} else if (kind === 1) {
			// Paint, where it flew.
			for (let i = 0; i < 18; i++) {
				const px = x + 4 + Math.floor(r() * (w - 8));
				const py = y + 5 + Math.floor(r() * (h - 26));
				const c = mix(TOYS[Math.floor(r() * 7)], wall, 0.25);
				R(px, py, 2 + Math.floor(r() * 3), 2, c);
				R(px + 1, py - 1, 2, 1, c);
				R(px + 1, py + 2, 1, 1 + Math.floor(r() * 4), c);
			}
		} else if (kind === 2) {
			for (let j = y + 9; j < floorY - 18; j += 9) R(x, j, w, 1, faint);
			for (let i = x + 12; i < x + w; i += 24) R(i, y + 2, 1, 5, soft), R(i - 1, y + 7, 3, 2, soft);
		} else if (kind === 3) {
			for (let j = y + 4; j < floorY - 20; j += 6) for (let i = x + 3 + ((j / 6) & 1) * 4; i < x + w - 1; i += 8) R(i, j, 1, 1, soft), R(i - 1, j + 1, 3, 1, faint);
		} else if (kind === 4) {
			// Plates of tin, a rivet in each corner; a pipe along the top with a wheel to turn.
			for (let i = x + 19; i < x + w; i += 20) R(i, y, 1, h - 16, soft);
			for (let j = y + 13; j < floorY - 17; j += 13) R(x, j, w, 1, soft);
			for (let i = x + 2; i < x + w; i += 20) for (let j = y + 3; j < floorY - 18; j += 13) R(i, j, 1, 1, tone(wall, 1)), R(i + 15, j, 1, 1, tone(wall, 1)), R(i, j + 8, 1, 1, tone(wall, 1)), R(i + 15, j + 8, 1, 1, tone(wall, 1));
		} else if (kind === 5) {
			for (let i = x + 4; i < x + w; i += 8) R(i, y, 4, h - 16, mix(wall, "#ffffff", 0.7));
		} else if (kind === 6) {
			const star = mix(wall, GOLD, 0.7);
			for (let i = 0; i < 16; i++) {
				const px = x + 5 + Math.floor(r() * (w - 10));
				const py = y + 5 + Math.floor(r() * (h - 28));
				R(px - 1, py, 3, 1, star), R(px, py - 1, 1, 3, star);
			}
		} else {
			// Blocks of ice, laid in bond, a glint in some.
			for (let j = y + 6, n = 0; j < floorY - 17; j += 6, n++) {
				R(x, j, w, 1, soft);
				for (let i = x + 5 + (n % 2) * 6; i < x + w; i += 12) R(i, j - 5, 1, 5, faint);
			}
			for (let i = 0; i < 9; i++) R(x + 4 + Math.floor(r() * (w - 8)), y + 4 + Math.floor(r() * (h - 26)), 2, 1, "#ffffff");
		}
		R(x, y, w, 2, soft);
		// Below: panels, or tiles where things get wet.
		const dado = bay.dado;
		R(x, floorY - 16, w, 16, dado);
		if (kind === 2 || kind === 5) {
			const other = kind === 2 ? "#a9cde6" : "#ffffff";
			for (let j = 0; j < 4; j++) for (let i = x + ((j % 2) * 4); i < x + w; i += 8) R(i, floorY - 16 + j * 4, 4, 4, mix(dado, other, 0.75));
		} else if (kind === 4) {
			for (let i = x + 9; i < x + w; i += 20) R(i, floorY - 16, 1, 14, tone(dado, -1)), R(i + 2, floorY - 13, 1, 1, tone(dado, 1)), R(i + 2, floorY - 5, 1, 1, tone(dado, 1));
		} else if (kind === 7) {
			for (let i = x + 5; i < x + w; i += 12) R(i, floorY - 16, 1, 14, tone(dado, -1));
			R(x, floorY - 9, w, 1, tone(dado, -1));
		} else for (let i = x + 7; i < x + w; i += 10) R(i, floorY - 14, 1, 11, tone(dado, -1)), R(i + 1, floorY - 14, 1, 11, tone(dado, 1));
		R(x, floorY - 17, w, 1, tone(dado, 1));
		R(x, floorY - 16, w, 1, tone(dado, -1));
		R(x, floorY - 2, w, 2, tone(dado, -2));
		// The floor.
		const floor = bay.floor;
		R(x, floorY, w, 2, floor);
		R(x, floorY, w, 1, tone(floor, 1));
		if (kind === 2 || kind === 5) for (let i = x; i < x + w; i += 6) ((i - x) / 6) % 2 && R(i, floorY, 6, 2, kind === 2 ? "#c9744e" : "#ffffff");
		else for (let i = x + 9; i < x + w; i += 13) R(i, floorY, 1, 2, tone(floor, -1));
		// The post between two bays: a candy cane from floor to ceiling.
		candy(x, y, 2, h, "#e5484d", "#ffffff", 2);
	}

	/** A window: square, arched or round. Outside it the sky as it is, the snow, the northern lights at night; frost in its corners. */
	private window(room: Room, b: Box, style: Bay["win"], frame: string, curtain: string | undefined, now: number, night: number, tint: Tint): void {
		const sky = this.sky;
		const cx = b.x + b.w / 2;
		const half = (j: number, m: number): number => {
			if (j < m || j >= b.h - m) return 0;
			if (style === "round") {
				const rad = b.h / 2 - m;
				const dy = j + 0.5 - b.h / 2;
				return Math.abs(dy) < rad ? Math.round(Math.sqrt(rad * rad - dy * dy)) : 0;
			}
			if (style === "arch" && j < b.w / 2) {
				const rad = b.w / 2 - m;
				const dy = b.w / 2 - j - 0.5;
				return dy < rad ? Math.round(Math.sqrt(rad * rad - dy * dy)) : 0;
			}
			return b.w / 2 - m;
		};
		const rows = (m: number, fn: (x: number, y: number, w: number, j: number) => void) => {
			for (let j = -1; j <= b.h; j++) {
				const hw = half(j, m);
				if (hw > 0) fn(Math.round(cx - hw), b.y + j, hw * 2, j);
			}
		};
		T = tint;
		rows(-1, (px, py, w) => R(px, py, w, 1, tone(frame, -2)));
		rows(0, (px, py, w) => R(px, py, w, 1, frame));
		rows(1, (px, py, w, j) => j === 1 && R(px, py, w, 1, tone(frame, 1)));
		T = PLAIN;
		const gh = b.h - 4;
		rows(2, (px, py, w, j) => R(px, py, w, 1, skyColor(sky, 0.35 + ((j - 2) / gh) * 0.6)));
		g.save();
		g.beginPath();
		rows(2, (px, py, w) => g.rect(px, py, w, 1));
		g.clip();
		if (sky.day > 0.3 || sky.dusk > 0.3) {
			const drift = Math.floor(now / 2400 + b.x) % (b.w + 12);
			R(b.x + 2 + clamp(drift - 8, 0, b.w - 4), b.y + 7, clamp(Math.min(drift, b.w + 4 - drift), 0, 8), 2, sky.cloud[0]);
			R(b.x + 2 + clamp(drift - 6, 0, b.w - 4), b.y + 6, clamp(Math.min(drift - 2, b.w + 2 - drift), 0, 4), 1, sky.cloud[0]);
		} else {
			// Stars, and the northern lights going by.
			R(b.x + 5, b.y + 5, 1, 1, "#f2f4ff");
			R(b.x + 15, b.y + 9, 1, 1, Math.floor(now / 800) % 2 ? "#f2f4ff" : "#8a94c8");
			g.globalAlpha = 0.5;
			for (let i = 0; i < b.w - 4; i += 2) {
				const u = (b.x + i) / 9 + now / 5000;
				const ay = b.y + 6 + Math.round(Math.sin(u) * 2);
				R(b.x + 2 + i, ay, 2, 3 + Math.round(Math.sin(u * 2.3) * 1.5), i % 4 ? "#5cf2b0" : "#58d8ff");
			}
			g.globalAlpha = 1;
		}
		// The snow outside, a pine in it, flakes going down.
		T = tintOf(sky.grade);
		R(b.x + 2, b.y + b.h - 6, b.w - 4, 4, "#f2f7fd");
		R(b.x + 2, b.y + b.h - 7, 8, 1, "#f2f7fd");
		R(b.x + 13, b.y + b.h - 7, 6, 1, "#f2f7fd");
		const tx = b.x + 5 + (hashOf(room.agent) % 3) * 6;
		R(tx, b.y + b.h - 10, 1, 4, PINE), R(tx - 1, b.y + b.h - 8, 3, 1, PINE), R(tx - 2, b.y + b.h - 7, 5, 1, PINE), R(tx, b.y + b.h - 11, 1, 1, "#ffffff");
		T = PLAIN;
		for (let i = 0; i < 4; i++) R(b.x + 3 + ((i * 7 + Math.floor(now / 1700)) % (b.w - 6)), b.y + 3 + ((Math.floor(now / 160) + i * 5) % (b.h - 8)), 1, 1, "#ffffff");
		g.globalAlpha = 0.28;
		g.fillStyle = "#ffffff";
		g.fillRect(b.x + 5, b.y + 4, 2, 6);
		g.fillRect(b.x + 8, b.y + 4, 1, 4);
		g.globalAlpha = 1;
		g.restore();
		// Frost, growing in from the corners.
		rows(2, (px, py, w, j) => {
			if (j > b.h - 8) R(px, py, Math.max(0, j - (b.h - 8)) > 2 ? 2 : 1, 1, "#ffffff"), R(px + w - 1, py, 1, 1, "#ffffff");
			if (j === b.h - 3) for (let i = 1; i < w; i += 3) R(px + i, py, 1, 1, "#ffffff");
		});
		T = tint;
		R(Math.round(cx), b.y + 2, 1, b.h - 4, frame);
		R(b.x + 2, b.y + Math.floor(b.h / 2), b.w - 4, 1, frame);
		if (style !== "round") {
			R(b.x - 2, b.y + b.h, b.w + 4, 2, tone(frame, 1));
			R(b.x - 2, b.y + b.h, b.w + 4, 1, "#ffffff");
		}
		if (curtain && style === "square") {
			R(b.x - 3, b.y - 3, b.w + 6, 1, tone(frame, -1));
			const cur = tone(curtain, 1);
			for (const cxx of [b.x - 2, b.x + b.w - 2]) {
				R(cxx, b.y - 2, 4, b.h + 1, cur);
				R(cxx + 1, b.y - 2, 1, b.h + 1, tone(cur, 1));
				R(cxx + 3, b.y - 2, 1, b.h + 1, tone(cur, -1));
				R(cxx, b.y + b.h - 6, 4, 1, tone(curtain, -1));
			}
		}
		// At night an unlit bay has the moon on its floor.
		if (night > 0.6 && room.lit < 0.5) dither(b.x + 2, room.floorY - 1, b.w - 2, 1, "#aab8ee", 8);
	}

	/** A string of pennants along the ceiling, in the agent's color: whose bay this is. */
	private bunting(x0: number, x1: number, y: number, color: string): void {
		R(x0, y, x1 - x0, 1, tone(color, -2));
		for (let i = x0 + 2, n = 0; i < x1 - 4; i += 7, n++) {
			const c = n % 2 ? FUR : color;
			R(i, y + 1, 5, 1, c);
			R(i + 1, y + 2, 3, 1, c);
			R(i + 2, y + 3, 1, 1, tone(c, -1));
		}
	}

	/** A bell on the wall for each schedule the agent has: they jingle when one is due. */
	private bells(room: Room, agent: ViewAgent | undefined, now: number, tint: Tint, glows: Glow[]): void {
		const sched = agent?.schedules ?? [];
		if (!sched.length) return;
		const ringing = now - (this.hotAt.get(`clocks:${room.agent}`) ?? -1e9) < 3000;
		const n = Math.min(sched.length, 3);
		R(room.clocks.x - 1, room.clocks.y, n * 9 + 1, 1, "#d8362f");
		for (let i = 0; i < n; i++) {
			const swing = ringing ? [-1, 0, 1, 0][Math.floor(now / 70 + i) % 4] : 0;
			const cx = room.clocks.x + 3 + i * 9;
			const cy = room.clocks.y + 1;
			R(cx, cy, 1, 2, "#d8362f");
			T = ringing ? PLAIN : tint;
			R(cx - 1 + swing, cy + 2, 3, 1, INK);
			R(cx - 2 + swing, cy + 3, 5, 4, INK);
			R(cx - 3 + swing, cy + 6, 7, 2, INK);
			R(cx + swing, cy + 2, 1, 1, GOLD);
			R(cx - 1 + swing, cy + 3, 3, 3, GOLD);
			R(cx - 2 + swing, cy + 6, 5, 1, ringing ? "#fff6c8" : "#d9a84a");
			R(cx - 1 + swing, cy + 3, 1, 2, "#fff6c8");
			R(cx + swing * 2, cy + 7, 1, 1, "#8a6a2a");
			if (ringing) {
				R(cx - 5, cy + 2 + (Math.floor(now / 90) % 2), 1, 1, KIND_COLOR.clock);
				R(cx + 5, cy + 3 - (Math.floor(now / 90) % 2), 1, 1, KIND_COLOR.clock);
				glows.push({ x: cx, y: cy + 4, r: 8, color: KIND_COLOR.clock, a: 0.9 });
			}
			T = tint;
		}
		if (sched.length > 3) R(room.clocks.x + 29, room.clocks.y + 4, 3, 1, INK), R(room.clocks.x + 30, room.clocks.y + 3, 1, 3, INK);
	}

	/** The lamp from the ceiling: on while work runs. */
	private lamp(room: Room, color: string, tint: Tint, glows: Glow[]): void {
		const y = room.y;
		R(room.lamp, y, 1, 7, INK);
		for (let j = 0; j < 4; j++) R(room.lamp - 2 - j, y + 7 + j, 5 + j * 2, 1, j === 0 ? tone(color, 1) : j === 3 ? tone(color, -1) : color);
		R(room.lamp - 5, y + 10, 11, 1, FUR);
		if (room.lit > 0.2) {
			T = PLAIN;
			R(room.lamp - 1, y + 11, 3, 2, "#fff6c8");
			T = tint;
			glows.push({ x: room.lamp, y: y + 14, r: 26, color: "#ffe2a0", a: 0.55 * room.lit }, { x: room.lamp, y: room.floorY - 6, r: 34, color: "#ffd98a", a: 0.25 * room.lit });
		}
	}

	/** What the mode of an agent and what it has read do to its bay: tape and a beacon for bypass, an amber lantern after outside content. */
	private signals(room: Room, agent: ViewAgent | undefined, jobs: ViewWork[], now: number, tint: Tint, glows: Glow[]): void {
		const { x, y, w } = room;
		if (agent?.mode === "bypass") {
			for (let i = x + 2; i < x + w; i += 6) R(i, y, 3, 2, "#f2c230"), R(i + 3, y, 3, 2, "#2b2140");
			const on = Math.floor(now / 380) % 2 === 0;
			R(x + w - 22, y + 2, 5, 2, "#59657a");
			T = PLAIN;
			R(x + w - 22, y + 4, 5, 3, on ? "#ff4d4d" : "#8a2a2a");
			T = tint;
			if (on) glows.push({ x: x + w - 20, y: y + 5, r: 12, color: "#ff4d4d", a: 0.8 });
		}
		const outside = jobs.some((j) => j.outside) || agent?.conversations?.some((c) => c.outside && c.busy);
		if (outside) {
			const on = Math.floor(now / 520) % 2 === 0;
			T = PLAIN;
			R(x + 3, y + 13, 7, 3, on ? "#ffb21f" : "#a8741a");
			R(x + 4, y + 12, 5, 1, "#59657a");
			T = tint;
			if (on) glows.push({ x: x + 6, y: y + 14, r: 12, color: "#ffb21f", a: 0.7 });
		}
	}

	/** The shelf: toys that are done, and under them a book with a star for each skill the agent has. */
	private shelf(room: Room, agent: ViewAgent | undefined, jobs: ViewWork[], now: number, tint: Tint, glows: Glow[], wood: string): void {
		const { floorY } = room;
		const sx = room.shelf;
		const dark = tone(wood, -2);
		R(sx - 1, floorY, 21, 1, tone("#d9a56e", -2));
		block(sx, floorY - 36, 18, 36, wood, { r: 0, ink: dark });
		R(sx + 1, floorY - 35, 16, 34, tone(wood, -1));
		for (const k of [0, 11, 22]) R(sx + 1, floorY - 36 + 11 + k, 16, 2, wood), R(sx + 1, floorY - 36 + 11 + k, 16, 1, tone(wood, 1));
		for (const [tx, base, type, c] of room.toys) drawToy(type, tx, base, c);
		this.skillBooks(room, agent, jobs, now, tint, glows, sx + 2, floorY - 2);
		// On top of it: a jar of sweets and a star to go on a tree.
		R(sx + 2, floorY - 42, 6, 6, INK);
		R(sx + 3, floorY - 41, 4, 4, "#d8f0f8");
		R(sx + 3, floorY - 43, 4, 2, tone(wood, 1));
		R(sx + 4, floorY - 40, 1, 1, "#e5484d"), R(sx + 5, floorY - 39, 1, 1, "#3fa468"), R(sx + 3, floorY - 38, 1, 1, "#f2b134"), R(sx + 6, floorY - 38, 1, 1, "#4a90d9");
		R(sx + 12, floorY - 40, 1, 3, GOLD), R(sx + 11, floorY - 39, 3, 1, GOLD);
	}

	/** A book with a star on its back for each skill, their feet on `base`: one lifts and glows when the agent reads it. */
	private skillBooks(room: Room, agent: ViewAgent | undefined, jobs: ViewWork[], now: number, tint: Tint, glows: Glow[], x: number, base: number): void {
		const skills = agent?.skills ?? [];
		const shown = Math.min(skills.length, 5);
		for (let i = 0; i < shown; i++) {
			const hot = now - (this.hotAt.get(`skill:${room.agent}:${skills[i]}`) ?? -1e9) < 2500 || jobs.some((j) => j.skill === skills[i]);
			const more = i === 4 && skills.length > 5;
			const bx = x + i * 3;
			const c = more ? "#b8ada0" : ["#e0b040", "#d99a2e", "#f2c95a"][i % 3];
			const up = hot ? 2 : 0;
			T = hot ? PLAIN : tint;
			R(bx, base - 9 - up, 3, 9, c);
			R(bx, base - 9 - up, 1, 9, tone(c, 1));
			R(bx + 2, base - 9 - up, 1, 9, tone(c, -1));
			if (more) R(bx + 1, base - 6, 1, 1, INK), R(bx + 1, base - 4, 1, 1, INK), R(bx + 1, base - 2, 1, 1, INK);
			else R(bx + 1, base - 6 - up, 1, 1, "#fffbe0"), R(bx, base - 5 - up, 3, 1, "#fff3c4"), R(bx + 1, base - 4 - up, 1, 1, "#fffbe0");
			T = tint;
			if (hot) glows.push({ x: bx + 1, y: base - 6, r: 8, color: "#ffe27a", a: 0.9 });
		}
	}

	/**
	 * The machine: a column of glass full of gumballs, one for each MCP server the agent has. The one in use
	 * lights up and jumps, the crank turns, and steam comes out of the top.
	 */
	private machine(room: Room, agent: ViewAgent | undefined, jobs: ViewWork[], now: number, tint: Tint, glows: Glow[], accent: string): void {
		const { floorY } = room;
		const rx = room.rack;
		const servers = agent?.mcp ?? [];
		const used = servers.some((name) => jobs.some((j) => j.mcp === name && j.doing === "tool"));
		R(rx - 1, floorY, 13, 1, tone("#d9a56e", -2));
		// The foot, with the door the sweets come out of and the crank.
		block(rx - 1, floorY - 8, 12, 8, accent, { r: 1 });
		R(rx + 2, floorY - 5, 5, 4, INK);
		R(rx + 3, floorY - 4, 3, 2, tone(accent, -2));
		R(rx - 1, floorY - 8, 12, 1, tone(accent, 2));
		const turn = used ? Math.floor(now / 110) % 4 : 0;
		R(rx + 11, floorY - 6, 2, 2, "#59657a");
		R(rx + 12 + [1, 0, -1, 0][turn], floorY - 6 + [0, 1, 0, -1][turn] - 1, 2, 2, GOLD);
		// The glass, and the cap on it.
		R(rx - 1, floorY - 30, 12, 22, INK);
		R(rx, floorY - 29, 10, 21, "#d2eef8");
		R(rx + 1, floorY - 28, 1, 19, "#ffffff");
		R(rx + 8, floorY - 29, 2, 21, "#a9d2e2");
		block(rx + 1, floorY - 33, 8, 3, accent, { r: 1 });
		R(rx + 4, floorY - 35, 2, 2, GOLD);
		for (let i = 0; i < 8; i++) {
			const name = servers[i];
			const by = floorY - 13 - Math.floor(i / 2) * 5;
			const bx = rx + 1 + (i % 2) * 4 + (Math.floor(i / 2) % 2);
			if (!name) continue;
			if (i === 7 && servers.length > 8) {
				R(bx, by + 1, 1, 1, INK), R(bx + 2, by + 1, 1, 1, INK), R(bx + 1, by - 1, 1, 1, INK);
				continue;
			}
			const use = jobs.some((j) => j.mcp === name && j.doing === "tool");
			const hot = use || now - (this.hotAt.get(`mcp:${room.agent}:${name}`) ?? -1e9) < 1800;
			const c = ["#f2b84a", "#4a90d9", "#e5484d", "#3fa468", "#9b6bd6", "#ec7fa9"][hashOf(name) % 6];
			const jump = hot ? Math.floor(now / 90 + i) % 2 : 0;
			T = hot ? PLAIN : tint;
			slab(bx - 1, by - 1 - jump, 6, 6, tone(c, -2), 2);
			slab(bx, by - jump, 4, 4, hot ? mix(c, "#ffffff", 0.3) : c, 1);
			R(bx + 1, by - jump, 1, 1, "#ffffff");
			R(bx + 2, by + 3 - jump, 1, 1, tone(c, -1));
			T = tint;
			if (hot) glows.push({ x: bx + 2, y: by + 2, r: 8, color: c, a: 0.95 });
		}
		if (used) {
			const wasT = T;
			T = PLAIN;
			for (let i = 0; i < 3; i++) {
				const k = (now / 900 + i / 3) % 1;
				R(rx + 4 + Math.round(Math.sin(k * 6 + i) * 2), floorY - 37 - Math.round(k * 9), k < 0.5 ? 2 : 1, k < 0.5 ? 2 : 1, "#f2f7fd");
			}
			T = wasT;
		}
	}

	/** What hangs on the wall over the bench, by the kind of workshop: tools, pots of paint, spools, wheels that turn. */
	private decor(room: Room, kind: number, now: number, tint: Tint, working: boolean): void {
		const x0 = room.desk + 3;
		const y0 = room.y + 20;
		const steel = "#9aa6b8";
		const handle = "#8a5a3a";
		if (kind === 0) {
			// A rail of tools: a saw, a hammer, a square, a plane.
			R(x0, y0, 23, 1, handle);
			R(x0 + 1, y0 + 1, 2, 3, handle), R(x0 + 1, y0 + 4, 7, 3, steel), R(x0 + 1, y0 + 7, 7, 1, tone(steel, -1));
			R(x0 + 11, y0 + 1, 1, 7, handle), R(x0 + 9, y0 + 1, 5, 2, steel);
			R(x0 + 16, y0 + 1, 1, 7, steel), R(x0 + 16, y0 + 7, 5, 1, steel);
		} else if (kind === 1) {
			// Pots of paint on a shelf, a brush in one.
			R(x0, y0 + 8, 23, 1, handle), R(x0, y0 + 9, 23, 1, tone(handle, -1));
			["#e5484d", "#f2b134", "#3fa468", "#4a90d9", "#9b6bd6"].forEach((c, i) => {
				R(x0 + 1 + i * 4, y0 + 4, 3, 4, "#cfd8e2");
				R(x0 + 1 + i * 4, y0 + 4, 3, 1, c);
				R(x0 + 2 + i * 4, y0 + 6, 1, 1, c);
			});
			R(x0 + 10, y0, 1, 4, handle);
		} else if (kind === 2) {
			// What a baker hangs up: a rolling pin, a whisk, a spoon; and a tray of biscuits.
			R(x0, y0, 23, 1, steel);
			R(x0 + 2, y0 + 1, 1, 2, steel), R(x0 + 1, y0 + 3, 3, 6, "#d9a56e"), R(x0 + 2, y0 + 9, 1, 1, handle);
			R(x0 + 8, y0 + 1, 1, 4, handle), R(x0 + 7, y0 + 5, 3, 4, steel), R(x0 + 8, y0 + 6, 1, 2, tone(steel, 1));
			R(x0 + 14, y0 + 1, 1, 5, handle), R(x0 + 13, y0 + 6, 3, 3, handle);
			R(x0 + 18, y0 + 4, 5, 1, steel), R(x0 + 18, y0 + 3, 1, 1, GINGER), R(x0 + 20, y0 + 3, 1, 1, GINGER), R(x0 + 22, y0 + 3, 1, 1, GINGER);
		} else if (kind === 3) {
			// Spools of thread on their pegs, a pair of scissors.
			["#e5484d", "#f2b134", "#3fa468", "#4a90d9", "#ec7fa9", "#9b6bd6"].forEach((c, i) => {
				const px = x0 + 1 + (i % 3) * 5;
				const py = y0 + Math.floor(i / 3) * 5;
				R(px, py, 3, 1, handle), R(px, py + 1, 3, 3, c), R(px, py + 4, 3, 1, handle), R(px, py + 2, 3, 1, tone(c, 1));
			});
			R(x0 + 18, y0 + 1, 1, 5, steel), R(x0 + 20, y0 + 1, 1, 5, steel), R(x0 + 19, y0 + 5, 1, 1, steel), R(x0 + 17, y0 + 6, 2, 2, "#e5484d"), R(x0 + 20, y0 + 6, 2, 2, "#e5484d");
		} else if (kind === 4) {
			// Two wheels with teeth: they go round while work runs.
			const a0 = working ? Math.floor(now / 140) * (Math.PI / 8) : 0;
			const gear = (cx: number, cy: number, rad: number, a: number, c: string) => {
				for (let k = 0; k < 8; k++) R(cx + Math.cos(a + (k * Math.PI) / 4) * (rad + 1) - 0.5, cy + Math.sin(a + (k * Math.PI) / 4) * (rad + 1) - 0.5, 2, 2, c);
				disc(cx, cy, rad, c);
				disc(cx, cy, rad - 2, tone(c, -1));
				R(cx, cy, 1, 1, tone(c, 2));
			};
			gear(x0 + 6, y0 + 5, 4, a0, "#d9a84a");
			gear(x0 + 16, y0 + 4, 3, -a0 + 0.4, steel);
		} else if (kind === 5) {
			// Sweets on strings.
			R(x0, y0, 23, 1, FUR);
			for (let i = 0; i < 4; i++) {
				const px = x0 + 2 + i * 6;
				const c = ["#e5484d", "#3fa468", "#ec7fa9", "#f2b134"][i];
				R(px, y0 + 1, 1, 2 + (i % 2), FUR);
				if (i % 2) disc(px, y0 + 6, 2, c), R(px - 1, y0 + 5, 1, 1, "#ffffff"), R(px, y0 + 8, 1, 2, FUR);
				else for (let j = 0; j < 6; j++) R(px, y0 + 3 + j, 1, 1, j % 2 ? c : "#ffffff"), j === 0 && R(px + 1, y0 + 2, 2, 1, c);
			}
		} else if (kind === 6) {
			// Rolls of wrapping paper on a rod, a length of each hanging down.
			R(x0, y0 + 1, 23, 1, steel);
			["#e5484d", "#3fa468", "#f2b134", "#4a90d9"].forEach((c, i) => {
				R(x0 + 1 + i * 6, y0, 4, 3, c);
				R(x0 + 1 + i * 6, y0, 4, 1, tone(c, 1));
				R(x0 + 1 + i * 6, y0 + 3, 4, 2 + ((i * 3) % 5), tone(c, -1));
				R(x0 + 2 + i * 6, y0 + 3, 1, 2 + ((i * 3) % 5), FUR);
			});
		} else {
			// Snowflakes cut from paper, turning on their threads.
			for (let i = 0; i < 3; i++) {
				const px = x0 + 3 + i * 8;
				const len = 2 + ((i * 5) % 4);
				R(px, y0 - 2, 1, len + 2, "#ffffff");
				const turn = Math.floor(now / 700 + i) % 2;
				R(px - 2, y0 + len + 2, 5, 1, "#ffffff"), R(px, y0 + len, 1, 5, "#ffffff");
				if (turn) R(px - 1, y0 + len + 1, 1, 1, "#ffffff"), R(px + 1, y0 + len + 1, 1, 1, "#ffffff"), R(px - 1, y0 + len + 3, 1, 1, "#ffffff"), R(px + 1, y0 + len + 3, 1, 1, "#ffffff");
			}
		}
		void tint;
	}

	/**
	 * The workbench (Santa's is a desk), and on it what the work is doing: the toy while tools run, a plan on blue
	 * paper while the agent thinks, a glass of sand while it waits, a parcel being tied while it writes its answer,
	 * and a jack-in-the-box with a red ! when it asks you.
	 */
	private bench(room: Room, kind: number, color: string, job: ViewWork | undefined, agent: ViewAgent | undefined, jobs: ViewWork[], now: number, tint: Tint, glows: Glow[], night: number): void {
		const { floorY } = room;
		const dx = room.desk;
		const desk = room.main;
		const wood = desk ? "#7a4a34" : "#b98a62";
		const dark = tone(wood, -2);
		R(dx - 1, floorY, 29, 1, tone("#d9a56e", -2));
		if (desk) {
			block(dx, floorY - 12, 27, 12, wood, { r: 0, ink: dark });
			R(dx, floorY - 12, 27, 2, "#3f7a5f");
			R(dx, floorY - 12, 27, 1, "#5a9a7a");
			R(dx + 9, floorY - 9, 9, 9, tone(wood, -2));
			for (const px of [dx + 2, dx + 20]) R(px, floorY - 7, 5, 1, GOLD), R(px, floorY - 3, 5, 1, GOLD);
			// An inkwell and a quill.
			R(dx + 2, floorY - 15, 3, 3, INK), R(dx + 3, floorY - 16, 1, 1, "#4a90d9");
			line(dx + 4, floorY - 16, dx + 7, floorY - 21, "#ffffff");
		} else {
			R(dx, floorY - 12, 27, 3, tone(wood, 1));
			R(dx, floorY - 12, 27, 1, "#f0d2a8");
			R(dx, floorY - 9, 27, 1, dark);
			R(dx + 1, floorY - 8, 2, 8, dark);
			R(dx + 24, floorY - 8, 2, 8, dark);
			R(dx + 3, floorY - 3, 21, 1, wood);
			// A box of parts under it, a vise at its end.
			block(dx + 14, floorY - 7, 8, 4, "#c79a6e", { r: 0, ink: dark });
			R(dx + 16, floorY - 8, 2, 1, "#e5484d"), R(dx + 19, floorY - 8, 1, 1, "#4a90d9");
			R(dx + 1, floorY - 15, 4, 3, "#9aa6b8");
			R(dx + 1, floorY - 15, 4, 1, "#cfd8e2");
			R(dx + 5, floorY - 14, 2, 1, "#59657a");
		}
		const bx = dx + 12;
		const base = floorY - 12;
		if (job?.asking) {
			block(bx + 1, base - 6, 9, 6, "#4a90d9", { r: 0 });
			R(bx + 5, base - 6, 1, 6, GOLD);
			R(bx + 1, base - 4, 9, 1, GOLD);
			const bob = [0, 1, 2, 1][Math.floor(now / 110) % 4];
			for (let j = 0; j < 4 + bob; j++) R(bx + 4 + (j % 2), base - 7 - j, 2, 1, "#cfd8e2");
			T = PLAIN;
			const cy = base - 15 - bob;
			disc(bx + 5, cy, 5, INK);
			disc(bx + 5, cy, 4, "#e5484d");
			R(bx + 5, cy - 3, 1, 4, "#ffffff");
			R(bx + 5, cy + 2, 1, 1, "#ffffff");
			T = tint;
			glows.push({ x: bx + 5, y: cy, r: 12, color: "#ff6a6a", a: 0.8 });
		} else if (job?.doing === "writing") {
			const k = Math.floor(now / 260) % 9;
			const rib = wrapOf(color).r;
			R(bx - 1, base - 9, 13, 9, INK);
			R(bx, base - 8, 11, 8, color);
			R(bx, base - 8, 11, 1, tone(color, 1));
			R(bx + 10, base - 8, 1, 8, tone(color, -1));
			R(bx + 5, base - 8, 1, Math.min(8, 2 + k * 2), rib);
			if (k > 2) R(bx, base - 5, Math.min(11, (k - 2) * 3), 1, rib);
			if (k > 5) R(bx + 2, base - 11, 3, 2, rib), R(bx + 6, base - 11, 3, 2, rib), R(bx + 5, base - 10, 1, 2, rib), R(bx + 1, base - 12, 2, 1, INK), R(bx + 8, base - 12, 2, 1, INK);
			T = PLAIN;
			R(bx + 1 + ((k * 5) % 10), base - 13 - (k % 3), 1, 1, "#fff6c8");
			T = tint;
			glows.push({ x: bx + 5, y: base - 5, r: 12, color, a: 0.5 });
		} else if (job?.doing === "waiting") {
			const k = (now % 3600) / 3600;
			const sand = "#f2c84a";
			R(bx + 2, base - 11, 7, 11, INK);
			R(bx + 2, base - 11, 7, 1, GOLD);
			R(bx + 2, base - 1, 7, 1, GOLD);
			R(bx + 3, base - 10, 5, 4, "#d8f0f8");
			R(bx + 3, base - 5, 5, 4, "#d8f0f8");
			R(bx + 5, base - 6, 1, 1, "#d8f0f8");
			const up = Math.round((1 - k) * 3);
			const below = Math.round(k * 3);
			if (up) R(bx + 3, base - 6 - up, 5, up, sand);
			if (below) R(bx + 3, base - 1 - below, 5, below, sand);
			if (Math.floor(now / 120) % 2) R(bx + 5, base - 6, 1, 5 - below, sand);
		} else if (job && job.doing !== "tool") {
			R(bx - 1, base - 10, 13, 10, INK);
			R(bx, base - 9, 11, 9, "#3b74e0");
			R(bx, base - 9, 11, 1, "#6a9af0");
			const n = Math.floor(now / 200) % 30;
			[[1, 2, 7], [1, 4, 4], [6, 4, 4], [2, 6, 8]].forEach(([px, py, w], i) => R(bx + px, base - 9 + py, clamp(n - i * 6, 0, w), 1, "#ffffff"));
			if (n > 20) R(bx + 7, base - 8, 3, 3, "#bcd2ff"), R(bx + 8, base - 7, 1, 1, "#3b74e0");
			glows.push({ x: bx + 5, y: base - 5, r: 10, color: "#8ab4ff", a: 0.4 });
		} else {
			const hit = job && Math.floor(now / 140) % 4 === 2;
			benchToy(desk ? 8 : kind, bx, base - (hit ? 1 : 0), now, color);
			if (job) {
				T = PLAIN;
				const k = Math.floor(now / 90);
				if (k % 3 === 0) R(bx - 2 + ((k * 7) % 5), base - 3 - ((k * 5) % 7), 1, 1, k % 2 ? "#ffe27a" : "#ffffff");
				T = tint;
				glows.push({ x: bx + 4, y: base - 5, r: 12, color: "#ffd98a", a: 0.45 });
			}
		}
		// A candle that burns through the night.
		if (night > 0.5 && room.lit < 0.5) {
			R(dx + 8, base - 4, 2, 4, FUR);
			T = PLAIN;
			R(dx + 8, base - 6 - (Math.floor(now / 300) % 2), 2, 2, "#ffd98a");
			T = tint;
			glows.push({ x: dx + 9, y: base - 6, r: 10, color: "#ffc870", a: 0.55 });
		}
		// A goal: a little tree with a star on the bench while pine calls the agent again and again.
		const goal = agent?.conversations?.find((c) => c.goal === "active");
		if (goal || jobs.some((j) => j.round)) {
			const gx = dx + 8;
			R(gx, base - 2, 1, 2, "#7a5a3a");
			R(gx - 2, base - 4, 5, 2, "#2f8a58"), R(gx - 1, base - 6, 3, 2, "#3fa468"), R(gx, base - 7, 1, 1, "#3fa468");
			T = PLAIN;
			R(gx, base - 9, 1, 2, Math.floor(now / 260) % 2 ? "#ffffff" : GOLD), R(gx - 1, base - 8, 3, 1, GOLD);
			T = tint;
		}
	}

	/** A bay: the walls of its kind of workshop, what the agent has, and who works there. */
	private drawRoom(s: Now, room: Room, jobs: ViewWork[], now: number, night: number, glows: Glow[]): void {
		if (room.main) return this.drawPent(s, room, jobs, now, night, glows);
		const agent = s.agent.get(room.agent);
		const color = agent?.color ?? "#8899aa";
		const { x, y, w, floorY } = room;
		const tint = this.roomTint(room.lit, night);
		const kind = room.bay % BAYS.length;
		const bay = BAYS[kind];
		T = tint;
		this.walls(room, bay, kind);
		this.decor(room, kind, now, tint, jobs.length > 0);
		this.bunting(x + 3, x + w - 12, y + 2, color);
		this.signals(room, agent, jobs, now, tint, glows);
		for (const b of room.win) this.window(room, b, bay.win, bay.wood, bay.curtains ? color : undefined, now, night, tint);
		this.lamp(room, color, tint, glows);
		this.shelf(room, agent, jobs, now, tint, glows, bay.wood);
		this.drawBoard(room, agent, now, tint, glows);

		// The task board: while the agent has a board with work on it, a cork board on a trolley with a card for each task.
		const tasks = this.boardOf(s, room.agent, now);
		if (tasks) this.drawTasks(room.tasks, floorY, tasks, s, now, tint, glows, `tasks:${room.agent}`);
		drawPlant(room.plant, floorY, room.kind, now, room.lit > 0.5);
		this.machine(room, agent, jobs, now, tint, glows, bay.accent);
		this.bench(room, kind, color, jobs.find((j) => !j.copy), agent, jobs, now, tint, glows, night);
		// A stool with a cushion in the agent's color.
		const sx = room.seat.x;
		R(sx - 5, floorY - 7, 9, 2, color);
		R(sx - 5, floorY - 7, 9, 1, tone(color, 1));
		R(sx - 5, floorY - 5, 9, 1, tone(bay.wood, -1));
		R(sx - 4, floorY - 4, 1, 4, bay.wood), R(sx + 2, floorY - 4, 1, 4, bay.wood), R(sx - 3, floorY - 2, 5, 1, tone(bay.wood, -1));
		this.bells(room, agent, now, tint, glows);
		// The basket the sweets from the chute drop into.
		block(x + w - 11, floorY - 6, 9, 6, "#c79a6e", { r: 1, ink: "#6a4632" });
		for (let i = 0; i < 4; i++) R(x + w - 10 + i * 2, floorY - 5 + (i % 2), 1, 4, "#a8794e");
		R(x + w - 11, floorY - 6, 9, 1, "#e0b88a");
		this.folk(s, room, now, color, tint);
	}

	/** Who is in a bay: the copies and the others first, the agent's own elf in front. */
	private folk(s: Now, room: Room, now: number, color: string, tint: Tint): void {
		const mine = [...this.workers.values()].filter((k) => k.agent === room.agent).sort((a, b) => Number(a.key.startsWith("a:")) - Number(b.key.startsWith("a:")));
		for (const k of mine) this.drawWorker(s, room, k, now, color, tint);
		T = PLAIN;
	}

	/**
	 * Santa's room under the roof: the fire with the skills on its mantel, the tree with a bauble for each MCP
	 * server and the presents under it, his desk and his chair.
	 */
	private drawPent(s: Now, room: Room, jobs: ViewWork[], now: number, night: number, glows: Glow[]): void {
		const agent = s.agent.get(room.agent);
		const color = agent?.color ?? "#8899aa";
		const { x, y, w, h, floorY } = room;
		// The fire is always on: his room is never quite dark.
		const tint = this.roomTint(Math.max(room.lit, 0.35), night * 0.8);
		const wood = "#7a4a34";
		T = tint;

		// Green paper with a little gold in it, dark panels below, a red runner on the boards.
		const wall = "#73ac8c";
		R(x, y, w, h, wall);
		if (room.lit > 0.3) {
			const lc = mix(wall, "#fffbe6", 0.4);
			for (let j = 0; j < h - 28; j++) {
				const half = 7 + Math.round(j * 0.95);
				const lx = Math.max(x, room.lamp - half);
				R(lx, y + 12 + j, Math.min(x + w, room.lamp + half + 1) - lx, 1, lc);
			}
		}
		const fleck = mix(wall, GOLD, 0.55);
		for (let j = y + 5, n = 0; j < floorY - 20; j += 7, n++) for (let i = x + 5 + (n % 2) * 5; i < x + w - 2; i += 10) R(i, j, 1, 3, fleck), R(i - 1, j + 1, 3, 1, fleck);
		R(x, y, w, 2, tone(wall, -1));
		R(x, floorY - 16, w, 16, wood);
		R(x, floorY - 17, w, 1, GOLD);
		R(x, floorY - 16, w, 1, tone(wood, -1));
		for (let i = x + 4; i < x + w - 6; i += 14) block(i, floorY - 13, 10, 9, tone(wood, 1), { r: 0, ink: tone(wood, -1), flat: true });
		R(x, floorY - 2, w, 2, tone(wood, -2));
		R(x, floorY, w, 2, "#c9a877");
		R(x, floorY, w, 1, "#e0c490");
		for (let i = x + 9; i < x + w; i += 13) R(i, floorY, 1, 2, "#a8845a");
		R(x + 24, floorY, w - 62, 2, "#c0392b");
		R(x + 24, floorY, w - 62, 1, "#e06a5a");
		for (let i = x + 25; i < x + w - 39; i += 4) R(i, floorY + 1, 2, 1, GOLD);
		candy(x, y, 2, h, "#e5484d", "#ffffff", 2);
		// A garland of fir along the ceiling, a red bow where it is tied up.
		for (let i = x + 4, n = 0; i < x + w - 12; i += 4, n++) {
			const sag = [0, 1, 2, 2, 1, 0][n % 6];
			R(i, y + 2 + sag, 4, 2, n % 2 ? "#2f8a58" : "#3fa468");
			if (n % 6 === 0) R(i - 1, y + 1, 3, 2, "#d8362f"), R(i, y + 3, 1, 2, "#d8362f");
			else if (n % 3 === 1) R(i + 1, y + 3 + sag, 1, 1, GOLD);
		}
		this.signals(room, agent, jobs, now, tint, glows);

		// Tall windows, a wreath on the first.
		for (const b of room.win) this.window(room, b, "arch", wood, undefined, now, night, tint);
		const wb = room.win[0];
		const wcx = wb.x + wb.w / 2;
		for (let k = 0; k < 12; k++) {
			const a = (k * Math.PI) / 6;
			R(wcx + Math.cos(a) * 4 - 1, wb.y + 5 + Math.sin(a) * 4 - 1, 2, 2, k % 2 ? "#2f8a58" : "#3fa468");
		}
		R(wcx - 2, wb.y, 4, 2, "#d8362f"), R(wcx - 1, wb.y + 2, 1, 2, "#d8362f"), R(wcx + 1, wb.y + 2, 1, 2, "#d8362f");
		R(wcx + 3, wb.y + 7, 1, 1, "#e5484d"), R(wcx - 4, wb.y + 4, 1, 1, "#e5484d");

		// A stocking for each elf, where the room is wide enough: it glows while that agent works, and goes red while it asks.
		if (room.screen) {
			const b = room.screen;
			R(b.x, b.y, b.w, 2, wood);
			R(b.x, b.y, b.w, 1, tone(wood, 1));
			s.agents.slice(0, 24).forEach((a, i) => {
				const px = b.x + 3 + (i % 8) * 5;
				const py = b.y + 2 + Math.floor(i / 8) * 6;
				const mine = s.running.filter((j) => j.agent === a.id);
				const asks = mine.some((j) => j.asking);
				const on = mine.length > 0;
				T = on ? PLAIN : tint;
				const c = asks && Math.floor(now / 300) % 2 ? "#ff5a5a" : on ? a.color : tone(a.color, -1);
				const sw = on ? [0, 1, 0, -1][Math.floor(now / 160 + i) % 4] : 0;
				R(px + 1, py, 1, 1, GOLD);
				R(px + sw, py + 1, 3, 1, FUR);
				R(px + sw, py + 2, 3, 2, c);
				R(px + sw, py + 4, 4, 1, c);
				T = tint;
				if (on) glows.push({ x: px + 1, y: py + 3, r: 6, color: asks ? "#ff5a5a" : a.color, a: 0.8 });
			});
		}

		// The lamp: a ring of candles.
		R(room.lamp, y, 1, 6, INK);
		R(room.lamp - 6, y + 9, 13, 1, GOLD);
		R(room.lamp - 5, y + 10, 11, 1, "#d9a84a");
		for (const k of [-5, 0, 5]) {
			R(room.lamp + k, y + 6, 1, 3, FUR);
			T = PLAIN;
			R(room.lamp + k, y + 5 - (Math.floor(now / 280 + k) % 2), 1, 1, "#ffd98a");
			T = tint;
		}
		glows.push({ x: room.lamp, y: y + 8, r: 22, color: "#ffe2a0", a: 0.35 + 0.3 * room.lit }, { x: room.lamp, y: floorY - 6, r: 34, color: "#ffd98a", a: 0.25 * room.lit });

		// The fireplace: bricks, a mantel, the fire. On the mantel a starred book for each skill.
		const fx = room.shelf;
		R(fx - 1, floorY, 22, 1, tone("#c9a877", -2));
		block(fx, floorY - 30, 20, 30, BRICK, { r: 0 });
		for (let j = 0; j < 8; j++) {
			R(fx, floorY - 27 + j * 4, 20, 1, tone(BRICK, -1));
			for (let i = fx + 2 + (j % 2) * 3; i < fx + 20; i += 6) R(i, floorY - 30 + j * 4, 1, 3, tone(BRICK, -1));
		}
		R(fx + 3, floorY - 19, 14, 19, "#2a1a1e");
		R(fx + 4, floorY - 20, 12, 1, "#2a1a1e");
		R(fx + 2, floorY - 21, 16, 1, tone(BRICK, 1));
		R(fx + 5, floorY - 3, 10, 2, "#6a4632"), R(fx + 6, floorY - 5, 7, 2, "#8a5f44"), R(fx + 5, floorY - 3, 10, 1, "#8a5f44");
		T = PLAIN;
		const fl = Math.floor(now / 130);
		for (let i = 0; i < 5; i++) {
			const fh = 5 + ((fl * (i + 3) + i * 5) % 6);
			R(fx + 5 + i * 2, floorY - 5 - fh, 2, fh, "#ff8a2a");
			R(fx + 5 + i * 2, floorY - 5 - Math.round(fh * 0.6), 2, Math.round(fh * 0.6), "#ffd24a");
			if (i % 2) R(fx + 5 + i * 2, floorY - 6, 2, 2, "#fff3b0");
		}
		if (fl % 3 === 0) R(fx + 6 + ((fl * 5) % 8), floorY - 14 - (fl % 4), 1, 1, "#ffd24a");
		T = tint;
		glows.push({ x: fx + 10, y: floorY - 8, r: 30, color: "#ffa850", a: 0.55 + (fl % 5 === 0 ? 0.1 : 0) }, { x: fx + 10, y: floorY - 9, r: 12, color: "#ffd98a", a: 0.7 });
		block(fx - 2, floorY - 33, 24, 3, wood, { r: 0, ink: tone(wood, -2) });
		R(fx - 2, floorY - 33, 24, 1, tone(wood, 2));
		for (let i = fx - 1; i < fx + 21; i += 3) R(i, floorY - 30, 2, 1, "#2f8a58"), i % 2 && R(i, floorY - 29, 1, 1, "#e5484d");
		this.skillBooks(room, agent, jobs, now, tint, glows, fx + 1, floorY - 34);
		if (!(agent?.skills ?? []).length) {
			R(fx + 3, floorY - 38, 2, 4, FUR);
			T = PLAIN;
			R(fx + 3, floorY - 40, 2, 2, "#ffd98a");
			T = tint;
		}
		// A clock on the mantel, that goes.
		R(fx + 16, floorY - 39, 5, 5, INK);
		R(fx + 17, floorY - 38, 3, 3, "#fffaf0");
		R(fx + 18, floorY - 37, 1, 1, Math.floor(now / 1000) % 2 ? INK : "#d8362f");

		this.drawBoard(room, agent, now, tint, glows);

		// The task board: while the agent has a board with work on it, a cork board on a trolley with a card for each task.
		const tasks = this.boardOf(s, room.agent, now);
		if (tasks) this.drawTasks(room.tasks, floorY, tasks, s, now, tint, glows, `tasks:${room.agent}`);

		// The tree: a bauble for each MCP server, a string of little lights, a star; and presents under it, more as more gets done.
		const tx = room.rack + 5;
		const servers = agent?.mcp ?? [];
		const done = [...s.work.values()].filter((j) => j.doing === "done").length;
		const gifts = Math.min(8, 3 + done);
		const spots: Array<[number, number, number, number]> = [[-17, 0, 8, 6], [-25, 0, 7, 5], [11, 0, 7, 5], [-33, 0, 8, 7], [-20, 6, 6, 5], [-27, 5, 5, 4], [18, 0, 6, 6], [12, 5, 5, 4]];
		for (let i = 0; i < gifts; i++) {
			const [gx, up, gw, gh] = spots[i];
			const c = COATS[(i * 5 + 2) % COATS.length];
			const pal = wrapOf(c);
			block(tx + gx, floorY - up - gh, gw, gh, c, { r: 0 });
			R(tx + gx + Math.floor(gw / 2), floorY - up - gh, 1, gh, pal.r);
			R(tx + gx, floorY - up - Math.ceil(gh / 2), gw, 1, pal.r);
			R(tx + gx + Math.floor(gw / 2) - 1, floorY - up - gh - 1, 3, 1, pal.r);
		}
		R(tx - 1, floorY - 4, 3, 4, "#6b4a3a");
		block(tx - 4, floorY - 3, 9, 3, "#c0392b", { r: 0 });
		R(tx - 4, floorY - 3, 9, 1, GOLD);
		const leafs = ["#2f8a58", "#3fa468"];
		for (let i = 0; i < 6; i++) {
			const half = 13 - i * 2;
			const ty = floorY - 5 - i * 6;
			for (let j = 0; j < 7; j++) {
				const hw = Math.max(1, Math.round((half * (j + 2)) / 8));
				R(tx - hw, ty - 6 + j, hw * 2 + 1, 1, j > 4 ? tone(leafs[0], -1) : leafs[i % 2]);
				R(tx - hw, ty - 6 + j, Math.max(1, Math.round(hw * 0.4)), 1, "#5cc27e");
			}
			for (let k = -half; k <= half; k += 2) R(tx + k, ty + 1, 1, 1, tone(leafs[0], -1));
		}
		const BAUBLES: Array<[number, number]> = [[-8, -8], [6, -9], [-5, -15], [7, -16], [-1, -21], [-4, -27], [3, -28], [0, -34]];
		for (let i = 0; i < BAUBLES.length; i++) {
			const [bx, by] = BAUBLES[i];
			const name = servers[i];
			// Between the baubles the little lights of the string.
			T = PLAIN;
			const lx = tx - bx + (i % 2 ? 1 : -1);
			if (Math.floor(now / 450 + i) % 3) R(lx, floorY + by + 3, 1, 1, "#fff6c8");
			T = tint;
			if (!name) continue;
			if (i === 7 && servers.length > 8) {
				R(tx + bx - 1, floorY + by, 3, 1, "#ffffff"), R(tx + bx, floorY + by - 1, 1, 3, "#ffffff");
				continue;
			}
			const use = jobs.some((j) => j.mcp === name && j.doing === "tool");
			const hot = use || now - (this.hotAt.get(`mcp:${room.agent}:${name}`) ?? -1e9) < 1800;
			const c = ["#f2b84a", "#4a90d9", "#e5484d", "#f08ad0", "#9b6bd6", "#58d8e8"][hashOf(name) % 6];
			T = hot ? PLAIN : tint;
			R(tx + bx - 1, floorY + by - 1, 3, 3, INK);
			R(tx + bx - 1, floorY + by - 1, 3, 3, hot && Math.floor(now / 100) % 2 ? "#ffffff" : c);
			R(tx + bx - 1, floorY + by - 1, 1, 1, "#ffffff");
			R(tx + bx, floorY + by - 2, 1, 1, GOLD);
			T = tint;
			if (hot) glows.push({ x: tx + bx, y: floorY + by, r: 8, color: c, a: 0.95 });
		}
		T = PLAIN;
		const tw = Math.floor(now / 400) % 2;
		R(tx, floorY - 46, 1, 5, GOLD), R(tx - 2, floorY - 44, 5, 1, GOLD), R(tx - 1, floorY - 45, 3, 3, tw ? "#fff6c8" : GOLD);
		T = tint;
		glows.push({ x: tx, y: floorY - 44, r: 9, color: "#ffe27a", a: 0.8 }, { x: tx, y: floorY - 18, r: 20, color: "#ffe2a0", a: 0.25 });

		// His desk, and the chair with wings that he sits and sleeps in.
		this.bench(room, 8, color, jobs.find((j) => !j.copy), agent, jobs, now, tint, glows, night);
		const sx = room.seat.x;
		const green = "#2f6f52";
		block(sx - 11, floorY - 27, 5, 26, green, { r: 2 });
		R(sx - 7, floorY - 27, 3, 6, green), R(sx - 5, floorY - 26, 1, 4, tone(green, 1));
		block(sx - 9, floorY - 8, 15, 6, green, { r: 1 });
		R(sx - 7, floorY - 8, 12, 2, "#c0392b");
		R(sx - 7, floorY - 8, 12, 1, "#e06a5a");
		R(sx - 9, floorY - 1, 2, 1, GOLD), R(sx + 4, floorY - 1, 2, 1, GOLD);
		for (const dy of [22, 17, 12]) R(sx - 9, floorY - dy, 1, 1, GOLD);
		this.bells(room, agent, now, tint, glows);
		block(x + w - 11, floorY - 6, 9, 6, "#c79a6e", { r: 1, ink: "#6a4632" });
		for (let i = 0; i < 4; i++) R(x + w - 10 + i * 2, floorY - 5 + (i % 2), 1, 4, "#a8794e");
		R(x + w - 11, floorY - 6, 9, 1, "#e0b88a");
		this.folk(s, room, now, color, tint);
	}
	/** An agent's conversations on its board, as lines: never their names. */
	private drawBoard(room: Room, agent: ViewAgent | undefined, now: number, tint: Tint, glows: Glow[]): void {
		const b = room.board;
		block(b.x, b.y, b.w, b.h, PAPER, { r: 0, ink: "#8a5f44" });
		R(b.x - 1, b.y + b.h, b.w + 2, 1, "#6a4632");
		R(b.x + Math.floor(b.w / 2) - 1, b.y - 2, 3, 2, "#d8362f");
		const convs = agent?.conversations ?? [];
		const trunkY = b.y + b.h - 4;
		const BLUE = "#3b74e0";
		const GREEN = "#2fa868";
		const main = convs.find((c) => c.main);
		R(b.x + 2, trunkY, b.w - 4, 1, BLUE);
		R(b.x + 1, trunkY - 1, 3, 3, BLUE);
		if (main?.busy && Math.floor(now / 350) % 2) R(b.x + b.w - 4, trunkY - 1, 3, 3, BLUE);
		else R(b.x + b.w - 3, trunkY, 1, 1, tone(BLUE, -1));
		const forks = convs.filter((c) => c.branchOf !== undefined);
		const others = convs.filter((c) => !c.main && c.branchOf === undefined);
		forks.slice(0, 4).forEach((c, i) => {
			const fx = b.x + 5 + i * 4;
			const top = trunkY - 4 - (i % 2) * 3;
			const col = c.worktree ? GREEN : "#8a6ad0";
			line(fx, trunkY - 1, fx + 3, top, col);
			R(fx + 3, top, b.x + b.w - 4 - (fx + 3) - i * 2, 1, col);
			const ex = b.x + b.w - 4 - i * 2;
			R(ex, top - 1, 2, 3, c.busy && Math.floor(now / 350) % 2 ? "#ffffff" : col);
			if (c.worktree) R(ex + 2, top - 2, 2, 2, "#5cc27e"), R(ex + 3, top - 3, 1, 1, "#5cc27e");
			if (c.goal === "active") R(ex - 2, top - 3, 1, 3, INK), R(ex - 1, top - 3, 2, 2, "#e5484d");
		});
		// The other conversations: a dot each along the top.
		others.slice(0, 7).forEach((c, i) => {
			const col = c.worktree ? GREEN : "#9aa6b8";
			R(b.x + 2 + i * 3, b.y + 2, 2, 2, c.busy && Math.floor(now / 350) % 2 ? BLUE : col);
		});
		if (forks.length > 4 || others.length > 7) R(b.x + b.w - 3, b.y + 2, 1, 1, INK), R(b.x + b.w - 5, b.y + 2, 1, 1, INK);
		if (now - (this.hotAt.get(`board:${room.agent}`) ?? -1e9) < 2500) {
			T = PLAIN;
			const k = Math.floor(now / 120) % 4;
			R(b.x + 3 + k * 5, b.y + 2 + (k % 2) * 6, 1, 1, "#7ee0a0");
			R(b.x + b.w - 4 - k * 4, b.y + 4 + ((k + 1) % 2) * 5, 1, 1, "#ffffff");
			T = tint;
			glows.push({ x: b.x + b.w / 2, y: b.y + b.h / 2, r: 14, color: "#7ee0a0", a: 0.7 });
		}
	}

	/**
	 * The board that stands in an agent's room: the one its sub-agents work through, or another of its own with work
	 * on it (the one with the most). It stays for a moment after its last task is settled, so that the end is seen.
	 */
	boardOf(s: Now, agent: string, now: number): ViewBoard | undefined {
		const mine = s.boards.filter((b) => b.agent === agent && b.scope !== "all");
		const live = mine.filter((b) => unsettled(b) > 0).sort((a, b) => unsettled(b) - unsettled(a) || a.id - b.id)[0];
		const last = this.boardShown.get(agent);
		const shown = live ?? (last && now - last.at < 9000 ? mine.find((b) => b.id === last.id) : undefined);
		if (live) this.boardShown.set(agent, { id: live.id, at: now });
		// (Whether a task board stands in the room: what the pointer asks.)
		if (shown) this.trolleys.add(agent);
		else this.trolleys.delete(agent);
		return shown;
	}

	/** Where the boards that are for all agents hang in the hall: two at most, left of the way out, where there is room. */
	private placeNotices(s: Now): void {
		const boxes = [...this.ports.values()].filter((p) => p.kind !== "clock" && p.kind !== "you");
		const used = 48 + Math.ceil(boxes.length / 2) * 16;
		const x = this.inner.x;
		this.notices = [];
		s.boards
			.filter((b) => b.scope === "all")
			.slice(0, 2)
			.forEach((b, i) => {
				const box = { x: x + this.inner.w - 21 - 8 - (i + 1) * 28, y: this.hallTop + 9, w: 24, h: 14 };
				if (box.x >= x + used + 2) this.notices.push({ id: b.id, name: b.name ?? "board", box });
			});
	}

	/**
	 * A board's tasks as cards on a cork board: paper for one that is to do (dim while it waits for another), the
	 * color of the agent whose sub-agent has it, blinking, green when it is done, amber when its worker asked
	 * something, red when it failed. What comes after a task (a check of it) hangs under it. A strip along the top
	 * says how far the board is, and a sign stands over it while a question waits. With `floorY` it is on a trolley.
	 */
	private drawTasks(t: Box, floorY: number | undefined, b: ViewBoard, s: Now, now: number, tint: Tint, glows: Glow[], key: string): void {
		T = tint;
		const CORK = "#c98f55";
		const WOOD = "#6a4632";
		if (floorY !== undefined) {
			R(t.x + 3, t.y + t.h, 1, floorY - t.y - t.h - 1, WOOD);
			R(t.x + t.w - 4, t.y + t.h, 1, floorY - t.y - t.h - 1, WOOD);
			R(t.x + 2, floorY - 1, 3, 1, INK);
			R(t.x + t.w - 5, floorY - 1, 3, 1, INK);
		}
		block(t.x, t.y, t.w, t.h, CORK, { r: 0, ink: WOOD });
		const all = b.open + b.taken + b.done + b.failed + b.blocked;
		R(t.x + 1, t.y + 1, t.w - 2, 1, tone(CORK, -2));
		if (all) R(t.x + 1, t.y + 1, Math.round(((t.w - 2) * b.done) / all), 1, "#2fa868");
		const grid = tiling(b, t.w - 2, t.h - 4, [[2, 1], [1, 1]], 1);
		const blink = Math.floor(now / 350) % 2 === 0;
		for (const { task, x, y } of grid.tiles) {
			const lit = task.state === "taken" || task.state === "blocked";
			const c = task.state === "done" ? "#2fa868" : task.state === "failed" ? "#e5484d" : task.state === "blocked" ? (blink ? "#ffb21f" : "#fff3c4") : task.state === "taken" ? (blink ? this.colorOf(s, task.agent ?? b.agent ?? "") : "#ffffff") : task.state === "waiting" ? tone(CORK, 1) : PAPER;
			T = lit ? PLAIN : tint;
			R(t.x + 1 + x, t.y + 3 + y, grid.size, grid.size, c);
		}
		T = tint;
		if (grid.more) R(t.x + t.w - 2, t.y + t.h - 2, 1, 1, INK), R(t.x + t.w - 4, t.y + t.h - 2, 1, 1, INK);
		if (b.blocked) {
			// A question on it: a sign over the board, for as long as it waits for an answer.
			T = PLAIN;
			const hop = Math.floor(now / 250) % 2;
			const qx = t.x + t.w - 7;
			const qy = t.y - 10 - hop;
			slab(qx, qy, 7, 9, INK, 2);
			slab(qx + 1, qy + 1, 5, 7, "#ffb21f", 1);
			R(qx + 2, qy + 2, 3, 1, INK);
			R(qx + 4, qy + 3, 1, 1, INK);
			R(qx + 3, qy + 4, 1, 1, INK);
			R(qx + 3, qy + 6, 1, 1, INK);
			T = tint;
			glows.push({ x: qx + 3, y: qy + 4, r: 9, color: "#ffb21f", a: 0.7 });
		}
		if (now - (this.hotAt.get(key) ?? -1e9) < 1500) glows.push({ x: t.x + t.w / 2, y: t.y + t.h / 2, r: 15, color: "#ffe27a", a: 0.6 });
	}

	private drawWorker(s: Now, room: Room, w: Worker, now: number, color: string, tint: Tint): void {
		const j = w.work !== undefined ? s.work.get(w.work) : undefined;
		const fading = w.goneAt !== undefined || now - w.born < 120;
		if (fading && Math.floor(now / 60) % 2) return;
		const eye = j?.outside ? "#ffb21f" : undefined;
		const seated = !w.walking && (w.act === "sit" || w.act === "type" || w.act === "wrap" || w.act === "wait" || w.act === "sleep");
		const lesser = w.small || w.extra;
		const pose: Pose = w.walking ? "walk" : w.act === "stand" ? "stand" : w.act;
		const args: FolkArgs = { pose, t: now, dir: w.dir, small: w.small, main: room.main && !lesser, eye, shield: Boolean(j?.held), lit: Boolean(j && !ended(j)), prop: w.act === "skill" ? "#e0b040" : w.act === "hand" ? color : undefined, tool: room.bay };
		T = tint;
		// Its shadow on the boards.
		if (!seated || lesser) R(w.x - (w.small ? 3 : 5), room.floorY, w.small ? 7 : 10, 1, tone("#b98a62", -2));
		const y = seated ? (lesser ? room.floorY - 1 : room.seat.y) : room.floorY;
		// A helper who is not a copy is another elf: one of its own looks, in the agent's cap.
		w.box = drawFolk(lookOf(lesser && !w.small ? w.key : w.agent), color, w.x, y, args);
		// After outside content: an amber sign beside its head.
		if (j?.outside && !lesser) {
			T = PLAIN;
			const bx = w.box.x + w.box.w - 1;
			R(bx + 2, w.box.y + 4, 1, 1, "#ffb21f");
			R(bx + 1, w.box.y + 5, 3, 1, "#ffb21f");
			R(bx, w.box.y + 6, 5, 1, "#ffb21f");
			R(bx + 2, w.box.y + 5, 1, 1, INK);
			T = tint;
		}
	}

	/** A bay nobody works in yet: bare gingerbread, crates, a ladder, a parcel that waits. */
	private drawVacant(b: Box, night: number): void {
		T = this.roomTint(0, night);
		R(b.x, b.y, b.w, b.h, "#d9c3a0");
		for (let i = b.x + 7; i < b.x + b.w; i += 12) R(i, b.y, 1, b.h, "#cdb690");
		R(b.x, b.y, b.w, 2, "#bfa680");
		R(b.x, b.y + b.h, b.w, 2, "#c9a877");
		candy(b.x, b.y, 2, b.h, "#e5484d", "#ffffff", 2);
		const lx = b.x + Math.round(b.w * 0.62);
		line(lx, b.y + b.h, lx + 7, b.y + 22, "#b98a62");
		line(lx + 14, b.y + b.h, lx + 8, b.y + 22, "#b98a62");
		for (let k = 0; k < 4; k++) R(lx + 2 + k, b.y + b.h - 6 - k * 7, 10 - k * 2, 1, "#8a5f44");
		// Crates, one on two; a parcel on top that says somebody is expected.
		for (const [cx, cy] of [[20, 0], [33, 0], [26, 11]]) {
			block(b.x + cx, b.y + b.h - 11 - cy, 12, 11, "#c9a877", { r: 0, ink: "#8a6a4a" });
			R(b.x + cx, b.y + b.h - 8 - cy, 12, 1, "#a8845a"), R(b.x + cx, b.y + b.h - 4 - cy, 12, 1, "#a8845a");
			line(b.x + cx + 1, b.y + b.h - 10 - cy, b.x + cx + 10, b.y + b.h - 1 - cy, "#a8845a");
		}
		R(b.x + 28, b.y + b.h - 29, 9, 7, INK);
		stamp(PRESENT, wrapOf("#3fa468"), b.x + 29, b.y + b.h - 30);
		R(b.x + 52, b.y + b.h - 4, 12, 4, "#f2f7fd"), R(b.x + 54, b.y + b.h - 6, 7, 2, "#f2f7fd");
		R(b.x + 60, b.y + b.h - 18, 1, 16, "#8a5a3a"), R(b.x + 58, b.y + b.h - 4, 5, 3, "#9aa6b8");
		T = PLAIN;
	}

	/** The mail room: you at the counter, a letter box for each way in, the pipes that lead from them into the chute. */
	private hall(s: Now, now: number, night: number, glows: Glow[]): void {
		const x = this.inner.x;
		const w = this.inner.w;
		const y = this.hallTop;
		const floor = y + HALL_IN;
		const tint = this.roomTint(0.75, night);
		T = tint;
		// Gingerbread walls with icing piped on, green panels, a floor of stone in two colors.
		const wp = "#e9cfa6";
		R(x, y, w, HALL_IN, wp);
		for (let j = y + 8, n = 0; j < floor - 16; j += 8, n++) for (let i = x + 4 + (n % 2) * 6; i < x + w; i += 12) R(i, j, 3, 1, ICING), R(i + 1, j - 1, 1, 3, ICING);
		R(x, y, w, 2, tone(wp, -1));
		const panel = "#4f8f6e";
		R(x, floor - 14, w, 14, panel);
		R(x, floor - 15, w, 1, ICING);
		for (let i = x + 6; i < x + w; i += 9) R(i, floor - 12, 1, 10, tone(panel, -1));
		R(x, floor - 2, w, 2, tone(panel, -2));
		for (let i = x; i < x + w; i += 6) R(i, floor, 6, 2, ((i - x) / 6) % 2 ? "#e8e0d0" : "#b9b0a2");
		R(x, floor, w, 1, "#f6f0e2");
		candy(x, y, 2, HALL_IN, "#e5484d", "#ffffff", 2);

		// The way out, at the far end: a green door with a wreath, snow on the mat before it.
		const boxes = [...this.ports.values()].filter((p) => p.kind !== "clock" && p.kind !== "you");
		const used = 48 + Math.ceil(boxes.length / 2) * 16;
		// An order board on the wall for each board that is for all agents (two at most), left of the way out.
		this.placeNotices(s);
		for (const n of this.notices) {
			const b = s.boards.find((k) => k.id === n.id);
			if (b) this.drawTasks(n.box, undefined, b, s, now, tint, glows, `notice:${n.id}`);
		}
		T = tint;
		if (w - used > 26) {
			const dx = x + w - 21;
			block(dx, floor - 30, 15, 30, "#2f6f52", { r: 1 });
			R(dx + 2, floor - 27, 11, 11, tone("#2f6f52", -1));
			R(dx + 3, floor - 13, 9, 10, tone("#2f6f52", 1));
			for (let k = 0; k < 10; k++) {
				const a = (k * Math.PI) / 5;
				R(dx + 7 + Math.cos(a) * 3.4 - 0.5, floor - 22 + Math.sin(a) * 3.4 - 0.5, 2, 2, k % 2 ? "#3fa468" : "#5cc27e");
			}
			R(dx + 6, floor - 27, 3, 2, "#d8362f");
			R(dx + 12, floor - 14, 2, 2, GOLD);
			R(dx - 2, floor - 1, 19, 1, "#c0392b");
			R(dx + 1, floor - 2, 5, 1, "#ffffff"), R(dx + 9, floor - 2, 4, 1, "#ffffff");
			// A sack of letters beside it.
			if (w - used > 44) {
				const sx = dx - 13;
				disc(sx + 4, floor - 5, 5, INK);
				disc(sx + 4, floor - 5, 4, "#c9a877");
				R(sx, floor - 4, 9, 4, "#c9a877");
				R(sx + 2, floor - 11, 5, 2, "#a8845a");
				R(sx + 1, floor - 13, 3, 3, PAPER), R(sx + 5, floor - 14, 3, 4, PAPER), R(sx + 6, floor - 13, 1, 1, "#e5484d");
			}
		}
		// A lamp over the counter.
		const lx = this.you.x + 16;
		R(lx, y, 1, 5, INK);
		for (let j = 0; j < 3; j++) R(lx - 2 - j, y + 5 + j, 5 + j * 2, 1, j ? "#c0392b" : "#e06a5a");
		R(lx - 5, y + 8, 11, 1, FUR);
		T = PLAIN;
		R(lx - 1, y + 9, 3, 2, "#fff6c8");
		T = tint;
		glows.push({ x: lx, y: y + 12, r: 22, color: "#ffe2a0", a: 0.5 });

		// You: head and shoulders behind the counter in a bobble hat, a bell that rings when you are asked.
		const u = this.you;
		const asked = this.youMood?.kind === "asked";
		const glad = this.youMood?.kind === "glad";
		const bob = glad ? [0, 1, 2, 1][Math.floor(now / 120) % 4] : 0;
		stamp(glad ? YOU_GLAD : YOU, { o: INK, h: "#3d7dd8", w: FUR, s: "#f2c9a4", e: INK, m: "#c9605a", c: "#f2b134", j: "#2f8a58" }, u.x + 6, floor - 13 - 13 - bob);
		block(u.x, floor - 13, u.w - 6, 13, "#b98a62", { r: 0, ink: "#6a4632" });
		R(u.x, floor - 13, u.w - 6, 2, "#e8c69a");
		for (let i = u.x + 4; i < u.x + u.w - 8; i += 7) R(i, floor - 9, 1, 8, "#8a5f44");
		for (let i = u.x + 1; i < u.x + u.w - 8; i += 4) R(i, floor - 11, 3, 1, "#2f8a58"), i % 8 < 4 && R(i + 1, floor - 10, 1, 1, "#e5484d");
		// The letters on the counter: the top one is red while a question waits for you.
		R(u.x + 18, floor - 17, 9, 4, INK);
		R(u.x + 19, floor - 16, 7, 2, PAPER);
		T = PLAIN;
		R(u.x + 18, floor - 19, 9, 3, INK);
		R(u.x + 19, floor - 18, 7, 1, asked && Math.floor(now / 300) % 2 ? "#ff6a6a" : PAPER);
		R(u.x + 22, floor - 18, 1, 1, asked ? "#ffffff" : "#e5484d");
		T = tint;
		const ring = asked ? [-1, 0, 1, 0][Math.floor(now / 90) % 4] : 0;
		R(u.x + 2 + ring, floor - 16, 4, 2, GOLD);
		R(u.x + 3 + ring, floor - 17, 2, 1, GOLD);
		R(u.x + 1, floor - 14, 6, 1, "#d9a84a");
		if (asked) {
			T = PLAIN;
			const hop = Math.floor(now / 200) % 2;
			slab(u.x + 9, floor - 39 - hop, 7, 9, INK, 2);
			slab(u.x + 10, floor - 38 - hop, 5, 7, "#e5484d", 1);
			R(u.x + 12, floor - 37 - hop, 1, 3, "#ffffff");
			R(u.x + 12, floor - 33 - hop, 1, 1, "#ffffff");
			T = tint;
			glows.push({ x: u.x + 12, y: floor - 35, r: 12, color: "#ff5a5f", a: 0.8 });
		}

		// A letter box for each way in: red, snow on its top, its sign on the door; bright for a moment when something comes in.
		for (const p of this.ports.values()) {
			if (p.kind === "clock" || p.kind === "you") continue;
			const input = s.input.get(p.id);
			const hot = now - (this.hotAt.get(`port:${p.id}`) ?? -1e9) < 1600 || (input?.last !== undefined && now - input.last < 1600);
			const b = p.box;
			block(b.x, b.y, b.w, b.h, "#c0392b", { r: 1, ink: "#6a1f1a" });
			R(b.x, b.y - 1, b.w, 1, "#ffffff");
			R(b.x + 1, b.y - 2, b.w - 3, 1, "#ffffff");
			T = hot ? PLAIN : tint;
			R(b.x + 1, b.y + 1, b.w - 2, b.h - 2, hot ? "#fff6d8" : "#fff1dc");
			sign(sourceSign(p.type, p.kind), b.x + 2, b.y + 1, input?.failing ? "#e5484d" : hot ? tone(KIND_COLOR[p.kind], -1) : tone(KIND_COLOR[p.kind], -1));
			T = tint;
			if (hot) glows.push({ x: b.x + 6, y: b.y + 5, r: 12, color: KIND_COLOR[p.kind], a: 0.9 });
			if (input?.failing && Math.floor(now / 500) % 2) R(b.x + b.w - 3, b.y + 1, 2, 2, "#e5484d");
		}
		T = PLAIN;
	}
}

const untilText = (ms: number) => (ms < 5000 ? "now" : ms < 90_000 ? `in ${Math.round(ms / 1000)}s` : ms < 5_400_000 ? `in ${Math.round(ms / 60_000)}m` : ms < 129_600_000 ? `in ${Math.round(ms / 3_600_000)}h` : `in ${Math.round(ms / 86_400_000)}d`);

// ---- the view: the workshop in the panel, through its camera----------------------------------------------------------

const STYLE = `
.workshop-canvas { position: absolute; inset: 0; width: 100%; height: 100%; display: block; touch-action: none; cursor: grab; image-rendering: pixelated; }
.workshop-canvas.over { cursor: pointer; }
.workshop-bar { position: absolute; top: 8px; right: 8px; display: flex; gap: 6px; z-index: 2; }
.workshop-bar button { width: 30px; height: 30px; padding: 0; display: grid; place-items: center; border: 2px solid ${INK}; border-radius: 4px; background: ${PAPER}; box-shadow: 0 2px 0 ${INK}; cursor: pointer; }
.workshop-bar button:active, .workshop-bar button[aria-pressed="true"] { transform: translateY(2px); box-shadow: none; background: #ffe27a; }
.workshop-bar canvas { width: 18px; height: 18px; image-rendering: pixelated; }
.workshop-words { position: absolute; width: 1px; height: 1px; overflow: hidden; clip-path: inset(50%); }
`;

/** What the signs and the things in a room stand for: the key the ? shows. */
const KEY: Array<[Sign, string, string]> = [
	["shield", "safe: runs in a sandbox", "#3b8fd8"],
	["lock", "manual: asks before each step", "#3b8fd8"],
	["bolt", "auto: runs as you, no sandbox", "#d9822b"],
	["warn", "bypass: never asks", "#e5484d"],
	["plan", "plan: read-only", "#3b74e0"],
	["think", "thinking: pacing the bay", HUE.think],
	["read", "reading a file: at the shelf", HUE.read],
	["find", "searching", HUE.read],
	["term", "running a command: at the bench", HUE.tool],
	["write", "writing: at the bench, a parcel", HUE.write],
	["plug", "MCP server: a gumball, a bauble", HUE.mcp],
	["star", "skill: a starred book", HUE.skill],
	["wait", "waiting for others", HUE.wait],
	["ask", "needs your answer: see above", HUE.ask],
	["hand", "delegated task: a flying present", HUE.hand],
	["copy", "sub-agent: a small elf", HUE.hand],
	["mail", "event: a sweet in the chute", "#3b8fd8"],
	["clock", "schedule: bells, the tower", "#9b59c7"],
	["note", "task board: a card for each task", "#c98f55"],
	["tick", "cards: paper to do, green done", "#2fa868"],
	["ask", "amber card: a sub-agent asks", "#ffb21f"],
	["branch", "branches: forks on the board", "#8a6ad0"],
	["leaf", "worktree: a leaf on a fork", "#2fa868"],
	["flag", "goal: a little tree with a star", "#2fa868"],
	["send", "outgoing message: up to the sleigh", HUE.hand],
	["warn", "amber lantern: outside content", "#d9822b"],
];

const MODE_SIGN: Record<string, Sign> = { safe: "shield", manual: "lock", auto: "bolt", bypass: "warn", plan: "plan" };
const light = (c: string) => {
	const [r, gg, b] = rgb(c);
	return r * 0.299 + gg * 0.587 + b * 0.114 > 150;
};

/** Text broken into lines of at most `max` pixels. */
function wrap(text: string, max: number): string[] {
	const out: string[] = [];
	let lineNow = "";
	for (const word of text.split(" ")) {
		const next = lineNow ? `${lineNow} ${word}` : word;
		if (widthOf(next) > max && lineNow) out.push(lineNow), (lineNow = word);
		else lineNow = next;
	}
	if (lineNow) out.push(lineNow);
	return out.slice(0, 6);
}

/** Text with a dark edge all round: readable on anything. */
function outlined(text: string, x: number, y: number, c: string): void {
	for (const [dx, dy] of [[-1, 0], [1, 0], [0, -1], [0, 1], [-1, -1], [1, 1], [-1, 1], [1, -1]]) write(text, x + dx, y + dy, INK);
	write(text, x, y, c);
}

export default defineView((host: ViewHost) => {
	const root = host.root;
	const style = document.createElement("style");
	style.textContent = STYLE;
	const canvas = document.createElement("canvas");
	canvas.className = "workshop-canvas";
	canvas.setAttribute("aria-label", "Santa's workshop, with a bay for each agent and an elf at work in each");
	const bar = document.createElement("div");
	bar.className = "workshop-bar";
	const button = (title: string, paint: () => void) => {
		const b = document.createElement("button");
		b.title = title;
		b.setAttribute("aria-label", title.split(":")[0]);
		const c = paper(9, 9);
		g = penOf(c);
		T = PLAIN;
		paint();
		b.append(c);
		return b;
	};
	const followButton = button("Follow activity: the camera moves to where agents are working. Scroll, drag or pinch to look around yourself", () => sign("eye", 0, 0, INK));
	const allButton = button("Show everything", () => {
		for (const [x, y] of [[0, 0], [6, 0], [0, 6], [6, 6]]) R(x, y, 3, 3, INK);
		R(1, 1, 7, 7, PAPER);
		R(3, 3, 3, 3, INK);
	});
	const keyButton = button("Legend: what the sweets and the things in a bay mean", () => write("?", 2, 1, INK));
	bar.append(followButton, allButton, keyButton);
	// What the drawing shows, in words: for a screen reader, and for whoever cannot tell the pixels apart.
	const words = document.createElement("ul");
	words.className = "workshop-words";
	words.dataset.slot = "workshop-words";
	root.append(style, canvas, bar, words);

	const shop = new Workshop();
	const scene = paper(8, 8);
	let sctx = penOf(scene);
	const ctx = canvas.getContext("2d")!;
	let size = { w: root.clientWidth, h: root.clientHeight };
	let follow = true;
	let showKey = false;
	let hover: Hit;
	let pointer: Pt | undefined;
	let drag: { x: number; y: number; moved: boolean } | undefined;
	let dragged = false;
	let snapAt = 0;
	const setFollow = (on: boolean) => {
		follow = on;
		followButton.setAttribute("aria-pressed", String(on));
	};
	setFollow(true);
	const ro = new ResizeObserver(() => (size = { w: root.clientWidth, h: root.clientHeight }));
	ro.observe(root);

	const toShop = (e: MouseEvent) => {
		const r = canvas.getBoundingClientRect();
		const { x, y, z } = shop.cam;
		return { x: (e.clientX - r.left - size.w / 2) / z + x, y: (e.clientY - r.top - size.h / 2) / z + y };
	};
	const targetOf = (h: Hit) => (h?.k === "agent" ? { agent: h.id } : h?.k === "work" ? { work: h.id } : undefined);

	canvas.addEventListener("pointerdown", (e) => {
		drag = { x: e.clientX, y: e.clientY, moved: false };
		canvas.setPointerCapture(e.pointerId);
	});
	canvas.addEventListener("pointermove", (e) => {
		const r = canvas.getBoundingClientRect();
		pointer = { x: e.clientX - r.left, y: e.clientY - r.top };
		if (drag && (drag.moved || Math.hypot(e.clientX - drag.x, e.clientY - drag.y) > 3)) {
			const cam = shop.cam;
			shop.cam = { ...cam, x: cam.x - (e.clientX - drag.x) / cam.z, y: cam.y - (e.clientY - drag.y) / cam.z };
			drag = { x: e.clientX, y: e.clientY, moved: true };
			hover = undefined;
			setFollow(false);
			return;
		}
		hover = shop.hit(toShop(e));
		canvas.classList.toggle("over", Boolean(hover));
	});
	canvas.addEventListener("pointerup", () => {
		dragged = Boolean(drag?.moved);
		drag = undefined;
	});
	canvas.addEventListener("pointerleave", () => ((hover = undefined), (pointer = undefined)));
	canvas.addEventListener("click", (e) => {
		if (dragged) return;
		const h = shop.hit(toShop(e));
		if (h?.k !== "port") host.select(targetOf(h));
	});
	canvas.addEventListener("dblclick", (e) => {
		const t = targetOf(shop.hit(toShop(e)));
		if (t) host.open(t);
		else setFollow(true);
	});
	canvas.addEventListener(
		"wheel",
		(e) => {
			e.preventDefault();
			const cam = shop.cam;
			if (e.ctrlKey || e.metaKey) {
				const r = canvas.getBoundingClientRect();
				const px = e.clientX - r.left - size.w / 2;
				const py = e.clientY - r.top - size.h / 2;
				const z = Math.max(0.2, Math.min(Z_MAX * 1.5, cam.z * Math.exp(-e.deltaY * 0.01)));
				shop.cam = { x: cam.x + px / cam.z - px / z, y: cam.y + py / cam.z - py / z, z };
				// When the fingers rest, the zoom settles on whole pixels.
				snapAt = Date.now() + 260;
			} else shop.cam = { ...cam, x: cam.x + e.deltaX / cam.z, y: cam.y + e.deltaY / cam.z };
			setFollow(false);
		},
		{ passive: false },
	);
	followButton.addEventListener("click", () => setFollow(!follow));
	allButton.addEventListener("click", () => {
		setFollow(false);
		shop.cam = shop.framed(shop.whole(), size);
	});
	keyButton.addEventListener("click", () => {
		showKey = !showKey;
		keyButton.setAttribute("aria-pressed", String(showKey));
	});

	// The words follow the state, not every frame.
	const say = (s: Now) => {
		words.replaceChildren(
			...s.agents.map((a) => {
				const li = document.createElement("li");
				li.dataset.agent = a.id;
				const mine = s.running.filter((w) => w.agent === a.id);
				const has = [a.mcp.length ? `MCP servers: ${a.mcp.join(", ")}` : "", a.skills.length ? `skills: ${a.skills.join(", ")}` : "", a.schedules.length ? `schedules: ${a.schedules.join(", ")}` : "", a.conversations?.length > 1 ? `${a.conversations.length} conversations, ${a.conversations.filter((c) => c.branchOf !== undefined).length} of them branches` : "", ...s.boards.filter((b) => b.agent === a.id && b.open + b.taken + b.blocked > 0).map((b) => `a board with ${b.done} of ${b.open + b.taken + b.done + b.failed + b.blocked} tasks done${b.blocked ? `, ${b.blocked} waiting for your answer` : ""}`)].filter(Boolean).join("; ");
				li.textContent = `${a.id}, ${a.mode} mode${a.main ? ", the main agent, Santa, under the roof" : ""}: ${mine.length ? `${mine.length} task${mine.length === 1 ? "" : "s"} running` : "idle"}${has ? `. ${has}` : ""}`;
				const ul = document.createElement("ul");
				for (const w of mine) {
					const item = document.createElement("li");
					item.dataset.work = String(w.id);
					item.textContent = `${w.copy ? "sub-agent, " : ""}from ${w.from.k === "agent" ? w.from.id : w.from.k === "source" ? w.from.name : w.from.k}, ${doingOf(w)}${w.steps ? `, step ${w.steps.done} of ${w.steps.total}` : ""}${w.branch ? ", in a branch" : ""}${w.worktree ? ", in a worktree" : ""}${w.held && w.mode ? `, limited to ${w.mode} mode` : ""}${w.outside ? ", read outside content" : ""}`;
					ul.append(item);
				}
				li.append(ul);
				return li;
			}),
		);
	};
	say(nowOf(host.state()));
	const stopWords = host.on("state", (s) => say(nowOf(s)));
	const stopHearing = host.on("happening", (h) => shop.hear(h, nowOf(host.state()), Date.now()));

	/** What the pointer is over, in a few lines. */
	const tipOf = (s: Now, now: number): string[] => {
		if (!hover) return [];
		if (hover.k === "work") {
			const w = s.work.get(hover.id);
			if (!w) return [];
			const more = [w.from.k === "agent" ? `for ${w.from.id}` : w.from.k === "source" ? `triggered by ${w.from.name}` : w.from.k === "clock" ? `triggered by ${w.from.name ?? "a schedule"}` : w.from.k === "you" ? "for you" : "", w.steps ? `step ${w.steps.done} of ${w.steps.total}` : "", w.round ? `goal, round ${w.round}` : "", w.branch ? "in a branch" : "", w.worktree ? "in a worktree" : "", w.held && w.mode ? `limited to ${w.mode} mode` : "", w.outside ? "read outside content" : "", `${Math.max(0, Math.round((now - w.started) / 1000))}s`, w.tools ? `${w.tools} tool call${w.tools === 1 ? "" : "s"}` : ""].filter(Boolean);
			return [`${w.agent}${w.copy ? " (sub-agent)" : ""}: ${doingOf(w)}`, ...wrap(more.join(" · "), 190)];
		}
		if (hover.k === "port") {
			const p = s.input.get(hover.id);
			if (!p) return [];
			if (p.kind === "you") return ["you: your messages go up the chute,", "and the answers come back down"];
			if (p.kind === "clock") {
				const next = s.schedules.filter((x) => x.next !== undefined).slice(0, 3);
				return [`${s.schedules.length} schedule${s.schedules.length === 1 ? "" : "s"}`, ...next.map((x) => `${x.name}${x.agent ? ` triggers ${x.agent}` : ""} ${untilText(x.next! - now)}`)];
			}
			return [`${p.name}${p.type ? ` (${p.type})` : ""}: ${p.count} event${p.count === 1 ? "" : "s"}${p.failing ? " · not running" : ""}`, ...(p.agents?.length ? wrap(`triggers ${p.agents.join(", ")}`, 190) : [])];
		}
		const a = s.agent.get(hover.id);
		if (!a) return [];
		const list = (title: string, names: string[], none: string) => (names.length ? wrap(`${title}: ${names.join(", ")}`, 190) : [none]);
		if (hover.part === "rack") return list("MCP servers", a.mcp, "no MCP servers yet");
		if (hover.part === "shelf") return list("skills", a.skills, "no skills yet");
		if (hover.part === "clocks") return list("schedules", a.schedules.map((n) => {
			const sc = s.schedules.find((x) => x.name === n && x.agent === a.id);
			return sc?.next !== undefined ? `${n} (${untilText(sc.next - now)})` : n;
		}), "no schedules yet");
		if (hover.part === "tasks") {
			const b = shop.boardOf(s, a.id, now);
			if (!b) return [];
			const all = b.open + b.taken + b.done + b.failed + b.blocked;
			const waits = tasksOf(b).filter((t) => t.state === "waiting").length;
			return [
				`${b.name ? `board ${b.name}` : "task board"}: ${b.done} of ${all} done`,
				...[b.taken ? `${b.taken} in progress` : "", b.open ? `${b.open} to do${waits ? ` (${waits} after other tasks)` : ""}` : "", b.blocked ? `${b.blocked} waiting for an answer` : "", b.failed ? `${b.failed} failed` : ""].filter(Boolean),
			];
		}
		if (hover.part === "board") {
			const c = a.conversations ?? [];
			const br = c.filter((x) => x.branchOf !== undefined).length;
			const wt = c.filter((x) => x.worktree).length;
			const goal = c.filter((x) => x.goal === "active").length;
			return wrap(`${c.length} conversation${c.length === 1 ? "" : "s"}${br ? `, ${br} branch${br === 1 ? "" : "es"}` : ""}${wt ? `, ${wt} in a worktree` : ""}${goal ? `, ${goal} with a goal` : ""}`, 190);
		}
		const mine = s.running.filter((x) => x.agent === a.id).length;
		return [`${a.id} · ${a.mode} mode${a.main ? " · the main agent, Santa" : ""}`, mine ? `${mine} task${mine === 1 ? "" : "s"} running` : "idle", ...(a.sources.length ? wrap(`listens to ${a.sources.join(", ")}`, 190) : [])];
	};

	let id = 0;
	// The time between frames, as the workshop says (`pace`); short for a moment after the pointer moved.
	let wait = 33;
	let touched = 0;
	canvas.addEventListener("pointermove", () => (touched = Date.now()));
	canvas.addEventListener("wheel", () => (touched = Date.now()));
	// One frame, then sleep until the next is due: the page is not woken up at the screen's rate for nothing.
	let timer = 0;
	const tick = (t: number) => {
		try {
			draw();
		} finally {
			timer = window.setTimeout(() => (id = requestAnimationFrame(tick)), Math.max(0, wait - (performance.now() - t)));
		}
	};
	const draw = () => {
		if (!size.w || !size.h) return;
		const now = Date.now();
		const state = host.state();
		const s = nowOf(state);
		const sel = state.selected;
		const focus: Hit = sel ? ("agent" in sel ? { k: "agent", id: sel.agent } : "work" in sel ? { k: "work", id: sel.work } : undefined) : undefined;
		const dpr = window.devicePixelRatio || 1;
		// On a screen with two pixels to a point, half a step is still a whole pixel.
		shop.zoomStep = dpr >= 2 ? 0.5 : 1;
		shop.layout(s, size);
		shop.sync(s, now);
		shop.step(s, now, size, { focus, follow });
		if (!follow && snapAt && now > snapAt) {
			const st = shop.zoomStep;
			const z = shop.cam.z >= st ? Math.round(shop.cam.z / st) * st : st / Math.round(st / shop.cam.z);
			shop.cam = ease(shop.cam, { ...shop.cam, z }, 50);
			if (shop.cam.z === z) snapAt = 0;
		}
		wait = now - touched < 1000 || snapAt ? 33 : shop.pace(s);
		if (canvas.width !== Math.round(size.w * dpr) || canvas.height !== Math.round(size.h * dpr)) {
			canvas.width = Math.round(size.w * dpr);
			canvas.height = Math.round(size.h * dpr);
		}
		const { x, y, z } = shop.cam;
		const left = x - size.w / z / 2;
		const top = y - size.h / z / 2;
		const ox = Math.floor(left);
		const oy = Math.floor(top);
		const vw = Math.ceil(size.w / z) + 2;
		const vh = Math.ceil(size.h / z) + 2;
		if (scene.width !== vw || scene.height !== vh) {
			scene.width = vw;
			scene.height = vh;
			sctx = penOf(scene);
		}
		shop.draw(sctx, s, now, { ox, oy, w: vw, h: vh, cx: x }, { selected: focus, hover });
		ctx.setTransform(1, 0, 0, 1, 0, 0);
		ctx.imageSmoothingEnabled = false;
		ctx.drawImage(scene, 0, 0, vw, vh, Math.round(-(left - ox) * z * dpr), Math.round(-(top - oy) * z * dpr), Math.round(vw * z * dpr), Math.round(vh * z * dpr));

		// What is written: in the same letters at a size that reads, whatever the camera does.
		const U = z >= 2.5 && size.w > 420 ? 3 : 2;
		ctx.setTransform(U * dpr, 0, 0, U * dpr, 0, 0);
		g = ctx;
		T = PLAIN;
		const W = size.w / U;
		const H = size.h / U;
		const ux = (wx: number) => Math.round(((wx - left) * z) / U);
		const uy = (wy: number) => Math.round(((wy - top) * z) / U);
		const back = s.dark ? "#2b2140" : PAPER;
		const fore = s.dark ? PAPER : INK;
		// Words in the bubbles from one and a half times on: below that a room is too small for them.
		const close = z >= 1.5;
		const placed: Box[] = [];
		const plates: Box[] = [];
		const tags = shop.tags(s, now);
		for (const tag of tags) {
			if (tag.k !== "plate") continue;
			const px = ux(tag.x);
			const py = uy(tag.y) - 3;
			const roomW = (ROOM_W * z) / U;
			if (px > W || py > H || px + roomW < 0 || py < -14) continue;
			const color = s.agent.get(tag.agent)?.color ?? "#8899aa";
			const ink = light(color) ? INK : "#ffffff";
			const modeSign = MODE_SIGN[tag.mode];
			const name = fit(tag.agent, Math.max(24, roomW - 44));
			const tw = widthOf(name) + (modeSign ? 13 : 3) + 4 + (tag.outside ? 11 : 0) + (tag.busy ? 6 : 0);
			slab(px - 1, py - 1, tw + 2, 15, INK, 3);
			slab(px, py, tw, 13, color, 2);
			R(px + 2, py, tw - 4, 1, tone(color, 1));
			R(px + 2, py + 12, tw - 4, 1, tone(color, -1));
			let cx = px + 3;
			if (modeSign) sign(modeSign, cx, py + 2, ink), (cx += 11);
			write(name, cx, py + 3, ink);
			cx += widthOf(name) + 2;
			if (tag.outside) sign("warn", cx, py + 2, light(color) ? "#b3600a" : "#ffd27a"), (cx += 11);
			if (tag.busy) R(cx + 1, py + 5, 3, 3, Math.floor(now / 350) % 2 ? "#ffffff" : tone(color, 2)), R(cx + 1, py + 5, 3, 3, Math.floor(now / 350) % 2 ? "#ffffff" : ink);
			plates.push({ x: px - 1, y: py - 1, w: tw + 2, h: 15 });
		}
		for (const tag of tags) {
			if (tag.k !== "label" || !tag.text) continue;
			if (!close && !tag.sign && tag.text !== "you" && !tag.hot) continue;
			const text = fit(tag.text, tag.sign ? 120 : tag.hot ? 60 : Math.max(20, (40 * z) / U - 2));
			const tw = widthOf(text) + (tag.sign ? 11 : 0) + 4;
			// A name is written where its thing is: one that is out of the picture is not pushed back into it.
			if (ux(tag.x) < 4 || ux(tag.x) > W - 4) continue;
			const px = clamp(ux(tag.x) - Math.round(tw / 2), 1, W - tw - 1);
			let py = uy(tag.y) + 1;
			if (py > H || py < -12) continue;
			// Not under the buttons at the top right.
			if (px + tw > W - 110 / U && py < 42 / U) py = Math.round(42 / U);
			slab(px - 1, py - 1, tw + 2, 12, INK, 2);
			slab(px, py, tw, 10, tag.hot ? "#ffe27a" : tag.bad ? "#ffd0d0" : back, 1);
			if (tag.sign) sign(tag.sign, px + 1, py, tag.hot ? INK : "#9b59c7");
			write(text, px + 2 + (tag.sign ? 10 : 0), py + 1, tag.hot ? INK : tag.bad ? "#a8262b" : fore);
		}
		// Bubbles: what each elf does. From afar a sign alone; close enough to read, in words too.
		const bubbles = tags.filter((t): t is Extract<Tag, { k: "say" }> => t.k === "say").sort((a, b) => Number(b.small) - Number(a.small));
		for (const tag of bubbles) {
			const hx = ux(tag.x);
			const hy = uy(tag.y);
			if (hx < -40 || hx > W + 40 || hy < -10 || hy > H + 40) continue;
			const sayNow = tag.say;
			const full = close && !tag.small;
			const text = full ? sayNow.text : "";
			const note = full && z >= 2 ? sayNow.note : undefined;
			const steps = full ? sayNow.steps : undefined;
			const tw = Math.max(text ? widthOf(text) : 0, note ? widthOf(note) : 0, steps ? Math.min(steps.total, 10) * 4 - 1 : 0);
			const bw = 13 + (tw ? tw + 5 : 0);
			const bh = 13 + (note ? 9 : 0) + (steps ? 5 : 0);
			const bounce = sayNow.loud ? [0, -1, -2, -1][Math.floor(now / 110) % 4] : 0;
			let bx = clamp(hx - Math.round(bw / 2), 1, Math.max(1, W - bw - 1));
			let by = hy - bh - 6 + bounce;
			// A bubble keeps clear of a door plate by moving aside, as far as its tail still reaches the elf:
			// moved up, it would hang in the room above.
			for (const p of plates) {
				if (!(bx < p.x + p.w && bx + bw > p.x && by < p.y + p.h && by + bh > p.y)) continue;
				const right = p.x + p.w + 1;
				if (hx >= right - 4 && right + bw < W) bx = right;
				else if (hx <= p.x + 4 && p.x - bw - 1 > 0) bx = p.x - bw - 1;
			}
			for (let tries = 0; tries < 4 && placed.some((p) => bx < p.x + p.w && bx + bw > p.x && by < p.y + p.h && by + bh > p.y); tries++) by -= 8;
			by = Math.max(1, by);
			placed.push({ x: bx - 1, y: by - 1, w: bw + 2, h: bh + 2 });
			const fill = sayNow.loud ? sayNow.color : PAPER;
			const textC = sayNow.loud ? "#ffffff" : INK;
			slab(bx - 1, by - 1, bw + 2, bh + 2, INK, 4);
			slab(bx, by, bw, bh, fill, 3);
			if (!sayNow.loud) R(bx + 3, by + bh - 1, bw - 6, 1, tone(sayNow.color, 2));
			// The tail, down to the elf.
			const tx = clamp(hx, bx + 5, bx + bw - 6);
			R(tx - 3, by + bh, 7, 1, INK);
			R(tx - 2, by + bh, 5, 1, fill);
			R(tx - 2, by + bh + 1, 5, 1, INK);
			R(tx - 1, by + bh + 1, 3, 1, fill);
			R(tx - 1, by + bh + 2, 3, 1, INK);
			R(tx, by + bh + 2, 1, 1, fill);
			R(tx, by + bh + 3, 1, 1, INK);
			sign(sayNow.sign, bx + 2, by + 2, sayNow.loud ? "#ffffff" : sayNow.color);
			if (text) write(text, bx + 14, by + 3, textC);
			if (note) write(note, bx + 14, by + 12, sayNow.loud ? "#ffd9d9" : "#8a8499");
			if (steps) {
				const sy2 = by + bh - 5;
				if (steps.total <= 10) for (let i = 0; i < steps.total; i++) R(bx + 14 + i * 4, sy2, 3, 2, i < steps.done ? "#3fbf6f" : "#d8d2c4");
				else {
					R(bx + 14, sy2, tw, 2, "#d8d2c4");
					R(bx + 14, sy2, Math.round((tw * steps.done) / steps.total), 2, "#3fbf6f");
				}
			}
		}
		for (const tag of tags) {
			if (tag.k !== "float") continue;
			const text = fit(tag.text, 130);
			const tw = widthOf(text) + (tag.sign ? 11 : 0);
			const px = clamp(ux(tag.x) - Math.round(tw / 2), 2, W - tw - 2);
			const py = uy(tag.y) - 10 - Math.round(tag.age * 16);
			g.globalAlpha = tag.age > 0.85 ? 0.35 : tag.age > 0.7 ? 0.7 : 1;
			if (tag.sign) {
				for (const [dx, dy] of [[-1, 0], [1, 0], [0, -1], [0, 1]]) sign(tag.sign, px + dx, py - 1 + dy, INK);
				sign(tag.sign, px, py - 1, tag.color);
			}
			outlined(text, px + (tag.sign ? 11 : 0), py, "#ffffff");
			g.globalAlpha = 1;
		}

		// On top: the hour and how much goes on; the key; what the pointer is over.
		const time = clock();
		const asks = s.running.filter((j) => j.asking).length;
		const atWork = new Set(s.running.map((j) => j.agent)).size;
		const hud = `${String(time.getHours()).padStart(2, "0")}:${String(time.getMinutes()).padStart(2, "0")}  ${atWork ? `${atWork} working` : "all idle"}`;
		const hw = widthOf(hud) + 8;
		slab(3, 3, hw + 2, 13, INK, 3);
		slab(4, 4, hw, 11, back, 2);
		write(hud, 8, 6, fore);
		if (asks) {
			const at = `${asks} waiting for you`;
			const aw = widthOf(at) + 18;
			const hop = Math.floor(now / 300) % 2;
			slab(hw + 8, 3 - hop, aw + 2, 13, INK, 3);
			slab(hw + 9, 4 - hop, aw, 11, HUE.ask, 2);
			sign("ask", hw + 11, 5 - hop, "#ffffff");
			write(at, hw + 22, 6 - hop, "#ffffff");
		}
		if (showKey) {
			const rows = KEY.length;
			const kw = 196;
			const kx = Math.max(2, W - kw - 4);
			const ky = Math.round(44 / U) + 2;
			slab(kx - 1, ky - 1, kw + 2, rows * 11 + 8, INK, 4);
			slab(kx, ky, kw, rows * 11 + 6, back, 3);
			KEY.forEach(([sg, text, c], i) => {
				sign(sg, kx + 4, ky + 4 + i * 11, c);
				write(text, kx + 17, ky + 5 + i * 11, fore);
			});
		}
		const tip = pointer && !drag ? tipOf(s, now) : [];
		if (tip.length && pointer) {
			const tw = Math.max(...tip.map(widthOf)) + 8;
			const th = tip.length * 10 + 5;
			const px = clamp(Math.round(pointer.x / U) - Math.round(tw / 2), 2, Math.max(2, W - tw - 2));
			const py = Math.round(pointer.y / U) - th - 8 < 2 ? Math.round(pointer.y / U) + 12 : Math.round(pointer.y / U) - th - 8;
			slab(px - 1, py - 1, tw + 2, th + 2, PAPER, 3);
			slab(px, py, tw, th, INK, 2);
			tip.forEach((lineText, i) => write(lineText, px + 4, py + 3 + i * 10, i ? "#cfc8dc" : "#ffffff"));
		}
	};
	id = requestAnimationFrame(tick);
	return () => {
		cancelAnimationFrame(id);
		window.clearTimeout(timer);
		ro.disconnect();
		stopWords();
		stopHearing();
		root.replaceChildren();
	};
});
