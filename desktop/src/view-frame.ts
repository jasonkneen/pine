// The frame a view of the owner's runs in (view.html). The panel (View.tsx) makes it sandboxed, with
// scripts and nothing else, so it has an origin of its own that is nobody's: it cannot reach the
// page's bridge, its storage, the daemon or the web (the frame's policy allows no address at all).
// The panel hands it the view's code and, from then on, the state of pine with everything that could
// be private taken out (view-state.ts). A view tells the panel what to show or open, and nothing else.
//
// "pine/view", the one thing a view imports, is pine's src/view-kit.ts: the frame makes a module of it
// and points the view's import at that module.
import * as kit from "../../src/view-kit.ts";
import type { ViewHappening, ViewHost, ViewState, ViewTarget } from "../../src/view-kit.ts";

type In = { type: "load"; code: string; state: ViewState } | { type: "state"; state: ViewState } | { type: "happening"; happening: ViewHappening };

const root = document.getElementById("root")!;
let state: ViewState | undefined;
let started = false;
const onState = new Set<(s: ViewState) => void>();
const onHappening = new Set<(h: ViewHappening) => void>();

const tell = (message: { type: "booted" } | { type: "ready" } | { type: "error"; message: string } | { type: "select"; target?: ViewTarget } | { type: "open"; target: ViewTarget }) => window.parent.postMessage(message, "*");
const said = (e: unknown) => (e instanceof Error ? e.message : String(e)).slice(0, 400);

function each<T>(set: Set<(v: T) => void>, v: T): void {
	for (const fn of set) {
		try {
			fn(v);
		} catch (e) {
			tell({ type: "error", message: said(e) });
		}
	}
}

const host: ViewHost = {
	root,
	state: () => state!,
	on: ((what: "state" | "happening", fn: (v: never) => void) => {
		const set = (what === "state" ? onState : onHappening) as Set<(v: unknown) => void>;
		set.add(fn as (v: unknown) => void);
		return () => void set.delete(fn as (v: unknown) => void);
	}) as ViewHost["on"],
	select: (target) => tell({ type: "select", target: target && ("agent" in target ? { agent: String(target.agent) } : "work" in target ? { work: Number(target.work) } : { board: Number(target.board), ...(target.task !== undefined ? { task: Number(target.task) } : {}) }) }),
	open: (target) => void ("board" in target || tell({ type: "open", target: "agent" in target ? { agent: String(target.agent) } : { work: Number(target.work) } })),
};

async function start(code: string): Promise<void> {
	// The kit as a module of its own, for the view's `import ... from "pine/view"`.
	(globalThis as { __viewKit?: unknown }).__viewKit = kit;
	const names = Object.keys(kit).filter((k) => /^[A-Za-z_$][\w$]*$/.test(k));
	const kitUrl = URL.createObjectURL(new Blob([`const k = globalThis.__viewKit;\nexport const { ${names.join(", ")} } = k;\n`], { type: "text/javascript" }));
	const source = code.replace(/(\bfrom\s*|\bimport\s*\(\s*|\bimport\s+)(["'])pine\/view\2/g, (_m, before: string, q: string) => `${before}${q}${kitUrl}${q}`);
	const url = URL.createObjectURL(new Blob([source], { type: "text/javascript" }));
	try {
		const mod = (await import(/* @vite-ignore */ url)) as { default?: { pineView?: number; start?: (host: ViewHost) => unknown } };
		const view = mod.default;
		if (!view || view.pineView !== 1 || typeof view.start !== "function") throw new Error('a view\'s file has `export default defineView((host) => { ... })`, with defineView from "pine/view"');
		view.start(host);
		tell({ type: "ready" });
	} catch (e) {
		tell({ type: "error", message: said(e) });
	}
}

window.addEventListener("error", (e) => tell({ type: "error", message: said(e.error ?? e.message) }));
window.addEventListener("unhandledrejection", (e) => tell({ type: "error", message: said(e.reason) }));

window.addEventListener("message", (e: MessageEvent<In>) => {
	// Only the panel that made the frame speaks to it.
	if (e.source !== window.parent) return;
	const m = e.data;
	if (m?.type === "load" && !started) {
		started = true;
		state = m.state;
		void start(String(m.code));
	} else if (m?.type === "state") {
		state = m.state;
		each(onState, m.state);
	} else if (m?.type === "happening") each(onHappening, m.happening);
});

// The frame is up: the panel may hand it the view.
tell({ type: "booted" });
