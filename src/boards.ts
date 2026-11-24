// Boards: a shared place for tasks and notes.
//
// Several runs work on one job (a conversation and its sub-agents, an agent and the agents it hands
// work to) and need to know who does what and what the others found. A board holds that: tasks,
// each taken by one run at a time, and notes. It is rows in pine's database and nothing else; the
// tools in src/tools.ts and the control API read and write it through this class.
//
// What keeps it safe is said where it is done:
//   - A task is taken in one synchronous step, so two runs never both get it.
//   - A task is held by a run of pine's (a task of the task list), and the daemon gives it back
//     when that run ends: nothing is left taken because an agent forgot to say it was done.
//   - A post carries the trust and the outside-content mark of the run that wrote it. The tools
//     mark whoever reads it (src/tools.ts), so a board is no way around that mark.
import type { DatabaseSync } from "node:sqlite";

export const BOARD_SCHEMA = `
CREATE TABLE IF NOT EXISTS boards (
  id INTEGER PRIMARY KEY AUTOINCREMENT, scope TEXT NOT NULL, agent TEXT NOT NULL DEFAULT '', session TEXT NOT NULL DEFAULT '',
  name TEXT NOT NULL DEFAULT '', created INTEGER NOT NULL, UNIQUE(scope, agent, session, name)
);
CREATE TABLE IF NOT EXISTS board_items (
  id INTEGER PRIMARY KEY AUTOINCREMENT, board INTEGER NOT NULL, kind TEXT NOT NULL, text TEXT NOT NULL, data TEXT,
  state TEXT NOT NULL DEFAULT '', by TEXT NOT NULL, trust TEXT NOT NULL DEFAULT 'owner', tainted TEXT,
  holder TEXT, run INTEGER, result TEXT, after TEXT, about INTEGER, created INTEGER NOT NULL, updated INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS board_items_board ON board_items(board, id);
CREATE INDEX IF NOT EXISTS board_items_run ON board_items(run);
`;

/** Whom a board is for, in the words the other setup tools use: one conversation, an agent, all agents. */
export type BoardScope = "local" | "agent" | "global";
export type BoardState = "open" | "taken" | "done" | "failed" | "blocked";
export const SETTLED: BoardState[] = ["done", "failed", "blocked"];

export interface Board {
	id: number;
	scope: BoardScope;
	/** The agent it belongs to ("" for a board for all agents). */
	agent: string;
	/** The conversation it belongs to ("" unless `scope` is local). */
	session: string;
	/** "" is a conversation's own board, which needs no name. */
	name: string;
	created: number;
}

export interface BoardItem {
	id: number;
	board: number;
	kind: "task" | "note";
	text: string;
	/** Fields of a note or a task that others read without picking them out of its text. */
	data?: Record<string, unknown>;
	/** A task's state; "" for a note. */
	state: BoardState | "";
	/** Who posted it: an agent's id, or "owner". */
	by: string;
	trust: "owner" | "untrusted";
	/** Why the run that posted it counted as having read outside content, if it did. */
	tainted?: string;
	/** Who has the task: an agent's id. */
	holder?: string;
	/** The run (a task of pine's task list) that holds it. The claim ends with that run. */
	run?: number;
	/** What became of the task: its result, why it failed, or the question it waits on. */
	result?: string;
	/** Tasks that have to be done before this one can be taken. */
	after: number[];
	/** For a note: the task it is about. */
	about?: number;
	created: number;
	updated: number;
}

export interface Counts {
	open: number;
	taken: number;
	done: number;
	failed: number;
	blocked: number;
	notes: number;
}

/** The conversation a run belongs to, and the agent it runs as (a task handed on runs as another agent on the first one's board). */
export interface Who {
	agent: string;
	conversation: { agent: string; session: string };
}

/** How long a task's text, a note and a result may be, and how much a board holds. More is cut or refused. */
export const TASK_CHARS = 4000;
/** A task that holds a report to be checked in full (the check of the whole that pine posts in a swarm): cut short, the check would miss what was left out and call it missing. */
export const LONG_TASK_CHARS = 16_000;
export const NOTE_CHARS = 2000;
/** The note a conversation gives a job's sub-agents: all of them go by it, so it is kept and shown whole, up to this. */
export const JOB_NOTE_CHARS = 8000;
export const RESULT_CHARS = 4000;
export const DATA_CHARS = 2000;
export const MAX_ITEMS = 500;
export const MAX_BOARDS = 200;

const cut = (s: string, n: number) => (s.length > n ? `${s.slice(0, n)}…` : s);
/** A result that is longer than a board holds says so where it ends: a bare "…" reads like the end of what the sub-agent wrote, or like a fault of whoever shows it. */
const cutResult = (s: string) => (s.length > RESULT_CHARS ? `${s.slice(0, RESULT_CHARS)}\n[pine: cut here. This answer was ${s.length} characters, and a result on a board holds ${RESULT_CHARS}: the rest is not kept. Where all of it is needed, have it written to a file.]` : s);
const parse = (s: unknown) => {
	try {
		return typeof s === "string" && s.length ? JSON.parse(s) : undefined;
	} catch {
		return undefined;
	}
};

/**
 * Whether an answer ends by asking something: its last line is a question. Emphasis, quotes and
 * brackets around it do not count; an answer that ends in a code block is no question.
 */
export function asksAtEnd(answer: string): boolean {
	const text = answer.trim();
	if (!text || text.endsWith("```")) return false;
	const last = text.split("\n").at(-1)!.replace(/[\s*_"'\u201d\u2019)\]]+$/u, "");
	return /[?\uff1f]$/u.test(last);
}

/**
 * What a check says of the work it checked: PASS or FAIL, as a line of its own (whatever emphasis is around it,
 * also after "Verdict:"). It is asked for as the last line, where a model that reasons first puts its conclusion;
 * the last such line counts, then a first or last line that begins with the word. A line that says how one rule
 * of several went ("2. Word count: PASS") is no verdict. Neither: the check is a report, and nothing follows from it.
 */
export function verdictOf(answer: string | undefined): "pass" | "fail" | undefined {
	const lines = String(answer ?? "").split("\n").map((l) => l.trim()).filter(Boolean);
	const word = (m: RegExpExecArray | null) => (m ? (m[1].toLowerCase().startsWith("pass") ? "pass" : "fail") : undefined);
	const alone = (l: string) => word(/^[^a-z0-9]*(?:(?:final\s+)?(?:verdict|result|outcome|status)\s*[:=-]\s*)?[^a-z0-9]*(pass|fail)(?:ed|es|s)?[^a-z0-9]*$/i.exec(l));
	const starts = (l: string | undefined) => word(/^[^a-z0-9]*(?:(?:final\s+)?(?:verdict|result|outcome|status)\s*[:=-]\s*)?[^a-z0-9]*(pass|fail)(?:ed|es|s)?\b/i.exec(l ?? ""));
	for (let i = lines.length - 1; i >= 0; i--) {
		const v = alone(lines[i]);
		if (v) return v;
	}
	return starts(lines.at(-1)) ?? starts(lines[0]);
}

/**
 * How often a task is given out again because the check of its result failed. After that the check's report
 * stands, for whoever gave out the work. Once: whoever does it again is shown what the check found, which settles
 * a slip. What fails a second time is mostly a rule that can be read two ways, and a third and fourth sub-agent
 * for every piece does not settle that.
 */
export const MAX_REWORK = 1;
/** How many checks of the whole may fail one after the other on a board before no further one is made: a check that never passes is not asked a fourth time. */
export const MAX_FAILED_FINALS = 3;

/** A board's name as it is kept: lowercase letters, digits, - and _. */
export function boardName(wanted: unknown): string {
	const name = String(wanted ?? "").trim().toLowerCase().replace(/^#/, "").replace(/[\s./]+/g, "-").replace(/[^a-z0-9_-]+/g, "").slice(0, 40);
	if (!name) throw new Error('a board\'s name is a word or two: lowercase letters, digits, "-" and "_"');
	return name;
}

export class Boards {
	private db: DatabaseSync;
	/** Told after every change, with the board and what happened: the daemon publishes it. */
	onChange?: (board: Board, what: "posted" | "taken" | "released" | "settled" | "removed", item?: BoardItem, cause?: unknown) => void;

	constructor(db: DatabaseSync) {
		this.db = db;
		db.exec(BOARD_SCHEMA);
	}

	// ---- boards -------------------------------------------------------------------------------------

	get(id: number): Board | undefined {
		const row = this.db.prepare("SELECT * FROM boards WHERE id = ?").get(id);
		return row ? this.boardOf(row) : undefined;
	}

	find(scope: BoardScope, agent: string, session: string, name: string): Board | undefined {
		const row = this.db.prepare("SELECT * FROM boards WHERE scope = ? AND agent = ? AND session = ? AND name = ?").get(scope, scope === "global" ? "" : agent, scope === "local" ? session : "", name);
		return row ? this.boardOf(row) : undefined;
	}

	/** The board of that place and name, made if there is none. */
	ensure(scope: BoardScope, agent: string, session: string, name: string): Board {
		const found = this.find(scope, agent, session, name);
		if (found) return found;
		if ((this.db.prepare("SELECT COUNT(*) AS n FROM boards").get() as any).n >= MAX_BOARDS) throw new Error(`there are ${MAX_BOARDS} boards already. Remove one whose work is finished (board_remove), or ask your owner to`);
		const r = this.db.prepare("INSERT INTO boards (scope, agent, session, name, created) VALUES (?, ?, ?, ?, ?)").run(scope, scope === "global" ? "" : agent, scope === "local" ? session : "", name, Date.now());
		return this.get(Number(r.lastInsertRowid))!;
	}

	list(): Board[] {
		return this.db.prepare("SELECT * FROM boards ORDER BY id").all().map((r) => this.boardOf(r));
	}

	/** Whether a run may read and write a board: its conversation's, its agent's, or one for all agents. */
	may(board: Board, who: Who): boolean {
		if (board.scope === "global") return true;
		if (board.scope === "agent") return board.agent === who.agent;
		return board.agent === who.conversation.agent && board.session === who.conversation.session;
	}

	/** The boards a run can use. */
	visible(who: Who): Board[] {
		return this.list().filter((b) => this.may(b, who));
	}

	/**
	 * The board a run means by a name: its conversation's own without one; with one, the nearest
	 * board of that name (the conversation's, then the agent's, then one for all agents).
	 */
	resolve(who: Who, name: string): Board | undefined {
		if (!name) return this.find("local", who.conversation.agent, who.conversation.session, "");
		return this.find("local", who.conversation.agent, who.conversation.session, name) ?? this.find("agent", who.agent, "", name) ?? this.find("global", "", "", name);
	}

	counts(board: number): Counts {
		const c: Counts = { open: 0, taken: 0, done: 0, failed: 0, blocked: 0, notes: 0 };
		for (const r of this.db.prepare("SELECT kind, state, COUNT(*) AS n FROM board_items WHERE board = ? GROUP BY kind, state").all(board) as any[]) {
			if (r.kind === "note") c.notes += r.n;
			else if (r.state in c) (c as any)[r.state] += r.n;
		}
		return c;
	}

	/** Remove a board with everything on it. */
	remove(id: number): boolean {
		const board = this.get(id);
		if (!board) return false;
		this.db.prepare("DELETE FROM board_items WHERE board = ?").run(id);
		this.db.prepare("DELETE FROM boards WHERE id = ?").run(id);
		this.onChange?.(board, "removed");
		return true;
	}

	// ---- what is on a board -------------------------------------------------------------------------

	item(id: number): BoardItem | undefined {
		const row = Number.isInteger(id) ? this.db.prepare("SELECT * FROM board_items WHERE id = ?").get(id) : undefined;
		return row ? this.itemOf(row) : undefined;
	}

	items(board: number, q: { kind?: "task" | "note"; after?: number; about?: number } = {}): BoardItem[] {
		const where = ["board = ?"];
		const args: any[] = [board];
		if (q.kind) where.push("kind = ?"), args.push(q.kind);
		if (q.after !== undefined) where.push("id > ?"), args.push(q.after);
		if (q.about !== undefined) where.push("about = ?"), args.push(q.about);
		return this.db.prepare(`SELECT * FROM board_items WHERE ${where.join(" AND ")} ORDER BY id`).all(...args).map((r) => this.itemOf(r));
	}

	/** The newest item's number on a board, or 0. */
	last(board: number): number {
		return Number((this.db.prepare("SELECT MAX(id) AS n FROM board_items WHERE board = ?").get(board) as any)?.n ?? 0);
	}

	post(board: Board, o: { kind: "task" | "note"; text: string; data?: unknown; by: string; trust: "owner" | "untrusted"; tainted?: string; after?: number[]; about?: number; cause?: unknown; long?: boolean }): BoardItem {
		const text = String(o.text ?? "").trim();
		if (!text) throw new Error(o.kind === "task" ? "a task needs a text: what is to be done, self-contained" : "a note needs a text");
		if ((this.db.prepare("SELECT COUNT(*) AS n FROM board_items WHERE board = ?").get(board.id) as any).n >= MAX_ITEMS) throw new Error(`this board holds ${MAX_ITEMS} posts, which is all it takes. Remove what is finished (board_remove with an id, or the whole board), or use a new board`);
		let data: string | null = null;
		if (o.data !== undefined && o.data !== null && o.data !== "") {
			if (typeof o.data !== "object" || Array.isArray(o.data)) throw new Error('"data" is a JSON object of fields, for example {"file": "src/a.css", "line": 12}');
			data = JSON.stringify(o.data);
			if (data.length > DATA_CHARS) throw new Error(`"data" is too long (${data.length} characters, at most ${DATA_CHARS}). Put long text into a file and name the file`);
		}
		const after = [...new Set((o.after ?? []).map(Number))];
		for (const id of after) {
			const dep = this.item(id);
			if (!dep || dep.board !== board.id || dep.kind !== "task") throw new Error(`"after": there is no task #${id} on this board`);
		}
		if (o.kind === "note" && after.length) throw new Error('"after" is for a task: a note waits for nothing');
		if (o.about !== undefined) {
			const on = this.item(o.about);
			if (!on || on.board !== board.id || on.kind !== "task") throw new Error(`"on": there is no task #${o.about} on this board`);
		}
		const now = Date.now();
		const r = this.db
			.prepare("INSERT INTO board_items (board, kind, text, data, state, by, trust, tainted, after, about, created, updated) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)")
			.run(board.id, o.kind, cut(text, o.kind === "task" ? (o.long ? LONG_TASK_CHARS : TASK_CHARS) : o.long ? JOB_NOTE_CHARS : NOTE_CHARS), data, o.kind === "task" ? "open" : "", o.by, o.trust, o.tainted ?? null, after.length ? JSON.stringify(after) : null, o.about ?? null, now, now);
		const item = this.item(Number(r.lastInsertRowid))!;
		this.onChange?.(board, "posted", item, o.cause);
		return item;
	}

	/** Replace the fields of a post (a pool's note names the tasks it is for, and a later call adds to them). */
	setData(id: number, data: Record<string, unknown>): void {
		this.db.prepare("UPDATE board_items SET data = ? WHERE id = ?").run(JSON.stringify(data), id);
	}

	/** Make an open task wait for more tasks of its board: a check of the whole comes after whatever was added while it waited. */
	waitFor(id: number, more: number[]): void {
		const item = this.item(id);
		if (!item || item.kind !== "task" || item.state !== "open") return;
		const after = [...new Set([...item.after, ...more.filter((m) => m !== id && this.item(m)?.board === item.board)])];
		if (after.length !== item.after.length) this.db.prepare("UPDATE board_items SET after = ?, updated = ? WHERE id = ?").run(JSON.stringify(after), Date.now(), id);
	}

	/** The tasks an open task still waits for: those named in `after` that are not done. */
	waitsFor(item: BoardItem): number[] {
		return item.after.filter((id) => this.item(id)?.state !== "done" && this.item(id) !== undefined);
	}

	/** Whether a task can be taken now. */
	ready(item: BoardItem): boolean {
		return item.kind === "task" && item.state === "open" && !this.waitsFor(item).length;
	}

	/**
	 * Take a task for a run: the one named, or the oldest that is ready. One synchronous step, so two
	 * runs that ask at once never both get it. `from` narrows which tasks count as ready (a run takes
	 * only what it may follow). Returns the task, or a sentence saying why there is none.
	 */
	claim(board: Board, o: { id?: number; holder: string; run: number; from?: (item: BoardItem) => boolean; cause?: unknown }): BoardItem | string {
		let item: BoardItem | undefined;
		if (o.id !== undefined) {
			item = this.item(o.id);
			if (!item || item.board !== board.id || item.kind !== "task") return `there is no task #${o.id} on this board`;
			if (item.state === "taken") return item.run === o.run ? `you have task #${item.id} already` : `task #${item.id} is taken by ${item.holder ?? "another run"}. Take another one`;
			if (item.state !== "open") return `task #${item.id} is ${item.state} already`;
			const waits = this.waitsFor(item);
			if (waits.length) return `task #${item.id} waits for ${waits.map((w) => `#${w}`).join(", ")}, which ${waits.length === 1 ? "is" : "are"} not done yet`;
		} else {
			item = this.items(board.id, { kind: "task" }).find((t) => this.ready(t) && (o.from?.(t) ?? true));
			if (!item) return "no task on this board is ready to be taken";
		}
		const now = Date.now();
		// (The state is checked once more where it is written: nothing ran in between, and nothing may.)
		const done = this.db.prepare("UPDATE board_items SET state = 'taken', holder = ?, run = ?, updated = ? WHERE id = ? AND state = 'open'").run(o.holder, o.run, now, item.id);
		if (!done.changes) return `task #${item.id} was taken a moment ago. Take another one`;
		const taken = this.item(item.id)!;
		this.onChange?.(board, "taken", taken, o.cause);
		return taken;
	}

	/**
	 * Say what became of a task. `run` is the run that says so: only the run that holds a task settles
	 * it, and the owner (no run) settles any. A blocked task waits for an answer; `reopen` puts it back.
	 */
	settle(id: number, outcome: "done" | "failed" | "blocked", result: string, o: { run?: number; tainted?: string; untrusted?: boolean; cause?: unknown } = {}): BoardItem {
		const item = this.item(id);
		if (!item || item.kind !== "task") throw new Error(`there is no task #${id}`);
		if (o.run !== undefined && !(item.state === "taken" && item.run === o.run)) throw new Error(item.state === "taken" ? `task #${id} is taken by ${item.holder ?? "another run"}, not by you` : `task #${id} is ${item.state}: take it first (board_claim) and then say what became of it`);
		// What a run that read outside content wrote as the result is marked like a post of its own.
		this.db
			.prepare("UPDATE board_items SET state = ?, result = ?, run = NULL, tainted = COALESCE(tainted, ?), trust = CASE WHEN ? THEN 'untrusted' ELSE trust END, updated = ? WHERE id = ?")
			.run(outcome, cutResult(String(result ?? "").trim()) || null, o.tainted ?? null, o.untrusted ? 1 : 0, Date.now(), id);
		const settled = this.item(id)!;
		const board = this.get(item.board);
		if (board) this.onChange?.(board, "settled", settled, o.cause);
		return settled;
	}

	/** Put a task back for anyone to take: given up by the run that had it, taken back by the owner, or answered after it was blocked. */
	reopen(id: number, o: { run?: number; cause?: unknown } = {}): BoardItem {
		const item = this.item(id);
		if (!item || item.kind !== "task") throw new Error(`there is no task #${id}`);
		if (o.run !== undefined && !(item.state === "taken" && item.run === o.run)) throw new Error(`task #${id} is not yours to give back`);
		this.db.prepare("UPDATE board_items SET state = 'open', holder = NULL, run = NULL, result = NULL, updated = ? WHERE id = ?").run(Date.now(), id);
		const open = this.item(id)!;
		const board = this.get(item.board);
		if (board) this.onChange?.(board, "released", open, o.cause);
		return open;
	}

	/**
	 * Answer the question a task waits on: the answer goes into the task's notes, with the question it
	 * answers in `data.question` (`reopen` clears it from the task), and the task is open again for whoever
	 * takes it next.
	 */
	answer(id: number, answer: string, o: { by: string; trust: "owner" | "untrusted"; tainted?: string; cause?: unknown }): BoardItem {
		const item = this.item(id);
		const board = item && this.get(item.board);
		if (!item || !board || item.kind !== "task") throw new Error(`there is no task #${id}`);
		const text = String(answer ?? "").trim();
		if (!text) throw new Error("give the answer");
		// The note is the answer, and says in a field which question it answers: whoever shows it can set the two apart.
		this.post(board, { kind: "note", text, ...(item.result ? { data: { question: item.result.length > 600 ? `${item.result.slice(0, 600)}…` : item.result } } : {}), by: o.by, trust: o.trust, tainted: o.tainted, about: item.id, cause: o.cause });
		return this.reopen(id, { cause: o.cause });
	}

	/**
	 * The check of a task's result failed (`data.check` of the check names the task): the task is given out
	 * again with what the check found as a note about it, and the check waits for it once more. At most
	 * MAX_REWORK times for a task; after that, and for a check that is no task's alone, nothing happens here
	 * and the check's report stands. Returns whether the work was given out again.
	 */
	rework(check: BoardItem, o: { by: string; trust: "owner" | "untrusted"; tainted?: string; cause?: unknown }): boolean {
		const work = typeof check.data?.check === "number" ? this.item(check.data.check) : undefined;
		const board = work && this.get(work.board);
		if (!work || !board || work.board !== check.board || work.kind !== "task" || work.state !== "done" || check.state !== "done") return false;
		const rounds = Number(work.data?.reworked ?? 0);
		if (rounds >= MAX_REWORK) return false;
		const was = work.result ? `\n\nWhat the sub-agent before you answered:\n${cut(work.result, 600)}` : "";
		// (The task is done again, as it stands: a task that was to look and report is not turned into one that changes
		// what it looked at because a check found its report wrong.)
		this.post(board, { kind: "note", text: `A sub-agent did this task before you, and a check found its result wrong or incomplete. Do the task again, as it is written, and get right what the check found. The task has not changed: change files only where the task itself says to (files it had you write are as that sub-agent left them).\n\nWhat the check found:\n${cut(check.result ?? "", 1200)}${was}`, data: { rework: rounds + 1 }, by: o.by, trust: o.trust, tainted: o.tainted, about: work.id, cause: o.cause });
		this.setData(work.id, { ...(work.data ?? {}), reworked: rounds + 1 });
		this.reopen(work.id, { cause: o.cause });
		this.reopen(check.id, { cause: o.cause });
		return true;
	}

	/** The tasks a run of pine's holds right now. When the run ends, the daemon settles or gives back each: nothing stays taken for ever. */
	heldBy(run: number): BoardItem[] {
		return this.db.prepare("SELECT * FROM board_items WHERE run = ? AND state = 'taken' ORDER BY id").all(run).map((r) => this.itemOf(r));
	}

	/** At the daemon's start: a task held by a run that is no longer running is open again. */
	releaseStale(running: (run: number) => boolean): number {
		const held = this.db.prepare("SELECT id, run FROM board_items WHERE state = 'taken'").all() as Array<{ id: number; run: number | null }>;
		const stale = held.filter((h) => h.run === null || !running(h.run));
		for (const h of stale) this.reopen(h.id);
		return stale.length;
	}

	removeItem(id: number): boolean {
		const item = this.item(id);
		if (!item) return false;
		// A note about a task goes with it, and nothing waits for a task that is gone.
		this.db.prepare("DELETE FROM board_items WHERE id = ? OR about = ?").run(id, id);
		for (const other of this.items(item.board, { kind: "task" })) {
			if (other.after.includes(id)) this.db.prepare("UPDATE board_items SET after = ? WHERE id = ?").run(JSON.stringify(other.after.filter((a) => a !== id)), other.id);
		}
		const board = this.get(item.board);
		if (board) this.onChange?.(board, "removed", item);
		return true;
	}

	// ---- what goes with a conversation or an agent --------------------------------------------------

	/** A conversation is forgotten or removed: its boards go with it. */
	dropConversation(agent: string, session: string): number {
		const gone = this.list().filter((b) => b.scope === "local" && b.agent === agent && b.session === session);
		for (const b of gone) this.remove(b.id);
		return gone.length;
	}

	/** An agent is removed: its boards go, and so does every post under its name on a board for all agents. */
	dropAgent(agent: string): void {
		for (const b of this.list().filter((x) => x.scope !== "global" && x.agent === agent)) this.remove(b.id);
		const rest = (this.db.prepare("SELECT id FROM board_items WHERE by = ?").all(agent) as any[]).map((r) => r.id as number);
		for (const id of rest) this.removeItem(id);
		this.db.prepare("UPDATE board_items SET state = 'open', holder = NULL, run = NULL WHERE holder = ? AND state = 'taken'").run(agent);
		this.db.prepare("UPDATE board_items SET holder = NULL WHERE holder = ?").run(agent);
	}

	renameAgent(from: string, to: string): void {
		this.db.prepare("UPDATE boards SET agent = ? WHERE agent = ?").run(to, from);
		this.db.prepare("UPDATE board_items SET by = ? WHERE by = ?").run(to, from);
		this.db.prepare("UPDATE board_items SET holder = ? WHERE holder = ?").run(to, from);
	}

	renameConversation(agent: string, from: string, to: string): void {
		this.db.prepare("UPDATE boards SET session = ? WHERE scope = 'local' AND agent = ? AND session = ?").run(to, agent, from);
	}

	/** Take a secret out of what is on the boards (see Bus.scrub). */
	scrub(secret: string): void {
		if (secret.length < 8) return;
		for (const col of ["text", "data", "result"]) this.db.prepare(`UPDATE board_items SET ${col} = replace(${col}, ?, '[redacted]') WHERE instr(${col}, ?) > 0`).run(secret, secret);
	}

	private boardOf(r: any): Board {
		return { id: r.id, scope: r.scope, agent: r.agent, session: r.session, name: r.name, created: r.created };
	}

	private itemOf(r: any): BoardItem {
		const after = parse(r.after);
		return {
			id: r.id, board: r.board, kind: r.kind, text: r.text, data: parse(r.data), state: r.state, by: r.by, trust: r.trust === "untrusted" ? "untrusted" : "owner",
			tainted: r.tainted ?? undefined, holder: r.holder ?? undefined, run: r.run ?? undefined, result: r.result ?? undefined,
			after: Array.isArray(after) ? after.map(Number) : [], about: r.about ?? undefined, created: r.created, updated: r.updated,
		};
	}
}

/** A board as people call it: "the board of this conversation", or its name with whom it is for. */
export function boardTitle(b: Board): string {
	const whose = b.scope === "global" ? "for all agents" : b.scope === "agent" ? `of ${b.agent}` : `of the conversation ${b.session} of ${b.agent}`;
	return b.name ? `"${b.name}" (${whose})` : `the board ${whose}`;
}
