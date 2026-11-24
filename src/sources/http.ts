import fs from "node:fs";
import path from "node:path";
import { Type } from "typebox";
import { localTarget } from "../net.ts";
import type { SourceType } from "../source-types.ts";
import type { SourceApi } from "../sources.ts";
import { errText, getPath, parseDuration } from "../util.ts";
import { ask, askable, clip, found, guardFor, harmless, keepSince, lineDiff, numbers, pageText, pattern, type Rendered, rendered, selected, selector, shown, sinceOf, whyFailed } from "../watching.ts";

/**
 * A web address, looked at again and again: reports when what it answers changes, and when it
 * stops or starts answering. For pages and services that cannot call you: a price, a version, a
 * status page, a device with a state page on your network.
 *
 * options: { url, every?, path?, values?, match?, select?, attr?, render?, method?, body?, headers?, token?, tokenHeader?, local? }
 *   every        how often to look ("5m" by default)
 *   path         for a JSON answer: watch only this field ("data.price")
 *   values       for a JSON answer: watch several fields, each under a name ({ "price": "data.price" })
 *   match        for a page or text: watch only what this regular expression finds
 *   select       for a page: watch only the text of the first element this CSS selector matches
 *   attr         with select: the value of this attribute of the element instead of its text
 *   render       for a page that a script fills in after loading: every look opens the page in pine's browser,
 *                without a window, and takes what a reader sees then. `select` is the browser's own CSS then
 *   method, body "POST" and what to send, for an address that is asked that way (GraphQL)
 *   headers      headers to send
 *   token        sent as "Authorization: Bearer <token>", or as it is in the header `tokenHeader`
 *   local        the address is on the owner's own network, under a name that does not say so
 *
 * event "changed": { url, value, previous, number?, previousNumber? }   with path, match or select
 *                  { url, values, previous, changed }                    with values
 *                  { url, added, removed, more? }                        without: the lines that are new and gone
 * event "down":    { url, error, looks }              after three failed looks in a row
 * event "up":      { url }                            when it answers again
 *
 * The first look is the starting point and reports nothing.
 *
 * A rendered look runs in a helper program (mcp/render.ts, started by `rendered` in watching.ts):
 * the page's own scripts run in that browser, so everything it connects to goes through the
 * guard of the browser server, which keeps it off the local network. A local address is opened
 * only where it says by itself that it is local, and then that host and port and no other.
 */
const MIN = "30s";
/** With `render` a browser is started for every look. */
const RENDER_MIN = "2m";
const DOWN_AFTER = 3;
const NAME = /^[A-Za-z][A-Za-z0-9_-]{0,39}$/;

export const type: SourceType = {
	summary: "a web address looked at again and again: reports when what it answers changes (the whole page, or one value in it: a price, a version, a state), and when it stops or starts answering. For pages and services that cannot call you",
	options: Type.Object(
		{
			url: Type.String({ description: "the address to look at, https://... (http:// for a device on the local network)" }),
			every: Type.Optional(Type.String({ description: 'how often to look, e.g. "5m", "1h". Default "5m", at least "30s"' })),
			path: Type.Optional(Type.String({ description: 'for an answer in JSON: watch only this field, e.g. "data.price" or "items.0.state"' })),
			match: Type.Optional(Type.String({ description: 'for a page or text: watch only what this regular expression finds (the first group, if there is one), e.g. "Price: ([0-9.,]+)". Without path, values, match or select the whole text counts, and a page that shows the time or a counter changes at every look' })),
			select: Type.Optional(Type.String({ description: 'for a page: watch only the text of the first element this CSS selector matches, e.g. ".product .price" or "#stock > span". Tags, #id, .class, [attribute=value], nested with a space or >' })),
			attr: Type.Optional(Type.String({ description: 'with "select": watch the value of this attribute of the element instead of the element\'s text, e.g. "content" for a meta tag or "data-price"' })),
			render: Type.Optional(Type.Boolean({ description: 'true for a page that a script fills in after loading, where the value is not in the page as the server sends it. Every look then opens the page in pine\'s browser, without a window, and takes what a reader sees. "select" can then be any CSS selector, "every" is at least "2m", and "path", "values", "method", "body", "headers" and "token" do not go with it. Slow and heavy: where the page\'s script asks an address of its own (usually JSON), watch that address without "render" instead' })),
			values: Type.Optional(Type.Record(Type.String(), Type.String(), { description: 'for an answer in JSON: watch several fields at once, each under a name of yours, e.g. {"price": "data.price", "stock": "data.stock.count"}. One event says which of them changed' })),
			method: Type.Optional(Type.String({ description: '"POST" for an address that is asked by sending something (GraphQL, a search). Default "GET"' })),
			body: Type.Optional(Type.String({ description: 'with "POST": what to send, as text, e.g. "{\\"query\\": \\"{ product(id: 7) { price } }\\"}". Sent as JSON when it is JSON. Not for secrets' })),
			headers: Type.Optional(Type.Record(Type.String(), Type.String(), { description: 'headers to send, e.g. {"accept": "application/json"}. Not for secrets' })),
			token: Type.Optional(Type.String({ description: "an access token or key, if the address wants one. Sent as Authorization: Bearer <token>", secret: true })),
			tokenHeader: Type.Optional(Type.String({ description: 'send the token as this header instead, as it is, e.g. "x-api-key"' })),
			local: Type.Optional(Type.Boolean({ description: "true if the address is on your owner's own network under a name that does not say so (nas.home, ha.lan). Not needed for an IP address, localhost or a .local name" })),
		},
		{ additionalProperties: false },
	),
	plan(o, setup) {
		const render = o.render === true || o.render === "true";
		if (render && parseDuration(o.every ?? "5m") < parseDuration(RENDER_MIN)) throw new Error(`"every" must be at least "${RENDER_MIN}" with "render": a browser is started for every look`);
		const { url, every, local } = askable(o, MIN, "5m");
		if (o.path && o.match && !o.values && !o.select) throw new Error('"path" is for an answer in JSON, "match" for a page or text: give one of them');
		const ways = ["path", "values", "match", "select"].filter((k) => o[k] !== undefined && o[k] !== "");
		if (ways.length > 1) throw new Error(`${ways.map((w) => `"${w}"`).join(" and ")} are different ways to say what counts in the answer: give one of them`);
		if (o.match) pattern(o.match);
		// A rendered page is read by the browser, which takes every selector there is.
		if (o.select && !render) selector(o.select);
		if (o.attr !== undefined && !o.select) throw new Error('"attr" goes with "select": it names an attribute of the element the selector finds');
		if (o.attr !== undefined && !/^[A-Za-z_:][\w:.-]*$/.test(o.attr)) throw new Error('"attr" is the name of an attribute, e.g. "content" or "data-price"');
		const names = Object.keys(o.values ?? {});
		if (o.values !== undefined) {
			if (!names.length) throw new Error('"values" is empty. It names the fields to watch: {"price": "data.price", "stock": "data.stock"}');
			if (names.length > 20) throw new Error('"values" takes 20 fields at most');
			const odd = names.filter((n) => !NAME.test(n) || !String(o.values[n]).trim());
			if (odd.length) throw new Error(`"values": ${odd.join(", ")} will not do. Each entry is a short name of yours (letters, digits, - and _) and the field it stands for: {"price": "data.price"}`);
		}
		const method = String(o.method ?? "GET").toUpperCase();
		if (method !== "GET" && method !== "POST") throw new Error('"method" is "GET" or "POST". A source only looks: it never changes or deletes anything');
		if (o.body !== undefined && method !== "POST") throw new Error('"body" is what a POST sends: give "method": "POST" with it');
		if (o.body !== undefined && String(o.body).length > 20_000) throw new Error('"body" is too long: 20000 characters at most');
		const allowed = render ? renderable(o, url, setup?.controlPort) : undefined;
		const what = o.path ? `the field ${o.path} of what it answers` : names.length ? `one of the fields ${names.map((n) => `${n} (${o.values[n]})`).join(", ")} of what it answers` : o.match ? `what /${o.match}/ finds in it` : o.select ? `${o.attr ? `the attribute ${o.attr} of ` : ""}the element ${o.select} of the page` : render ? "what it shows" : "what it answers";
		const where = `${clip(url.href, 160)}${local ? " (an address on your own network or this computer)" : ""}`;
		const { method: _m, render: _r, ...rest } = o;
		const does = render
			? [`open ${where} in pine's browser every ${every}, without a window, and report when ${what} changes, and when the page stops or starts opening`, `the page's own scripts run in that browser, as in yours. From there the page reaches the internet${allowed ? ` and ${allowed} on your network, and nothing else on your network` : " and nothing on your own network"}`]
			: [`${method === "POST" ? `send a POST request${o.body ? ` (${clip(String(o.body), 200)})` : ""} to` : "ask"} ${where} every ${every} and report when ${what} changes, and when it stops or starts answering`, ...(o.token ? [`with the token given, sent only to ${url.host}`] : [])];
		return {
			options: { ...rest, url: url.href, ...(method === "POST" ? { method } : {}), ...(render ? { render: true } : {}) },
			does,
			opens: true,
			tell: "The first look is the starting point and reports nothing; from then on only a change does. The sources tool shows what it found at the last look.",
		};
	},
};

/**
 * What a source with `render` cannot have, said so that it can be put right, when it is set up and
 * again when it starts. Returns the one local "host:port" the page's browser may reach, if the
 * address is a local one. `control` is the port of pine's own control API, which no page is opened at.
 */
function renderable(o: Record<string, any>, url: URL, control: number | undefined): string | undefined {
	const json = ["path", "values"].filter((k) => o[k] !== undefined && o[k] !== "");
	if (json.length) throw new Error(`"${json[0]}" is for an answer in JSON, and "render" is for a page as a browser shows it: leave "render" out to watch JSON`);
	const sent = ["method", "body", "headers", "token", "tokenHeader"].filter((k) => o[k] !== undefined && o[k] !== "" && !(k === "method" && String(o[k]).toUpperCase() === "GET") && !(k === "headers" && !Object.keys(o[k] ?? {}).length));
	if (sent.length) throw new Error(`${sent.map((k) => `"${k}"`).join(" and ")} ${sent.length === 1 ? "does" : "do"} not go with "render": a rendered page is asked the way a reader's browser asks it, and a token or a header would go to every address the page loads from. Leave ${sent.length === 1 ? "it" : "them"} out, or leave "render" out and watch the address that needs ${sent.length === 1 ? "it" : "them"}`);
	if (o.select !== undefined && (!String(o.select).trim() || String(o.select).length > 300)) throw new Error('"select" is a CSS selector of at most 300 characters, e.g. ".product .price"');
	const target = localTarget(url.href);
	// A name that has to be looked up can point somewhere else tomorrow, and a page's scripts would be there then.
	if (!target && o.local === true) throw new Error(`"render" does not go with "local": true. A browser is let onto your network only at an address that says by itself that it is local: localhost, a .local name or an IP address. Give the IP address of ${url.hostname}, or leave "render" out`);
	if (target && control !== undefined && target.port === control) throw new Error(`${target.key} is pine's own control port. No page is opened there`);
	return target?.key;
}

export default function http(source: SourceApi): void {
	const o = source.options;
	if (typeof o.url !== "string") throw new Error(`needs "url": the address to look at`);
	const url = new URL(o.url);
	if (!["http:", "https:"].includes(url.protocol)) throw new Error("the address must start with https:// or http://");
	const render = o.render === true;
	const re = o.match ? pattern(String(o.match)) : undefined;
	const sel = o.select && !render ? selector(String(o.select)) : undefined;
	const fields: Array<[string, string]> = o.values && typeof o.values === "object" ? Object.entries(o.values).map(([k, v]) => [k, String(v)]) : [];
	source.secret(o.token);
	// The one local address the page's browser may reach, written where the browser's guard reads it and no agent writes.
	let localFile: string | undefined;
	if (render) {
		const allowed = renderable(o, url, source.controlPort);
		const file = path.join(source.dataDir, "local.json");
		// (Written anew at every start: the address may be another one than last time, or not a local one any more.)
		fs.rmSync(file, { force: true });
		if (allowed) fs.writeFileSync((localFile = file), JSON.stringify([allowed]), { mode: 0o600 });
	}
	const guard = render ? undefined : guardFor(url, o.local);
	if (guard) source.onStop(() => guard.close());
	// What an answer is read for: an address that says "nothing new" is believed only for the same reading.
	const about = { url: url.href, path: o.path, values: o.values, match: o.match, select: o.select, attr: o.attr };
	// How many looks in a row failed. Whether "down" was said is kept, so that "up" follows it also across a restart.
	let failed = 0;
	// A look with the browser that is under way. The source has stopped only when its browser is gone.
	let looking: Promise<unknown> | undefined;
	source.onStop(async () => void (await looking?.catch(() => {})));

	source.poll(o.every ?? "5m", async (signal) => {
		let answer: Awaited<ReturnType<typeof ask>> | undefined;
		let page: Rendered | undefined;
		try {
			if (render) page = await (looking = rendered({ url: url.href, select: o.select ? String(o.select) : undefined, attr: o.attr ? String(o.attr) : undefined, localFile }, source.dataDir, signal));
			else answer = await ask(url, o, guard, signal, sinceOf(source, about));
		} catch (e) {
			if (signal.aborted) return;
			const why = render ? errText(e) : whyFailed(e, url);
			failed++;
			if (failed === DOWN_AFTER && !source.kv.get("down")) {
				source.kv.set("down", true);
				source.emit("down", { url: o.url, error: why, looks: failed });
			}
			throw new Error(why);
		}
		failed = 0;
		if (source.kv.get("down")) {
			source.kv.set("down", false);
			source.emit("up", { url: o.url });
		}
		// Nothing new since the last answer, says the address itself: what was found then still stands.
		if (answer?.unchanged) return;
		const body = answer?.body ?? "";
		const html = Boolean(answer) && (/html/i.test(answer!.type) || /^\s*<(!doctype html|html)\b/i.test(body));
		let json: unknown;
		if (answer && !html) {
			try {
				json = JSON.parse(body);
			} catch {
				// plain text
			}
		}
		if (fields.length) {
			const values = Object.fromEntries(fields.map(([name, path]) => [name, json === undefined ? null : (getPath(json, path) ?? null)]));
			const missing = fields.filter(([name]) => values[name] === null).length;
			source.status(missing === fields.length ? "found none of the fields" : `now: ${fields.slice(0, 4).map(([name]) => `${name} ${harmless(values[name])}`).join(", ")}${fields.length > 4 ? ` and ${fields.length - 4} more` : ""}`);
			const was = source.changed(values);
			keepSince(source, about, answer!);
			if (!was) return;
			const previous: Record<string, unknown> = was.previous && typeof was.previous === "object" ? was.previous : {};
			const changed = fields.map(([name]) => name).filter((name) => JSON.stringify(values[name]) !== JSON.stringify(previous[name] ?? null));
			if (changed.length) source.emit("changed", { url: o.url, values: Object.fromEntries(fields.map(([name]) => [name, shown(values[name])])), previous: Object.fromEntries(fields.map(([name]) => [name, shown(previous[name] ?? null)])), changed });
			return;
		}
		if (o.path || re || o.select) {
			let value: unknown = null;
			// A rendered page: the browser found the element, and a pattern looks in what a reader sees.
			if (page) value = o.select ? (typeof page.value === "string" ? clip(page.value.trim()) : null) : found(re!, page.text ?? "");
			else if (o.path) value = json === undefined ? null : (getPath(json, String(o.path)) ?? null);
			else if (sel) value = selected(body, sel, o.attr ? String(o.attr) : undefined);
			// In what a reader sees first; a pattern that is about the markup finds it in the source.
			else value = (html ? found(re!, pageText(body)) : null) ?? found(re!, body);
			source.status(value === null ? `found nothing ${o.path ? `at ${o.path}` : o.select ? "with the selector" : "with the pattern"}` : `now: ${harmless(value)}`);
			const was = source.changed(value);
			if (answer) keepSince(source, about, answer);
			if (was) source.emit("changed", { url: o.url, value: shown(value), previous: shown(was.previous), ...numbers(value, was.previous) });
			return;
		}
		const text = (page ? (page.text ?? "") : html ? pageText(body) : json !== undefined ? JSON.stringify(json, null, 1) : body).slice(0, 200_000);
		source.status(`now: ${text.split("\n").length} lines`);
		const was = source.changed(text);
		if (answer) keepSince(source, about, answer);
		if (!was) return;
		const diff = lineDiff(String(was.previous), text);
		// The same lines in another order are not worth a turn.
		if (diff.added.length || diff.removed.length) source.emit("changed", { url: o.url, ...diff });
	});
}
