// `npm test` in desktop/: builds the app once for this run, into a temp folder of its own, then
// runs `node --test` with the arguments given here and PINE_DESKTOP_APP naming that build
// (test/support/app.ts launches it). A test file run on its own builds for itself instead.
//   node scripts/test.mjs [node --test arguments]
//
// A run keeps to itself, on a computer that is being used:
// - The apps it starts have no window on the screen (test/support/app.ts).
// - Everything its tests write lies in the run's folder (TMPDIR), which is removed at the end,
//   and a process a test left behind (an app, a daemon) is ended then: its command line names
//   that folder.
// - How many files run side by side follows the computer: fewer when it is busy already
//   (`sideBySide`; `--test-concurrency=<n>` says it by hand).
// - A file with a failure is run again, alone. Most failures of these tests on a busy computer are
//   a wait that ran out; one that passes alone is said to be that, by name, and the run passes.
import { execFileSync, spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { buildApp } from "./build.mjs";
import { whenParentGone } from "./leash.mjs";

const root = path.resolve(import.meta.dirname, "..");
const into = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "pine-desktop-app-")));
/** Where the tests of this run make their homes and folders. A short name: the socket of an ssh connection lies under it, and a socket's path has a limit. */
const temp = path.join(into, "t");
fs.mkdirSync(temp);
/** Written by scripts/failed-files.mjs: the files in which a test failed, one a line. */
const failedList = path.join(into, "failed");
let child;
let leaving = false;

/** Ends what a test of this run started and left running. Returns how many there were. */
function sweep() {
	if (process.platform === "win32") return 0;
	const mark = path.basename(into);
	let ended = 0;
	for (let pass = 0; pass < 3; pass++) {
		let found = [];
		try {
			const table = execFileSync("/bin/ps", ["-A", "-o", "pid=,command="], { encoding: "utf8", maxBuffer: 32 * 1024 * 1024 });
			found = table.split("\n").map((line) => /^\s*(\d+)\s+(.*)$/.exec(line)).filter((m) => m && m[2].includes(mark) && Number(m[1]) !== process.pid).map((m) => Number(m[1]));
		} catch {
			// no ps: nothing is swept
		}
		if (!found.length) break;
		ended += found.length;
		for (const pid of found) {
			try {
				process.kill(pid, "SIGKILL");
			} catch {
				// gone by itself
			}
		}
		// A moment for what was ended to be gone, and for what it had started to show.
		Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 200);
	}
	return ended;
}

process.once("exit", () => {
	const ended = sweep();
	if (ended) console.error(`${ended} process${ended === 1 ? "" : "es"} that the tests left running ${ended === 1 ? "was" : "were"} ended.`);
	fs.rmSync(into, { recursive: true, force: true, maxRetries: 3 });
});

// Whoever started the run is gone, or it was interrupted: the tests and their apps go with it.
whenParentGone(() => {
	leaving = true;
	if (!child || child.exitCode !== null) process.exit(1);
	child.kill("SIGTERM");
	setTimeout(() => child.kill("SIGKILL"), 10_000).unref();
});

/**
 * Files side by side: each is an app, a daemon and a model server, so one for every two processors
 * that are idle right now, six at most and two at least. Measured over a quarter of a second: the
 * load average would still count a run that has just ended.
 */
async function sideBySide() {
	const look = () => os.cpus().reduce((sum, c) => ({ idle: sum.idle + c.times.idle, all: sum.all + c.times.user + c.times.nice + c.times.sys + c.times.idle + c.times.irq }), { idle: 0, all: 0 });
	const a = look();
	await new Promise((r) => setTimeout(r, 250));
	const b = look();
	const idle = b.all > a.all ? (b.idle - a.idle) / (b.all - a.all) : 1;
	return Math.max(2, Math.min(6, Math.floor((os.availableParallelism() * idle) / 2)));
}

const given = process.argv.slice(2);
const has = (flag) => given.some((a) => a === flag || a.startsWith(`${flag}=`));
/** Somebody who names a reporter gets that reporter and nothing beside it, so no second run either. */
const plain = !has("--test-reporter");
const reporters = plain ? ["--test-reporter=spec", "--test-reporter-destination=stdout", `--test-reporter=${path.join(root, "scripts", "failed-files.mjs")}`, "--test-reporter-destination=stdout"] : [];

function run(args, env) {
	child = spawn(process.execPath, ["--test", ...reporters, ...args], { stdio: "inherit", cwd: root, env });
	return new Promise((resolve) => child.on("close", (c, signal) => resolve(c ?? (signal ? 1 : 0))));
}

const failed = () => {
	try {
		return [...new Set(fs.readFileSync(failedList, "utf8").split("\n").filter(Boolean))];
	} catch {
		return [];
	}
};
const short = (files) => files.map((f) => path.relative(root, f)).join(", ");

try {
	// Before the build, which keeps the processors busy itself.
	const lanes = has("--test-concurrency") ? [] : [`--test-concurrency=${await sideBySide()}`];
	const app = await buildApp(into);
	if (leaving) throw new Error("stopped before the tests started");
	const env = { ...process.env, PINE_DESKTOP_APP: app, TMPDIR: temp, PINE_DESKTOP_FAILED: failedList };
	let code = await run([...lanes, ...given], env);
	const files = failed();
	// More than a few files failing is no busy computer: that is said as it is.
	if (code !== 0 && plain && !leaving && files.length && files.length <= 4) {
		console.log(`\nFailed: ${short(files)}. Running ${files.length === 1 ? "it" : "them"} again, one at a time, to tell a broken test from a wait that ran out on a busy computer.\n`);
		sweep();
		fs.rmSync(failedList, { force: true });
		const flags = given.filter((a) => a.startsWith("--") && !a.startsWith("--test-concurrency"));
		code = await run(["--test-concurrency=1", ...flags, ...files], env);
		if (code === 0) console.log(`\nPassed alone: ${short(files)}. The failures above came with running beside other work; a test that fails this way often is worth a look all the same.`);
		else console.log(`\nFailed again, alone: ${short(failed())}.`);
	}
	process.exit(leaving ? 1 : code);
} catch (e) {
	console.error(`The app could not be built for the tests: ${e instanceof Error ? e.message : e}`);
	process.exit(1);
}
