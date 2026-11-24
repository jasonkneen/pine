import { Type } from "typebox";
import type { SourceType } from "../source-types.ts";
import type { SourceApi } from "../sources.ts";
import { errText, parseDuration } from "../util.ts";
import { capped, clip, found, harmless, lineDiff, pattern, shown } from "../watching.ts";

/**
 * A command, run again and again: reports when what it prints or how it ends changes. For what
 * only a command can tell: free disk space, a build, a branch that moved, a log, whether a
 * machine answers.
 *
 * options: { run, every?, match?, timeout? }
 *   run      the command line, run by bash from the workspace of the agent the source belongs to
 *   every    how often ("1m" by default)
 *   match    watch only what this regular expression finds in what it prints
 *   timeout  how long one run may take ("30s" by default)
 *
 * event "changed": { command, code, previousCode?, value, previous }         with match
 *                  { command, code, previousCode?, added, removed, more? }   without
 *
 * With `follow` the command is started once and kept running, and every line it prints is an
 * event as it comes: for what tells by itself when something happens (tail -F, log stream,
 * docker events, kubectl get -w, a client of some broker).
 *
 *   follow     true: keep the command running and report its lines; `every` is not used
 *   perMinute  with follow: at most this many lines a minute (30 by default); the rest are counted
 *
 * event "line":  { command, line, value?, dropped? }   value: what `match` found, or the line as JSON if it is JSON
 * event "ended": { command, code, error?, ran }        it ended and is started again; not repeated while it ends at once every time
 *
 * The command runs in the sandbox of that agent's shell: it reaches what the agent reaches and
 * nothing else. The first run is the starting point and reports nothing.
 */
const MIN = 5000;
/** A followed command that ended is started again after a pause that grows with each end in a row. */
const AGAIN = [250, 500, 1000, 2000, 5000, 15_000, 60_000, 300_000];
/** A run shorter than this that follows another such run is the same trouble, not news. */
const BRIEF = 5000;

export const type: SourceType = {
	summary: "a command run again and again: reports when what it prints, or how it ends (the exit code), changes. For what only a command can tell: free disk space, a build, a branch that moved, a log, whether a machine answers. It runs like a command in your own shell, with the same limits",
	options: Type.Object(
		{
			run: Type.String({ description: 'the command line, run by bash from your workspace, e.g. "df -h /" or "git -C ~/dev/app rev-parse origin/main". One that only looks: it runs unattended, again and again' }),
			every: Type.Optional(Type.String({ description: 'how often to run it, e.g. "1m", "1h". Default "1m", at least "5s"' })),
			match: Type.Optional(Type.String({ description: 'watch only what this regular expression finds in what it prints (the first group, if there is one), e.g. "([0-9]+)% used". Without it everything it prints counts' })),
			timeout: Type.Optional(Type.String({ description: 'how long one run may take before it is stopped. Default "30s"' })),
			follow: Type.Optional(Type.Boolean({ description: 'true for a command that keeps running and prints a line whenever something happens ("tail -n0 -F app.log", "log stream --predicate ...", "docker events"): it is started once, and every line it prints is reported as it comes. "every" and "timeout" are not used then. Not on Linux' })),
			perMinute: Type.Optional(Type.Number({ description: "with follow: report at most this many lines a minute, the rest are counted and left out. Default 30" })),
		},
		{ additionalProperties: false },
	),
	plan(o, setup) {
		const run = String(o.run ?? "").trim();
		if (!run) throw new Error(`needs "run": the command line`);
		if (run.length > 2000) throw new Error("that command line is too long: put it into a script in your workspace and run that");
		if (o.match) pattern(o.match);
		if (o.follow === true) {
			if (o.every !== undefined || o.timeout !== undefined) throw new Error('a command that is followed runs all the time: leave "every" and "timeout" out');
			if (process.platform === "linux") throw new Error('"follow" does not work on Linux: the sandbox there cleans up after a command, and a followed command does not end. Leave "follow" out and give "every": the command is then run again and again');
			const perMinute = o.perMinute ?? 30;
			if (!(perMinute >= 1 && perMinute <= 600)) throw new Error('"perMinute" is a number from 1 to 600');
			return {
				options: { ...o, run },
				does: [`start this command and keep it running, unattended, with the rights of ${setup.agent}'s shell (the agent's sandbox): ${run}`, `report ${o.match ? `every line it prints in which /${o.match}/ finds something` : "every line it prints"}, at most ${perMinute} a minute`, "start it again whenever it ends"],
				opens: true,
				tell: "It runs from now on; what it prints from here on is reported, line by line. The sources tool shows whether it is running.",
			};
		}
		if (o.perMinute !== undefined) throw new Error('"perMinute" is for a command that is followed ("follow": true)');
		const every = o.every ?? "1m";
		if (parseDuration(every) < MIN) throw new Error('"every" must be at least "5s"');
		if (o.timeout && parseDuration(o.timeout) < 1000) throw new Error('"timeout" must be at least "1s"');
		return {
			options: { ...o, run },
			does: [`run this command every ${every}, unattended, with the rights of ${setup.agent}'s shell (the agent's sandbox): ${run}`, `report when ${o.match ? `what /${o.match}/ finds in what it prints` : "what it prints"} or the exit code changes`],
			opens: true,
			tell: "The first run is the starting point and reports nothing; from then on only a change does. The sources tool shows how the last run went.",
		};
	},
};

export default function command(source: SourceApi): void {
	const o = source.options;
	const run = typeof o.run === "string" ? o.run.trim() : "";
	if (!run) throw new Error(`needs "run": the command line`);
	const re = o.match ? pattern(String(o.match)) : undefined;
	if (o.follow === true) return void following(source, run, re);
	const timeoutMs = parseDuration(o.timeout ?? "30s");

	source.poll(o.every ?? "1m", async (signal) => {
		const { code, output } = await source.exec(run, { timeoutMs, signal });
		const text = output.replace(/\r\n/g, "\n").trimEnd().slice(0, 200_000);
		if (re) {
			const value = found(re, text);
			source.status(`exit ${code}, ${value === null ? "found nothing with the pattern" : `now: ${harmless(value)}`}`);
			const was = source.changed({ code, value });
			if (was) source.emit("changed", { command: clip(run, 300), code, value, previous: shown(was.previous.value), ...(was.previous.code !== code ? { previousCode: was.previous.code } : {}) });
			return;
		}
		source.status(`exit ${code}, ${text ? text.split("\n").length : 0} lines`);
		const was = source.changed({ code, text });
		if (!was) return;
		const diff = lineDiff(String(was.previous.text ?? ""), text);
		if (diff.added.length || diff.removed.length || was.previous.code !== code) source.emit("changed", { command: clip(run, 300), code, ...(was.previous.code !== code ? { previousCode: was.previous.code } : {}), ...diff });
	});
}

const clock = () => new Date().toTimeString().slice(0, 8);

/** Wait, but not longer than the source lives. */
const pause = (ms: number, signal: AbortSignal) =>
	new Promise<void>((resolve) => {
		if (signal.aborted) return resolve();
		const done = () => {
			clearTimeout(timer);
			signal.removeEventListener("abort", done);
			resolve();
		};
		const timer = setTimeout(done, ms);
		signal.addEventListener("abort", done, { once: true });
	});

/** Keep a command running and report what it prints. It is started again when it ends, a little later each time it ends at once. */
function following(source: SourceApi, run: string, re: RegExp | undefined): void {
	const cap = capped(Number(source.options.perMinute ?? 30));
	const stop = new AbortController();
	source.onStop(() => stop.abort());
	let lines = 0;
	const line = (text: string) => {
		// What a terminal would act on is not text.
		const clean = text.replace(/\x1b\[[0-9;?]*[A-Za-z]|[\x00-\x08\x0b-\x1f\x7f]/g, "");
		let value: unknown;
		if (re) {
			value = found(re, clean);
			if (value === null) return;
		} else if (/^\s*[[{]/.test(clean)) {
			try {
				value = JSON.parse(clean);
			} catch {
				// a line that only looks like JSON
			}
		}
		if (!cap.ok()) return;
		lines++;
		const dropped = cap.dropped();
		source.emit("line", { command: clip(run, 300), line: clip(clean, 2000), ...(value !== undefined ? { value: shown(value) } : {}), ...(dropped ? { dropped } : {}) });
	};
	void (async () => {
		let fails = 0;
		let wasBrief = false;
		while (!stop.signal.aborted) {
			const from = Date.now();
			source.status(`running since ${clock()}, ${lines} ${lines === 1 ? "line" : "lines"} reported`);
			let code: number | undefined;
			let error = "";
			try {
				({ code, error } = await source.follow(run, line, { signal: stop.signal }));
			} catch (e) {
				if (stop.signal.aborted) return;
				error = errText(e);
			}
			const ran = Date.now() - from;
			const brief = ran < BRIEF;
			// Said when it ends, but not again and again for a command that ends the moment it is started.
			if (!(brief && wasBrief)) source.emit("ended", { command: clip(run, 300), ...(code !== undefined ? { code } : {}), ...(error ? { error: clip(error, 600) } : {}), ran: Math.round(ran / 1000) });
			wasBrief = brief;
			fails = brief ? fails + 1 : 0;
			source.status(`ended at ${clock()}${code !== undefined ? ` with exit ${code}` : ""}, ${code === undefined ? "could not be started" : "starting it again"}`);
			await pause(AGAIN[Math.min(fails, AGAIN.length - 1)], stop.signal);
		}
	})();
}
