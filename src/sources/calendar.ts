import crypto from "node:crypto";
import { Type } from "typebox";
import type { SourceType } from "../source-types.ts";
import type { SourceApi } from "../sources.ts";
import { parseDuration } from "../util.ts";
import { ask, askable, clip, guardFor, keepSince, sinceOf, whyFailed } from "../watching.ts";

/**
 * A calendar, read again and again: reports the entries that were added, changed or removed.
 * For any calendar that has an address of its own in iCalendar format (.ics): a shared family
 * calendar, a team's, a school's, the waste collection.
 *
 * options: { url, every?, ahead?, headers?, token?, tokenHeader?, local? }
 *   url     https://... or webcal://... (which is read as https)
 *   every   how often to read it ("15m" by default)
 *   ahead   only entries that begin within this from now ("60d" by default)
 *
 * event "added":   { calendar, uid, summary, start, end?, allDay?, zone?, location?, description?, repeats? }
 * event "changed": the same, with was: { summary, start, end?, location? }
 * event "removed": { calendar, uid, summary, start }
 *
 * It reports changes to the calendar and nothing else. It never fires because an entry is about
 * to begin: what should happen at a time is a schedule. An entry that has simply passed is not
 * "removed". A repeating entry is one entry with its rule in `repeats`; it is not unfolded.
 */
const MIN = "1m";
/** A calendar carries its whole past. More than this is not read, and a look says so. */
const MAX_BODY = 8 * 1024 * 1024;
const AT_ONCE = 20;
const MOST = 5000;
/** "Never over": a repeating entry without an end. */
const NEVER = 8.64e15;

export interface Item {
	key: string;
	uid: string;
	summary: string;
	start: string;
	end?: string;
	allDay?: boolean;
	zone?: string;
	location?: string;
	description?: string;
	repeats?: string;
	/** When it begins and when it is over, as instants. */
	at: number;
	until: number;
}

export const type: SourceType = {
	summary: "a calendar (an .ics address) read again and again: reports entries that are added, changed or removed. For shared, team, school and collection calendars",
	options: Type.Object(
		{
			url: Type.String({ description: "the address of the calendar in iCalendar format, https://... or webcal://... (it usually ends in .ics; calendar services call it the iCal, ICS or subscription address)" }),
			every: Type.Optional(Type.String({ description: 'how often to read it, e.g. "15m", "1h". Default "15m", at least "1m"' })),
			ahead: Type.Optional(Type.String({ description: 'only entries that begin within this from now, e.g. "14d". Default "60d". What is added further away is not reported, also not later when it comes nearer' })),
			headers: Type.Optional(Type.Record(Type.String(), Type.String(), { description: "headers to send. Not for secrets" })),
			token: Type.Optional(Type.String({ description: "an access token or key, if the calendar wants one. Sent as Authorization: Bearer <token>", secret: true })),
			tokenHeader: Type.Optional(Type.String({ description: 'send the token as this header instead, as it is, e.g. "x-api-key"' })),
			local: Type.Optional(Type.Boolean({ description: "true if the address is on your owner's own network under a name that does not say so. Not needed for an IP address, localhost or a .local name" })),
		},
		{ additionalProperties: false },
	),
	plan(o) {
		// webcal:// is how calendar programs write "subscribe to this": the same address over https.
		const { url, every, local } = askable({ ...o, url: String(o.url ?? "").trim().replace(/^webcals?:\/\//i, "https://") }, MIN, "15m");
		const ahead = o.ahead ?? "60d";
		if (parseDuration(ahead) < 3_600_000) throw new Error('"ahead" must be at least "1h"');
		return {
			options: { ...o, url: url.href },
			does: [`read the calendar at ${clip(url.href, 160)}${local ? " (an address on your own network or this computer)" : ""} every ${every} and report entries that are added, changed or removed, as far as they begin within ${ahead}`, ...(o.token ? [`with the token given, sent only to ${url.host}`] : [])],
			opens: true,
			tell: 'The entries that are in the calendar now are the starting point and are not reported; from then on each change is. It does not report that an entry is about to begin: for a reminder before one, add a schedule (add_schedule with "at").',
		};
	},
};

// ---- reading a calendar ---------------------------------------------------------------------------

/** One line of a calendar: the property's name, its parameters, its value. */
function content(line: string): { name: string; params: Record<string, string>; value: string } | undefined {
	let quoted = false;
	let colon = -1;
	const cuts: number[] = [];
	for (let i = 0; i < line.length; i++) {
		const c = line[i];
		if (c === '"') quoted = !quoted;
		else if (!quoted && c === ";") cuts.push(i);
		else if (!quoted && c === ":") {
			colon = i;
			break;
		}
	}
	if (colon < 1) return undefined;
	const ends = [...cuts, colon];
	const name = line.slice(0, ends[0]).trim().toUpperCase();
	const params: Record<string, string> = {};
	for (let i = 1; i < ends.length; i++) {
		const p = line.slice(ends[i - 1] + 1, ends[i]);
		const eq = p.indexOf("=");
		if (eq > 0) params[p.slice(0, eq).toUpperCase()] = p.slice(eq + 1).replace(/^"|"$/g, "");
	}
	return { name, params, value: line.slice(colon + 1) };
}

/** A text value as it was typed: \n is a new line, \, a comma, \; a semicolon. */
const typed = (s: string) => s.replace(/\\([nN,;\\])/g, (_all, c: string) => (c === "n" || c === "N" ? "\n" : c)).trim();

/** How far a zone's clock is ahead of UTC at an instant, in milliseconds. Throws for a zone the system does not know. */
function ahead(ts: number, zone: string): number {
	const parts = new Intl.DateTimeFormat("en-US", { timeZone: zone, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit" }).formatToParts(ts);
	const n = (t: string) => Number(parts.find((p) => p.type === t)?.value);
	return Date.UTC(n("year"), n("month") - 1, n("day"), n("hour"), n("minute"), n("second")) - Math.floor(ts / 1000) * 1000;
}

/** A date or a date with a time as a calendar writes it: how an event says it, and the instant it means. */
function time(value: string, params: Record<string, string>): { text: string; at: number; allDay?: boolean; zone?: string } | undefined {
	const m = /^(\d{4})(\d{2})(\d{2})(?:T(\d{2})(\d{2})(\d{2})(Z?))?$/.exec(value.trim());
	if (!m) return undefined;
	const [y, mo, d, h, mi, s] = m.slice(1, 7).map((x) => Number(x ?? 0));
	const day = `${m[1]}-${m[2]}-${m[3]}`;
	// A day as such: it begins when the day does where pine runs.
	if (m[4] === undefined) return { text: day, at: new Date(y, mo - 1, d).getTime(), allDay: true };
	const clock = `${day}T${m[4]}:${m[5]}:${m[6]}`;
	if (m[7]) return { text: `${clock}Z`, at: Date.UTC(y, mo - 1, d, h, mi, s) };
	const zone = (params.TZID ?? "").replace(/^\//, "").trim() || undefined;
	if (zone) {
		try {
			const wall = Date.UTC(y, mo - 1, d, h, mi, s);
			const first = wall - ahead(wall, zone);
			return { text: clock, zone: clip(zone, 80), at: wall - ahead(first, zone) };
		} catch {
			// A zone under a name of the program that wrote the calendar: read as this computer's own.
		}
	}
	return { text: clock, ...(zone ? { zone: clip(zone, 80) } : {}), at: new Date(y, mo - 1, d, h, mi, s).getTime() };
}

/** How long "P1DT2H30M" is, in milliseconds. */
function span(value: string): number {
	const m = /^[+-]?P(?:(\d+)W)?(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?)?$/.exec(value.trim());
	if (!m) return 0;
	const [w, d, h, mi, s] = m.slice(1).map((x) => Number(x ?? 0));
	return ((((w * 7 + d) * 24 + h) * 60 + mi) * 60 + s) * 1000;
}

const dayBefore = (day: string) => {
	const [y, m, d] = day.split("-").map(Number);
	const t = new Date(Date.UTC(y, m - 1, d - 1));
	return t.toISOString().slice(0, 10);
};

/** A calendar's name and its entries. Throws for a document that is no calendar. */
export function parseCalendar(body: string): { name: string; items: Item[] } {
	const text = body.replace(/^﻿/, "");
	if (!/^\s*BEGIN:VCALENDAR/im.test(text)) throw new Error(/^\s*<(!doctype html|html)\b/i.test(text) ? "that address is a web page, not a calendar. The calendar itself has a separate address, which usually ends in .ics: calendar services show it as the iCal or subscription address" : "what it answers is not a calendar (iCalendar, .ics)");
	// A long line is continued on the next one, which then begins with a space.
	const lines = text.replace(/\r\n?/g, "\n").replace(/\n[ \t]/g, "").split("\n");
	const open: string[] = [];
	const items: Item[] = [];
	let name = "";
	let props: Record<string, { params: Record<string, string>; value: string }> = {};
	for (const raw of lines) {
		const c = content(raw);
		if (!c) continue;
		if (c.name === "BEGIN") {
			open.push(c.value.trim().toUpperCase());
			if (open.at(-1) === "VEVENT") props = {};
			continue;
		}
		if (c.name === "END") {
			const kind = open.pop();
			if (kind !== "VEVENT") continue;
			const begins = props.DTSTART ? time(props.DTSTART.value, props.DTSTART.params) : undefined;
			if (!begins || /^CANCELLED$/i.test(props.STATUS?.value.trim() ?? "")) continue;
			const ends = props.DTEND ? time(props.DTEND.value, props.DTEND.params) : undefined;
			const summary = clip(typed(props.SUMMARY?.value ?? "").replace(/\s+/g, " "), 300);
			const uid = clip((props.UID?.value ?? "").trim() || `#${crypto.createHash("sha256").update(`${summary}\n${begins.text}`).digest("hex").slice(0, 16)}`, 300);
			const rule = props.RRULE?.value.trim();
			const stops = rule ? /(?:^|;)UNTIL=([0-9TZ]+)/i.exec(rule)?.[1] : undefined;
			const over = ends ? ends.at : begins.at + (props.DURATION ? span(props.DURATION.value) : begins.allDay ? 86_400_000 : 0);
			// For a whole day the calendar names the day after as the end; a reader means the last day.
			const last = ends && begins.allDay && ends.allDay ? dayBefore(ends.text) : ends?.text;
			const location = clip(typed(props.LOCATION?.value ?? "").replace(/\s+/g, " "), 300);
			const description = clip(typed(props.DESCRIPTION?.value ?? ""), 1000);
			items.push({
				// One occurrence of a repeating entry that was moved is an entry of its own, under the same uid.
				key: props["RECURRENCE-ID"] ? `${uid}\n${props["RECURRENCE-ID"].value.trim()}` : uid,
				uid,
				summary,
				start: begins.text,
				...(last && last !== begins.text ? { end: last } : {}),
				...(begins.allDay ? { allDay: true } : {}),
				...(begins.zone ? { zone: begins.zone } : {}),
				...(location ? { location } : {}),
				...(description ? { description } : {}),
				...(rule ? { repeats: clip(rule, 200) } : {}),
				at: begins.at,
				until: rule ? (stops ? (time(stops, {})?.at ?? NEVER) + 86_400_000 : NEVER) : over,
			});
			continue;
		}
		if (open.at(-1) === "VEVENT") props[c.name] ??= { params: c.params, value: c.value };
		else if (open.length === 1 && c.name === "X-WR-CALNAME") name = clip(typed(c.value).replace(/\s+/g, " "), 120);
	}
	return { name, items };
}

/** What is kept of an entry between two looks: enough to say what changed and whether it has passed. */
interface Kept {
	s: string;
	a: string;
	e?: string;
	l?: string;
	at: number;
	until: number;
	r?: 1;
}

export default function calendar(source: SourceApi): void {
	const o = source.options;
	if (typeof o.url !== "string") throw new Error(`needs "url": the address of the calendar`);
	const url = new URL(o.url.replace(/^webcals?:\/\//i, "https://"));
	if (!["http:", "https:"].includes(url.protocol)) throw new Error("the address must start with https://, http:// or webcal://");
	const aheadMs = parseDuration(o.ahead ?? "60d");
	source.secret(o.token);
	const guard = guardFor(url, o.local);
	if (guard) source.onStop(() => guard.close());
	const about = { url: url.href };

	source.poll(o.every ?? "15m", async (signal) => {
		let answer: Awaited<ReturnType<typeof ask>>;
		try {
			answer = await ask(url, { headers: o.headers, token: o.token, tokenHeader: o.tokenHeader, accept: "text/calendar, */*;q=0.5" }, guard, signal, sinceOf(source, about), MAX_BODY);
		} catch (e) {
			if (signal.aborted) return;
			throw new Error(whyFailed(e, url));
		}
		if (answer.unchanged) return;
		// Half a calendar would make every entry of the other half look removed.
		if (answer.truncated) throw new Error("the calendar is larger than 8 MB, which is more than is read of one");
		const { name, items } = parseCalendar(answer.body);
		const now = Date.now();
		const near = (e: { at: number; r?: 1 }) => e.r === 1 || e.at <= now + aheadMs;
		// What is over is neither kept nor missed.
		const current = new Map<string, Item>();
		for (const item of items) if (item.until >= now && current.size < MOST && !current.has(item.key)) current.set(item.key, item);
		const keep = (i: Item): Kept => ({ s: i.summary, a: i.start, ...(i.end ? { e: i.end } : {}), ...(i.location ? { l: i.location } : {}), at: i.at, until: i.until, ...(i.repeats ? { r: 1 as const } : {}) });
		const next: Record<string, Kept> = Object.fromEntries([...current].map(([key, item]) => [key, keep(item)]));
		const before = source.kv.get<Record<string, Kept>>("entries");
		source.status(`now: ${Object.values(next).filter(near).length} entries ahead`);
		if (!before || JSON.stringify(before) !== JSON.stringify(next)) source.kv.set("entries", next);
		keepSince(source, about, answer);
		// The first look is the starting point.
		if (!before) return;
		const calendarName = name || url.host;
		const full = (i: Item) => {
			const { key: _key, at: _at, until: _until, ...said } = i;
			return { calendar: calendarName, ...said };
		};
		const events: Array<{ event: string; at: number; payload: Record<string, unknown> }> = [];
		for (const [key, item] of current) {
			const was = before[key];
			const is = next[key];
			if (!was) {
				if (near(is)) events.push({ event: "added", at: item.at, payload: full(item) });
			} else if ((was.s !== is.s || was.a !== is.a || (was.e ?? "") !== (is.e ?? "") || (was.l ?? "") !== (is.l ?? "")) && (near(is) || near(was))) {
				events.push({ event: "changed", at: item.at, payload: { ...full(item), was: { summary: was.s, start: was.a, ...(was.e ? { end: was.e } : {}), ...(was.l ? { location: was.l } : {}) } } });
			}
		}
		for (const [key, was] of Object.entries(before)) {
			if (!current.has(key) && was.until >= now && near(was)) events.push({ event: "removed", at: was.at, payload: { calendar: calendarName, uid: key.split("\n")[0], summary: was.s, start: was.a } });
		}
		events.sort((a, b) => a.at - b.at);
		const told = events.slice(0, AT_ONCE);
		told.forEach((e, i) => source.emit(e.event, { ...e.payload, ...(events.length > told.length && i === told.length - 1 ? { more: events.length - told.length } : {}) }));
	});
}
