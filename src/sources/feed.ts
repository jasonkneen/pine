import crypto from "node:crypto";
import { Type } from "typebox";
import type { SourceType } from "../source-types.ts";
import type { SourceApi } from "../sources.ts";
import { ask, askable, clip, guardFor, keepSince, pageText, pattern, sinceOf, unescaped, whyFailed } from "../watching.ts";

/**
 * A feed, read again and again: reports each entry that was not there before. For what publishes
 * itself as RSS or Atom: releases, blogs, channels, podcasts, searches, status pages.
 *
 * options: { url, every?, match?, headers?, token?, tokenHeader?, local? }
 *   every   how often to read it ("15m" by default)
 *   match   only entries whose title or text this regular expression finds
 *
 * event "entry": { feed, title, link, id, published?, author?, summary, media?, more? }
 *   one for each new entry, oldest first, ten a look at most; `more` on the last says how many were left out
 *
 * It reads RSS 2.0, RSS 1.0, Atom and JSON Feed. The entries that are there at the first look are
 * the starting point and are not reported.
 */
const MIN = "1m";
/** How many new entries one look reports. A feed that was moved or renumbered must not fill a conversation. */
const AT_ONCE = 10;
/** How many entries that have left the feed are still known, so that one that comes back is not new. */
const KEPT = 500;
const ACCEPT = "application/atom+xml, application/rss+xml, application/feed+json, application/xml;q=0.9, application/json;q=0.9, */*;q=0.8";

export interface Entry {
	id: string;
	title: string;
	link: string;
	published?: string;
	author?: string;
	summary: string;
	/** A sound or video file the entry carries (an episode of a podcast). */
	media?: string;
}

export const type: SourceType = {
	summary: "an RSS or Atom feed read again and again: reports each new entry. For releases, blogs, channels, podcasts, searches and status pages that publish a feed",
	options: Type.Object(
		{
			url: Type.String({ description: "the address of the feed, https://... (an RSS, Atom or JSON feed, not the web page that links to it)" }),
			every: Type.Optional(Type.String({ description: 'how often to read it, e.g. "15m", "1h". Default "15m", at least "1m"' })),
			match: Type.Optional(Type.String({ description: 'only entries whose title or text this regular expression finds, e.g. "security|CVE" or "^v[0-9]+\\\\.0". Without it every new entry is reported' })),
			headers: Type.Optional(Type.Record(Type.String(), Type.String(), { description: "headers to send. Not for secrets" })),
			token: Type.Optional(Type.String({ description: "an access token or key, if the feed wants one. Sent as Authorization: Bearer <token>", secret: true })),
			tokenHeader: Type.Optional(Type.String({ description: 'send the token as this header instead, as it is, e.g. "x-api-key"' })),
			local: Type.Optional(Type.Boolean({ description: "true if the address is on your owner's own network under a name that does not say so. Not needed for an IP address, localhost or a .local name" })),
		},
		{ additionalProperties: false },
	),
	plan(o) {
		const { url, every, local } = askable(o, MIN, "15m");
		if (o.match) pattern(o.match);
		return {
			options: { ...o, url: url.href },
			does: [`read the feed at ${clip(url.href, 160)}${local ? " (an address on your own network or this computer)" : ""} every ${every} and report each new entry${o.match ? ` whose title or text /${o.match}/ finds` : ""}`, ...(o.token ? [`with the token given, sent only to ${url.host}`] : [])],
			opens: true,
			tell: "The entries that are in the feed now are the starting point and are not reported; from then on each new one is. The sources tool shows how the last look went.",
		};
	},
};

// ---- reading a feed -------------------------------------------------------------------------------

interface Node {
	name: string;
	attrs: Record<string, string>;
	children: Node[];
	/** Its own text, references written out, without what its children hold. */
	text: string;
	/** Where what is inside it begins and ends in the source. */
	from: number;
	to: number;
}

/** A document's elements as a tree. Forgiving: what was never closed ends where the text ends (an answer is read up to 1 MB). */
function tree(src: string): Node {
	const root: Node = { name: "", attrs: {}, children: [], text: "", from: 0, to: src.length };
	const open: Node[] = [root];
	const re = /<!--[\s\S]*?(?:-->|$)|<!\[CDATA\[([\s\S]*?)(?:\]\]>|$)|<\?[\s\S]*?\?>|<![^>]*>|<(\/?)([A-Za-z_][\w:.-]*)((?:[^>"']|"[^"]*"|'[^']*')*)>/g;
	let last = 0;
	let m: RegExpExecArray | null;
	while ((m = re.exec(src))) {
		const top = open.at(-1)!;
		top.text += unescaped(src.slice(last, m.index));
		last = m.index + m[0].length;
		if (m[1] !== undefined) {
			top.text += m[1];
			continue;
		}
		if (!m[3]) continue;
		// Atom elements are the same whatever prefix a document gives them.
		const name = m[3].toLowerCase().replace(/^(atom|a10):/, "");
		if (m[2]) {
			const i = open.findLastIndex((n) => n.name === name);
			if (i > 0) {
				for (let k = open.length - 1; k >= i; k--) open[k].to = m.index;
				open.length = i;
			}
			continue;
		}
		const attrs: Record<string, string> = {};
		const attrRe = /([^\s"'<>\/=]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g;
		let a: RegExpExecArray | null;
		while ((a = attrRe.exec(m[4]))) attrs[a[1].toLowerCase()] ??= unescaped(a[2] ?? a[3] ?? "");
		const node: Node = { name, attrs, children: [], text: "", from: last, to: last };
		top.children.push(node);
		if (!/\/\s*$/.test(m[4])) open.push(node);
	}
	open.at(-1)!.text += unescaped(src.slice(last));
	for (const n of open.slice(1)) n.to = src.length;
	return root;
}

const child = (n: Node | undefined, ...names: string[]) => n?.children.find((c) => names.includes(c.name));
const all = (n: Node | undefined, name: string) => n?.children.filter((c) => c.name === name) ?? [];

/** A title or a name: one line, as a reader sees it. */
const line = (s: unknown, n = 300) => clip((/[<&]/.test(String(s ?? "")) ? pageText(String(s)) : String(s ?? "")).replace(/\s+/g, " ").trim(), n);
/** A text that may be a piece of a web page: what a reader of it sees. */
const readable = (s: string) => clip((/<[a-z!\/]|&[#a-z0-9]+;/i.test(s) ? pageText(s) : s.split("\n").map((l) => l.replace(/\s+/g, " ").trim()).filter(Boolean).join("\n")).trim(), 1500);
/** What an element says: its text, or for one that holds markup (Atom's xhtml) what a reader of that sees. */
const said = (n: Node | undefined, src: string) => (!n ? "" : n.children.length ? readable(src.slice(n.from, n.to)) : readable(n.text));

const when = (s: unknown): string | undefined => {
	const t = Date.parse(String(s ?? "").trim());
	return Number.isFinite(t) ? new Date(t).toISOString() : undefined;
};

/** An address a feed names, made whole against the feed's own. Only web addresses: anything else is left out. */
const address = (raw: unknown, base: string): string => {
	const text = String(raw ?? "").trim();
	if (!text) return "";
	try {
		const url = new URL(text, base);
		return url.protocol === "http:" || url.protocol === "https:" ? clip(url.href, 1000) : "";
	} catch {
		return "";
	}
};

const hash = (s: string) => crypto.createHash("sha256").update(s).digest("hex").slice(0, 16);

/** What a feed holds: its title and its entries in the order it lists them. Throws for a document that is no feed. */
export function parseFeed(body: string, base: string): { title: string; entries: Entry[] } {
	const text = body.replace(/^﻿/, "").trimStart();
	const made = (e: Omit<Entry, "id"> & { id: string }): Entry => ({ ...e, id: clip(e.id || e.link || `#${hash(`${e.title}\n${e.published ?? ""}`)}`, 300) });
	if (text.startsWith("{")) {
		let json: any;
		try {
			json = JSON.parse(text);
		} catch {
			json = undefined;
		}
		if (!json || !Array.isArray(json.items)) throw new Error("what it answers is JSON but not a feed (a JSON Feed has \"items\"). To watch a field of a JSON answer, set up an http source with \"path\"");
		return {
			title: line(json.title),
			entries: json.items
				.filter((i: any) => i && typeof i === "object")
				.map((i: any) =>
					made({
						id: String(i.id ?? ""),
						title: line(i.title),
						link: address(i.url ?? i.external_url, base),
						published: when(i.date_published ?? i.date_modified),
						author: line(i.authors?.[0]?.name ?? i.author?.name, 200) || undefined,
						summary: readable(String(i.content_text ?? i.summary ?? i.content_html ?? "")),
						media: address(i.attachments?.[0]?.url, base) || undefined,
					}),
				),
		};
	}
	const doc = tree(text);
	const root = doc.children[0];
	const kind = root?.name === "feed" ? "atom" : root?.name === "rss" || root?.name === "rdf:rdf" || root?.name === "rdf" ? "rss" : undefined;
	if (!kind) throw new Error(/^<(!doctype html|html)\b/i.test(text) ? "that address is a web page, not a feed. A site's feed has a separate address, often ending in /feed, /rss or .atom: set the source up with that one, or watch the page itself with an http source" : "what it answers is not a feed (RSS, Atom or JSON Feed)");
	if (kind === "atom") {
		const link = (n: Node) => {
			const links = all(n, "link").filter((l) => l.attrs.href);
			return address((links.find((l) => (l.attrs.rel ?? "alternate") === "alternate") ?? links.find((l) => l.attrs.rel !== "self" && l.attrs.rel !== "enclosure") ?? links[0])?.attrs.href, base);
		};
		return {
			title: line(said(child(root, "title"), text)),
			entries: all(root, "entry").map((e) => {
				const group = child(e, "media:group");
				return made({
					id: (child(e, "id")?.text ?? "").trim(),
					title: line(said(child(e, "title") ?? child(group, "media:title"), text)),
					link: link(e),
					published: when(child(e, "published")?.text) ?? when(child(e, "updated")?.text),
					author: line(child(child(e, "author"), "name")?.text ?? child(e, "dc:creator")?.text, 200) || undefined,
					summary: said(child(e, "summary") ?? child(e, "content") ?? child(group, "media:description") ?? child(e, "media:description"), text),
					media: address(all(e, "link").find((l) => l.attrs.rel === "enclosure")?.attrs.href, base) || undefined,
				});
			}),
		};
	}
	const channel = child(root, "channel");
	// RSS 2.0 keeps its items inside the channel, RSS 1.0 next to it.
	const items = [...all(channel, "item"), ...all(root, "item")];
	return {
		title: line(said(child(channel, "title"), text)),
		entries: items.map((i) => {
			const guid = child(i, "guid");
			const id = (guid?.text ?? i.attrs["rdf:about"] ?? "").trim();
			return made({
				id,
				title: line(said(child(i, "title"), text)),
				// (an <atom:link> inside an item is a link too, and has its address in href)
				link: address(all(i, "link").find((l) => l.text.trim())?.text ?? all(i, "link").find((l) => l.attrs.href && l.attrs.rel !== "self")?.attrs.href, base) || (guid && guid.attrs.ispermalink !== "false" ? address(id, base) : ""),
				published: when(child(i, "pubdate", "dc:date", "published", "updated")?.text),
				author: line(child(i, "dc:creator", "author", "itunes:author")?.text, 200) || undefined,
				summary: said(child(i, "description") ?? child(i, "content:encoded") ?? child(i, "itunes:summary"), text),
				media: address(child(i, "enclosure")?.attrs.url ?? child(i, "media:content")?.attrs.url, base) || undefined,
			});
		}),
	};
}

export default function feed(source: SourceApi): void {
	const o = source.options;
	if (typeof o.url !== "string") throw new Error(`needs "url": the address of the feed`);
	const url = new URL(o.url);
	if (!["http:", "https:"].includes(url.protocol)) throw new Error("the address must start with https:// or http://");
	const re = o.match ? pattern(String(o.match)) : undefined;
	source.secret(o.token);
	const guard = guardFor(url, o.local);
	if (guard) source.onStop(() => guard.close());
	const about = { url: url.href, match: o.match };

	source.poll(o.every ?? "15m", async (signal) => {
		let answer: Awaited<ReturnType<typeof ask>>;
		try {
			answer = await ask(url, { headers: o.headers, token: o.token, tokenHeader: o.tokenHeader, accept: ACCEPT }, guard, signal, sinceOf(source, about));
		} catch (e) {
			if (signal.aborted) return;
			throw new Error(whyFailed(e, url));
		}
		if (answer.unchanged) return;
		const { title, entries } = parseFeed(answer.body, url.href);
		// An entry listed twice counts once.
		const ids = new Map<string, Entry>();
		for (const e of entries) if (!ids.has(hash(e.id))) ids.set(hash(e.id), e);
		source.status(`now: ${ids.size} ${ids.size === 1 ? "entry" : "entries"}`);
		const seen = source.kv.get<string[]>("seen");
		const known = new Set(seen ?? []);
		let fresh = [...ids].filter(([id]) => !known.has(id)).map(([, e]) => e);
		// What has left the feed is still known for a while, in case it comes back; what is in it, always.
		if (!seen || fresh.length) source.kv.set("seen", [...(seen ?? []).filter((id) => !ids.has(id)).slice(-KEPT), ...ids.keys()]);
		keepSince(source, about, answer);
		// The first look is the starting point.
		if (!seen) return;
		if (re) fresh = fresh.filter((e) => re.test(e.title) || re.test(e.summary));
		if (!fresh.length) return;
		// Oldest first. A feed lists its newest entry first, and where every entry says when it is from, that decides.
		fresh.reverse();
		if (fresh.every((e) => e.published)) fresh.sort((a, b) => a.published!.localeCompare(b.published!));
		const more = Math.max(0, fresh.length - AT_ONCE);
		const told = fresh.slice(-AT_ONCE);
		const name = title || url.host;
		told.forEach((e, i) =>
			source.emit("entry", {
				feed: name,
				title: e.title,
				link: e.link,
				id: e.id,
				...(e.published ? { published: e.published } : {}),
				...(e.author ? { author: e.author } : {}),
				summary: e.summary,
				...(e.media ? { media: e.media } : {}),
				...(more && i === told.length - 1 ? { more } : {}),
			}),
		);
	});
}
