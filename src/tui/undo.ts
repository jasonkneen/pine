import os from "node:os";
import type { UndoResult } from "../undo.ts";
import { c } from "./theme.ts";

// What the conversation says after /undo and /redo: which message, which files, and what the
// command could not take back. Said every time, because an undo that is believed to have undone
// more than it did is worse than none.

const tilde = (p: string) => (p === os.homedir() ? "~" : p.startsWith(`${os.homedir()}/`) ? `~${p.slice(os.homedir().length)}` : p);
const plain = (s: string) => s.replace(/[\x00-\x1f\x7f]/g, " ");
const quoted = (s: string) => {
	const line = plain(s).replace(/\s+/g, " ").trim();
	return `“${line.length > 80 ? `${line.slice(0, 79)}…` : line}”`;
};
const files = (n: number) => `${n} file${n === 1 ? "" : "s"}`;

/** The lines about files. `redo`: they are again as the message left them. */
function fileLines(r: UndoResult, redo: boolean): string[] {
	const out: string[] = [];
	const f = r.restored;
	if (f) {
		const n = f.changed + f.removed + f.back;
		const where = tilde(f.root);
		if (!n) out.push(c.gray(redo ? `no file had to be changed in ${where}` : `no file had to be restored in ${where}: the message changed none that pine records`));
		else {
			const parts = [f.changed ? `${f.changed} changed back` : "", f.removed ? `${f.removed} removed` : "", f.back ? `${f.back} brought back` : ""].filter(Boolean).join(", ");
			const names = `${f.files.map(plain).join(", ")}${n > f.files.length ? `, and ${n - f.files.length} more` : ""}`;
			out.push(`${c.green(redo ? `${files(n)} in ${where} ${n === 1 ? "is" : "are"} again as the message left ${n === 1 ? "it" : "them"}` : `${files(n)} restored in ${where}`)}${c.gray(` (${parts}): ${names}`)}`);
		}
		if (f.left.length) out.push(c.yellow(`left as ${f.left.length === 1 ? "it is" : "they are"}, too large to be recorded: ${f.left.slice(0, 8).map(plain).join(", ")}`));
	}
	if (r.note) out.push(c.yellow(r.note));
	return out;
}

/** After /undo. */
export function undoText(r: UndoResult): string {
	if (r.waiting) return `${c.accent("↶ withdrawn before work on it began:")} ${quoted(r.prompt)}\n  ${c.gray("what you wrote is back in the message box: edit it and send it again")}`;
	return [
		`${c.accent("↶ taken back:")} ${quoted(r.prompt)}`,
		...(r.stopped ? [c.gray(`what was still running was stopped first (${r.stopped} task${r.stopped === 1 ? "" : "s"})`)] : []),
		...fileLines(r, false),
		c.gray("not undone: changes made outside this folder, files git ignores, files over 2 MB, and anything that was sent out"),
		c.gray("what you wrote is back in the message box: edit it and send it again"),
		c.gray(`/redo restores it until you send something new${r.more ? " · /undo again to take back the message before it too" : ""}`),
	].map((line, i) => (i ? `  ${line}` : line)).join("\n");
}

/** After /redo. */
export function redoText(r: UndoResult): string {
	return [`${c.accent("↷ brought back:")} ${quoted(r.prompt)}`, ...fileLines(r, true), c.gray(`/undo takes it back again${r.redo ? ` · /redo brings back ${r.redo === 1 ? "one more message" : `${r.redo} more messages`}` : ""}`)].map((line, i) => (i ? `  ${line}` : line)).join("\n");
}
