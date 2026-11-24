import dns from "node:dns";
import net from "node:net";
import { Type } from "typebox";
import { type Agent, fetch, ping, WebSocket } from "undici";
import { isLocalHost, publicOnlyAgent, reachOptions } from "../net.ts";
import type { SourceType } from "../source-types.ts";
import type { SourceApi } from "../sources.ts";
import { errText, getPath } from "../util.ts";
import { capped, clip, found, pattern, shown } from "../watching.ts";

/**
 * A service that pushes: it is connected to once and then says by itself when something happens,
 * over Server-Sent Events (one long answer to a web request) or over a WebSocket. For what would
 * otherwise have to be asked again and again, and for services whose only way out is such a
 * stream: ntfy, Gotify, Home Assistant, Mastodon, a webhook relay, a ticker.
 *
 * options: { url, kind?, hello?, token?, tokenHeader?, headers?, event?, path?, match?, changed?, perMinute?, local? }
 *   kind       "sse" or "websocket". Not given: by the address (ws:// and wss:// are a WebSocket)
 *   hello      for a WebSocket: what is sent after connecting, one message or a list. {{token}} in it is the token
 *   event      for SSE: only events of this name
 *   path       for messages in JSON: only this field of each
 *   match      only messages this regular expression finds; its first group, if it has one, is the value
 *   changed    report a value only when it differs from the last one
 *   perMinute  at most this many reports a minute (30 by default); the rest are counted and dropped
 *
 * event "message": { value, event?, id?, previous?, dropped? }
 * event "down":    { url, error }    after three attempts in a row that did not connect
 * event "up":      { url }           when it is connected again
 *
 * This file also holds what the types that keep a connection open share (slack, matrix, discord):
 * the loop that connects again, one WebSocket from open to close, and what a status line may say.
 */

const MAX_PAUSE = 5 * 60_000;
/** A connection that lasted this long was a working one: the next attempt starts from the short pause again. */
const SETTLED = 30_000;
const DOWN_AFTER = 3;
const MAX_MESSAGE = 256 * 1024;
/** A stream that says nothing for this long is taken for dead and connected to again. */
const SILENCE = 5 * 60_000;
/** How often a WebSocket is pinged, so that a connection that died without a word is noticed by the system. */
const PING = 45_000;

export const clock = (ts = Date.now()) => new Date(ts).toTimeString().slice(0, 8);

/** This computer itself. What runs here is back quickly when it was restarted, so it is asked again quickly. */
const loopback = (host: string) => ["localhost", "127.0.0.1", "::1"].includes(host.replace(/^\[|\]$/g, "").toLowerCase());

/** The first pause before connecting again to a host: a second, or a twentieth of one for this computer. */
export const firstPause = (host: string) => (loopback(host) ? 50 : 1000);

/**
 * What a service said, as a status line may repeat it. A status line is read by agents without
 * the mark that outside content gets, so only a code or a single word is passed on.
 */
export const word = (v: unknown) => {
	const s = String(v ?? "");
	return /^[\w.:-]{1,48}$/.test(s) ? s : `an answer of ${s.length} characters`;
};

/** An error pine words itself: what it says may be shown where the sources are listed. */
export class Plain extends Error {}

/** Why a connection failed, in words that are pine's own or the system's. */
function why(e: unknown): string {
	if (e instanceof Plain) return e.message;
	const cause: any = (e as any)?.cause ?? e;
	const text = errText(cause);
	if (/resolves to a private address|leads to an address on your own network/.test(text)) return `the address leads into your own network. If that is meant, set the source up again with "local": true`;
	if (/BODY_TIMEOUT/.test(String(cause?.code))) return "nothing came for five minutes";
	if (typeof cause?.code === "string" && /^[A-Z_0-9]{3,40}$/.test(cause.code)) return cause.code;
	if ((e as any)?.name === "TimeoutError" || /timeout/i.test(text)) return "no answer in time";
	return "the connection failed";
}

const pauseFor = (ms: number, signal: AbortSignal) =>
	new Promise<void>((resolve) => {
		if (signal.aborted) return resolve();
		const done = () => {
			clearTimeout(t);
			signal.removeEventListener("abort", done);
			resolve();
		};
		const t = setTimeout(done, ms);
		signal.addEventListener("abort", done, { once: true });
	});

export interface Held {
	/** Aborted when the source stops. */
	signal: AbortSignal;
	/** Say the status line again, when what `note` returns has changed. */
	refresh(): void;
}

/**
 * Keep a connection: `run` makes one and returns (or throws) when it has ended, and is then
 * called again after a pause that starts short and doubles with every attempt that did not last,
 * up to five minutes. `run` calls `up` once the connection works. The status line says how
 * things stand; with `report` an address that cannot be reached is an event ("down", once, after
 * three attempts in a row) and so is its return ("up").
 */
export function hold(
	source: SourceApi,
	o: { host: string; report?: string; note?: () => string; run: (signal: AbortSignal, up: () => void, wait: (ms: number) => void) => Promise<void> },
): Held {
	const stop = new AbortController();
	source.onStop(() => stop.abort());
	const base = firstPause(o.host);
	let line = "connecting";
	const say = (text?: string) => {
		if (text) line = text;
		const more = o.note?.();
		source.status(more ? `${line}. ${more}` : line);
	};
	say();
	void (async () => {
		let pause = base;
		let fails = 0;
		let since = 0;
		while (!stop.signal.aborted) {
			let was = 0;
			let asked: number | undefined;
			let reason = "the connection was closed";
			try {
				await o.run(
					stop.signal,
					() => {
						// Said once for a connection, however often its loop reports that it works.
						if (was) return;
						was = Date.now();
						if (fails) source.log.info(`connected again after ${fails} failed ${fails === 1 ? "attempt" : "attempts"}`);
						fails = 0;
						since = 0;
						say(`connected since ${clock()}`);
						if (o.report && source.kv.get("down")) {
							source.kv.set("down", false);
							source.emit("up", { url: o.report });
						}
					},
					(ms) => void (asked = ms),
				);
			} catch (e) {
				reason = why(e);
			}
			if (stop.signal.aborted) return;
			if (was) say(`connecting again since ${clock()}: ${reason}`);
			else {
				// Said once in the log; the status line carries it from here.
				if (!fails) source.log.warn("could not connect", reason);
				fails++;
				since ||= Date.now();
				say(`cannot connect since ${clock(since)} (${fails} ${fails === 1 ? "attempt" : "attempts"}): ${reason}`);
				if (o.report && fails === DOWN_AFTER && !source.kv.get("down")) {
					source.kv.set("down", true);
					source.emit("down", { url: o.report, error: reason });
				}
			}
			if (was && Date.now() - was >= SETTLED) pause = base;
			// What the service itself asked for (SSE's "retry") counts for a connection that worked, never below a failed one's pause.
			const now = was && asked !== undefined ? Math.max(Math.min(asked, MAX_PAUSE), 10) : pause;
			await pauseFor(now * (0.9 + Math.random() * 0.2), stop.signal);
			if (!was || Date.now() - was < SETTLED) pause = Math.min(pause * 2, MAX_PAUSE);
		}
	})();
	return { signal: stop.signal, refresh: () => say() };
}

/** Connections that have to stay on the public internet, or none for a host that is local by its name or by the owner's word. */
export function guardFor(source: SourceApi, host: string, local: unknown, timeoutMs = SILENCE): Agent | undefined {
	if (local === true || isLocalHost(host)) return undefined;
	const guard = publicOnlyAgent(timeoutMs);
	source.onStop(() => guard.close());
	return guard;
}

/** Whether a host answers at all, to say more than "it failed" about a WebSocket that did not open. */
function probe(url: URL, local: boolean): Promise<string> {
	return new Promise((resolve) => {
		const host = url.hostname.replace(/^\[|\]$/g, "");
		const port = Number(url.port || (url.protocol === "wss:" || url.protocol === "https:" ? 443 : 80));
		const s = net.connect({ host, port, ...reachOptions(host, local) });
		const done = (text: string) => {
			s.destroy();
			resolve(text);
		};
		s.setTimeout(5000, () => done("no answer in time"));
		s.once("error", (e) => done(why(e)));
		s.once("connect", () => done("it is there but did not accept the WebSocket: a wrong path, or it wants a token"));
	});
}

export interface Wire {
	send(message: unknown): void;
	close(code?: number): void;
}

/**
 * One WebSocket, from open to close. Resolves with the close code once a connection that was
 * open has closed; rejects when it could not be opened. `guard` keeps it on the public internet.
 * A message is handed on as text; text frames and binary ones alike.
 */
export async function wire(address: string | URL, o: { guard?: Agent; headers?: Record<string, string>; signal: AbortSignal; onOpen?: (w: Wire) => void; onMessage: (text: string, w: Wire) => void }): Promise<number> {
	const url = new URL(address);
	if (o.guard) {
		// The guard refuses when the connection is made. Asked here first, only to be able to say why.
		const host = url.hostname.replace(/^\[|\]$/g, "");
		const found = net.isIP(host) ? [{ address: host }] : await dns.promises.lookup(host, { all: true }).catch(() => []);
		if (found.some((a) => isLocalHost(a.address))) throw new Plain(`${url.hostname} leads to an address on your own network. If that is meant, set the source up again with "local": true`);
	}
	return new Promise<number>((resolve, reject) => {
		if (o.signal.aborted) return reject(new Plain("stopped"));
		const ws = new WebSocket(url, { ...(o.guard ? { dispatcher: o.guard } : {}), ...(o.headers && Object.keys(o.headers).length ? { headers: o.headers } : {}) });
		ws.binaryType = "arraybuffer";
		let open = false;
		const w: Wire = {
			send: (message) => {
				if (ws.readyState === WebSocket.OPEN) ws.send(typeof message === "string" ? message : JSON.stringify(message));
			},
			close: (code) => {
				try {
					ws.close(code ?? 1000);
				} catch {
					// already closing
				}
			},
		};
		const stop = () => w.close();
		o.signal.addEventListener("abort", stop, { once: true });
		const alive = setInterval(() => {
			try {
				if (ws.readyState === WebSocket.OPEN) ping(ws);
			} catch {
				// closing
			}
		}, PING);
		alive.unref?.();
		ws.addEventListener("open", () => {
			open = true;
			try {
				o.onOpen?.(w);
			} catch (e) {
				reject(e);
				w.close();
			}
		});
		ws.addEventListener("message", (e: any) => {
			const text = typeof e.data === "string" ? e.data : Buffer.from(e.data as ArrayBuffer).toString("utf8");
			if (text.length > MAX_MESSAGE) return;
			try {
				o.onMessage(text, w);
			} catch (err) {
				reject(err);
				w.close();
			}
		});
		ws.addEventListener("close", (e: any) => {
			o.signal.removeEventListener("abort", stop);
			clearInterval(alive);
			if (open) return resolve(Number(e.code) || 1006);
			if (o.signal.aborted) return reject(new Plain("stopped"));
			void probe(url, !o.guard).then((text) => reject(new Plain(text)));
		});
	});
}

/** A regular expression that has a group: what it finds is a value. One without only says which messages count. */
const hasGroup = (re: RegExp) => new RegExp(`${re.source}|`).exec("")!.length > 1;

/** Headers that carry a secret. Those go into `token`, which is kept out of the configuration. */
const SECRET_HEADERS = ["authorization", "proxy-authorization", "cookie"];

const helloList = (hello: unknown): unknown[] => (hello === undefined || hello === null ? [] : Array.isArray(hello) ? hello : [hello]);

export const type: SourceType = {
	summary: "a service that pushes over Server-Sent Events or a WebSocket: reports each message it sends. For ntfy, Home Assistant, Mastodon, webhook relays, tickers",
	options: Type.Object(
		{
			url: Type.String({ description: "the address of the stream: https://... for Server-Sent Events, wss://... for a WebSocket (http:// and ws:// for something on the local network)" }),
			kind: Type.Optional(Type.Union([Type.Literal("sse"), Type.Literal("websocket")], { description: '"sse" or "websocket". Leave out: a ws:// or wss:// address is a WebSocket, any other one Server-Sent Events' })),
			hello: Type.Optional(Type.Any({ description: 'for a WebSocket: what to send right after connecting, to log in or to say what is wanted. One message or a list, each a text or a JSON object, e.g. [{"type": "auth", "access_token": "{{token}}"}, {"id": 1, "type": "subscribe_events"}]. Write {{token}} where the token belongs, never the token itself' })),
			token: Type.Optional(Type.String({ description: "an access token or key, if the service wants one. Sent as Authorization: Bearer <token>, and put where hello says {{token}}", secret: true })),
			tokenHeader: Type.Optional(Type.String({ description: 'send the token as this header instead, as it is, e.g. "x-api-key"' })),
			headers: Type.Optional(Type.Record(Type.String(), Type.String(), { description: "headers to send when connecting. Not for secrets" })),
			event: Type.Optional(Type.String({ description: 'for Server-Sent Events: only events of this name, e.g. "update"' })),
			path: Type.Optional(Type.String({ description: 'for messages in JSON: take only this field of each, e.g. "event.data.new_state.state". A message without it is left out' })),
			match: Type.Optional(Type.String({ description: 'only messages this regular expression finds something in. If it has a group, what the group finds is the value, e.g. "temperature: ([0-9.]+)"' })),
			changed: Type.Optional(Type.Boolean({ description: "true to report a value only when it differs from the last one. For a stream that repeats a state again and again" })),
			perMinute: Type.Optional(Type.Number({ description: "at most this many reports a minute. Default 30; what comes on top is dropped and counted" })),
			local: Type.Optional(Type.Boolean({ description: "true if the address is on your owner's own network under a name that does not say so (ha.lan). Not needed for an IP address, localhost or a .local name" })),
		},
		{ additionalProperties: false },
	),
	plan(o) {
		let url: URL;
		try {
			url = new URL(o.url);
		} catch {
			throw new Error(`"${o.url}" is not an address. A stream's looks like https://ntfy.sh/mytopic/sse or wss://example.com/socket`);
		}
		if (!["http:", "https:", "ws:", "wss:"].includes(url.protocol)) throw new Error("the address must start with https://, http://, wss:// or ws://");
		if (url.username || url.password) throw new Error('an address with a user name or password in it is not taken: leave it out of the address and name "token" in "ask"');
		const socket = url.protocol === "ws:" || url.protocol === "wss:";
		const kind = o.kind ?? (socket ? "websocket" : "sse");
		if (kind === "sse" && socket) throw new Error("Server-Sent Events come from an https:// address; ws:// and wss:// are a WebSocket");
		const localHost = o.local === true || isLocalHost(url.hostname);
		if ((url.protocol === "http:" || url.protocol === "ws:") && !localHost) throw new Error(`an address that is not on your own network must be ${socket || kind === "websocket" ? "wss://" : "https://"}: without it the token and everything it sends cross the internet unprotected`);
		if (kind === "sse" && o.hello !== undefined) throw new Error('"hello" is for a WebSocket: Server-Sent Events take nothing after connecting. What they need goes into the address or the headers');
		if (kind === "websocket" && o.event) throw new Error('"event" is for Server-Sent Events. For a WebSocket, pick with "path" or "match"');
		for (const m of helloList(o.hello)) if (typeof m !== "string" && (!m || typeof m !== "object")) throw new Error('"hello" is one message or a list of messages, each a text or a JSON object');
		if (JSON.stringify(o.hello ?? "").length > 8000) throw new Error('"hello" is too long');
		if (o.match) pattern(o.match);
		if (o.perMinute !== undefined && !(o.perMinute >= 1 && o.perMinute <= 600)) throw new Error('"perMinute" is a number from 1 to 600');
		const secret = Object.keys(o.headers ?? {}).filter((h) => SECRET_HEADERS.includes(h.toLowerCase()));
		if (secret.length) throw new Error(`the header ${secret.join(", ")} carries a secret: leave it out, name "token" in "ask" and give "tokenHeader": "${secret[0].toLowerCase()}"`);
		if (o.tokenHeader && !/^[A-Za-z0-9-]+$/.test(o.tokenHeader)) throw new Error('"tokenHeader" is the name of a header, e.g. "x-api-key"');
		const what = [o.event ? `events named ${o.event}` : "", o.path ? `the field ${o.path}` : "", o.match ? `what /${o.match}/ finds` : ""].filter(Boolean).join(", ");
		const hellos = helloList(o.hello).length;
		return {
			options: { ...o, url: url.href, kind },
			does: [
				`stay connected to ${clip(url.href, 160)}${localHost ? " (an address on your own network or this computer)" : ""} ${kind === "sse" ? "and read the events it sends (Server-Sent Events)" : "over a WebSocket"}`,
				...(hellos ? [`send it ${hellos === 1 ? "one message" : `${hellos} messages`} after connecting: ${clip(JSON.stringify(o.hello), 300)}`] : []),
				`report ${what ? `${what} of ` : ""}each message${o.changed ? " whose value differs from the last one" : ""}, at most ${o.perMinute ?? 30} a minute`,
				...(o.token ? [`with the token given, sent only to ${url.host}`] : []),
			],
			opens: true,
			tell: "It reports what the service sends from now on; nothing that was sent before. The sources tool shows whether it is connected.",
		};
	},
};

/** What Server-Sent Events are made of: fields line by line, an empty line ends an event. */
export function sseParser(on: (e: { event: string; data: string; id?: string }) => void, retry: (ms: number) => void): (chunk: string) => void {
	let buffer = "";
	let data: string[] = [];
	let size = 0;
	let event = "";
	let id: string | undefined;
	let first = true;
	const line = (l: string) => {
		if (l === "") {
			// An event larger than any message worth a turn is left out whole, not reported cut in the middle.
			if (data.length && size <= MAX_MESSAGE) on({ event: event || "message", data: data.join("\n"), ...(id !== undefined ? { id } : {}) });
			data = [];
			size = 0;
			event = "";
			return;
		}
		if (l[0] === ":") return;
		const colon = l.indexOf(":");
		const field = colon < 0 ? l : l.slice(0, colon);
		let value = colon < 0 ? "" : l.slice(colon + 1);
		if (value[0] === " ") value = value.slice(1);
		if (field === "data") {
			size += value.length + 1;
			if (size <= MAX_MESSAGE) data.push(value);
		} else if (field === "event") event = value;
		else if (field === "id") {
			if (!value.includes("\0")) id = value.slice(0, 500);
		} else if (field === "retry" && /^\d+$/.test(value)) retry(Number(value));
	};
	return (chunk) => {
		buffer += chunk;
		if (first && buffer.length) {
			if (buffer.charCodeAt(0) === 0xfeff) buffer = buffer.slice(1);
			first = false;
		}
		for (;;) {
			const m = /\r\n|\n|\r/.exec(buffer);
			// A lone \r at the very end may be the first half of \r\n.
			if (!m || (m[0] === "\r" && m.index === buffer.length - 1)) break;
			line(buffer.slice(0, m.index));
			buffer = buffer.slice(m.index + m[0].length);
		}
		if (buffer.length > MAX_MESSAGE * 2) buffer = "";
	};
}

export default function stream(source: SourceApi): void {
	const o = source.options;
	if (typeof o.url !== "string") throw new Error(`needs "url": the address of the stream`);
	const url = new URL(o.url);
	const kind: string = o.kind ?? (url.protocol === "ws:" || url.protocol === "wss:" ? "websocket" : "sse");
	const token = typeof o.token === "string" && o.token ? o.token : undefined;
	source.secret(token);
	// Inside a JSON message the token is written the way JSON writes a text.
	const hellos = helloList(o.hello).map((m) => (typeof m === "string" ? { text: m, json: false } : { text: JSON.stringify(m), json: true }));
	const inHello = hellos.some((m) => m.text.includes("{{token}}"));
	if (inHello && !token) throw new Error('"hello" says {{token}}, and there is no token. Set the source up again and name "token" in "ask", so that pine asks your owner for it');
	const re = o.match ? pattern(String(o.match)) : undefined;
	const picks = re ? hasGroup(re) : false;
	const cap = capped(Math.max(1, Number(o.perMinute ?? 30)));
	const guard = guardFor(source, url.hostname, o.local);
	const headers: Record<string, string> = { ...(o.headers ?? {}) };
	// A token that hello hands over is not sent a second time as a header, unless a header was named for it.
	if (token && (o.tokenHeader || !inHello)) headers[o.tokenHeader ?? "authorization"] = o.tokenHeader ? token : `Bearer ${token}`;
	let lastId: string | undefined;

	/** One message of the service: picked, filtered, compared, counted, and then reported. */
	const take = (text: string, more: { event?: string; id?: string } = {}) => {
		let value: unknown = text;
		try {
			value = JSON.parse(text);
		} catch {
			// plain text
		}
		if (o.path) {
			if (typeof value !== "object" || value === null) return;
			value = getPath(value, String(o.path));
			if (value === undefined || value === null) return;
		}
		if (re) {
			const hit = found(re, typeof value === "string" ? value : JSON.stringify(value));
			if (hit === null) return;
			if (picks) value = hit;
		}
		let previous: unknown;
		if (o.changed === true) {
			const was = source.changed(value);
			if (!was) return;
			previous = was.previous;
		}
		if (!cap.ok()) return;
		const dropped = cap.dropped();
		source.emit("message", { value: shown(value), ...(more.event && more.event !== "message" ? { event: clip(more.event, 100) } : {}), ...(more.id ? { id: clip(more.id, 200) } : {}), ...(previous !== undefined ? { previous: shown(previous) } : {}), ...(dropped ? { dropped } : {}) });
	};

	const sse = async (signal: AbortSignal, up: () => void, wait: (ms: number) => void) => {
		let at = url;
		for (let hop = 0; ; hop++) {
			if (hop > 5) throw new Plain("it sends on and on (more than five redirects)");
			const res = await fetch(at, { headers: { accept: "text/event-stream", "cache-control": "no-cache", ...headers, ...(lastId !== undefined ? { "last-event-id": lastId } : {}) }, redirect: "manual", signal, ...(guard ? { dispatcher: guard } : {}) });
			const to = res.status >= 300 && res.status < 400 ? res.headers.get("location") : null;
			if (to) {
				await res.body?.cancel().catch(() => {});
				const next = new URL(to, at);
				// The owner confirmed one host. Another one is another decision, and must not get the token.
				if (next.host !== url.host || next.protocol !== url.protocol) throw new Plain("it sends on to another address, which is not the one that was confirmed. If that is the right one, set the source up with it");
				at = next;
				continue;
			}
			if (!res.ok || !res.body) {
				await res.body?.cancel().catch(() => {});
				throw new Plain(`it answered ${res.status}`);
			}
			if (!/text\/event-stream/i.test(res.headers.get("content-type") ?? "")) {
				await res.body.cancel().catch(() => {});
				throw new Plain('it does not answer with an event stream. If it is a page or a value to look at again and again, that is an "http" source');
			}
			up();
			const feed = sseParser(
				(e) => {
					if (e.id !== undefined) lastId = e.id;
					if (o.event && e.event !== o.event) return;
					take(e.data, e);
				},
				wait,
			);
			const decoder = new TextDecoder();
			const reader = res.body.getReader();
			for (;;) {
				const { done, value } = await reader.read();
				if (done) return;
				feed(decoder.decode(value, { stream: true }));
			}
		}
	};

	const socket = async (signal: AbortSignal, up: () => void) => {
		const ws = new URL(url);
		if (ws.protocol === "https:") ws.protocol = "wss:";
		if (ws.protocol === "http:") ws.protocol = "ws:";
		await wire(ws, {
			guard,
			headers,
			signal,
			onOpen: (w) => {
				for (const m of hellos) w.send(m.text.replaceAll("{{token}}", m.json ? JSON.stringify(token ?? "").slice(1, -1) : (token ?? "")));
				up();
			},
			onMessage: (text) => take(text),
		});
	};

	hold(source, { host: url.hostname, report: o.url, run: kind === "websocket" ? socket : sse });
}

/**
 * The address of a service's API when the owner runs one of their own in its place: reached over
 * https, or on this machine. Returned without a slash at the end.
 */
export function ownServer(raw: unknown, usual: string): string {
	if (raw === undefined || raw === null || raw === "") return usual;
	let url: URL;
	try {
		url = new URL(String(raw));
	} catch {
		throw new Error(`"${raw}" is not an address`);
	}
	if (url.username || url.password) throw new Error("an address with a user name or password in it is not taken");
	if (url.protocol !== "https:" && !(url.protocol === "http:" && ["127.0.0.1", "localhost", "[::1]"].includes(url.hostname))) throw new Error("a server of your own in that place must be reached over https, or run on this machine");
	return url.href.replace(/\/+$/, "");
}

/** A list an agent may have written as one text with commas: trimmed entries, no empty ones. */
export const listOf = (v: unknown): string[] => (Array.isArray(v) ? v : typeof v === "string" ? v.split(",") : []).map((x) => String(x).trim()).filter(Boolean);

/** The keyword a text contains, capitals aside. */
export const keywordIn = (keywords: string[], text: string): string | undefined => {
	const lower = text.toLowerCase();
	return keywords.find((k) => lower.includes(k.toLowerCase()));
};
