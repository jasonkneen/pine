// What the view costs: the app's CPU while the view's panel is closed, open at rest, and open while
// agents work. Not part of the ordinary run (it measures, and a busy machine measures high): run it
// with PINE_PERF=1 to see the numbers, which it prints.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { after, before, test } from "node:test";
import { mockMsg, startMock } from "../../baseline/tests/mock.mjs";
import { launchApp } from "./support/app.ts";

const on = process.env.PINE_PERF === "1";
let app: any;
let page: any;
let mock: any;
let home: string;

const write = (file: string, content: string) => {
	fs.mkdirSync(path.dirname(file), { recursive: true });
	fs.writeFileSync(file, content);
};
const menu = (name: string) => app.evaluate(({ BrowserWindow }: any, n: string) => BrowserWindow.getAllWindows()[0].webContents.send("pine:menu", n), name);
const call = (method: string, url: string, body?: unknown) => page.evaluate(([m, u, b]: [string, string, unknown]) => (window as any).pine.call(m, u, b), [method, url, body]);

/** How many frames the view draws a second, and how long one takes on average: its frames, timed for two seconds. */
async function draws(): Promise<string> {
	const f = page.frames().find((x: any) => x.url().endsWith("view.html"));
	if (!f) return "no frame";
	return f.evaluate(() => new Promise<string>((done) => {
		const raf = window.requestAnimationFrame.bind(window);
		let n = 0;
		let ms = 0;
		window.requestAnimationFrame = (fn) => (n++, raf((t) => {
			const t0 = performance.now();
			fn(t);
			ms += performance.now() - t0;
		}));
		setTimeout(() => ((window.requestAnimationFrame = raf), done(`${n / 2} frames/s drawn, ${(ms / Math.max(1, n)).toFixed(1)} ms each`)), 2000);
	}));
}

/** The app's CPU over 6 seconds as the system counts it (top, as Activity Monitor shows it), in percent of one core. */
async function cpu(): Promise<number> {
	const pid = await app.evaluate(() => process.pid);
	const top = execFileSync("/usr/bin/top", ["-l", "2", "-s", "6", "-stats", "pid,ppid,cpu,command"], { encoding: "utf8" });
	const rows = top.slice(top.lastIndexOf("PID")).split("\n").map((l) => l.trim().split(/\s+/));
	// The app's own processes: its window, the view's frame, drawing. Not its pine, whose work is the agents'.
	return Math.round(rows.filter((c) => (c[0] === String(pid) || c[1] === String(pid)) && /Electron/.test(c[3] ?? "")).reduce((n, c) => n + Number(c[2]), 0) * 10) / 10;
}

before(async () => {
	if (!on) return;
	mock = await startMock({});
	home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "pine-desktop-perf-")));
	write(path.join(home, "models.json"), JSON.stringify({ providers: { mock: { name: "Mock", baseUrl: mock.baseUrl, api: "openai-completions", apiKey: "sk-mock", models: [{ id: "m", name: "Mock", contextWindow: 128000, maxTokens: 4096, input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }] } } }));
	write(path.join(home, "pine.json"), JSON.stringify({ http: { host: "127.0.0.1", port: 0 }, main: "main", defaults: { model: "mock/m", mode: "safe", introduce: false }, security: { askAccess: false } }));
	for (const id of ["main", "books", "scout", "mail", "house", "gonzo"]) {
		write(path.join(home, "agents", id, "agent.json"), JSON.stringify({ mode: id === "books" ? "bypass" : "safe" }));
		write(path.join(home, "agents", id, "workspace", "AGENTS.md"), `${id}.\n\nYou are ${id}.\n`);
	}
	fs.mkdirSync(path.join(home, "browsers"), { recursive: true });
	write(path.join(home, "desktop-data", "prefs.json"), JSON.stringify({ updates: false }));
	app = await launchApp({ ...process.env, PINE_DESKTOP_HEADLESS: "", PLAYWRIGHT_BROWSERS_PATH: path.join(home, "browsers"), PINE_HOME: home, PINE_DESKTOP_DATA: path.join(home, "desktop-data"), PINE_SKIP_DOWNLOADS: "1", PINE_DESKTOP_DEV_URL: "", PINE_DESKTOP_RELEASES: "" });
	page = await app.firstWindow();
	// In front and drawn: a window in the background is throttled, and would measure nothing.
	await app.evaluate(({ app: a, BrowserWindow }: any) => {
		const w = BrowserWindow.getAllWindows()[0];
		w.setSize(1280, 820);
		w.show();
		a.focus({ steal: true });
		w.focus();
	});
	await page.waitForSelector("[data-slot=empty] h1", { timeout: 30_000 });
	const dialog = await page.waitForSelector("[data-slot=dialog-footer] button >> text=Not now", { timeout: 3000 }).catch(() => undefined);
	if (dialog) await dialog.click();
});

after(async () => {
	await app?.close().catch(() => {});
	await mock?.close?.().catch(() => {});
	if (home) fs.rmSync(home, { recursive: true, force: true });
});

test("what the view costs", { skip: !on && "PINE_PERF=1 to measure" }, async () => {
	const work = async () => {
		for (const agent of ["books", "scout", "mail"]) await call("POST", `/agents/${agent}/prompt`, { prompt: mockMsg([{ delayMs: 9000, text: "done" }]), session: "main", wait: false });
		await new Promise((r) => setTimeout(r, 1500));
	};
	await new Promise((r) => setTimeout(r, 2000));
	const closed = await cpu();
	await menu("view");
	await page.waitForSelector("[data-slot=view-frame][data-ready]", { timeout: 20_000 });
	await new Promise((r) => setTimeout(r, 4000));
	const restDraws = await draws();
	const rest = await cpu();
	await work();
	const busyDraws = await draws();
	const busy = await cpu();
	await new Promise((r) => setTimeout(r, 9000));
	// The window behind another: the view rests.
	await app.evaluate(({ BrowserWindow }: any) => BrowserWindow.getAllWindows()[0].blur());
	await new Promise((r) => setTimeout(r, 2000));
	const behindDraws = await draws();
	const behind = await cpu();
	await app.evaluate(({ app: a, BrowserWindow }: any) => (a.focus({ steal: true }), BrowserWindow.getAllWindows()[0].focus()));
	await menu("view");
	await page.waitForSelector("[data-slot=view-aside]", { state: "detached" });
	await work();
	const closedBusy = await cpu();
	console.log(`\nCPU of the app (window, view, drawing; not pine), percent of one core (top, over 6 s):\n  panel closed, at rest:          ${closed}\n  panel open, at rest:            ${rest}   (${restDraws})\n  panel open, three at work:      ${busy}   (${busyDraws})\n  panel open, at rest, behind:    ${behind}   (${behindDraws})\n  panel closed, three at work:    ${closedBusy}\n`);
});
