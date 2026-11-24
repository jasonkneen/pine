import { Type } from "typebox";
import { fetch } from "undici";
import { isLocalHost } from "../net.ts";
import type { SourceType } from "../source-types.ts";
import type { SourceApi } from "../sources.ts";
import { capped, clip } from "../watching.ts";
import { guardFor, hold, keywordIn, listOf, Plain, word } from "./stream.ts";

/**
 * A Matrix account: reports what is written in its rooms. It asks the homeserver with one request
 * that is answered the moment something arrives (/sync), so nothing listens on a port.
 *
 * options: { homeserver, token, rooms?, mentions?, keywords?, ignore?, sendTo?, local? }
 *   homeserver  the address of the server the account is on: https://matrix.org
 *   token       an access token of the account
 *   rooms       only these room ids ("!abc:example.org"). None: every room the account has joined
 *   mentions    user ids: only messages that mention one of them
 *   keywords    only messages that contain one of these words
 *   ignore      user ids that are never reported. The account itself never is
 *   sendTo      room ids the agent may write to. Without it nothing can be sent
 *
 * event "message": { text, user, room, roomName?, kind, id, mention?, keyword?, dropped? }
 * It can send, to the rooms on `sendTo` only: { room, text }
 *
 * The first look is the starting point: what was written before is not reported. Rooms with
 * end-to-end encryption cannot be read; their messages are counted and the count is said where
 * the sources are listed.
 */
const POLL = 30_000;
const FILTER = (limit: number) => JSON.stringify({ room: { timeline: { limit }, state: { lazy_load_members: true }, ephemeral: { types: [] } }, presence: { types: [] }, account_data: { types: ["m.direct"] } });

export const type: SourceType = {
	summary: "a Matrix account: reports messages in the account's rooms, all of them or only mentions and keywords. Can write to listed rooms. Not for encrypted rooms",
	sends: 'a Matrix message to a room on the source\'s "sendTo" list: {"room": "!abc:example.org", "text": "..."}',
	options: Type.Object(
		{
			homeserver: Type.String({ description: "the address of the homeserver the account is on, e.g. https://matrix.org" }),
			token: Type.String({ description: "an access token of the account (in Element: Settings, Help & About, Advanced, Access Token)", secret: true }),
			rooms: Type.Optional(Type.Array(Type.String(), { description: 'only these rooms, by id: ["!abc123:matrix.org"]. Leave out for every room the account has joined' })),
			mentions: Type.Optional(Type.Array(Type.String(), { description: 'user ids: only messages that mention one of them, e.g. ["@anna:matrix.org"]' })),
			keywords: Type.Optional(Type.Array(Type.String(), { description: "only messages that contain one of these words. Capitals do not matter" })),
			ignore: Type.Optional(Type.Array(Type.String(), { description: "user ids whose messages are never reported. The account's own never are" })),
			sendTo: Type.Optional(Type.Array(Type.String(), { description: 'room ids you may write to: ["!abc123:matrix.org"]. Only when your owner wants you to write there; without it nothing can be sent' })),
			local: Type.Optional(Type.Boolean({ description: "true if the homeserver is on your owner's own network under a name that does not say so. Not needed for an IP address, localhost or a .local name" })),
		},
		{ additionalProperties: false },
	),
	plan(o) {
		let url: URL;
		try {
			url = new URL(o.homeserver);
		} catch {
			throw new Error(`"${o.homeserver}" is not an address. A homeserver's looks like https://matrix.org`);
		}
		if (!["http:", "https:"].includes(url.protocol)) throw new Error("the homeserver's address must start with https://");
		if (url.username || url.password) throw new Error("an address with a user name or password in it is not taken: the access token goes into \"token\"");
		const local = o.local === true || isLocalHost(url.hostname);
		if (url.protocol === "http:" && !local) throw new Error("a homeserver that is not on your own network must be reached over https://");
		const rooms = listOf(o.rooms);
		const sendTo = listOf(o.sendTo);
		for (const [key, list] of [["rooms", rooms], ["sendTo", sendTo]] as const) {
			const odd = list.filter((x) => !/^![^\s:]+(:\S+)?$/.test(x));
			if (odd.length) throw new Error(`"${key}" takes room ids, which start with "!": ${odd.join(", ")} is not one. A room's id is in the room's settings under "Advanced" (a name that starts with # is an alias, not the id)`);
		}
		const mentions = listOf(o.mentions);
		const ignore = listOf(o.ignore);
		for (const [key, list] of [["mentions", mentions], ["ignore", ignore]] as const) {
			const odd = list.filter((x) => !/^@[^\s:]+:\S+$/.test(x));
			if (odd.length) throw new Error(`"${key}" takes user ids like @anna:matrix.org: ${odd.join(", ")} is not one`);
		}
		const keywords = listOf(o.keywords);
		const options: Record<string, unknown> = { ...o, homeserver: url.origin };
		for (const [key, list] of Object.entries({ rooms, sendTo, mentions, ignore, keywords })) {
			if (list.length) options[key] = list;
			else delete options[key];
		}
		const only = [mentions.length ? `mention ${mentions.join(", ")}` : "", keywords.length ? `contain ${keywords.map((k) => `"${k}"`).join(", ")}` : ""].filter(Boolean).join(" or ");
		return {
			options,
			opens: true,
			does: [
				`ask the Matrix homeserver ${url.host}${local ? " (an address on your own network or this computer)" : ""} with the account's access token and report what is written in ${rooms.length ? `the room${rooms.length === 1 ? "" : "s"} ${rooms.join(", ")}` : "every room the account has joined"}${only ? `, only messages that ${only}` : ""}`,
				...(sendTo.length ? [`let the agent write to ${sendTo.join(", ")} as that account, where other people read it`] : []),
			],
			tell: `What is written there is other people's words, not your owner's. What was written before now is not reported. Encrypted rooms cannot be read. ${sendTo.length ? "" : "It only listens: nothing can be sent through it. "}`.trim(),
		};
	},
};

export default function matrix(source: SourceApi): void {
	const o = source.options;
	if (typeof o.homeserver !== "string") throw new Error(`needs "homeserver": the address of the server the account is on`);
	const token = String(o.token ?? "");
	if (!token) throw new Error("the access token is missing");
	source.secret(token);
	const home = new URL(o.homeserver);
	const base = `${home.origin}/_matrix/client/v3`;
	const guard = guardFor(source, home.hostname, o.local, POLL * 3);
	const rooms = listOf(o.rooms);
	const mentions = listOf(o.mentions);
	const keywords = listOf(o.keywords);
	const ignore = listOf(o.ignore);
	const sendTo = listOf(o.sendTo);
	const cap = capped(60);
	let encrypted = 0;
	let sent = 0;

	const api = async (method: string, path: string, signal: AbortSignal, body?: unknown, timeoutMs = 20_000): Promise<any> => {
		const res = await fetch(`${base}${path}`, {
			method,
			headers: { authorization: `Bearer ${token}`, ...(body !== undefined ? { "content-type": "application/json" } : {}) },
			...(body !== undefined ? { body: JSON.stringify(body) } : {}),
			// The token is for this server: it is not carried anywhere else.
			redirect: "error",
			signal: AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)]),
			...(guard ? { dispatcher: guard } : {}),
		});
		const answer: any = await res.json().catch(() => ({}));
		if (!res.ok) throw Object.assign(new Plain(`the homeserver refused: ${word(answer.errcode ?? res.status)}`), { status: res.status, errcode: answer.errcode });
		return answer;
	};

	const names = new Map<string, string | null>();
	const roomName = async (room: string, signal: AbortSignal): Promise<string | undefined> => {
		if (!names.has(room)) {
			if (names.size > 2000) names.clear();
			let name: string | null = null;
			try {
				name = (await api("GET", `/rooms/${encodeURIComponent(room)}/state/m.room.name`, signal)).name ?? null;
			} catch {
				// a room without a name, or one whose state the account may not read
			}
			names.set(room, name ? clip(String(name), 80) : null);
		}
		return names.get(room) ?? undefined;
	};

	const held = hold(source, {
		host: home.hostname,
		note: () => (encrypted ? `${encrypted} message${encrypted === 1 ? "" : "s"} in encrypted rooms could not be read` : ""),
		run: async (signal, up) => {
			const me = String((await api("GET", "/account/whoami", signal)).user_id ?? "");
			if (!me) throw new Plain("the homeserver did not say whose token this is");
			// Which rooms are a conversation between two.
			const direct = new Set<string>();
			const directs = (content: any) => {
				direct.clear();
				for (const list of Object.values(content ?? {})) if (Array.isArray(list)) for (const room of list) direct.add(String(room));
			};
			await api("GET", `/user/${encodeURIComponent(me)}/account_data/m.direct`, signal).then(directs, () => {});
			for (;;) {
				const since = source.kv.get<string>("since");
				let answer: any;
				try {
					// The first look only asks where "now" is.
					answer = await api("GET", `/sync?timeout=${since ? POLL : 0}&filter=${encodeURIComponent(FILTER(since ? 50 : 1))}${since ? `&since=${encodeURIComponent(since)}` : ""}`, signal, undefined, POLL * 2.5);
				} catch (e) {
					// A place in the room history the server no longer knows: start from now.
					if (since && (e as any)?.status === 400) source.kv.set("since", null);
					throw e;
				}
				if (signal.aborted) return;
				up();
				for (const e of answer.account_data?.events ?? []) if (e?.type === "m.direct") directs(e.content);
				if (since) {
					for (const [room, joined] of Object.entries<any>(answer.rooms?.join ?? {})) {
						if (rooms.length && !rooms.includes(room)) continue;
						for (const e of joined?.timeline?.events ?? []) {
							if (e?.type === "m.room.encrypted") {
								encrypted++;
								held.refresh();
								continue;
							}
							const c = e?.content;
							const user = String(e?.sender ?? "");
							if (e?.type !== "m.room.message" || typeof c?.body !== "string" || !user) continue;
							// An edit repeats a message that was reported already.
							if (c["m.relates_to"]?.rel_type === "m.replace") continue;
							if (user === me || ignore.includes(user)) continue;
							const said: string[] = Array.isArray(c["m.mentions"]?.user_ids) ? c["m.mentions"].user_ids.map(String) : [];
							const mention = mentions.find((id) => said.includes(id) || c.body.includes(id));
							const keyword = keywordIn(keywords, c.body);
							if ((mentions.length || keywords.length) && !mention && !keyword) continue;
							if (!cap.ok()) continue;
							const dropped = cap.dropped();
							const name = await roomName(room, signal);
							if (signal.aborted) return;
							source.emit("message", { text: clip(c.body), user, room, ...(name ? { roomName: name } : {}), kind: direct.has(room) ? "dm" : "room", id: String(e.event_id ?? ""), ...(mention ? { mention } : {}), ...(keyword ? { keyword } : {}), ...(dropped ? { dropped } : {}) });
						}
					}
				}
				if (typeof answer.next_batch === "string" && answer.next_batch !== since) source.kv.set("since", answer.next_batch);
				else if (!answer.next_batch) throw new Plain("the homeserver's answer was not a sync answer");
			}
		},
	});

	// Sending: only to the rooms the owner put on the list, whatever the call names.
	source.onSend(async (message) => {
		if (!sendTo.length) throw new Error("this source was set up to listen only: it has no rooms to send to. Tell your owner; they can set it up again with \"sendTo\"");
		const room = String(message.room ?? (sendTo.length === 1 ? sendTo[0] : ""));
		if (!room) throw new Error(`say which room: {"room": "...", "text": "..."}. It may send to ${sendTo.join(", ")}`);
		if (!sendTo.includes(room)) throw new Error(`"${room}" is not a room this source may send to (${sendTo.join(", ")})`);
		const text = String(message.text ?? "").trim();
		if (!text) throw new Error('there is nothing to send: give "text"');
		await api("PUT", `/rooms/${encodeURIComponent(room)}/send/m.room.message/pine-${Date.now()}-${++sent}`, held.signal, { msgtype: "m.text", body: text.slice(0, 30_000) });
		return `sent to the Matrix room ${room}`;
	});
}
