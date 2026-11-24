import { type Component, type EditorTheme, Markdown, type MarkdownTheme, type SelectListTheme, stripTerminalSequences, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { foldsIn, summaryOf } from "../util.ts";
import { highlightCode } from "./highlight.ts";

const on = !process.env.NO_COLOR;
const sgr = (open: string, close: string) => (s: string) => (on ? `\x1b[${open}m${s}\x1b[${close}m` : s);

/** Plain 16/256-color styling, so the UI follows the terminal's own palette. */
export const c = {
	bold: sgr("1", "22"),
	dim: sgr("2", "22"),
	italic: sgr("3", "23"),
	underline: sgr("4", "24"),
	inverse: sgr("7", "27"),
	strike: sgr("9", "29"),
	red: sgr("31", "39"),
	green: sgr("32", "39"),
	yellow: sgr("33", "39"),
	blue: sgr("34", "39"),
	magenta: sgr("35", "39"),
	cyan: sgr("36", "39"),
	gray: sgr("90", "39"),
	accent: sgr("38;5;114", "39"),
	bgPanel: sgr("48;5;236", "49"),
	bgUser: sgr("48;5;237", "49"),
	bgAccent: sgr("48;5;114;30", "49;39"),
};

export const selectTheme: SelectListTheme = {
	selectedPrefix: c.accent,
	selectedText: (s) => c.bold(c.accent(s)),
	description: c.gray,
	scrollInfo: c.gray,
	noMatch: c.gray,
};

export const editorTheme: EditorTheme = { borderColor: c.gray, selectList: selectTheme };

/** Marks a line that only held a code block's backticks. A private-use character: no text contains it. */
const FENCE = "\uE000";

export const markdownTheme: MarkdownTheme = {
	// From the third level on, the library puts the "###" in front as a piece of its own. It is markup, so it is left out.
	heading: (s) => (/^(?:\x1b\[[0-9;]*m)*#{3,6} (?:\x1b\[[0-9;]*m)*$/.test(s) ? "" : c.bold(c.accent(s))),
	link: c.cyan,
	linkUrl: c.gray,
	code: c.yellow,
	codeBlock: (s) => s,
	// A code block is a bar down its left side with its language above it. The lines of backticks
	// around it are markup, not content: the opening one becomes the language, the others are
	// marked here and left out by Answer below.
	codeBlockBorder: (s) => {
		const lang = s.replace(/^[`~]+/, "").trim();
		return lang ? c.gray(lang) : FENCE;
	},
	codeBlockIndent: c.gray("│ "),
	highlightCode,
	quote: c.italic,
	quoteBorder: c.gray,
	hr: c.gray,
	listBullet: c.accent,
	bold: c.bold,
	italic: c.italic,
	strikethrough: c.strike,
	underline: c.underline,
};

export const SPINNER = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

/** Markdown drawn: headings, lists, tables, quotes, and code in color. */
class Prose extends Markdown {
	private from?: readonly string[];
	private drawn: readonly string[] = [];
	private written: string;

	constructor(text: string) {
		super(text, 1, 0, markdownTheme);
		this.written = text;
	}

	/** The same text again costs nothing: an answer that streams in sets all its parts with every piece. */
	override setText(text: string): void {
		if (text === this.written) return;
		this.written = text;
		super.setText(text);
	}

	override render(width: number): readonly string[] {
		const lines = super.render(width);
		if (lines !== this.from) {
			this.from = lines;
			this.drawn = lines.some((l) => l.includes(FENCE)) ? lines.filter((l) => !l.includes(FENCE)) : lines;
		}
		return this.drawn;
	}
}

/** An open block of more lines than this has a line at its end that closes it. */
const LONG = 6;
/** The beginning of a tag that folds, at the end of a text that is still being written. */
const HALF_TAG = /<\/?(?:d(?:e(?:t(?:a(?:i(?:l(?:s(?:\s[^<>]*)?)?)?)?)?)?)?)?$/i;
/** Blank lines in front of a text. Not the spaces that begin its first line: they can mean something. */
const BLANK_LINES = /^(?:[ \t]*\n)+/;

/** A part of an answer that is folded into one line (`<details>`), and opens on a click. */
export interface Block {
	/** What stands for it: its summary as written, and drawn. */
	summary: string;
	label: string;
	/** `<details open>`: how it is until somebody clicks it. */
	written: boolean;
	/** What a click made of it. Kept while the answer is on screen, also while more of it arrives. */
	chosen?: boolean;
	body: Answer;
	/** The line of the answer it begins at, as it was last drawn. */
	row: number;
}

/** What a line of an answer is: the line of a block that opens and closes it, a line of what a block holds, or text. */
type AnswerRow = { block: Block; y?: number } | undefined;

/** A summary as one line, with the bold and code in it drawn. Nothing in it may move the cursor or color the screen. */
function drawLabel(summary: string): string {
	// Inside a tag, models write tags for what markdown has marks for.
	const text = stripTerminalSequences(summary).replace(/[\x00-\x1f\x7f]+/g, " ").replace(/<\/?(?:b|strong)>/gi, "**").replace(/<\/?(?:i|em)>/gi, "*").replace(/<\/?code>/gi, "`");
	const lines = new Markdown(text, 0, 0, markdownTheme).render(2000).map((l) => l.trimEnd()).filter(Boolean);
	return lines.join(" ") || text;
}

/**
 * Markdown from an agent or a tool, drawn. A part that the answer folds away
 * (`<details><summary>what it is</summary> ... </details>`) is one line, and a click on that line
 * opens and closes it. What it holds is an answer again, set in under its line, so a block
 * inside a block works the same way.
 */
export class Answer implements Component {
	/** A click opened or closed a block: whoever shows the answer keeps the block's line in view. */
	toggled?: (block: Block, open: boolean) => void;
	private parts: Array<Prose | Block> = [];
	private proses: Prose[] = [];
	private blocks: Block[] = [];
	private rows: AnswerRow[] = [];
	private drawn?: { width: number; lines: string[] };

	constructor(text: string) {
		this.setText(text);
	}

	/**
	 * `live`: the answer is still being written. Then the beginning of a tag at its end is held
	 * back until it is known what it becomes, and a block whose summary is not whole yet is "…".
	 */
	setText(text: string, live = false): void {
		const shown = live ? text.replace(HALF_TAG, "") : text;
		const folds = foldsIn(shown, live);
		const parts: Array<Prose | Block> = [];
		let proses = 0;
		const words = (piece: string) => {
			// Without a block the text is drawn as it is, empty too. Between blocks, nothing is nothing.
			if (folds.length && !piece.trim()) return;
			const prose = (this.proses[proses++] ??= new Prose(piece));
			prose.setText(piece);
			parts.push(prose);
		};
		let at = 0;
		folds.forEach((fold, i) => {
			words(shown.slice(at, fold.from).replace(BLANK_LINES, "").trimEnd());
			// The n-th block stays the n-th block while the answer grows, and with it what a click made of it.
			const block = (this.blocks[i] ??= this.block());
			block.written = fold.open;
			const summary = live && fold.pending ? "…" : summaryOf(fold);
			if (summary !== block.summary) block.label = drawLabel((block.summary = summary));
			block.body.setText(fold.body.replace(BLANK_LINES, "").trimEnd(), live);
			parts.push(block);
			at = fold.to;
		});
		words(at ? shown.slice(at).replace(BLANK_LINES, "").trimEnd() : shown);
		this.proses.length = proses;
		this.blocks.length = folds.length;
		this.parts = parts;
		this.rows = [];
		this.drawn = undefined;
	}

	private block(): Block {
		const body = new Answer("");
		body.toggled = (block, open) => {
			this.drawn = undefined;
			this.toggled?.(block, open);
		};
		return { summary: "", label: "", written: false, body, row: 0 };
	}

	invalidate(): void {
		for (const p of this.proses) p.invalidate();
		for (const b of this.blocks) b.body.invalidate();
		this.drawn = undefined;
	}

	render(width: number): readonly string[] {
		// An answer that folds nothing is its markdown, as it always was.
		if (!this.blocks.length) return this.proses[0]?.render(width) ?? [];
		if (this.drawn?.width === width) return this.drawn.lines;
		const lines: string[] = [];
		const rows: AnswerRow[] = [];
		const put = (line: string, row: AnswerRow) => (lines.push(line), rows.push(row));
		this.parts.forEach((part, i) => {
			if (i) put("", undefined);
			if (part instanceof Prose) {
				for (const l of part.render(width)) put(l, undefined);
				return;
			}
			const open = part.chosen ?? part.written;
			const hint = ` · ${open ? "click here to close" : "click to open"}`;
			part.row = lines.length;
			put(truncateToWidth(` ${c.gray(open ? "▾" : "▸")} ${truncateToWidth(part.label, Math.max(8, width - 4 - hint.length), "…")}${c.gray(hint)}`, width), { block: part });
			if (!open) return;
			const body = part.body.render(Math.max(1, width - 2));
			body.forEach((l, y) => put(`  ${l}`, { block: part, y }));
			if (body.length > LONG) put(` ${c.gray("▴ close")}`, { block: part });
		});
		this.rows = rows;
		this.drawn = { width, lines };
		return lines;
	}

	/** The line at which a block begins, as the answer is drawn at this width. Nothing if it is not in it, or inside a block that is closed. */
	rowOf(block: object, width: number): number | undefined {
		this.render(width);
		for (const b of this.blocks) {
			if (b === block) return b.row;
			const at = (b.chosen ?? b.written) ? b.body.rowOf(block, Math.max(1, width - 2)) : undefined;
			if (at !== undefined) return b.row + 1 + at;
		}
		return undefined;
	}

	handleMouse(e: any): { handled: boolean; render: boolean } | undefined {
		const row = this.rows[e.y];
		if (!row) return undefined; // text: left to selection
		if (row.y !== undefined) return row.block.body.handleMouse({ ...e, x: e.x - 2, y: row.y });
		if (e.button !== "left" || (e.type !== "press" && e.type !== "click" && e.type !== "release")) return undefined;
		if (e.type === "click") {
			row.block.chosen = !(row.block.chosen ?? row.block.written);
			this.drawn = undefined;
			this.toggled?.(row.block, row.block.chosen);
		}
		return { handled: true, render: true };
	}
}

// Two things the library's tables leave out, added where it wraps a cell's text to its column:
// a <br>, which models write for a line break inside a cell, becomes that break; and a column
// that the table's second line aligns to the right ("---:") or centres (":---:") is set that way.
const proto = Markdown.prototype as any;
const wrapCell = proto.wrapCellText as ((text: string, width: number, stylePrefix?: string) => string[]) | undefined;
const drawTable = proto.renderTable as ((token: any, ...rest: unknown[]) => string[]) | undefined;
const inline = proto.renderInlineTokens as ((...args: unknown[]) => string) | undefined;
const BR = /\s*<br\s*\/?>\s*/i;
if (wrapCell && drawTable && inline) {
	const own = Prose.prototype as any;
	own.renderTable = function (this: any, token: any, ...rest: unknown[]): string[] {
		// The library first reads every cell once to size the columns, then once more, cell after
		// cell and row by row, to draw them. Counting says which of the two it is doing, and which
		// column a cell is in.
		const cells = (token?.header?.length ?? 0) + (token?.rows ?? []).reduce((n: number, row: unknown[]) => n + row.length, 0);
		this.table = { align: Array.isArray(token?.align) ? token.align : [], columns: token?.header?.length || 1, cell: 0, sizing: cells, depth: 0 };
		try {
			return drawTable.call(this, token, ...rest);
		} finally {
			this.table = undefined;
		}
	};
	own.renderInlineTokens = function (this: any, ...args: unknown[]): string {
		const table = this.table;
		if (!table) return inline.apply(this, args);
		table.depth++;
		let text: string;
		try {
			text = inline.apply(this, args);
		} finally {
			table.depth--;
		}
		if (table.depth > 0 || table.sizing <= 0) return text;
		table.sizing--;
		// A cell with line breaks is as wide as its longest line, not as all of them in a row.
		return BR.test(text) ? text.split(BR).reduce((a, b) => (visibleWidth(b) > visibleWidth(a) ? b : a)) : text;
	};
	own.wrapCellText = function (this: any, text: string, width: number, stylePrefix?: string): string[] {
		const lines = text.split(BR).flatMap((part) => wrapCell.call(this, part, width, stylePrefix));
		const side = this.table ? this.table.align[this.table.cell++ % this.table.columns] : undefined;
		if (side !== "right" && side !== "center") return lines;
		return lines.map((line) => {
			const free = Math.max(0, width - visibleWidth(line));
			return " ".repeat(side === "right" ? free : Math.floor(free / 2)) + line;
		});
	};
}
