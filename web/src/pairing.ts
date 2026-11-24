// A paired computer, as the web bridge knows it: its machine id (the fingerprint of the host key of
// the computer that runs the Pine app), the pairing link the app's QR code carries, and the pairing
// request the app's access server answers. The link's fragment is the one place a host key comes
// from without the owner's press on "Trust this key": the owner scanned it at that computer, which
// is what makes it that computer's. The browser does not know what kind of computer it is: until it
// is paired it says "your computer", then the name the computer gave.
import { MACHINE_ID, YOUR_COMPUTER } from "../../desktop/src/machines.ts";
import { base64, type Channel, type Connection } from "./ssh.ts";

/** A pairing code: 16 random bytes, base64url without padding. */
const PAIR_CODE = /^[A-Za-z0-9_-]{22}$/;
/** The SSH user of a paired browser's session, and of a pairing session (`pair.<code>`). */
export const PAIRED_USER = "pine";
export const pairUser = (code: string) => `pair.${code}`;

export type PairLink = { id: string; code: string };

/** The host key fingerprint a machine id stands for, as OpenSSH prints it (`SHA256:` and base64). */
export const pairedFingerprint = (id: string) => `SHA256:${id.replace(/-/g, "+").replace(/_/g, "/")}`;

/**
 * The pairing link in `address`'s fragment (`#pair=<machine id>.<code>`), taken out of the address
 * at once with `replace` (history.replaceState), so that the code is in no address the browser
 * keeps, malformed or not. A malformed one is ignored, with a message for the console.
 */
export function takePairLink(address: { href: string; hash: string }, replace: (url: string) => void): { link?: PairLink; problem?: string } {
	// Read before it is replaced: `location` says the new address at once.
	const { href, hash } = address;
	if (!hash.startsWith("#pair=")) return {};
	replace(href.slice(0, href.indexOf("#")));
	const [id, code, ...more] = hash.slice("#pair=".length).split(".");
	if (more.length || !MACHINE_ID.test(id ?? "") || !PAIR_CODE.test(code ?? "")) return { problem: "That pairing link is not one this page can read: it was ignored. Open Pine on your computer and add this device again." };
	return { link: { id, code } };
}

/** A name to be shown as text: no control characters, at most 60 characters. */
export const cleanName = (name: string) => name.replace(/[\0-\x1f\x7f-\x9f]/g, "").trim().slice(0, 60);

/** This browser's name for the paired computer to show: the browser and the system, from the user agent ("Chrome on Android"). */
export function deviceName(userAgent: string): string {
	const browser = [
		[/Edg(A|iOS)?\//, "Edge"],
		[/OPR\/|Opera/, "Opera"],
		[/Firefox\/|FxiOS\//, "Firefox"],
		[/Chrome\/|CriOS\//, "Chrome"],
		[/Version\/[\d.]+.*Safari\//, "Safari"],
	].find(([pattern]) => (pattern as RegExp).test(userAgent))?.[1];
	const system = [
		[/Android/, "Android"],
		[/iPhone/, "iPhone"],
		[/iPad/, "iPad"],
		[/CrOS/, "ChromeOS"],
		[/Macintosh|Mac OS X/, "Mac"],
		[/Windows/, "Windows"],
		[/Linux/, "Linux"],
	].find(([pattern]) => (pattern as RegExp).test(userAgent))?.[1];
	if (!browser || !system) return "A web browser";
	return cleanName(`${browser} on ${system}`);
}

/** The pairing request: `pine-pair` and the base64url of `{"name": ...}`. */
export function pairCommand(name: string): string {
	const json = new TextEncoder().encode(JSON.stringify({ name: cleanName(name) }));
	return `pine-pair ${base64(json).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "")}`;
}

export type PairAnswer = { ok: true; name: string } | { ok: false; reason: "refused" | "expired" };

/**
 * Runs the pairing request on a pairing session and waits for the owner's answer at the computer.
 * `onCode` is told the four digits the computer shows beside this browser's name, and the computer's
 * name when it gives it with them (`computer`, cleaned; none: an older Pine app). A channel that
 * ends without an answer counts as expired. A yes without a name is kept as "your computer".
 */
export async function askToPair(connection: Connection, name: string, onCode: (code: string, computer?: string) => void): Promise<PairAnswer> {
	const channel: Channel = await connection.exec(pairCommand(name));
	return new Promise<PairAnswer>((resolve) => {
		let text = "";
		const decoder = new TextDecoder();
		channel.onData((bytes) => {
			text += decoder.decode(bytes, { stream: true });
			for (let end = text.indexOf("\n"); end >= 0; end = text.indexOf("\n")) {
				const line = text.slice(0, end);
				text = text.slice(end + 1);
				let said: { code?: unknown; computer?: unknown; ok?: unknown; name?: unknown; reason?: unknown };
				try {
					said = JSON.parse(line);
				} catch {
					continue;
				}
				if (typeof said.code === "string" && /^\d{4}$/.test(said.code)) onCode(said.code, (typeof said.computer === "string" && cleanName(said.computer)) || undefined);
				else if (said.ok === true) resolve({ ok: true, name: cleanName(typeof said.name === "string" ? said.name : "") || YOUR_COMPUTER });
				else if (said.ok === false) resolve({ ok: false, reason: said.reason === "refused" ? "refused" : "expired" });
			}
		});
		void channel.closed.then(() => resolve({ ok: false, reason: "expired" }));
	});
}
