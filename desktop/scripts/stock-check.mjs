// Keeps the app's page stock: shadcn's components as the registry has them, Tailwind's default scale, the
// theme's tokens. desktop/DESIGN.md says why; this says where the page left it. Part of `npm run check`.
//
//   node scripts/stock-check.mjs              everything
//   node scripts/stock-check.mjs --offline    without asking shadcn's registry
//
// It fails on:
// - a file of src/components/ui that differs from what the shadcn CLI would write for components.json
//   (the registry unreachable: a warning, and that part is skipped);
// - in src/index.css, an `@utility`, `@keyframes` or other at-rule of its own, a rule outside `@layer base`
//   other than `:root`, or a selector or `@apply` in `@layer base` that is not one of those already there;
// - in the page's code outside components/ui, an arbitrary value (`max-w-[37rem]`, `[mask:...]`) that is not
//   on ALLOWED, and a raw colour in a class (`bg-[#fff]`, `text-[rgb(...)]`, `text-blue-500`).
import { execFile } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { promisify } from "node:util";

const run = promisify(execFile);
const desktop = path.resolve(import.meta.dirname, "..");

/**
 * The arbitrary values the page uses on purpose, each for something Tailwind's scale cannot say.
 * Before adding one, look for the stock way: a utility on the default scale, a component's variant.
 */
export const ALLOWED = new Map([
	["[-webkit-app-region:drag]", "what moves the window (the title bar)"],
	["[-webkit-app-region:no-drag]", "what takes clicks inside the title bar"],
	["max-h-[50vh]", "a dialog's body scrolls past half the window"],
	["grid-cols-[auto_1fr]", "a list of terms and values, as stock Alert lays its icon and text"],
	["transition-[height]", "a height that follows a value, as stock Trace does"],
	["[contain-intrinsic-size:auto_1.5rem]", "the estimated height of an event row, as stock MessageScrollerItem does for a message"],
	["[font-size:inherit]", "a link button inside a sentence takes the sentence's size"],
	["[transform:translateY(-150%)]", "a toast that enters and leaves from the top"],
	["slide-out-to-left-[max(0px,100%_-_100cqw)]", "a long title scrolls by on hover, as far as it overflows"],
	["[animation-timing-function:steps(4,jump-none)]", "the pulse of a working agent ticks"],
	["[-webkit-text-fill-color:currentColor]", "a trace line at work drops the stock shimmer, which repaints every frame (Conversation.tsx)"],
	["[animation:pulse_2s_steps(4,jump-none)_infinite]", "a trace line at work fades in steps instead, which costs nearly nothing"],
]);

const PALETTE = "slate|gray|zinc|neutral|stone|red|orange|amber|yellow|lime|green|emerald|teal|cyan|sky|blue|indigo|violet|purple|fuchsia|pink|rose";
const COLOR_UTILITY = "bg|text|border|ring|fill|stroke|from|to|via|outline|decoration|shadow|accent|caret|divide|placeholder";
const paletteColor = new RegExp(`^(${COLOR_UTILITY})(-[xytrblse])?-(${PALETTE})-\\d{2,3}(\\/\\S+)?$`);
const rawColor = /#[0-9a-f]{3,8}\b|\b(rgba?|hsla?|oklch|oklab|lab|lch|color)\(/i;

/** The utility of a class, without its variants (`md:hover:` ...) and its `!`. */
function utilityOf(token) {
	let depth = 0;
	let start = 0;
	for (let i = 0; i < token.length; i++) {
		const c = token[i];
		if (c === "[" || c === "(") depth++;
		else if (c === "]" || c === ")") depth--;
		else if (c === ":" && depth === 0) start = i + 1;
	}
	return token.slice(start).replace(/^!|!$/g, "");
}

/** What in a source file's string literals is not stock: an arbitrary value not allowed, a raw colour. */
export function classProblems(text) {
	const found = [];
	const lines = text.split("\n");
	lines.forEach((line, i) => {
		for (const m of line.matchAll(/(["'`])((?:(?!\1).)*)\1/g)) {
			for (const token of m[2].split(/\s+/)) {
				const u = utilityOf(token);
				const arbitrary = /^-?[a-z][a-z0-9-]*-\[.+\](\/\S+)?$/.test(u) || /^\[[a-z-]+:.+\]$/.test(u);
				if (paletteColor.test(u)) found.push({ line: i + 1, what: u, why: "a raw palette colour: use a semantic token (text-muted-foreground, bg-primary...) or a Badge variant" });
				else if (arbitrary && rawColor.test(u)) found.push({ line: i + 1, what: u, why: "a raw colour: use a semantic token, or add a role to the theme in src/index.css" });
				else if (arbitrary && !ALLOWED.has(u)) found.push({ line: i + 1, what: u, why: "an arbitrary value: use Tailwind's default scale or a component's variant (or, when nothing stock can say it, add it to ALLOWED in scripts/stock-check.mjs with its reason)" });
			}
		}
	});
	return found;
}

/** What src/index.css may hold: these at-rules at the top, `:root` as the only plain rule, and in `@layer base` these. */
const TOP_AT_RULES = new Set(["import", "source", "custom-variant", "theme", "layer"]);
export const BASE_SELECTORS = new Set([
	"*",
	":root",
	":root.dark",
	"html,\nbody,\n#root",
	"html",
	"body",
	'html[data-platform="darwin"] body',
	"::selection",
	"::highlight(pine-find)",
	"::highlight(pine-bookmark)",
	"::highlight(pine-find-at)",
	"[data-base-ui-portal] *",
]);
export const BASE_APPLY = new Set([
	"border-border outline-ring/50",
	"h-full",
	"font-sans",
	"overflow-hidden bg-background text-foreground antialiased select-none cursor-default",
	"bg-transparent",
]);

/** The blocks of a stylesheet at one level: an at-rule or a rule, its prelude and its body. */
function blocks(css) {
	const out = [];
	let i = 0;
	while (i < css.length) {
		const open = css.indexOf("{", i);
		const semi = css.indexOf(";", i);
		if (semi !== -1 && (open === -1 || semi < open)) {
			out.push({ prelude: css.slice(i, semi).trim(), body: undefined });
			i = semi + 1;
			continue;
		}
		if (open === -1) break;
		let depth = 1;
		let j = open + 1;
		for (; j < css.length && depth; j++) {
			if (css[j] === "{") depth++;
			else if (css[j] === "}") depth--;
		}
		out.push({ prelude: css.slice(i, open).trim(), body: css.slice(open + 1, j - 1) });
		i = j;
	}
	return out.filter((b) => b.prelude);
}

/** What in src/index.css goes beyond stock shadcn and the theme bridge. */
export function cssProblems(text) {
	const css = text.replace(/\/\*[\s\S]*?\*\//g, "");
	const found = [];
	for (const b of blocks(css)) {
		const at = /^@([\w-]+)/.exec(b.prelude)?.[1];
		if (at && !TOP_AT_RULES.has(at)) found.push({ what: b.prelude, why: `@${at} is not stock here: compose utilities in the markup, or use a component's variant` });
		else if (at === "layer" && b.prelude !== "@layer base") found.push({ what: b.prelude, why: "only @layer base holds rules here" });
		else if (!at && b.prelude !== ":root") found.push({ what: b.prelude, why: "a global rule outside @layer base: write utilities in the markup" });
		if (b.prelude !== "@layer base" || b.body === undefined) continue;
		for (const r of blocks(b.body)) {
			if (r.prelude.startsWith("@")) {
				found.push({ what: r.prelude, why: "an at-rule inside @layer base" });
				continue;
			}
			const selector = r.prelude.split("\n").map((l) => l.trim()).join("\n");
			if (!BASE_SELECTORS.has(selector)) found.push({ what: selector, why: "a new global rule changes stock components everywhere: write utilities in the markup" });
			for (const a of (r.body ?? "").matchAll(/@apply\s+([^;]+);/g)) {
				if (!BASE_APPLY.has(a[1].trim())) found.push({ what: `@apply ${a[1].trim()}`, why: "a new @apply: write the utilities in the markup" });
			}
		}
	}
	return found;
}

/** The page's code that the class check reads: src/ without components/ui, which the registry check covers. */
function pageFiles() {
	const files = [];
	const walk = (dir) => {
		for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
			const p = path.join(dir, e.name);
			if (e.isDirectory()) {
				if (p !== path.join(desktop, "src", "components", "ui")) walk(p);
			} else if (/\.tsx?$/.test(e.name)) files.push(p);
		}
	};
	walk(path.join(desktop, "src"));
	return files;
}

async function shadcn(args) {
	const { stdout, stderr } = await run(process.execPath, [path.join(desktop, "node_modules", "shadcn", "dist", "index.js"), ...args], { cwd: desktop, timeout: 60_000, maxBuffer: 16 << 20 });
	return `${stdout}\n${stderr}`;
}

/**
 * The files of components/ui that the CLI would overwrite. One dry run for all, then each file it names
 * alone: in a dry run of several items, an item's dependency can resolve from another style and differ
 * from that item's own file, which the item's own dry run does not.
 */
async function registryProblems() {
	const ui = path.join(desktop, "src", "components", "ui");
	const names = fs.readdirSync(ui).filter((f) => f.endsWith(".tsx")).map((f) => f.slice(0, -4));
	const overwritten = (out) => [...out.matchAll(/~ src\/components\/ui\/([\w-]+)\.tsx\s+overwrite/g)].map((m) => m[1]);
	const suspects = overwritten(await shadcn(["add", ...names, "--dry-run"])).filter((n) => names.includes(n));
	const found = [];
	await Promise.all(suspects.map(async (name) => {
		if (overwritten(await shadcn(["add", name, "--dry-run"])).includes(name)) found.push({ what: `src/components/ui/${name}.tsx`, why: `differs from the registry: \`npx shadcn add ${name} --diff src/components/ui/${name}.tsx\` shows how; bring it back with the CLI` });
	}));
	return found;
}

async function main() {
	const offline = process.argv.includes("--offline");
	const problems = [];
	for (const p of cssProblems(fs.readFileSync(path.join(desktop, "src", "index.css"), "utf8"))) problems.push(`src/index.css: ${p.what.split("\n").join(" ")}: ${p.why}`);
	for (const file of pageFiles()) {
		for (const p of classProblems(fs.readFileSync(file, "utf8"))) problems.push(`${path.relative(desktop, file)}:${p.line}: ${p.what}: ${p.why}`);
	}
	if (!offline) {
		try {
			for (const p of await registryProblems()) problems.push(`${p.what}: ${p.why}`);
		} catch (e) {
			console.warn(`stock check: shadcn's registry was not reached, so components/ui was not compared with it (${String(e?.message ?? e).split("\n")[0]})`);
		}
	}
	if (problems.length) {
		console.error(`stock check: ${problems.length} place(s) where the page is not stock (desktop/DESIGN.md):\n${problems.map((p) => `  ${p}`).join("\n")}`);
		process.exit(1);
	}
	console.log("stock check: the page is stock");
}

if (import.meta.filename === process.argv[1]) await main();
