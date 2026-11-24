// Pairing: how a new key gets onto the access server's list. The owner opens a pairing at the
// computer and gets a link that carries this computer's machine id and a one-time code. A browser
// that connects with that code under the user name `pair.<code>` may run one command, the pairing request, which
// names the device. It is shown four digits, the owner is asked with the device's name and the same
// digits, and only the owner's yes stores the key. No Electron here: the owner's question is a
// function the caller hands in (a toast in the app, a direct answer in the tests).
//
// A device on the same network may also ask without a code (ADR 0005): it found this computer's
// machine id in its announcement and connects under the user name `nearby`, then makes the same
// request. That is let in only while the owner keeps this computer visible on the network, one
// request at a time, never in the 30 seconds after the owner refused one, and never for an hour
// after three refusals in ten minutes. Whatever is refused that way is refused without a word: only
// a request that reaches the owner shows anything.
import { createHash, randomBytes, randomInt, timingSafeEqual } from "node:crypto";
import os from "node:os";
import type { ServerChannel } from "ssh2";
import { type Admission, type Admit, type Key, pairedKeys } from "./server.ts";
import { type AccessStore, cleanName, type Device } from "./store.ts";

/** How long a pairing's code works, from the moment it is opened. */
export const PAIRING_MS = 2 * 60_000;
/** How long a pairing request waits for the owner's answer. */
export const ANSWER_MS = 2 * 60_000;
/** Wrong codes that close a pairing. */
export const WRONG_CODES = 5;
/** The user name prefix of a pairing session; a paired session is `pine`. */
export const PAIR_USER = "pair.";
/** The command of the pairing request: this word, a space, and base64url of `{"name": string}`. */
export const PAIR_COMMAND = "pine-pair";
/** The name of a device that gave none that can be shown. */
export const NO_NAME = "Unnamed device";
/** The prefix of the id a pairing session has in the access server's reports and for `cut`. */
export const PAIRING_ID = "pairing:";
/**
 * The user name of a codeless pairing session, from a device that found this computer on the network:
 * this word, a dot, and the nonce of the announcement it heard (`nearby.<nonce>`).
 */
export const NEARBY_USER = "nearby";
/** How long codeless requests are refused after the owner refused one. */
export const NEARBY_PAUSE_MS = 30_000;
/** Refusals of codeless requests within `NEARBY_WINDOW_MS` that suspend the announcement for `NEARBY_SUSPEND_MS`. */
export const NEARBY_REFUSALS = 3;
export const NEARBY_WINDOW_MS = 10 * 60_000;
export const NEARBY_SUSPEND_MS = 60 * 60_000;
/** How long a codeless session that was let in has to make its request: its place is the only one. */
export const NEARBY_REQUEST_MS = 10_000;
/** The least time between two codeless sessions let in, so that one that never asks cannot hold the place without a break. */
export const NEARBY_GAP_MS = 3_000;
/** A nonce of the announcement: 16 random bytes, base64url. */
const NONCE = /^[A-Za-z0-9_-]{22}$/;

/** Why a request did not end in a pairing: the owner said no, time ran out, the device left, the owner closed the pairing. */
export type Ended = "refused" | "expired" | "closed" | "cancelled";

/**
 * What the owner is asked about: the device's name as plain text, the four digits its screen shows,
 * and how it came: with a pairing's code (`code`), or from the network without one (`nearby`).
 */
export interface PairingRequest {
	/** Which question this is: the owner's answer names it, so that it never goes to another one. */
	id: string;
	name: string;
	code: string;
	kind?: "code" | "nearby";
}

/**
 * The owner's decision: true allows the device. `signal` is aborted when the question no longer
 * stands, with the reason (`Ended`) as `signal.reason`, so that a dialog can close and say why.
 */
export type Ask = (request: PairingRequest, signal: AbortSignal) => Promise<boolean>;

export interface PairingOptions {
	store: AccessStore;
	/** The address of the web client and the meeting service: the link's origin. */
	service: string;
	ask: Ask;
	/** Ends the access server's sessions of an id (`AccessServer.cut`): closes a pairing's session when it is cancelled. */
	cut: (id: string) => void;
	/** The name the browser stores for this computer. */
	computerName?: () => string;
	/** A device was paired (the app's notification). */
	paired?: (device: Device) => void;
	pairingMs?: number;
	answerMs?: number;
	/** The least time between two codeless sessions (`NEARBY_GAP_MS`; the native cores' helper sets none, its tests ask in a row). */
	nearbyGapMs?: number;
	/**
	 * Whether a codeless request may come in now: browser access on, and the owner keeps this computer
	 * visible on the network. Left out: never.
	 */
	nearby?: () => boolean;
	/** Codeless requests were suspended after too many refusals, until then (the app's toast). */
	suspended?: (until: Date) => void;
	/** The clock the pause and the suspension are counted on (a test's own). */
	now?: () => number;
}

/** An open pairing, as the settings show it: the link (the QR code encodes it) and when it stops working. */
export interface Opened {
	link: string;
	expires: Date;
}

export interface Pairing {
	/** Opens a pairing, closing the one that was open. */
	open(): Opened;
	/** Closes the open pairing: its code stops working, a question to the owner is withdrawn and its session is closed. */
	cancel(): void;
	/** The open pairing whose code still works. */
	current(): Opened | undefined;
	/** The access server's decision: paired keys as `pine`, an unknown key with the open pairing's code, and a codeless request while it is let in. */
	admit: Admit;
	/** Until when codeless requests are suspended after too many refusals; none when they are not. */
	suspendedUntil(): Date | undefined;
	/** The owner turned visibility back on: the suspension, the pause and the refusals counted so far are forgotten. */
	resume(): void;
	/** The nonce the announcement carries now; a codeless request names it, or the one before it. */
	nearbyNonce(): string;
	/** A new nonce (the app does it every few minutes while it announces): the one before still works, the older one no longer. */
	rotateNearbyNonce(): void;
}

/** A request under way: an open pairing's, or a codeless one's (`kind`). */
interface Open {
	kind: "code" | "nearby";
	opened: Opened;
	/** The SHA-256 of the code: compared in constant time, and of the same length whatever a client sends. */
	digest: Buffer;
	/** Wrong codes so far. */
	wrong: number;
	/** The code was presented (or a codeless session let in): the pairing is used, and this is its session. */
	session?: string;
	/** The pairing request was made (one per pairing). */
	asked?: boolean;
	/** The owner answered: nothing is withdrawn after that. */
	decided?: boolean;
	/** Withdraws the question to the owner. */
	abort: AbortController;
	timer: ReturnType<typeof setTimeout>;
}

const digestOf = (code: string) => createHash("sha256").update(code, "utf8").digest();

/** The longest pairing request read: a name of 60 characters needs far less. */
const MAX_REQUEST = 4096;

/** The device's name from a pairing request, or undefined when it is no request. */
function requested(command: string): string | undefined {
	if (command.length > MAX_REQUEST || !command.startsWith(`${PAIR_COMMAND} `)) return undefined;
	const body = command.slice(PAIR_COMMAND.length + 1);
	if (!/^[A-Za-z0-9_-]+$/.test(body)) return undefined;
	try {
		const said = JSON.parse(Buffer.from(body, "base64url").toString("utf8"));
		if (typeof said?.name !== "string") return undefined;
		return cleanName(said.name) || NO_NAME;
	} catch {
		return undefined;
	}
}

export function createPairing(options: PairingOptions): Pairing {
	const pairingMs = options.pairingMs ?? PAIRING_MS;
	const answerMs = options.answerMs ?? ANSWER_MS;
	const computerName = options.computerName ?? (() => os.hostname());
	const paired = pairedKeys(options.store);
	const clock = options.now ?? Date.now;
	let open: Open | undefined;
	/** The one codeless request let in, from its session's start to its end. */
	let nearby: Open | undefined;
	/** Codeless requests are refused until then (after a refusal), and until `suspendedUntil` (after too many). */
	let pausedUntil = 0;
	let suspendedUntil = 0;
	/** When the owner refused codeless requests (or a requester hung up or let one expire), within the last `NEARBY_WINDOW_MS`. */
	let refusals: number[] = [];
	/** When the last codeless session was let in. */
	let lastNearby = -Infinity;
	/** The announcement's nonce and the one before it, as digests: compared in constant time. */
	const fresh = () => randomBytes(16).toString("base64url");
	let nonce = fresh();
	let nonces: Buffer[] = [digestOf(nonce)];

	/**
	 * A codeless request ended without a yes: the owner refused it, or the requester hung up or let it
	 * expire after it was shown (otherwise hanging up would ask again and again for free). A pause, and
	 * after too many in a short time the suspension.
	 */
	const refusedNearby = () => {
		const now = clock();
		pausedUntil = now + NEARBY_PAUSE_MS;
		refusals = [...refusals.filter((at) => now - at < NEARBY_WINDOW_MS), now];
		if (refusals.length < NEARBY_REFUSALS) return;
		refusals = [];
		suspendedUntil = now + NEARBY_SUSPEND_MS;
		options.suspended?.(new Date(suspendedUntil));
	};

	const close = (which: Open, why: Ended) => {
		clearTimeout(which.timer);
		if (open === which) open = undefined;
		if (nearby === which) {
			nearby = undefined;
			if (why === "refused" || (which.asked && (why === "closed" || why === "expired"))) refusedNearby();
		}
		if (!which.decided) {
			which.decided = true;
			which.abort.abort(why);
		}
		// A session that made its request is told why on its channel first, and cut when that channel closes.
		if (which.session && (why === "cancelled" || why === "closed" || !which.asked)) options.cut(which.session);
	};

	/** The pairing request on the pairing's one session: four digits, the owner's answer, and the key stored or not. */
	function request(which: Open, key: Key, command: string, accept: () => ServerChannel): boolean {
		const name = requested(command);
		// One request per pairing: a second exec on the same session is refused.
		if (name === undefined || which.abort.signal.aborted || which.asked) return false;
		// One question at a time, whichever came first: a codeless one never stands beside a code's, nor the reverse.
		const other = which.kind === "nearby" ? open : nearby;
		if (other?.asked && !other.decided) return false;
		which.asked = true;
		const channel = accept();
		const code = String(randomInt(0, 10_000)).padStart(4, "0");
		const signal = which.abort.signal;
		const finish = (ok: boolean, line: object) => {
			if (channel.destroyed) return;
			channel.write(`${JSON.stringify(line)}\n`);
			channel.exit(ok ? 0 : 1);
			channel.end();
		};
		channel.on("error", () => {});
		channel.on("data", () => {});
		channel.once("close", () => close(which, "closed"));
		clearTimeout(which.timer);
		which.timer = setTimeout(() => close(which, "expired"), answerMs);
		// The device is told this computer's name with the digits: it found it by a machine id alone.
		// And the meeting service it is reached at, said by the computer that holds the key: a phone keeps this
		// one, never what an announcement on the network said.
		channel.write(`${JSON.stringify({ code, computer: computerName(), service: options.service.replace(/\/+$/, "") })}\n`);

		const withdrawn = new Promise<false>((resolve) => signal.addEventListener("abort", () => resolve(false), { once: true }));
		Promise.race([Promise.resolve().then(() => options.ask({ id: randomBytes(9).toString("base64url"), name, code, kind: which.kind }, signal)), withdrawn])
			.then(async (yes) => {
				if (!signal.aborted) which.decided = true;
				if (signal.aborted) return finish(false, { ok: false, reason: signal.reason === "expired" ? "expired" : "refused" });
				if (yes !== true) {
					finish(false, { ok: false, reason: "refused" });
					return close(which, "refused");
				}
				clearTimeout(which.timer);
				const device = await options.store.add({ key: key.data, name });
				finish(true, { ok: true, name: computerName() });
				if (open === which) open = undefined;
				if (nearby === which) nearby = undefined;
				options.paired?.(device);
			})
			.catch(() => {
				which.decided = true;
				finish(false, { ok: false, reason: "refused" });
				close(which, "refused");
			});
		return true;
	}

	/** Whether the owner is being asked about a device now, or a codeless session holds its place. */
	const busy = () => Boolean(nearby || (open?.asked && !open.decided));

	/** A codeless request: let in only while it may come, one at a time, outside the pause and the suspension. Refused without a word. */
	const admitNearby = (given: string, key: Parameters<Admit>[1]) => {
		const now = clock();
		// Only a device that heard the announcement knows its nonce: the machine id alone, which old links carry, is not enough.
		const heard = NONCE.test(given) && nonces.some((d) => timingSafeEqual(digestOf(given), d));
		if (!heard || !options.nearby?.() || busy() || now < pausedUntil || now < suspendedUntil || now - lastNearby < (options.nearbyGapMs ?? NEARBY_GAP_MS)) return false;
		lastNearby = now;
		const which: Open = { kind: "nearby", opened: { link: "", expires: new Date(now + NEARBY_REQUEST_MS) }, digest: Buffer.alloc(0), wrong: 0, abort: new AbortController(), timer: setTimeout(() => close(which, "expired"), NEARBY_REQUEST_MS) };
		which.session = `${PAIRING_ID}${randomBytes(9).toString("base64url")}`;
		nearby = which;
		const admission: Admission = { id: which.session, pine: false, exec: (command, accept) => request(which, key, command, accept), left: () => close(which, "closed") };
		return admission;
	};

	const admit: Admit = (user, key) => {
		if (user.startsWith(`${NEARBY_USER}.`)) return admitNearby(user.slice(NEARBY_USER.length + 1), key);
		if (!user.startsWith(PAIR_USER)) return paired(user, key);
		const which = open;
		// A wrong code, or a code with no pairing open, closes the connection.
		if (!which || which.session || Date.now() >= which.opened.expires.getTime()) return false;
		if (!timingSafeEqual(digestOf(user.slice(PAIR_USER.length)), which.digest)) {
			if (++which.wrong >= WRONG_CODES) close(which, "cancelled");
			return false;
		}
		// The first connection that presents the code consumes it.
		which.session = `${PAIRING_ID}${randomBytes(9).toString("base64url")}`;
		const admission: Admission = { id: which.session, pine: false, exec: (command, accept) => request(which, key, command, accept) };
		return admission;
	};

	return {
		open() {
			if (open) close(open, "cancelled");
			const code = randomBytes(16).toString("base64url");
			const opened = { link: `${options.service.replace(/\/+$/, "")}/#pair=${options.store.machineId()}.${code}`, expires: new Date(Date.now() + pairingMs) };
			const which: Open = { kind: "code", opened, digest: digestOf(code), wrong: 0, abort: new AbortController(), timer: setTimeout(() => close(which, "expired"), pairingMs) };
			open = which;
			return { ...opened };
		},
		cancel() {
			if (open) close(open, "cancelled");
		},
		current() {
			if (!open || open.session || Date.now() >= open.opened.expires.getTime()) return undefined;
			return { ...open.opened };
		},
		admit,
		suspendedUntil: () => (clock() < suspendedUntil ? new Date(suspendedUntil) : undefined),
		resume() {
			suspendedUntil = 0;
			pausedUntil = 0;
			refusals = [];
		},
		nearbyNonce: () => nonce,
		rotateNearbyNonce() {
			nonce = fresh();
			nonces = [digestOf(nonce), nonces[0]];
		},
	};
}
