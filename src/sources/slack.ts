import fs from "node:fs";
import path from "node:path";
import { SocketModeClient } from "@slack/socket-mode";
import { LogLevel, WebAPIHTTPError, WebAPIPlatformError, WebAPIRateLimitedError, WebClient } from "@slack/web-api";
import type { FetchFunction, Logger, WebClientOptions } from "@slack/web-api";
import { Type } from "typebox";
import { Agent, fetch, FormData as Multipart } from "undici";
import { fileName, keepFiles, type Mail, type MailFile, pruneFiles } from "../mime.ts";
import type { SourceType } from "../source-types.ts";
import type { SourceApi } from "../sources.ts";
import { errText } from "../util.ts";
import { capped, clip, shown } from "../watching.ts";
import { guardFor, type Held, hold, keywordIn, listOf, ownServer, Plain, word } from "./stream.ts";

/**
 * A Slack workspace, watched through Socket Mode: the app connects out to Slack and is told what
 * happens where it may look. Nothing listens on a port, so it works behind any router. The
 * connection and every call of Slack's Web API are made by Slack's own SDK (@slack/socket-mode,
 * @slack/web-api); connecting again, the status line and what counts are pine's.
 *
 * options: { appToken, token?, events?, channels?, mentions?, keywords?, from?, dms?, bots?, ignore?,
 *            sendTo?, perMinute?, maxMb?, keepDays?, apiBase? }
 *   appToken   the app-level token (xapp-...) that Socket Mode connects with
 *   token      a bot token (xoxb-) or user token (xoxp-): names for ids, channels by name, "me",
 *              the files of a message, and everything that is sent
 *   events     which kinds of thing are reported: message (the default), reaction, edit, member,
 *              channel, pin, command, other
 *   channels   only these channels, by id or by name. None: every channel the app is told about
 *   mentions   user ids (or "me", "here", "channel", "everyone", a user group's id): only messages that mention one
 *   keywords   only messages that contain one of these words
 *   from       user ids (or "me") whose messages always count, wherever they write and whatever they say
 *   dms        direct messages count (default true)
 *   bots       what other apps and integrations post counts too (default false)
 *   ignore     user ids (or "me") that are never reported: the owner's own account
 *   sendTo     channel and user ids the agent may write to. Without it nothing can be sent
 *   perMinute  at most this many reports a minute (60); the rest are counted and dropped
 *   maxMb, keepDays   files of a message are fetched up to this size (10) and kept this long (7)
 *   history    false: nothing that was written earlier is read (default true, with a token)
 *   context    how many earlier messages of a thread come with an answer in it (3; 0 for none)
 *
 * event "message":  { text, user, userName?, channel, channelName?, kind, ts, thread?, reply?, bot?, why, mention?, keyword?, from?, files?, images?, late?, dropped? }
 *                   why: the reasons it is reported, a word each: "dm", "mention", "keyword", "from", or "channel" for none of these
 *                   late: it was written while the source was not connected, and asked for afterwards
 * event "gap":      { text, from, to, seconds, found, looked, complete, missing? }
 *                   the source was not connected for a minute or longer: how much of that time it could make up for
 * event "reaction": { reaction, added, user, userName?, channel, channelName?, ts, author?, authorName? }
 * event "edited":   { text, previous?, user, userName?, channel, channelName?, kind, ts, mention?, keyword?, from? }
 * event "deleted":  { channel, channelName?, ts, previous? }
 * event "joined", "left": { user, userName?, channel?, channelName? }
 * event "channel":  { what, channel, channelName? }
 * event "pin":      { added, channel, channelName?, ts?, user, userName? }
 * event "command":  { command, text, user, userName?, channel, channelName? }
 * event "event":    { type, data }
 *
 * It can send, to what is on `sendTo` only: { channel, text, thread? } a message; a user id as
 * `channel` a direct message; { channel, ts, react } an emoji on a message; `file` a file.
 *
 * Which message counts, in this order: never the app's own, one of a user on `ignore`, or one of
 * another app unless `bots` is on. One of a user on `from` counts. A direct message counts when
 * `dms` is on. Any other must be in a channel on `channels` (or there is no such list), and if
 * `mentions` or `keywords` are given, one of them must be found in it. The other kinds go the same
 * way as far as they have a user or a channel; mentions and keywords are for messages and edits.
 */
const SLACK = "https://slack.com/api";
/** Where Slack keeps the files of a message. The token is sent there and to no other host. */
const FILES = "files.slack.com";
/** Messages with one of these subtypes are somebody writing. Any other subtype says that something happened to a channel. */
const WRITTEN = ["file_share", "thread_broadcast", "me_message", "bot_message"];
/** What Slack answers when it is the one that has trouble: tried again, not taken for a no. */
const PASSING = ["ratelimited", "rate_limited", "internal_error", "fatal_error", "service_unavailable", "request_timeout"];
/**
 * The kinds of conversation an account has, as Slack sorts them: what it calls each in a message
 * (`type`), the scope that listing them needs, the scope that reading them needs.
 */
const PLACES = [
	{ types: "public_channel", type: "channel", lists: "channels:read", reads: "channels:history", what: "public channels" },
	{ types: "private_channel", type: "group", lists: "groups:read", reads: "groups:history", what: "private channels" },
	{ types: "mpim", type: "mpim", lists: "mpim:read", reads: "mpim:history", what: "group conversations" },
	{ types: "im", type: "im", lists: "im:read", reads: "im:history", what: "direct conversations" },
];
/** After a time without a connection: how many conversations are asked for at most, how many after a gap too short to report, and how many messages a question brings. */
const [MOST, NEAR, PAGE] = [200, 40, 50];
/** What somebody who typed a slash command reads. */
const PASSED = "Passed on.";

/**
 * Times the tests set: what a second of "wait this long" from Slack lasts, how long a new
 * connection may take to be greeted, within what time Slack has to answer a ping (the SDK pings
 * three times in that time, and takes a connection without an answer for dead), and how long a
 * goodbye is waited for before the socket is cut. For the time it was not connected: how often
 * it notes that the connection works (`beat`), how far before that note it asks Slack for what was
 * written (`margin`: a line can be dead for a ping's time before anybody knows, and Slack's clock is
 * not this machine's), from how long on a gap is reported (`quiet`), and the rest between two
 * conversations when many are asked for (`between`).
 */
export const pace = { second: 1000, hello: 30_000, ping: 5000, bye: 1000, beat: 15_000, margin: 10_000, quiet: 60_000, between: 1000 };

/** The kinds of thing that can be reported, with what the owner reads about each. */
const KINDS: Record<string, { does: string; short: string }> = {
	message: { does: "", short: "messages" },
	reaction: { does: "who puts which emoji on which message, or takes it away", short: "reactions" },
	edit: { does: "messages that are edited or deleted, with what they said before", short: "edits" },
	member: { does: "who joins and who leaves", short: "who joins and leaves" },
	channel: { does: "channels that are created, renamed, archived or deleted", short: "changes to channels" },
	pin: { does: "messages that are pinned or unpinned", short: "pins" },
	command: { does: `the slash commands of your app, each answered with "${PASSED}"`, short: "slash commands" },
	other: { does: "every other event your app is subscribed to, as Slack sends it", short: "other events" },
};

/** Slack's events, by the kind they are reported as. A message is sorted by its subtype. */
const KIND_OF: Record<string, string> = {
	...{ reaction_added: "reaction", reaction_removed: "reaction" },
	...{ member_joined_channel: "member", member_left_channel: "member", team_join: "member" },
	...{ channel_created: "channel", channel_rename: "channel", channel_archive: "channel", channel_unarchive: "channel", channel_deleted: "channel" },
	...{ group_rename: "channel", group_archive: "channel", group_unarchive: "channel", group_deleted: "channel" },
	...{ pin_added: "pin", pin_removed: "pin" },
};
const CHANGED: Record<string, string> = { created: "created", rename: "renamed", archive: "archived", unarchive: "unarchived", deleted: "deleted" };

// An id is capitals and digits with a digit in it. A channel's name is written small, so the two are told apart.
const id = (first: string) => (x: string) => new RegExp(`^[${first}][A-Z0-9]{2,20}$`).test(x) && /\d/.test(x);
const isChannel = id("CGD");
const isUser = id("UW");
const isActor = id("UWB");
const isGroup = id("S");
const EVERYBODY = ["here", "channel", "everyone"];
const channelName = (x: string) => x.replace(/^#/, "").toLowerCase();
const list = (v: unknown): any[] => (Array.isArray(v) ? v : []);
const plural = (n: number, one: string, many = `${one}s`) => (n === 1 ? one : many);

/** The lists of a set-up as they are used: without "#" and "@" in front, a channel's name written small. */
function lists(o: Record<string, any>) {
	const channels = listOf(o.channels).map((x) => (isChannel(x.replace(/^#/, "")) ? x.replace(/^#/, "") : channelName(x)));
	const people = (key: string) => listOf(o[key]).map((x) => x.replace(/^@/, ""));
	return { channels, mentions: people("mentions"), from: people("from"), ignore: people("ignore"), sendTo: listOf(o.sendTo).map((x) => x.replace(/^[#@]/, "")), keywords: listOf(o.keywords), events: [...new Set(o.events === undefined ? ["message"] : listOf(o.events).map((x) => x.toLowerCase()))] };
}

export const type: SourceType = {
	summary: "a Slack workspace: reports messages (all, or only mentions, keywords, certain people), and reactions, edits, joins, pins, commands. Can post, react and send files to listed channels",
	sends: 'a Slack message to a channel or person on the source\'s "sendTo" list: {"channel": "C0123ABCD", "text": "..."}. "thread" (a message\'s ts) answers in that thread; a user id as "channel" writes to that person directly; with "file" a file goes along; {"channel": "...", "ts": "...", "react": "eyes"} puts an emoji on a message',
	reads: 'what was written earlier, to understand a message: {"channel": "C0123ABCD"} gives the last messages of a channel or direct conversation ("channel" as an event had it; a user id for the conversation with that person), with "thread" (the "thread" or "ts" of an event) that thread; "limit" up to 50, "before" a ts to go further back',
	files: true,
	options: Type.Object(
		{
			appToken: Type.String({ description: "the app-level token of the Slack app (xapp-...), with the scope connections:write. Socket Mode connects with it", secret: true }),
			token: Type.Optional(Type.String({ description: 'a bot token (xoxb-...) or user token (xoxp-...) of the same app. With it people and channels have names, channels can be given by name, "me" is known, files are fetched, and things can be sent. Name it in "ask" when any of that is wanted', secret: true })),
			events: Type.Optional(Type.Array(Type.String(), { description: 'which kinds of thing to report: "message" (the default, alone), "reaction", "edit" (edited and deleted messages), "member" (who joins and leaves), "channel" (created, renamed, archived), "pin", "command" (the app\'s slash commands), "other" (any other event the app is subscribed to)' })),
			channels: Type.Optional(Type.Array(Type.String(), { description: 'only these channels, by name or id: ["ops", "C0123ABCD"]. A name needs "token". Leave out for every channel the app sees' })),
			mentions: Type.Optional(Type.Array(Type.String(), { description: 'only messages that mention one of these: user ids (["U0123ABCD"]), "me" (the account the token belongs to), "here", "channel", "everyone", or a user group\'s id (S...)' })),
			keywords: Type.Optional(Type.Array(Type.String(), { description: 'only messages that contain one of these words, e.g. ["outage", "invoice"]. Capitals do not matter' })),
			from: Type.Optional(Type.Array(Type.String(), { description: 'user ids (or "me") whose messages always count, in any channel and whatever they say: a boss, a customer' })),
			dms: Type.Optional(Type.Boolean({ description: "direct messages count too. Default true" })),
			bots: Type.Optional(Type.Boolean({ description: "true to report what other apps and integrations post too: alerts, GitHub, a monitoring bot. Default false. What this app posts itself is never reported" })),
			ignore: Type.Optional(Type.Array(Type.String(), { description: "user ids whose messages are never reported. Not needed for your owner's own messages: what the token's account writes is left out by itself" })),
			sendTo: Type.Optional(Type.Array(Type.String(), { description: 'where you may write, by id only: channels (["C0123ABCD"]) and people (["U0123ABCD"], a direct message). Only when your owner wants you to write there; without it nothing can be sent. Needs "token"' })),
			perMinute: Type.Optional(Type.Number({ description: "at most this many reports a minute. Default 60; what comes on top is dropped and counted" })),
			history: Type.Optional(Type.Boolean({ description: 'false: nothing that was written earlier is read. Default true: with a "token" you can read earlier messages where the source listens (read_source), and an answer in a thread comes with what it answers' })),
			context: Type.Optional(Type.Number({ description: "how many earlier messages of a thread come with an answer in that thread, the thread's first message among them. Default 3, 0 for none, 10 at most" })),
			maxMb: Type.Optional(Type.Number({ description: 'files that come with a message are fetched up to this size, in MB. Default 10. Needs "token"' })),
			keepDays: Type.Optional(Type.Number({ description: "fetched files are deleted after this many days. Default 7" })),
			apiBase: Type.Optional(Type.String({ description: "address of a Slack-compatible server of your own, instead of https://slack.com/api" })),
		},
		{ additionalProperties: false },
	),
	// What cannot be done without the token of the workspace: pine asks the owner for it, without the agent having to think of it.
	needs(o) {
		const l = lists(o);
		return l.channels.some((c) => !isChannel(c)) || [...l.mentions, ...l.from, ...l.ignore].includes("me") || l.sendTo.length ? ["token"] : [];
	},
	plan(o) {
		// Without a token yet (the owner is about to be asked for it) there is nothing to check.
		if (o.appToken !== undefined && !/^xapp-/.test(String(o.appToken))) throw new Error('that is not an app-level token. It starts with xapp- and is made on api.slack.com under "Basic Information", "App-Level Tokens", with the scope connections:write. A token that starts with xoxb- or xoxp- goes into "token"');
		if (o.token !== undefined && !/^xox[bp]-/.test(String(o.token))) throw new Error('"token" is a bot token (xoxb-...) or a user token (xoxp-...), from "OAuth & Permissions" of the Slack app. The one that starts with xapp- goes into "appToken"');
		const base = ownServer(o.apiBase, SLACK);
		const l = lists(o);
		const person = 'A person\'s id starts with U and is in their profile under "Copy member ID"';
		const not = (key: string, odd: string[], what: string) => {
			if (odd.length) throw new Error(`"${key}" takes ${what}: ${odd.join(", ")} is not one. ${person}`);
		};
		const strange = l.channels.filter((c) => !isChannel(c) && !/^[^\s#@<>,|]{1,80}$/.test(c));
		if (strange.length) throw new Error(`"channels" takes channel names ("ops") or ids ("C0123ABCD"): ${strange.join(", ")} is neither`);
		not("mentions", l.mentions.filter((x) => x !== "me" && !EVERYBODY.includes(x) && !isUser(x) && !isGroup(x)), 'Slack user ids, "me", "here", "channel" or "everyone", not names');
		not("from", l.from.filter((x) => x !== "me" && !isActor(x)), 'Slack user ids or "me", not names');
		not("ignore", l.ignore.filter((x) => x !== "me" && !isActor(x)), 'Slack user ids or "me", not names');
		const nowhere = l.sendTo.filter((x) => !isChannel(x) && !isUser(x));
		// The one list that says where an agent may write: a name can be given to another channel tomorrow, an id cannot.
		if (nowhere.length) throw new Error(`"sendTo" takes ids, not names: ${nowhere.join(", ")} is not one. It says where the agent may write, and a name can come to mean another place. A channel's id starts with C (or G, D) and is at the end of the channel's link. ${person}`);
		const unknown = l.events.filter((k) => !KINDS[k]);
		if (unknown.length) throw new Error(`"events" takes ${Object.keys(KINDS).join(", ")}: ${unknown.join(", ")} is not one of them`);
		if (!l.events.length) throw new Error(`"events" is empty, so nothing would be reported. It takes ${Object.keys(KINDS).join(", ")}; leave it out for messages`);
		if (o.perMinute !== undefined && !(o.perMinute >= 1 && o.perMinute <= 600)) throw new Error('"perMinute" is a number from 1 to 600');
		for (const key of ["maxMb", "keepDays"]) if (o[key] !== undefined && !(Number(o[key]) > 0)) throw new Error(`"${key}" must be a number above 0`);
		if (o.maxMb !== undefined && o.maxMb > 50) throw new Error('"maxMb" is at most 50');
		if (o.context !== undefined && !(Number.isInteger(o.context) && o.context >= 0 && o.context <= 10)) throw new Error('"context" is a whole number from 0 to 10');

		const who = (x: string) => (x === "me" ? "the account the token belongs to" : x);
		const some = (xs: string[]) => xs.map(who).join(", ");
		const where = l.channels.length ? `the ${plural(l.channels.length, "channel")} ${l.channels.map((c) => (isChannel(c) ? c : `#${c}`)).join(", ")}` : "every channel the app is in";
		const picky = l.mentions.length || l.keywords.length ? `, there only messages that ${[l.mentions.length ? `mention ${some(l.mentions)}` : "", l.keywords.length ? `contain ${l.keywords.map((k) => `"${k}"`).join(", ")}` : ""].filter(Boolean).join(" or ")}` : "";
		const said = [l.from.length ? `everything ${some(l.from)} ${plural(l.from.length, "writes", "write")}` : "", o.dms === false ? "" : "direct messages", `${where}${picky}`].filter(Boolean);
		const messages = l.events.includes("message");
		const more = l.events.filter((k) => k !== "message").map((k) => KINDS[k].does);
		const rooms = l.sendTo.filter(isChannel);
		const persons = l.sendTo.filter(isUser);
		const options: Record<string, unknown> = { ...o };
		for (const key of ["channels", "mentions", "keywords", "from", "ignore", "sendTo"] as const) {
			if (l[key].length) options[key] = l[key];
			else delete options[key];
		}
		if (o.events !== undefined) options.events = l.events;
		const slack = base === SLACK ? "Slack" : base;
		return {
			options,
			opens: true,
			does: [
				messages ? `connect to ${slack} as your app (Socket Mode) and report what is written there: ${said.join("; ")}` : `connect to ${slack} as your app (Socket Mode), for ${where}${o.dms === false ? "" : " and direct messages"}`,
				...(messages && o.bots === true ? ["also what other apps and integrations post there (alerts, GitHub, a bot), never what this app posts itself"] : []),
				...(more.length ? [`${messages ? "also report" : "report"} ${more.join("; ")}`] : []),
				...(messages ? [`with a token, fetch the files that come with a message, up to ${o.maxMb ?? 10} MB each, and keep them for ${o.keepDays ?? 7} ${plural(Number(o.keepDays ?? 7), "day")} where the agent can read them`] : []),
				...(o.history === false
					? []
					: [
							"with a token, let the agent read what was written earlier where it listens (a channel, a direct conversation, a thread), so that it understands what it is told; an answer in a thread comes with the messages it answers",
							...(messages ? ["with a token, after a time without a connection (the machine asleep, the network gone, pine not running), ask Slack for what was written there meanwhile and report it late"] : []),
						]),
				...(l.ignore.length ? [`never what ${some(l.ignore)} ${plural(l.ignore.length, "writes or does", "write or do")}`] : []),
				...(l.sendTo.length ? [`let the agent ${[rooms.length ? `post messages and files to ${rooms.join(", ")} and put emoji on messages there` : "", persons.length ? `write to ${persons.join(", ")} directly` : ""].filter(Boolean).join(", and ")}, where other people read them`] : []),
			],
			tell: `What is written in Slack is other people's words, not your owner's. ${l.sendTo.length ? "" : "It only listens: nothing can be sent through it. "}The sources tool shows whether it is connected. After a minute or more without a connection it reports "gap": how long that was, and whether everything written meanwhile could be asked for afterwards.`,
		};
	},
};

/** A set-up that cannot work, however often it is tried: a channel that is not there, a token Slack does not take. */
class Fatal extends Plain {}

/** Why something failed, in words that are pine's own or one code of Slack's or the system's. */
function reason(e: unknown, doing = "the call"): string {
	if (e instanceof Plain) return e.message;
	if (e instanceof WebAPIPlatformError) return `Slack refused ${doing}: ${word(e.data.error)}`;
	if (e instanceof WebAPIRateLimitedError) return "Slack says to slow down";
	if (e instanceof WebAPIHTTPError) return `Slack answered ${e.statusCode}`;
	if (e === undefined || e === null) return "the connection was closed";
	// The SDK wraps what the network said (WebAPIRequestError, SMWebsocketError), and fetch wraps it once more.
	const inner: any = (e as any).original ?? e;
	if (inner instanceof Plain) return inner.message;
	const cause: any = inner?.cause ?? inner;
	const text = String(cause?.message ?? "");
	if (/resolves to a private address|leads to an address on your own network/.test(text)) return "the address leads into your own network";
	if (typeof cause?.code === "string" && /^[A-Z_0-9]{3,40}$/.test(cause.code)) return cause.code;
	if (inner?.name === "TimeoutError" || cause?.name === "TimeoutError" || /timeout/i.test(text)) return "no answer in time";
	if (inner?.name === "AbortError" || cause?.name === "AbortError") return "stopped";
	return "the connection failed";
}

/**
 * Where the SDK's own log lines go: to the source's log, for whoever looks for a fault. What it
 * says for debugging holds what it sent and received word for word (other people's messages, the
 * ticket of a connection), and that is left out; a token is taken out of whatever is said.
 */
function sdkLog(source: SourceApi, secrets: string[]): Logger {
	const WORDY = /^(Received a message on the WebSocket|Sending a WebSocket message|Calling ack\(\)|http request (url|body|headers|result)|Unable to parse)/;
	const said = new Map<string, number>();
	const clean = (parts: unknown[]) => {
		let s = parts.map((p) => (p instanceof Error ? p.message : typeof p === "string" ? p : (JSON.stringify(p) ?? ""))).join(" ");
		for (const x of secrets) if (x) s = s.replaceAll(x, "***");
		s = s.replace(/xapp-[\w-]+|xox[a-z]-[\w-]+/g, "***").replace(/((?:wss?|https?):\/\/[^\s?"')]+)\?[^\s"')]*/g, "$1?…");
		return clip(s.replace(/[\x00-\x1f\x7f]+/g, " "), 300);
	};
	const quietly = (...m: unknown[]) => {
		const s = clean(m);
		if (!WORDY.test(s)) source.log.debug(`sdk: ${s}`);
	};
	// Said once an hour at most: while Slack cannot be reached the same line comes with every attempt, and the status line carries it.
	const loudly = (...m: unknown[]) => {
		const s = clean(m);
		const now = Date.now();
		if (now - (said.get(s) ?? 0) < 3_600_000) return source.log.debug(`sdk: ${s}`);
		if (said.size > 200) said.clear();
		said.set(s, now);
		source.log.warn(`sdk: ${s}`);
	};
	return { debug: quietly, info: quietly, warn: loudly, error: loudly, setLevel: () => {}, getLevel: () => LogLevel.INFO, setName: () => {} };
}

/** What a block of a message says, piece by piece. Slack's own formats; a button and anything unknown is left out. */
function blockText(block: any, add: (s: unknown) => void, depth = 0): void {
	if (!block || typeof block !== "object" || depth > 4 || block.type === "actions") return;
	const inline = (el: any): string => {
		if (!el || typeof el !== "object") return "";
		if (el.type === "link") return el.text && el.text !== el.url ? `${el.text} (${el.url})` : String(el.url ?? "");
		if (el.type === "user") return `<@${el.user_id}>`;
		if (el.type === "channel") return `<#${el.channel_id}>`;
		if (el.type === "usergroup") return `<!subteam^${el.usergroup_id}>`;
		if (el.type === "broadcast") return `<!${el.range}>`;
		if (el.type === "emoji") return `:${el.name}:`;
		return typeof el.text === "string" ? el.text : "";
	};
	if (/^rich_text_(section|preformatted|quote)$/.test(String(block.type))) return add(list(block.elements).map(inline).join(""));
	add(typeof block.text === "string" ? block.text : block.text?.text);
	if (block.type === "image") add(block.title?.text ?? block.alt_text);
	for (const f of list(block.fields).slice(0, 20)) add(typeof f === "string" ? f : f?.text);
	for (const el of list(block.elements).slice(0, 40)) {
		if (Array.isArray(el?.elements)) blockText(el, add, depth + 1);
		else add(typeof el?.text === "string" ? el.text : (el?.text?.text ?? el?.alt_text));
	}
}

/**
 * What a reader of a message sees, put together. A person's message says it in `text`. An app's
 * often says it only in its attachments (an alert) or its blocks, and `text` is empty or a stub.
 */
function readable(m: any): string {
	const parts: string[] = [];
	const add = (s: unknown) => {
		const t = typeof s === "string" ? s.trim() : "";
		// The same words are often there twice: as the text and as what stands in for an attachment.
		if (t && parts.length < 60 && !parts.some((p) => p.includes(t))) parts.push(t.slice(0, 8000));
	};
	add(m?.text);
	if (!parts.length || m?.bot_id || m?.subtype === "bot_message") for (const b of list(m?.blocks).slice(0, 30)) blockText(b, add);
	for (const a of list(m?.attachments).slice(0, 10)) {
		const before = parts.length;
		add(a?.pretext);
		add(a?.title && a?.title_link ? `${a.title} (${a.title_link})` : a?.title);
		add(a?.text);
		for (const f of list(a?.fields).slice(0, 20)) add(f?.title && f?.value ? `${f.title}: ${f.value}` : (f?.value ?? f?.title));
		for (const b of list(a?.blocks).slice(0, 30)) blockText(b, add);
		if (parts.length === before) add(a?.fallback);
	}
	return parts.join("\n");
}

export default async function slack(source: SourceApi): Promise<void> {
	const o = source.options;
	const appToken = String(o.appToken ?? "");
	if (!appToken) throw new Error("the app-level token (xapp-...) is missing");
	const token = typeof o.token === "string" && o.token ? o.token : undefined;
	source.secret(appToken);
	source.secret(token);
	const base = ownServer(o.apiBase, SLACK);
	const api = new URL(base);
	const real = base === SLACK;
	const l = lists(o);
	const { mentions, keywords, from, ignore, sendTo } = l;
	const events = new Set(l.events);
	const channels = new Set(l.channels.filter(isChannel));
	const byName = l.channels.filter((c) => !isChannel(c));
	const dms = o.dms !== false;
	const bots = o.bots === true;
	const perMinute = Math.min(Math.max(1, Number(o.perMinute ?? 60)), 600);
	const cap = capped(perMinute);
	const maxBytes = Math.min(Number(o.maxMb ?? 10), 50) * 1024 * 1024;
	const keepMs = Number(o.keepDays ?? 7) * 86_400_000;
	if (!token && [...mentions, ...from, ...ignore].includes("me")) throw new Error('"me" is the account the token belongs to, and this source has no token. Set it up again and name "token" in "ask", or write the user id instead of "me"');
	if (!token && byName.length) throw new Error(`a channel given by name (${byName.join(", ")}) has to be looked up, and this source has no token for that. Set it up again and name "token" in "ask", or give the channel's id`);

	const stop = new AbortController();
	const rest = (ms: number) =>
		new Promise<void>((resolve) => {
			if (stop.signal.aborted) return resolve();
			const done = () => {
				clearTimeout(t);
				stop.signal.removeEventListener("abort", done);
				resolve();
			};
			const t = setTimeout(done, ms);
			stop.signal.addEventListener("abort", done, { once: true });
		});

	// ---- the connections ---------------------------------------------------------------------------
	// A server of the owner's own on this machine is reached as it is. Slack itself, and whatever address it hands out, has to be on the public internet.
	const guard = guardFor(source, api.hostname, false, 60_000);
	const local = guard ? undefined : new Agent();
	const net = guard ?? local!;
	/**
	 * The sockets under the WebSockets. undici takes such a socket out of its pool, so closing the
	 * agent does not reach it, and the SDK can only destroy one it made the connection for itself.
	 * Noted here, so that stopping the source ends them also when Slack does not answer the goodbye.
	 */
	const sockets = new Set<{ destroy(): void }>();
	const noted = (handler: any) =>
		new Proxy(handler, {
			get: (h, key) => {
				const v = h[key];
				if (typeof v !== "function") return v;
				if (key !== "onRequestUpgrade" && key !== "onUpgrade") return v.bind(h);
				return (...args: any[]) => {
					const socket = args.at(-1);
					if (socket && typeof socket.destroy === "function" && typeof socket.once === "function") {
						sockets.add(socket);
						socket.once("close", () => sockets.delete(socket));
					}
					return v.apply(h, args);
				};
			},
		});
	// A WebSocket is asked for over HTTP/1.1, so that it has a socket of its own, as with the SDK's own connections.
	const line = net.compose((dispatch) => (opts, handler) => (opts.upgrade ? dispatch({ ...opts, allowH2: false } as typeof opts, noted(handler)) : dispatch(opts, handler)));

	const ours = (at: URL) => at.host === api.host || (real && at.protocol === "https:" && (at.hostname === "slack.com" || at.hostname.endsWith(".slack.com")));
	/** Every request of the SDK: only to Slack, never along a redirect, ended when the source stops. */
	const send: FetchFunction = async (url, init = {}) => {
		const at = new URL(String(url));
		// The SDK sends its token with every request, also to an address that an answer named (where a file is uploaded to).
		if (!ours(at)) throw new Plain("an address that is not Slack's was named, and nothing is sent there");
		let body: any = init.body;
		// The SDK builds an upload with Node's own FormData, which this fetch (undici from npm) does not know: it would send the words "[object FormData]".
		if (body instanceof FormData) {
			const form = new Multipart();
			for (const [key, value] of body.entries()) typeof value === "string" ? form.append(key, value) : form.append(key, value, value.name);
			body = form;
		}
		return (await fetch(at, { ...init, body, redirect: "error", dispatcher: net, signal: AbortSignal.any([stop.signal, AbortSignal.timeout(typeof body === "string" ? 20_000 : 180_000)]) })) as any;
	};
	const log = sdkLog(source, [appToken, token ?? ""]);
	// Nothing is tried again by the SDK and no wait is its own: its timers would outlive the source. The loop below and `call` do both.
	const quiet: WebClientOptions = { slackApiUrl: `${base}/`, fetch: send, retryConfig: { retries: 0 }, rejectRateLimitedCalls: true, allowAbsoluteUrls: false };
	const web = token ? new WebClient(token, { ...quiet, logger: log }) : undefined;
	// The SDK's own reconnecting is off: when Slack refuses the token on the way back in, it throws where nothing can catch it, and it never says how things stand.
	const client = new SocketModeClient({ appToken, logger: log, autoReconnectEnabled: false, clientPingTimeout: pace.ping, clientOptions: { ...quiet }, dispatcher: line });

	/** A call of the Web API. When Slack says to wait, it is waited here, where the wait ends with the source. */
	let calm = 0;
	const call = async <T>(what: () => Promise<T>): Promise<T> => {
		for (let again = 0; ; again++) {
			if (calm > Date.now()) await rest(calm - Date.now());
			if (stop.signal.aborted) throw new Plain("stopped");
			try {
				return await what();
			} catch (e) {
				if (!(e instanceof WebAPIRateLimitedError) || again >= 3) throw e;
				calm = Date.now() + Math.min(Math.max(e.retryAfter, 1), 60) * pace.second;
			}
		}
	};

	// ---- names -----------------------------------------------------------------------------------
	// Looked up once each. One that Slack will not give (a scope the app lacks) is not asked for again.
	const names = new Map<string, string | null>();
	/**
	 * The direct conversation with each person, as far as it is known: seen when they wrote, or asked of
	 * Slack once. Kept, because asking needs a permission (im:write) that an app which only listens need not have.
	 */
	const direct = new Map<string, string>(Object.entries(source.kv.get<Record<string, string>>("direct") ?? {}));
	const met = (user: string, channel: string) => {
		if (!user || direct.get(user) === channel) return;
		direct.set(user, channel);
		if (direct.size > 500) for (const k of [...direct.keys()].slice(0, 250)) direct.delete(k);
		source.kv.set("direct", Object.fromEntries(direct));
	};
	/**
	 * The channels and group conversations a message came from, with what Slack calls each, for a source
	 * that listens to every channel the app is in. Kept, because asking Slack which those are needs a
	 * permission (channels:read) that an app which only listens need not have.
	 */
	const rooms = new Map<string, string>(Object.entries(source.kv.get<Record<string, string>>("rooms") ?? {}));
	const cameFrom = (channel: string, type: string) => {
		if (!channel || rooms.has(channel)) return;
		rooms.set(channel, /^(channel|group|mpim)$/.test(type) ? type : "");
		if (rooms.size > 300) for (const k of [...rooms.keys()].slice(0, 150)) rooms.delete(k);
		source.kv.set("rooms", Object.fromEntries(rooms));
	};
	const nameOf = async (kind: "user" | "channel", which: string): Promise<string | undefined> => {
		const key = `${kind}:${which}`;
		// (A name an event brought along is known without asking, also to a source without a token.)
		if (which && web && !names.has(key)) {
			if (names.size > 2000) names.clear();
			try {
				let name: unknown;
				if (kind === "user") {
					const u = (await call(() => web.users.info({ user: which }))).user;
					name = u?.real_name || u?.profile?.display_name || u?.name;
				} else name = (await call(() => web.conversations.info({ channel: which }))).channel?.name;
				names.set(key, name ? clip(String(name), 80) : null);
			} catch (e) {
				// What failed for the moment (no network, "slow down") is asked again with the next message.
				if (e instanceof WebAPIPlatformError && !PASSING.includes(e.data.error)) names.set(key, null);
				source.log.debug(`no name for ${word(which)}`, reason(e, `${kind === "user" ? "users" : "conversations"}.info`));
			}
		}
		return names.get(key) ?? undefined;
	};
	/** The name that goes with an id in an event: `userName` beside `user`, `channelName` beside `channel`. */
	const nameAs = async (key: string, which: string) => {
		const name = await nameOf(key === "channel" ? "channel" : "user", which);
		return name ? { [`${key}Name`]: name } : {};
	};

	// ---- who the app is, and which channels were meant -------------------------------------------------
	/** The account the token belongs to: "me". With a user token that is the owner, with a bot token the bot. */
	let me = "";
	const self = { app: "", bot: "" };
	let ready = !web;
	const prepare = async () => {
		if (ready || !web) return;
		let asking = "auth.test";
		try {
			const who = await call(() => web.auth.test());
			me = String(who.user_id ?? "");
			Object.assign(self, { app: String(who.app_id ?? ""), bot: String(who.bot_id ?? "") });
			asking = "conversations.list";
			const missing = new Set(byName);
			// Private channels need a scope of their own (groups:read). An app without it still finds the public ones.
			for (const types of ["public_channel,private_channel", "public_channel"]) {
				if (!missing.size) break;
				try {
					let cursor = "";
					for (let page = 0; page < 200 && missing.size; page++) {
						const got = await call(() => web.conversations.list({ types, exclude_archived: true, limit: 200, ...(cursor ? { cursor } : {}) }));
						for (const c of got.channels ?? []) {
							const name = String(c.name ?? "").toLowerCase();
							if (!c.id || !missing.delete(name)) continue;
							channels.add(c.id);
							names.set(`channel:${c.id}`, clip(name, 80));
						}
						cursor = String(got.response_metadata?.next_cursor ?? "");
						if (!cursor) break;
					}
					break;
				} catch (e) {
					if (!(e instanceof WebAPIPlatformError && e.data.error === "missing_scope" && types.includes("private"))) throw e;
				}
			}
			if (missing.size) throw new Fatal(`there is no channel named ${[...missing].map((n) => `"${n}"`).join(", ")} that the app can see. Check the spelling, invite the app to a private channel (/invite), or give the channel's id`);
			ready = true;
		} catch (e) {
			if (e instanceof Plain) throw e;
			if (!(e instanceof WebAPIPlatformError) || PASSING.includes(e.data.error)) throw new Plain(reason(e, asking));
			if (asking === "auth.test") throw new Fatal(`Slack does not take the token (${word(e.data.error)}). A bot token (xoxb-...) or user token (xoxp-...) is under "OAuth & Permissions" of the Slack app`);
			throw new Fatal(`Slack does not let the app list the workspace's channels (${word(e.data.error)}). To find a channel by name the app needs the scope channels:read, and groups:read for a private one. Or give the channel's id`);
		}
	};
	const on = (people: string[], who: string) => people.includes(who) || (who === me && people.includes("me"));
	const mentioned = (text: string) => {
		for (const entry of mentions) {
			const who = entry === "me" ? me : entry;
			if (!who) continue;
			const hit = EVERYBODY.includes(who) ? text.includes(`<!${who}>`) || text.includes(`<!${who}|`) : isGroup(who) ? text.includes(`<!subteam^${who}`) : text.includes(`<@${who}>`) || text.includes(`<@${who}|`);
			if (hit) return who;
		}
		return undefined;
	};

	/** A message's text the way a reader sees it: <@U123> is a person, <#C123|name> a channel, <https://x|label> a link. */
	const worded = async (raw: string): Promise<string> => {
		const people = new Map<string, string>();
		for (const who of [...new Set([...raw.matchAll(/<@([A-Z0-9]+)(?:\|[^>]*)?>/g)].map((x) => x[1]))].slice(0, 10)) {
			const name = await nameOf("user", who);
			if (name) people.set(who, name);
		}
		const rooms = new Map<string, string>();
		for (const which of [...new Set([...raw.matchAll(/<#([A-Z0-9]+)\|?>/g)].map((x) => x[1]))].slice(0, 5)) {
			const name = await nameOf("channel", which);
			if (name) rooms.set(which, name);
		}
		return (
			raw
				.replace(/<@([A-Z0-9]+)(?:\|([^>]*))?>/g, (all, who: string, label?: string) => (people.has(who) ? `@${people.get(who)}` : label ? `@${label}` : all))
				.replace(/<#([A-Z0-9]+)(?:\|([^>]*))?>/g, (all, which: string, label?: string) => (label ? `#${label}` : rooms.has(which) ? `#${rooms.get(which)}` : all))
				.replace(/<!(here|channel|everyone)(?:\|[^>]*)?>/g, "@$1")
				.replace(/<!subteam\^[A-Z0-9]+\|@?([^>]+)>/g, "@$1")
				// A link keeps its address next to its words: where it goes is not hidden behind what it says.
				.replace(/<((?:https?:\/\/|mailto:)[^|>\s]+)(?:\|([^>]*))?>/g, (_all, url: string, label?: string) => (label && label !== url && `mailto:${label}` !== url ? `${label} (${url.replace(/^mailto:/, "")})` : url.replace(/^mailto:/, "")))
				.replace(/&lt;/g, "<")
				.replace(/&gt;/g, ">")
				.replace(/&amp;/g, "&")
		);
	};

	// ---- what was written before ------------------------------------------------------------------------
	const history = o.history !== false;
	const around = Math.max(0, Math.min(Number.isInteger(o.context) ? Number(o.context) : 3, 10));
	/** Slack will not hand over earlier messages (the app lacks the scope): not asked for again with every answer in a thread. */
	let noHistory = false;
	/** One earlier message the way an event or a reading carries it. */
	const said = async (m: any, most: number): Promise<{ user: string; userName?: string; text: string; ts: string }> => {
		const user = String(m?.user ?? m?.bot_id ?? "");
		const posted = m?.bot_id ? clip(String(m.username ?? m.bot_profile?.name ?? ""), 80) : "";
		const userName = posted || (user ? await nameOf("user", user) : undefined);
		return { user, ...(userName ? { userName } : {}), text: clip(await worded(readable(m)), most), ts: String(m?.ts ?? "") };
	};
	/** What an answer in a thread answers: the thread's first message and the last few before the answer. */
	const earlier = async (channel: string, thread: string, ts: string) => {
		if (!web || !history || !around || noHistory) return undefined;
		try {
			const res: any = await call(() => web.conversations.replies({ channel, ts: thread, limit: 100 }));
			const before = list(res.messages).filter((m) => Number(m?.ts) < Number(ts)).sort((a, b) => Number(a.ts) - Number(b.ts));
			const first = before.find((m) => String(m.ts) === thread);
			const picked = [...(first ? [first] : []), ...before.filter((m) => m !== first).slice(-(around - (first ? 1 : 0)) || before.length)].slice(0, around);
			const out: Array<Awaited<ReturnType<typeof said>>> = [];
			for (const m of picked) out.push(await said(m, 600));
			return out.length ? out : undefined;
		} catch (e) {
			if (e instanceof WebAPIPlatformError && e.data.error === "missing_scope") noHistory = true;
			source.log.debug("could not read the thread of a message", reason(e));
			return undefined;
		}
	};

	// ---- the files of a message ----------------------------------------------------------------------
	const dir = path.join(source.dataDir, "files");
	let pruner: NodeJS.Timeout | undefined;
	if (token) {
		fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
		source.media(dir);
		pruneFiles(dir, keepMs);
		pruner = setInterval(() => pruneFiles(dir, keepMs), 6 * 3_600_000);
		pruner.unref?.();
	}
	const fromSlack = (at: URL) => (real ? at.protocol === "https:" && at.hostname === FILES : at.protocol === api.protocol && at.host === api.host);
	/** One file of a message: what it is, and its bytes when they could be had. Nothing a message says decides where it is fetched from. */
	const fetched = async (f: any): Promise<MailFile> => {
		const size = Number(f?.size) || 0;
		const none: MailFile = { name: clip(fileName(String(f?.name ?? f?.title ?? ""), "file"), 200), type: clip(String(f?.mimetype ?? f?.filetype ?? ""), 80), size, bytes: Buffer.alloc(0), skipped: true };
		if (!token || size > maxBytes) return none;
		let at: URL;
		try {
			at = new URL(String(f?.url_private_download ?? f?.url_private ?? ""));
		} catch {
			return none;
		}
		if (!fromSlack(at)) return none;
		try {
			const res = await fetch(at, { headers: { authorization: `Bearer ${token}` }, redirect: "manual", dispatcher: net, signal: AbortSignal.any([stop.signal, AbortSignal.timeout(60_000)]) });
			// A file the token may not read is answered with a redirect to the page where one signs in. That page is not the file, and is not followed.
			const page = /text\/html/i.test(res.headers.get("content-type") ?? "") && !/html/i.test(none.type);
			if (res.status !== 200 || !res.body || page) {
				await res.body?.cancel().catch(() => {});
				return none;
			}
			const chunks: Uint8Array[] = [];
			let got = 0;
			for await (const chunk of res.body) {
				got += chunk.length;
				// What a message says a file's size is, is not what is counted.
				if (got > maxBytes) return { ...none, size: Math.max(size, got) };
				chunks.push(chunk);
			}
			return { ...none, size: got, bytes: Buffer.concat(chunks), skipped: false };
		} catch (e) {
			source.log.debug("could not fetch a file", reason(e));
			return none;
		}
	};

	// ---- what counts -----------------------------------------------------------------------------------
	interface Why {
		from?: true;
		mention?: string;
		keyword?: string;
	}
	/** Whether something by `user` in `channel` counts. With a `text` (a message, an edit) mentions and keywords are looked for in it. */
	const counts = (x: { user: string; bot?: string; channel: string; dm: boolean; text?: string }): Why | undefined => {
		// (An app that posts has an id as an app, B..., and often one as a user as well: either may be on a list.)
		const one = (people: string[]) => Boolean((x.user && on(people, x.user)) || (x.bot && people.includes(x.bot)));
		if (one(ignore)) return undefined;
		// What the account itself writes is not news to its owner (with a user token, that is the owner). Unless they ask for it: "me" on `from`.
		if (me && x.user === me && !from.includes("me")) return undefined;
		const mention = x.text === undefined ? undefined : mentioned(x.text);
		const keyword = x.text === undefined ? undefined : keywordIn(keywords, x.text);
		const found: Why = { ...(mention ? { mention } : {}), ...(keyword ? { keyword } : {}) };
		if (one(from)) return { from: true, ...found };
		if (x.dm) return dms ? found : undefined;
		if (x.channel && l.channels.length && !channels.has(x.channel)) return undefined;
		if (x.text !== undefined && (mentions.length || keywords.length) && !mention && !keyword) return undefined;
		return found;
	};
	/** What this source sent itself: a message by where and when, an emoji by its message and name. */
	const sent = new Set<string>();
	const remember = (key: string) => {
		sent.add(key);
		if (sent.size > 500) for (const k of [...sent].slice(0, 250)) sent.delete(k);
	};
	/** A post of the app itself: Slack says which app posted, and what went out through here is known. */
	const own = (m: any, app: string) => {
		const by = String(m?.app_id ?? m?.bot_profile?.app_id ?? "");
		if (by && (by === app || by === self.app)) return true;
		if (m?.bot_id && m.bot_id === self.bot) return true;
		if (self.bot && m?.user && m.user === me) return true;
		return sent.has(`${m?.channel}:${m?.ts}`);
	};
	const placeOf = (channel: string, said?: unknown) => {
		const t = typeof said === "string" && said ? said : channel.startsWith("D") ? "im" : channel.startsWith("G") ? "group" : "channel";
		return { dm: t === "im", kind: t === "im" ? "dm" : t === "mpim" || t === "group" ? "group" : "channel" };
	};

	// One after the other: looking a name up or fetching a file must not let a later report overtake an earlier one.
	let queue = Promise.resolve();
	let waiting = 0;
	let lost = 0;
	/** Report something, if the cap allows: `job` gets the number of reports that were left out before it. */
	const later = (job: (dropped: number) => Promise<void>): boolean => {
		if (!cap.ok()) return false;
		// What waits is bounded too: reports that take long (a file to fetch) must not pile up behind each other.
		if (waiting >= 200) {
			lost++;
			return false;
		}
		waiting++;
		const dropped = cap.dropped() + lost;
		lost = 0;
		queue = queue
			.then(async () => {
				if (!stop.signal.aborted) await job(dropped);
			})
			.catch((e) => source.log.warn("could not report an event", reason(e)))
			.finally(() => void waiting--);
		return true;
	};
	const out = (event: string, payload: Record<string, unknown>, dropped: number) => {
		if (!stop.signal.aborted) source.emit(event, { ...payload, ...(dropped ? { dropped } : {}) });
	};

	/**
	 * Somebody wrote, or what somebody wrote was changed or taken away. `late`: it was not told but asked
	 * for, after a time without a connection. Says whether a message is reported (false: it counts, and
	 * the cap left it out).
	 */
	const written = (m: any, app: string, late = false): boolean | undefined => {
		const edit = m.subtype === "message_changed" || m.subtype === "message_deleted";
		if (!events.has(edit ? "edit" : "message")) return;
		if (m.subtype && !edit && !WRITTEN.includes(m.subtype)) return;
		const channel = String(m.channel ?? "");
		const { dm, kind } = placeOf(channel, m.channel_type);
		if (m.subtype === "message_deleted") {
			const before = m.previous_message ?? {};
			if ((before.bot_id && !bots) || own({ ...before, channel }, app)) return;
			const text = readable(before);
			if (!counts({ user: String(before.user ?? before.bot_id ?? ""), bot: before.bot_id, channel, dm, text })) return;
			later(async (dropped) => out("deleted", { channel, ...(dm ? {} : await nameAs("channel", channel)), ts: String(m.deleted_ts ?? before.ts ?? ""), ...(m.previous_message ? { previous: clip(await worded(text)) } : {}) }, dropped));
			return;
		}
		const now = edit ? { ...(m.message ?? {}), channel } : m;
		const byApp = Boolean(now.bot_id) || now.subtype === "bot_message";
		if ((byApp && !bots) || own(now, app)) return;
		const user = String(now.user ?? now.bot_id ?? "");
		if (!user) return;
		const raw = readable(now);
		const before = edit && m.previous_message ? readable(m.previous_message) : undefined;
		// Slack also says "changed" when it has put the preview of a link under a person's message: what they wrote is the same.
		if (edit && m.previous_message && (byApp ? before === raw : String(now.text ?? "") === String(m.previous_message.text ?? ""))) return;
		// Whoever writes directly shows which conversation is theirs (before any filter: it is only remembered, not reported).
		if (dm && !byApp && user !== me && String(m.channel_type ?? "") === "im") met(user, channel);
		if (!dm && !l.channels.length) cameFrom(channel, String(m.channel_type ?? ""));
		const why = counts({ user, bot: now.bot_id, channel, dm, text: raw });
		if (!why) return;
		return later(async (dropped) => {
			const text = clip(await worded(raw));
			// An app that posts for somebody says under which name; a person's name is looked up.
			const posted = byApp ? clip(String(now.username ?? now.bot_profile?.name ?? ""), 80) : "";
			const who = posted ? { userName: posted } : await nameAs("user", user);
			const place = { channel, ...(dm ? {} : await nameAs("channel", channel)), kind };
			// Why it is reported, in a word each, so that a subscription can pick ("payload.why": {"contains": "mention"}) and an agent need not work it out.
			const because = [...(dm ? ["dm"] : []), ...(why.mention ? ["mention"] : []), ...(why.keyword ? ["keyword"] : []), ...(why.from ? ["from"] : [])];
			const reasons = { why: because.length ? because : ["channel"] };
			if (edit) return out("edited", { text, ...(before !== undefined ? { previous: clip(await worded(before)) } : {}), user, ...who, ...place, ts: String(now.ts ?? ""), ...reasons, ...why }, dropped);
			const inThread = m.thread_ts && m.thread_ts !== m.ts;
			const context = inThread ? await earlier(channel, String(m.thread_ts), String(m.ts ?? "")) : undefined;
			const got: MailFile[] = [];
			for (const f of list(m.files).slice(0, 10)) got.push(await fetched(f));
			const kept = got.length ? keepFiles(dir, { attachments: got } as unknown as Mail) : undefined;
			out(
				"message",
				{
					text,
					user,
					...who,
					...place,
					ts: String(m.ts ?? ""),
					...(m.thread_ts && m.thread_ts !== m.ts ? { thread: String(m.thread_ts), reply: true } : {}),
					...(byApp ? { bot: true } : {}),
					...reasons,
					...why,
					...(context ? { context } : {}),
					...(late ? { late: true } : {}),
					...(kept ? { files: kept.attachments.map((a) => ({ name: a.file, type: a.type, size: a.size, ...(a.path ? { path: a.path } : {}) })) } : {}),
					...(kept?.images ? { images: kept.images } : {}),
				},
				dropped,
			);
		});
	};

	/** Anything else Slack tells an app: an emoji, somebody joining, a channel, a pin, or an event pine has no name for. */
	const happened = (e: any) => {
		const t = String(e.type);
		const kind = KIND_OF[t] ?? "other";
		// A new name is the channel's name from here on, whether or not such changes are reported: in its turn, not before what was written earlier.
		if (/_rename$/.test(t) && typeof e.channel?.id === "string" && typeof e.channel.name === "string" && e.channel.name) queue = queue.then(() => void names.set(`channel:${e.channel.id}`, clip(e.channel.name, 80)));
		if (!events.has(kind)) return;
		const text = (v: unknown) => (typeof v === "string" ? v : "");
		if (kind === "reaction") {
			if (e.item?.type !== "message") return;
			const [user, channel, ts, reaction] = [text(e.user), text(e.item.channel), text(e.item.ts), clip(text(e.reaction), 100)];
			// The emoji the agent put there itself comes back as an event like anybody's.
			if ((self.bot && user === me) || sent.delete(`${channel}:${ts}:${reaction}`)) return;
			if (!counts({ user, channel, dm: placeOf(channel).dm })) return;
			const author = text(e.item_user);
			later(async (dropped) => out("reaction", { reaction, added: t === "reaction_added", user, ...(await nameAs("user", user)), channel, ...(await nameAs("channel", channel)), ts, ...(author ? { author, ...(await nameAs("author", author)) } : {}) }, dropped));
		} else if (kind === "member") {
			const user = typeof e.user === "string" ? e.user : text(e.user?.id);
			const channel = text(e.channel);
			if (!user || !counts({ user, channel, dm: false })) return;
			later(async (dropped) => {
				// Somebody new to the workspace comes with their name.
				const called = text(e.user?.real_name) || text(e.user?.name);
				if (called && !names.get(`user:${user}`)) names.set(`user:${user}`, clip(called, 80));
				out(t === "member_left_channel" ? "left" : "joined", { user, ...(await nameAs("user", user)), ...(channel ? { channel, ...(await nameAs("channel", channel)) } : {}) }, dropped);
			});
		} else if (kind === "channel") {
			const channel = typeof e.channel === "string" ? e.channel : text(e.channel?.id);
			const what = CHANGED[t.replace(/^(channel|group)_/, "")];
			if (!channel || !what || !counts({ user: text(e.user) || text(e.channel?.creator), channel, dm: false })) return;
			later(async (dropped) => {
				// A channel that was just made comes with its name.
				if (typeof e.channel?.name === "string" && e.channel.name) names.set(`channel:${channel}`, clip(e.channel.name, 80));
				out("channel", { what, channel, ...(what === "deleted" && !names.get(`channel:${channel}`) ? {} : await nameAs("channel", channel)) }, dropped);
			});
		} else if (kind === "pin") {
			const [user, channel, ts] = [text(e.user), text(e.channel_id) || text(e.item?.channel), text(e.item?.message?.ts)];
			if (!channel || !counts({ user, channel, dm: placeOf(channel).dm })) return;
			later(async (dropped) => out("pin", { added: t === "pin_added", channel, ...(await nameAs("channel", channel)), ...(ts ? { ts } : {}), user, ...(await nameAs("user", user)) }, dropped));
		} else {
			if (!/^[a-z0-9_.:-]{1,80}$/i.test(t)) return;
			const channel = text(e.channel) || text(e.channel_id);
			if (!counts({ user: text(e.user) || text(e.user?.id) || text(e.user_id), channel, dm: channel ? placeOf(channel).dm : false })) return;
			later(async (dropped) => out("event", { type: t, data: shown(e) }, dropped));
		}
	};

	/** A slash command of the app. Says whether it is passed on, which is what its sender is told. */
	const command = (c: any): boolean => {
		if (!events.has("command") || typeof c?.command !== "string") return false;
		const [user, channel] = [String(c.user_id ?? ""), String(c.channel_id ?? "")];
		if (!counts({ user, channel, dm: placeOf(channel).dm })) return false;
		return later(async (dropped) => out("command", { command: clip(c.command, 100), text: clip(await worded(String(c.text ?? ""))), user, ...(await nameAs("user", user)), channel, ...(placeOf(channel).dm ? {} : await nameAs("channel", channel)) }, dropped));
	};

	// Slack sends an event again when its acknowledgement was slow, and tells an app about a message
	// that mentions it twice (as a message and as a mention): what was seen is not reported again.
	// The last messages are remembered across a restart, so that asking for what was written meanwhile
	// does not report the ones from just before it again.
	const seen = new Set<string>(list(source.kv.get("seen")).map(String));
	const fresh = (key: string) => {
		if (seen.has(key)) return false;
		seen.add(key);
		if (seen.size > 2000) for (const k of [...seen].slice(0, 1000)) seen.delete(k);
		return true;
	};
	client.on("slack_event", (env: any) => {
		let answer: Record<string, unknown> | undefined;
		try {
			const body = env?.body ?? {};
			const e = body.event;
			if (env?.type === "slash_commands") {
				if (command(body)) answer = { text: PASSED };
			} else if (env?.type === "events_api" && e && typeof e === "object" && typeof e.type === "string" && (!body.event_id || fresh(String(body.event_id)))) {
				const said = e.type === "message" || e.type === "app_mention";
				if (!said) happened(e);
				else if (e.subtype === "message_changed" || e.subtype === "message_deleted" || fresh(`${e.channel}:${e.ts}`)) written(e, String(body.api_app_id ?? ""));
			}
		} catch (e) {
			source.log.warn("could not take an event", errText(e));
		}
		// Every envelope is acknowledged, also one that is not reported (a button, a form): Slack sends again what it thinks was not taken.
		if (typeof env?.ack === "function") void Promise.resolve(env.ack(answer)).catch((e: unknown) => source.log.debug("could not acknowledge", errText(e)));
	});
	// Slack says why it is about to close a connection, in a message the SDK acts on and does not hand on.
	let closing = "";
	client.on("ws_message", (data: unknown) => {
		if (typeof data !== "string" || data.length > 2000 || !data.includes('"disconnect"')) return;
		try {
			const m = JSON.parse(data);
			if (m?.type === "disconnect") closing = String(m.reason ?? "");
		} catch {
			// not for us
		}
	});
	// A socket address that is not encrypted is not connected to. (Thrown here, the SDK takes it for a failed start.)
	client.on("authenticated", (r: any) => {
		if (guard && !/^wss:\/\//i.test(String(r?.url ?? ""))) throw new Plain("Slack gave an address that is not wss://");
	});

	/**
	 * End the connection. The SDK says goodbye and waits for the answer; a socket that is still
	 * open after `pace.bye` is cut, which is the end of the SDK's wait too. Nothing is open after this.
	 */
	const leave = async () => {
		const cut = () => {
			for (const s of sockets) s.destroy();
		};
		const late = setTimeout(cut, pace.bye);
		await client.disconnect().catch(() => {});
		clearTimeout(late);
		cut();
	};

	// ---- the time it was not connected ------------------------------------------------------------------
	// Slack does not send again what was written while no connection was open. So the source notes when
	// its connection last worked, and once it is connected again it asks Slack for what was written
	// since, as far as its token lets it, and says how long it was away and whether that is everything.
	/** When the connection was last known to work. Noted every few seconds, and kept across a restart. */
	let alive = Number(source.kv.get("alive")) || 0;
	// A look back that a restart cut short begins where it began.
	const owed = Number(source.kv.get("owed")) || 0;
	if (owed && owed < alive) alive = owed;
	let beat: NodeJS.Timeout | undefined;
	/** Why the source itself ended a connection that looked open. */
	let stale = "";
	let lastGap = "";
	let held: Held | undefined;
	const lives = () => {
		alive = Date.now();
		source.kv.set("alive", alive);
		source.kv.set("seen", [...seen].filter((k) => /^\w+:\d+\.\d+$/.test(k)).slice(-100));
	};
	const stamp = (ms: number) => new Date(ms).toLocaleString("sv-SE").slice(0, 19);
	const span = (ms: number) => {
		const of = (n: number, unit: string) => `${Math.round(n)} ${plural(Math.round(n), unit)}`;
		return ms < 90_000 ? of(ms / 1000, "second") : ms < 5_400_000 ? of(ms / 60_000, "minute") : ms < 129_600_000 ? of(ms / 3_600_000, "hour") : of(ms / 86_400_000, "day");
	};
	/**
	 * Ask Slack for what was written between `since` and `until`, where the source listens and nowhere
	 * else, and report it as late. After a gap of a minute or more an event of its own says how long it
	 * was and what could not be looked at; a shorter one (Slack renewing its connection) is made up for
	 * quietly, in the conversations the source knows without asking.
	 */
	const catchUp = async (since: number, until: number) => {
		const long = until - since >= pace.quiet;
		const missing: string[] = [];
		const gathered: any[] = [];
		let looked = 0;
		if (!events.has("message")) {
			// Nothing of what it reports can be asked for: said below.
		} else if (!web) missing.push("this source has no token, so it could not ask Slack what was written in that time");
		else if (!history) missing.push('this source was set up not to read what was written earlier ("history": false)');
		else {
			source.kv.set("owed", since);
			// A line can be dead for a while before anybody knows, and Slack's clock is not this machine's: asked from a little earlier. What was told already is known (`fresh`).
			const oldest = (since - pace.beat - pace.margin) / 1000;
			// Where: the channels it was given, then what it has seen a message in, the newest first. After a long gap, also what Slack lists.
			const places = new Map<string, string>();
			for (const c of channels) places.set(c, "");
			if (dms) for (const c of [...direct.values()].reverse()) if (!places.has(c)) places.set(c, "im");
			if (!l.channels.length) for (const [c, type] of [...rooms].reverse()) if (!places.has(c)) places.set(c, type);
			if (long) {
				for (const p of PLACES) {
					if (p.type === "im" ? !dms : l.channels.length > 0) continue;
					try {
						let cursor = "";
						for (let page = 0; page < 5; page++) {
							const got: any = await call(() => web.users.conversations({ types: p.types, exclude_archived: true, limit: 200, ...(cursor ? { cursor } : {}) }));
							for (const c of list(got.channels)) if (typeof c?.id === "string" && isChannel(c.id) && !places.has(c.id)) places.set(c.id, p.type);
							cursor = String(got.response_metadata?.next_cursor ?? "");
							if (!cursor) break;
						}
					} catch (e) {
						if (stop.signal.aborted) return;
						const lacks = e instanceof WebAPIPlatformError && e.data.error === "missing_scope";
						missing.push(`${p.what} this source had not seen a message in were not looked at (${lacks ? `the app lacks the scope ${p.lists}` : reason(e, "users.conversations")})`);
					}
				}
				if (l.channels.length && from.length) missing.push('what the people on "from" wrote outside the listed channels was not looked for');
			}
			const all = [...places].slice(0, long ? MOST : NEAR);
			if (long && places.size > all.length) missing.push(`${places.size - all.length} more ${plural(places.size - all.length, "conversation")} were not looked at: ${MOST} is the most at once`);
			let flooded = 0;
			/** What was written in one conversation since: its messages, and the answers in the threads among its last messages. */
			const read = async (channel: string, type: string) => {
				const got: any[] = [];
				const threads = new Set<string>();
				let latest = "";
				for (let page = 0; ; page++) {
					const res: any = await call(() => web.conversations.history({ channel, limit: PAGE, ...(latest ? { latest, inclusive: false } : {}) }));
					const batch = list(res.messages);
					for (const m of batch) {
						if (Number(m?.ts) > oldest) got.push(m);
						if (Number(m?.latest_reply) > oldest && threads.size < 10) threads.add(String(m.ts));
					}
					if (!res.has_more || !batch.length || batch.some((m) => !(Number(m?.ts) > oldest))) break;
					if (page >= 3) {
						flooded++;
						break;
					}
					latest = String(batch.reduce((a, m) => (Number(m.ts) < Number(a.ts) ? m : a)).ts);
				}
				for (const ts of threads) {
					const res: any = await call(() => web.conversations.replies({ channel, ts, oldest: oldest.toFixed(6), limit: 100 }));
					got.push(...list(res.messages).filter((m) => String(m?.ts) !== ts && Number(m?.ts) > oldest));
				}
				return got.map((m) => ({ ...m, type: "message", channel, ...(type ? { channel_type: type } : {}) }));
			};
			const kindOf = (channel: string, type: string) => PLACES.find((p) => p.type === (type || (channel.startsWith("D") ? "im" : channel.startsWith("G") ? "group" : "channel")))!;
			const closed = new Map<(typeof PLACES)[number], number>();
			const failed = new Map<string, number>();
			const count = <K>(m: Map<K, number>, key: K) => void m.set(key, (m.get(key) ?? 0) + 1);
			/** One conversation. Says whether to try it once more: what failed for the moment (the network) may work a little later. */
			const look = async (channel: string, type: string, last: boolean): Promise<boolean> => {
				const kind = kindOf(channel, type);
				// What Slack refused for one conversation of a kind, it refuses for the others: counted, not asked.
				if (closed.has(kind)) {
					count(closed, kind);
					return false;
				}
				try {
					gathered.push(...(await read(channel, type)));
					looked++;
				} catch (e) {
					if (stop.signal.aborted) return false;
					if (e instanceof WebAPIPlatformError && e.data.error === "missing_scope") count(closed, kind);
					else if (e instanceof WebAPIPlatformError && !PASSING.includes(e.data.error)) count(failed, word(e.data.error));
					else if (last) count(failed, reason(e, "conversations.history"));
					else return true;
				}
				return false;
			};
			const again: Array<[string, string]> = [];
			let asked = 0;
			for (const [channel, type] of all) {
				if (stop.signal.aborted) return;
				// Many at once would be more than Slack takes in a minute.
				if (++asked > 30) await rest(pace.between);
				if (await look(channel, type, false)) again.push([channel, type]);
			}
			for (const [channel, type] of again) {
				if (stop.signal.aborted) return;
				await look(channel, type, true);
			}
			for (const [kind, n] of closed) missing.push(`${n} ${n === 1 ? kind.what.replace(/s$/, "") : kind.what} could not be read (the app lacks the scope ${kind.reads})`);
			for (const [why, n] of failed) missing.push(`${n} ${plural(n, "conversation")} could not be read (${why})`);
			if (flooded) missing.push(`in ${flooded} ${plural(flooded, "conversation")} more was written than the last ${PAGE * 4} messages, and the older ones were not looked at`);
		}
		if (stop.signal.aborted) return;
		gathered.sort((a, b) => Number(a.ts) - Number(b.ts));
		const tally = { found: 0, over: 0 };
		// In its turn: before the late messages, which are counted by the time this runs.
		if (long)
			queue = queue
				.then(() => {
					if (stop.signal.aborted) return;
					if (tally.over) missing.push(`${tally.over} more ${plural(tally.over, "message")} from that time ${plural(tally.over, "was", "were")} left out, since at most ${perMinute} are reported in a minute ("perMinute"): read_source shows what was written`);
					const others = [...events].filter((k) => k !== "message").map((k) => KINDS[k].short);
					if (others.length) missing.push(`what else happened in that time (${others.join(", ")}) cannot be asked for afterwards`);
					const complete = !missing.length;
					const text = [
						`Slack was not connected from ${stamp(since)} to ${stamp(until)} (${span(until - since)}).`,
						tally.found ? `${tally.found} ${plural(tally.found, "message")} written in that time ${plural(tally.found, "follows", "follow")}, marked "late".` : looked ? "Nothing that counts was written in that time where it looked." : "",
						complete ? (looked ? `It looked through ${looked === 1 ? "the one conversation" : `all ${looked} conversations`} it listens to.` : "There is no conversation it listens to yet.") : `This is not everything: ${missing.join("; ")}.`,
					];
					source.emit("gap", { text: text.filter(Boolean).join(" "), from: stamp(since), to: stamp(until), seconds: Math.round((until - since) / 1000), found: tally.found, looked, complete, ...(complete ? {} : { missing }) });
					lastGap = `Not connected from ${stamp(since)} to ${stamp(until)}: ${complete ? "what was written then was asked for afterwards" : "not everything from then is known"}`;
					held?.refresh();
				})
				.catch((e) => source.log.warn("could not report a gap", reason(e)));
		for (const m of gathered) {
			if (!fresh(`${m.channel}:${m.ts}`)) continue;
			const took = written(m, self.app, true);
			if (took) tally.found++;
			else if (took === false) tally.over++;
		}
		source.kv.set("owed", 0);
	};
	let catching = Promise.resolve();
	/** Connected: from here on the connection is noted to work, and what was written since it last did is asked for. */
	const back = () => {
		const [since, until] = [alive, Date.now()];
		lives();
		beat = setInterval(() => {
			// This is late: the machine slept, or the process stood still. What the line carried meanwhile is not known, so it is connected to again and asked for.
			if (Date.now() - alive > pace.beat + pace.margin / 2) {
				stale = "this machine stood still for a while";
				return void leave();
			}
			lives();
		}, pace.beat);
		beat.unref?.();
		if (since) catching = catching.then(() => catchUp(since, until)).catch((e) => source.log.warn("could not ask for what was written meanwhile", reason(e)));
	};
	const away = () => {
		clearInterval(beat);
		beat = undefined;
	};

	source.onStop(async () => {
		// Stopped while connected: up to here nothing was missed.
		if (beat) lives();
		away();
		stop.abort();
		clearInterval(pruner);
		await leave();
		await local?.close().catch(() => {});
	});

	// What cannot work (a channel that is not there, a token Slack does not take) is found out now and is why the
	// source does not start. What only fails for the moment (no network yet) is tried again by the loop below.
	try {
		await prepare();
	} catch (e) {
		if (e instanceof Fatal) throw new Error(e.message);
	}

	const listening = () => {
		const kinds = [...events].map((k) => KINDS[k]?.short ?? k);
		return `listening to ${[l.channels.length ? `${l.channels.length} ${plural(l.channels.length, "channel")}` : "every channel the app is in", ...(dms ? ["direct messages"] : [])].join(" and ")}${events.size === 1 && events.has("message") ? "" : `, for ${kinds.join(", ")}`}`;
	};
	let fatal = false;
	held = hold(source, {
		host: api.hostname,
		note: () => `${listening()}${lastGap ? `. ${lastGap}` : ""}`,
		run: async (signal, up, wait) => {
			// Said once; trying the same again and again would ask Slack for nothing new.
			if (fatal) return new Promise<void>((resolve) => signal.addEventListener("abort", () => resolve(), { once: true }));
			try {
				await prepare();
			} catch (e) {
				fatal = e instanceof Fatal;
				throw e;
			}
			if (calm > Date.now()) await rest(calm - Date.now());
			closing = "";
			stale = "";
			let trouble: unknown;
			let ended = () => {};
			const gone = new Promise<void>((resolve) => (ended = resolve));
			// The first trouble is the reason; what follows from ending the connection is not.
			const failed = (e: unknown) => void (trouble ??= e);
			client.on("error", failed);
			client.on("disconnected", ended);
			const greeted = setTimeout(() => {
				trouble = new Plain("Slack did not greet the connection in time");
				void leave();
			}, pace.hello);
			try {
				try {
					await client.start();
				} catch (e) {
					if (e instanceof WebAPIRateLimitedError) calm = Date.now() + Math.min(Math.max(e.retryAfter, 1), 60) * pace.second;
					throw new Plain(reason(trouble ?? e, "apps.connections.open"));
				} finally {
					clearTimeout(greeted);
				}
				up();
				back();
				await gone;
			} finally {
				away();
				// Down for certain before the next attempt: a socket that is still saying goodbye would be taken for the new one.
				await leave();
				client.off("error", failed);
				client.off("disconnected", ended);
			}
			// Slack renews its connections now and then and says so beforehand: connected to again at once.
			if (closing === "warning" || closing === "refresh_requested") {
				wait(10);
				throw new Plain("Slack asked for a new connection");
			}
			throw new Plain(stale || (closing ? `Slack closed the connection: ${word(closing)}` : trouble ? reason(trouble) : "the connection was closed"));
		},
	});

	// ---- sending: only to what the owner put on the list, whatever the call names ------------------------------
	const refused = (e: unknown, method: string): Error => {
		if (!(e instanceof WebAPIPlatformError)) return new Error(`could not send through Slack: ${reason(e)}`);
		const code = e.data.error;
		const scope = String((e.data as any).needed ?? "");
		const hint =
			code === "not_in_channel"
				? ". The app is not in that channel: somebody there writes /invite and the app's name"
				: code === "missing_scope"
					? `. The app lacks ${/^[\w.:,-]{1,100}$/.test(scope) ? `the scope ${scope}` : "a scope"}: your owner adds it under "OAuth & Permissions" of the Slack app and installs the app again`
					: code === "channel_not_found"
						? ". Slack knows no such channel, or the app may not see it"
						: "";
		return new Error(`Slack refused ${method}: ${word(code)}${hint}`);
	};
	const doing = async <T>(method: string, what: () => Promise<T>): Promise<T> => {
		try {
			return await call(what);
		} catch (e) {
			throw refused(e, method);
		}
	};
	/** The conversation with one person. Slack says which it is; asked once. */
	const directly = async (user: string): Promise<string> => {
		if (!direct.has(user)) {
			const opened = (await doing("conversations.open", () => web!.conversations.open({ users: user }))).channel?.id;
			if (!opened) throw new Error("Slack opened no conversation with that person");
			met(user, opened);
		}
		return direct.get(user)!;
	};
	// ---- reading: what was written earlier, where the source listens and nowhere else ----------------------
	const listensTo = (channel: string) => (channel.startsWith("D") ? dms : !l.channels.length || channels.has(channel));
	source.onRead(async (q) => {
		if (!web) throw new Error('this source has no bot or user token, so it cannot read what was written earlier. Your owner sets it up again and names "token" in "ask"');
		if (!history) throw new Error('this source was set up not to read what was written earlier ("history": false). Tell your owner if you need it');
		const stampOf = (v: unknown, key: string) => {
			if (!/^\d{1,12}\.\d{1,9}$/.test(String(v))) throw new Error(`"${key}" is the ts of a message, as an event had it: "1712345678.000100"`);
			return String(v);
		};
		let channel = String(q.channel ?? "").trim().replace(/^[#@]/, "");
		if (!channel) throw new Error('say where: {"channel": "..."} with the "channel" of an event (it starts with C, G or D), and "thread" for a thread');
		// The conversation with one person, named by the person.
		if (isUser(channel)) {
			if (!dms) throw new Error("this source does not listen to direct messages, so it does not read them either");
			try {
				channel = await directly(channel);
			} catch (e) {
				throw new Error(`${e instanceof Error ? e.message : String(e)}. Or name the conversation itself: the "channel" of a message that person wrote to your owner (it starts with D)`);
			}
		}
		if (!isChannel(channel)) throw new Error(`"${clip(channel, 60)}" is not the id of a channel or a conversation. Take the "channel" of an event: it starts with C, G or D`);
		// Reading goes as far as listening does: what the owner set the source up for.
		if (!listensTo(channel)) throw new Error(`this source does not listen to ${channel}, so it does not read there either. It listens to ${channel.startsWith("D") ? "no direct messages" : `${[...channels].join(", ")}${dms ? " and direct messages" : ""}`}`);
		const limit = Math.max(1, Math.min(Number.isInteger(Number(q.limit)) && q.limit !== undefined ? Number(q.limit) : 20, 50));
		const thread = q.thread !== undefined && q.thread !== "" ? stampOf(q.thread, "thread") : undefined;
		const before = q.before !== undefined && q.before !== "" ? stampOf(q.before, "before") : undefined;
		let res: any;
		try {
			res = await call(() => (thread ? web.conversations.replies({ channel, ts: thread, limit, ...(before ? { latest: before, inclusive: false } : {}) }) : web.conversations.history({ channel, limit, ...(before ? { latest: before, inclusive: false } : {}) })));
		} catch (e) {
			if (!(e instanceof WebAPIPlatformError)) throw new Error(`could not read from Slack: ${reason(e)}`);
			const code = e.data.error;
			const scope = String((e.data as any).needed ?? "");
			const hint =
				code === "missing_scope"
					? `. The app lacks ${/^[\w.:,-]{1,100}$/.test(scope) ? `the scope ${scope.split(",").join(" or ")}` : "a scope"} (for a user token: among the User Token Scopes): your owner adds it under "OAuth & Permissions" of the Slack app and installs the app again`
					: code === "channel_not_found" || code === "not_in_channel"
						? ". Slack knows no such conversation, or this token may not see it"
						: code === "thread_not_found"
							? '. There is no thread with that ts in that conversation: "thread" is the ts of a thread\'s first message'
							: "";
			throw new Error(`Slack did not hand it over: ${word(code)}${hint}`);
		}
		const written = list(res.messages)
			.filter((m) => !m?.subtype || WRITTEN.includes(m.subtype))
			.sort((a, b) => Number(a.ts) - Number(b.ts));
		const place = `${channel.startsWith("D") ? "the direct conversation" : `the channel ${(await nameOf("channel", channel)) ?? ""}`.trim()} ${channel}`;
		if (!written.length) return `Nothing was written ${thread ? `in the thread ${thread} of ${place}` : `in ${place}`}${before ? ` before ${before}` : ""}.`;
		const lines: string[] = [];
		for (const m of written) {
			const one = await said(m, 1500);
			const when = new Date(Number(one.ts) * 1000).toLocaleString("sv-SE").slice(0, 16);
			const answers = !thread && Number(m.reply_count) > 0 ? `, a thread with ${Number(m.reply_count)} ${plural(Number(m.reply_count), "answer")}` : "";
			const files = list(m.files).length ? ` [${list(m.files).length} ${plural(list(m.files).length, "file")}]` : "";
			lines.push(`[${when}] ${one.userName ?? one.user} (ts ${one.ts}${answers}): ${one.text}${files}`);
		}
		const more = res.has_more ? (thread ? " The thread has more answers than these." : ` There is more before these: the same call with "before": "${String(written[0].ts)}".`) : "";
		return `${thread ? `The thread ${thread} in ${place}` : `The last ${written.length} ${plural(written.length, "message")} in ${place}`}, oldest first.${more}${thread ? "" : ' To read a thread: the same call with "thread" set to the message\'s ts.'}\n\n${lines.join("\n")}`;
	});

	source.onSend(async (message) => {
		if (!sendTo.length) throw new Error('this source was set up to listen only: it has nowhere to send to. Tell your owner; they can set it up again with "sendTo"');
		if (!web) throw new Error('this source has no bot or user token, so it cannot send. Set it up again and name "token" in "ask"');
		const target = String(message.channel ?? (sendTo.length === 1 ? sendTo[0] : "")).replace(/^[#@]/, "");
		if (!target) throw new Error(`say where to: {"channel": "...", "text": "..."}. It may send to ${sendTo.join(", ")}`);
		let channel = target;
		if (isUser(target) && sendTo.includes(target)) channel = await directly(target);
		else if (!sendTo.includes(target)) {
			// An answer to a direct message names the conversation, and the list names the person: Slack says whether they are the same.
			let theirs = false;
			if (target.startsWith("D")) for (const user of sendTo.filter(isUser)) theirs ||= (await directly(user)) === target;
			if (!theirs) throw new Error(`"${target}" is not a ${isUser(target) ? "person" : "channel"} this source may send to (${sendTo.join(", ")})`);
		}
		const there = isUser(target) ? `${target} on Slack, directly` : `the Slack channel ${channel}`;
		const stamp = (v: unknown, key: string) => {
			if (!/^\d{1,12}\.\d{1,9}$/.test(String(v))) throw new Error(`"${key}" is the ts of a message, as the event had it: "1712345678.000100"`);
			return String(v);
		};
		if (message.react !== undefined) {
			const name = String(message.react).trim().replace(/^:|:$/g, "").toLowerCase();
			if (!/^[\p{L}\p{N}_+'-]{1,80}(::skin-tone-[2-6])?$/u.test(name)) throw new Error('"react" is the name of an emoji as Slack writes it between colons: "eyes", "white_check_mark", "+1"');
			const ts = stamp(message.ts, "ts");
			remember(`${channel}:${ts}:${name}`);
			try {
				await call(() => web.reactions.add({ channel, timestamp: ts, name }));
			} catch (e) {
				// It is there already: what was asked for is the case.
				if (!(e instanceof WebAPIPlatformError && e.data.error === "already_reacted")) throw refused(e, "reactions.add");
			}
			return `put :${name}: on the message in ${there}`;
		}
		// "@channel" and its kind would call on everybody there. What an agent writes says it and calls on nobody.
		const text = String(message.text ?? "").trim().replace(/<!(channel|here|everyone)(?:\|[^>]*)?>/g, "@$1");
		const thread = message.thread === undefined || message.thread === "" ? undefined : stamp(message.thread, "thread");
		const file = message.file as { name: string; mime: string; bytes: Buffer } | undefined;
		if (file && Buffer.isBuffer(file.bytes)) {
			const filename = fileName(String(file.name ?? ""), "file");
			await doing("files.uploadV2", () => web.filesUploadV2({ channel_id: channel, file: file.bytes, filename, ...(text ? { initial_comment: text.slice(0, 39_000) } : {}), ...(thread ? { thread_ts: thread } : {}) } as any));
			return `posted ${filename} to ${there}`;
		}
		if (!text) throw new Error('there is nothing to send: give "text"');
		const done = await doing("chat.postMessage", () => web.chat.postMessage({ channel, text: text.slice(0, 39_000), ...(thread ? { thread_ts: thread } : {}) }));
		if (done.ts) remember(`${done.channel ?? channel}:${done.ts}`);
		return isUser(target) ? `sent to ${there}` : `posted to ${there}`;
	});
}
