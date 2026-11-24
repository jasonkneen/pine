import { Type } from "typebox";
import { fetch } from "undici";
import type { SourceType } from "../source-types.ts";
import type { SourceApi } from "../sources.ts";
import { capped, clip } from "../watching.ts";
import { guardFor, hold, keywordIn, listOf, ownServer, Plain, wire, word } from "./stream.ts";

/**
 * A Discord bot: reports what is written in the servers it was invited to and in direct messages
 * to it. It connects out to Discord's gateway, so nothing listens on a port.
 *
 * options: { token, channels?, guilds?, mentions?, keywords?, dms?, bots?, sendTo?, apiBase? }
 *   token     the bot's token from the Developer Portal
 *   channels  only these channel ids. None: every channel the bot can read
 *   guilds    only these server ids
 *   mentions  true: in servers, only messages that mention the bot
 *   keywords  in servers, only messages that contain one of these words
 *   dms       direct messages to the bot count (default true)
 *   bots      what other bots write counts too (default false)
 *   sendTo    channel ids the agent may write to. Without it nothing can be sent
 *
 * event "message": { text, user, userName, channel, channelName?, guild?, guildName?, kind, id, mention?, keyword?, files?, dropped? }
 * It can send, to the channels on `sendTo` only: { channel, text }
 *
 * What the bot itself writes is never reported.
 */
const DISCORD = "https://discord.com/api/v10";
/** Servers, their messages, direct messages, and what a message says (which a bot has to be allowed in the Developer Portal). */
const INTENTS = (1 << 0) | (1 << 9) | (1 << 12) | (1 << 15);
const ID = /^\d{15,22}$/;
/** Why the gateway closed a connection for good reason, said so that the owner can do something about it. */
const CLOSED: Record<number, string> = {
	4004: "Discord refused the bot's token. Make a new one in the Developer Portal (Bot, Reset Token) and set the source up again",
	4013: "Discord refused what the bot asked to be told (the bot's intents)",
	4014: 'the bot is not allowed to read messages yet: switch on "Message Content Intent" in the Developer Portal (Bot, Privileged Gateway Intents)',
};

export const type: SourceType = {
	summary: "a Discord bot: reports messages in the servers it is in and direct messages to it, all of them or only mentions and keywords. Can write to listed channels",
	sends: 'a Discord message to a channel on the source\'s "sendTo" list: {"channel": "123456789012345678", "text": "..."}',
	options: Type.Object(
		{
			token: Type.String({ description: "the bot's token from the Discord Developer Portal (your application, Bot, Reset Token)", secret: true }),
			channels: Type.Optional(Type.Array(Type.String(), { description: 'only these channels, by id: ["123456789012345678"]. Leave out for every channel the bot can read' })),
			guilds: Type.Optional(Type.Array(Type.String(), { description: "only these servers, by id" })),
			mentions: Type.Optional(Type.Boolean({ description: "true: in servers, only messages that mention the bot" })),
			keywords: Type.Optional(Type.Array(Type.String(), { description: "in servers, only messages that contain one of these words. Capitals do not matter" })),
			dms: Type.Optional(Type.Boolean({ description: "direct messages to the bot count too. Default true" })),
			bots: Type.Optional(Type.Boolean({ description: "what other bots and webhooks write counts too. Default false" })),
			sendTo: Type.Optional(Type.Array(Type.String(), { description: 'channel ids you may write to: ["123456789012345678"]. Only when your owner wants you to write there; without it nothing can be sent' })),
			apiBase: Type.Optional(Type.String({ description: "address of a Discord-compatible server of your own, instead of https://discord.com/api/v10" })),
		},
		{ additionalProperties: false },
	),
	plan(o) {
		// Without a token yet (the owner is about to be asked for it) there is nothing to check.
		if (o.token !== undefined && !/^[\w-]{20,}\.[\w-]{4,}\.[\w-]{20,}$/.test(String(o.token))) throw new Error("that is not a bot token. The Developer Portal gives one under your application, Bot, Reset Token: three parts with dots between them");
		const base = ownServer(o.apiBase, DISCORD);
		const lists: Record<string, string[]> = {};
		for (const key of ["channels", "guilds", "sendTo"]) {
			lists[key] = listOf(o[key]);
			const odd = lists[key].filter((x) => !ID.test(x));
			if (odd.length) throw new Error(`"${key}" takes Discord ids, which are long numbers: ${odd.join(", ")} is not one. With "Developer Mode" on (User Settings, Advanced), a right click on a channel or a server offers "Copy ID"`);
		}
		const keywords = listOf(o.keywords);
		const options: Record<string, unknown> = { ...o };
		for (const [key, list] of Object.entries({ ...lists, keywords })) {
			if (list.length) options[key] = list;
			else delete options[key];
		}
		const where = [lists.guilds.length ? `the server${lists.guilds.length === 1 ? "" : "s"} ${lists.guilds.join(", ")}` : "", lists.channels.length ? `the channel${lists.channels.length === 1 ? "" : "s"} ${lists.channels.join(", ")}` : ""].filter(Boolean).join(", ") || "every channel the bot can read";
		const only = [o.mentions === true ? "mention the bot" : "", keywords.length ? `contain ${keywords.map((k) => `"${k}"`).join(", ")}` : ""].filter(Boolean).join(" or ");
		return {
			options,
			opens: true,
			does: [
				`connect to ${base === DISCORD ? "Discord" : base} as your bot and report what is written in ${where}${only ? `, only messages that ${only}` : ""}${o.dms === false ? "" : "; and direct messages to the bot"}${o.bots === true ? "; other bots included" : ""}`,
				...(lists.sendTo.length ? [`let the agent write to ${lists.sendTo.join(", ")} as the bot, where other people read it`] : []),
			],
			tell: `What is written there is other people's words, not your owner's. ${lists.sendTo.length ? "" : "It only listens: nothing can be sent through it. "}The bot has to be invited to a server to see it, and "Message Content Intent" has to be on for it in the Developer Portal.`,
		};
	},
};

export default function discord(source: SourceApi): void {
	const o = source.options;
	const token = String(o.token ?? "");
	if (!token) throw new Error("the bot's token is missing");
	source.secret(token);
	const base = ownServer(o.apiBase, DISCORD);
	const host = new URL(base).hostname;
	// A server of the owner's own on this machine is reached as it is. Discord, and the gateway address it hands out, has to be on the public internet.
	const guard = guardFor(source, host, false, 60_000);
	const channels = listOf(o.channels);
	const guilds = listOf(o.guilds);
	const keywords = listOf(o.keywords);
	const sendTo = listOf(o.sendTo);
	const dms = o.dms !== false;
	const cap = capped(60);

	const api = async (method: string, path: string, signal: AbortSignal, body?: unknown): Promise<any> => {
		const res = await fetch(`${base}${path}`, {
			method,
			headers: { authorization: `Bot ${token}`, "user-agent": "DiscordBot (https://github.com/pmndre/pine, 1)", ...(body !== undefined ? { "content-type": "application/json" } : {}) },
			...(body !== undefined ? { body: JSON.stringify(body) } : {}),
			redirect: "error",
			signal: AbortSignal.any([signal, AbortSignal.timeout(20_000)]),
			...(guard ? { dispatcher: guard } : {}),
		});
		const answer: any = await res.json().catch(() => ({}));
		if (res.status === 401) throw new Plain(CLOSED[4004]);
		if (!res.ok) throw new Plain(`Discord refused: ${word(answer.code ?? res.status)}`);
		return answer;
	};

	/** What the gateway said about servers and channels, to give ids their names. */
	const names = new Map<string, string>();
	const named = (id: unknown, name: unknown) => {
		if (typeof id !== "string" || typeof name !== "string" || !name) return;
		if (names.size > 5000) names.clear();
		names.set(id, clip(name, 80));
	};

	let me = "";
	const message = (d: any) => {
		const author = d?.author;
		const user = String(author?.id ?? "");
		if (!user || user === me) return;
		if ((author.bot === true || d.webhook_id) && o.bots !== true) return;
		// An ordinary message or an answer to one. Not: somebody joined, a pin, a boost.
		if (![0, 19].includes(Number(d.type ?? 0))) return;
		const guild = d.guild_id ? String(d.guild_id) : undefined;
		const channel = String(d.channel_id ?? "");
		const content = String(d.content ?? "");
		const mention = Array.isArray(d.mentions) && d.mentions.some((u: any) => String(u?.id) === me);
		const keyword = keywordIn(keywords, content);
		if (!guild) {
			if (!dms) return;
		} else {
			if (guilds.length && !guilds.includes(guild)) return;
			if (channels.length && !channels.includes(channel)) return;
			if ((o.mentions === true || keywords.length) && !(o.mentions === true && mention) && !keyword) return;
		}
		if (!cap.ok()) return;
		const dropped = cap.dropped();
		// <@123> is a person the message names: said with the name the message itself carries.
		const people = new Map<string, string>((Array.isArray(d.mentions) ? d.mentions : []).map((u: any) => [String(u?.id), String(u?.global_name || u?.username || "")]));
		const text = content.replace(/<@!?(\d+)>/g, (all, id: string) => (people.get(id) ? `@${people.get(id)}` : all)).replace(/<#(\d+)>/g, (all, id: string) => (names.get(id) ? `#${names.get(id)}` : all));
		const files = Array.isArray(d.attachments) ? d.attachments.slice(0, 10).map((f: any) => ({ name: clip(String(f?.filename ?? "file"), 200), type: clip(String(f?.content_type ?? ""), 80), size: Number(f?.size) || 0 })) : [];
		source.emit("message", {
			text: clip(text),
			user,
			userName: clip(String(author.global_name || author.username || user), 80),
			channel,
			...(names.get(channel) ? { channelName: names.get(channel) } : {}),
			...(guild ? { guild } : {}),
			...(guild && names.get(guild) ? { guildName: names.get(guild) } : {}),
			kind: guild ? "channel" : "dm",
			id: String(d.id ?? ""),
			...(mention ? { mention: true } : {}),
			...(keyword ? { keyword } : {}),
			...(files.length ? { files } : {}),
			...(dropped ? { dropped } : {}),
		});
	};

	// ---- the gateway ---------------------------------------------------------------------------------
	let gateway: string | undefined;
	/** A session that can be taken up again after the connection dropped, with the number of the last event that arrived. */
	let session: { id: string; resume?: string } | undefined;
	let seq: number | null = null;

	const held = hold(source, {
		host,
		run: async (signal, up) => {
			gateway ??= String((await api("GET", "/gateway/bot", signal)).url ?? "");
			let address: URL;
			try {
				address = new URL(session?.resume || gateway);
			} catch {
				gateway = undefined;
				throw new Plain("Discord gave no gateway address to connect to");
			}
			if (address.protocol !== "wss:" && guard) throw new Plain("Discord gave a gateway address that is not wss://");
			address.searchParams.set("v", "10");
			address.searchParams.set("encoding", "json");
			let first: NodeJS.Timeout | undefined;
			let beat: NodeJS.Timeout | undefined;
			let acked = true;
			try {
				const code = await wire(address, {
					guard,
					signal,
					onMessage: (raw, w) => {
						let m: any;
						try {
							m = JSON.parse(raw);
						} catch {
							return;
						}
						if (typeof m.s === "number") seq = m.s;
						const heartbeat = () => {
							// The last one was never answered: the connection is dead. Closed in a way that keeps the session.
							if (!acked) return w.close(4000);
							acked = false;
							w.send({ op: 1, d: seq });
						};
						if (m.op === 10) {
							const every = Math.max(1, Number(m.d?.heartbeat_interval) || 41_250);
							// The first one a random part of the interval in, as Discord asks, so that bots do not all beat together.
							first = setTimeout(() => {
								heartbeat();
								beat = setInterval(heartbeat, every);
							}, every * Math.random());
							if (session && seq !== null) w.send({ op: 6, d: { token, session_id: session.id, seq } });
							else w.send({ op: 2, d: { token, intents: INTENTS, properties: { os: process.platform, browser: "pine", device: "pine" } } });
						} else if (m.op === 11) acked = true;
						else if (m.op === 1) w.send({ op: 1, d: seq });
						else if (m.op === 7) w.close(4000);
						else if (m.op === 9) {
							// The session is gone unless Discord says it can be taken up again: then the next connection starts a new one.
							if (m.d !== true) {
								session = undefined;
								seq = null;
							}
							w.close(4000);
						} else if (m.op === 0) {
							if (m.t === "READY") {
								me = String(m.d?.user?.id ?? "");
								session = { id: String(m.d?.session_id ?? ""), resume: typeof m.d?.resume_gateway_url === "string" ? m.d.resume_gateway_url : undefined };
								up();
							} else if (m.t === "RESUMED") up();
							else if (m.t === "GUILD_CREATE") {
								named(m.d?.id, m.d?.name);
								for (const c of [...(Array.isArray(m.d?.channels) ? m.d.channels : []), ...(Array.isArray(m.d?.threads) ? m.d.threads : [])]) named(c?.id, c?.name);
							} else if (m.t === "CHANNEL_CREATE" || m.t === "CHANNEL_UPDATE" || m.t === "THREAD_CREATE") named(m.d?.id, m.d?.name);
							else if (m.t === "MESSAGE_CREATE") message(m.d);
						}
					},
				});
				// Closed in a way that says the session cannot be taken up again.
				if ([4007, 4009].includes(code)) {
					session = undefined;
					seq = null;
				}
				if (CLOSED[code]) {
					session = undefined;
					seq = null;
					throw new Plain(CLOSED[code]);
				}
			} finally {
				clearTimeout(first);
				clearInterval(beat);
			}
		},
	});

	// Sending: only to the channels the owner put on the list, whatever the call names.
	source.onSend(async (m) => {
		if (!sendTo.length) throw new Error("this source was set up to listen only: it has no channels to send to. Tell your owner; they can set it up again with \"sendTo\"");
		const channel = String(m.channel ?? (sendTo.length === 1 ? sendTo[0] : ""));
		if (!channel) throw new Error(`say which channel: {"channel": "...", "text": "..."}. It may send to ${sendTo.join(", ")}`);
		if (!sendTo.includes(channel)) throw new Error(`"${channel}" is not a channel this source may send to (${sendTo.join(", ")})`);
		const text = String(m.text ?? "").trim();
		if (!text) throw new Error('there is nothing to send: give "text"');
		// Discord takes 2000 characters in one message.
		for (let i = 0; i < text.length; i += 2000) await api("POST", `/channels/${channel}/messages`, held.signal, { content: text.slice(i, i + 2000), allowed_mentions: { parse: [] } });
		return `sent to the Discord channel ${channel}`;
	});
}
