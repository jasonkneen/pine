import crypto from "node:crypto";
import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import tls from "node:tls";
import { Type } from "typebox";
import { fetch } from "undici";
import { keepFiles, parseMail, pruneFiles } from "../mime.ts";
import { isLocalHost, publicOnlyAgent, reachOptions } from "../net.ts";
import type { SourceType } from "../source-types.ts";
import type { SourceApi } from "../sources.ts";
import { errText } from "../util.ts";
import { clip } from "../watching.ts";

/**
 * A mailbox: reports every new mail, the moment the server says there is one (IMAP IDLE).
 *
 * options: { host, user, password, port?, security?, mailbox?, from?, subject?, maxMb?, keepDays?,
 *            smtpHost?, smtpPort?, sendTo?, sender?, insecureTls?, local? }
 *   security  "tls" (default, port 993), "starttls" (port 143), "none" only for a server on this machine or network
 *   mailbox   which folder to watch ("INBOX")
 *   from      only mail that says it is from one of these: an address, or "@domain"
 *   subject   only mail whose subject this regular expression finds
 *   maxMb     attachments are kept up to this size (10)
 *   sendTo    addresses the agent may write to, through smtpHost. Without it nothing can be sent
 *   signIn    "microsoft": no password. The owner signs in at Microsoft in a browser, once, with a
 *             code pine shows (the device code flow), and pine logs in with what it is given
 *             (XOAUTH2). For Outlook.com, Hotmail and Microsoft 365, which take no password over IMAP.
 *             Needs `clientId`: an app the owner registered at Microsoft; `tenant` says for which accounts.
 *
 * event "mail": { from, fromName?, to, subject, date?, text, attachments: [{ file, path?, type, size }], images?, cut? }
 * It can send, to the addresses on `sendTo` only: { to, subject, text }
 *
 * It only reads: the mailbox is opened read-only (EXAMINE) and messages are fetched with PEEK, so
 * nothing is marked as read, moved or deleted. Mail that is there when it first connects is the
 * starting point and is not reported. Who a mail says it is from is what the sender wrote, and
 * anyone can write any address: a mail is outside content, whoever it claims to come from.
 */

/** How long things take. A test makes them short. (`second`: what a second of waiting between two questions to Microsoft lasts.) */
export const pace = { retry: 1000, retryMax: 300_000, idle: 25 * 60_000, noop: 60_000, timeout: 30_000, second: 1000 };

/**
 * Where Microsoft signs people in. A test puts its stand-in here. It is not an option of the
 * source: whoever names this address is handed the sign-in, so no agent and no configuration does.
 */
export const oauth = { authority: "https://login.microsoftonline.com" };
/** The servers of a Microsoft mailbox, and what pine asks to be allowed there. */
const MICROSOFT = { imap: "outlook.office365.com", smtp: "smtp.office365.com", read: "https://outlook.office.com/IMAP.AccessAsUser.All", send: "https://outlook.office.com/SMTP.Send" };
const GUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** How many new mails one look takes; with more (a mailbox that was away for weeks), the oldest are left out. */
const MAX_CATCH_UP = 200;
const LINE_MAX = 64 * 1024;

/** Something that went wrong, in words of pine's own. What a server says about it never goes into a status line. */
class Said extends Error {
	/** Trying again will not help until the owner changes something. */
	fatal = false;
}
const said = (message: string, fatal = false) => Object.assign(new Said(message), { fatal });

const CODES: Record<string, string> = {
	ECONNREFUSED: "nothing answers at that address and port",
	ENOTFOUND: "that host name is not known",
	EAI_AGAIN: "the host name could not be looked up",
	ETIMEDOUT: "it did not answer in time",
	ECONNRESET: "the connection was cut",
	EHOSTUNREACH: "the host cannot be reached",
	ENETUNREACH: "the network cannot be reached",
};

/** Why a connection failed, without a word the other side chose. */
function reason(e: unknown): string {
	if (e instanceof Said) return e.message;
	const text = errText(e);
	if (/leads to an address on your own network/.test(text)) return text;
	const code = String((e as any)?.code ?? "");
	if (CODES[code]) return CODES[code];
	if (/CERT|SELF_SIGNED|UNABLE_TO_VERIFY|ALTNAME/.test(code)) return `the server's certificate could not be verified (${code})`;
	return /^[A-Z_0-9]{3,40}$/.test(code) ? `the connection failed (${code})` : "the connection failed";
}

const ADDRESS = /^[^\s@<>,;"]+@[^\s@<>,;"]+\.[^\s@<>,;"]+$/;
const hostName = (v: unknown, what: string): string => {
	const host = String(v ?? "").trim();
	if (!host || /[\s/:@]/.test(host.replace(/^\[.*\]$/, "x"))) throw new Error(`"${what}" is the name of a mail server alone, e.g. imap.example.com: no "imap://", no port, no path`);
	return host;
};
const portOf = (v: unknown, fallback: number, what: string): number => {
	if (v === undefined) return fallback;
	if (!Number.isInteger(v) || (v as number) < 1 || (v as number) > 65535) throw new Error(`"${what}" must be a port number, for example ${fallback}`);
	return v as number;
};

export const type: SourceType = {
	summary: "a mailbox (IMAP): reports each new mail with the text and attachments, without marking anything as read. With \"sendTo\" it can also write to the addresses listed",
	sends: 'an e-mail to an address on the source\'s "sendTo" list: {"to": "name@example.com", "subject": "...", "text": "..."}',
	options: Type.Object(
		{
			host: Type.Optional(Type.String({ description: 'the IMAP server of the mailbox, e.g. imap.gmail.com, imap.mail.me.com, imap.fastmail.com. Needed, except with "signIn"' })),
			user: Type.String({ description: "the user name of the mailbox, usually the e-mail address" }),
			password: Type.Optional(Type.String({ description: 'the password of the mailbox: leave it out and pine asks your owner for it. Gmail, iCloud and Fastmail want an app password made for this, not the account\'s own. Not used with "signIn"', secret: true })),
			signIn: Type.Optional(Type.String({ description: '"microsoft" for a mailbox at Outlook.com, Hotmail, Live or Microsoft 365, which takes no password: your owner signs in at Microsoft in their browser, once, with a code pine shows them. Needs "clientId". Leave out for every other mailbox' })),
			clientId: Type.Optional(Type.String({ description: 'with "signIn": the Application (client) ID of an app your owner registered at Microsoft (entra.microsoft.com, App registrations), e.g. 11111111-2222-3333-4444-555555555555. Ask your owner for it; it is not a secret' })),
			tenant: Type.Optional(Type.String({ description: 'with "signIn": whose accounts the app signs in. "common" (default): any. "consumers": private ones (Outlook.com, Hotmail). "organizations": work and school. Or one organisation\'s domain or id' })),
			port: Type.Optional(Type.Number({ description: 'port of the IMAP server. Default 993 (143 with security "starttls")' })),
			security: Type.Optional(Type.String({ description: '"tls" (default): encrypted from the start. "starttls": encrypted after connecting, as port 143 wants it. "none": only for a server on this computer or network' })),
			mailbox: Type.Optional(Type.String({ description: 'the folder to watch, as the server names it. Default "INBOX"' })),
			from: Type.Optional(Type.Array(Type.String(), { description: 'only mail that says it is from one of these: an address ("bank@example.com") or a whole domain ("@example.com"). A filter, not a proof: a sender can be forged' })),
			subject: Type.Optional(Type.String({ description: 'only mail whose subject this regular expression finds, e.g. "invoice|Rechnung". Capitals do not matter' })),
			maxMb: Type.Optional(Type.Number({ description: "attachments are kept up to this size, in MB. Default 10" })),
			keepDays: Type.Optional(Type.Number({ description: "kept attachments are deleted after this many days. Default 7" })),
			smtpHost: Type.Optional(Type.String({ description: 'for sending: the SMTP server, e.g. smtp.gmail.com. Only together with "sendTo"' })),
			smtpPort: Type.Optional(Type.Number({ description: "port of the SMTP server: 465 (default, encrypted from the start) or 587 (STARTTLS)" })),
			sendTo: Type.Optional(Type.Array(Type.String(), { description: 'the addresses you may write to, e.g. your owner\'s own: ["me@example.com"]. Only when your owner wants you to send mail; without it nothing can be sent' })),
			sender: Type.Optional(Type.String({ description: 'the address mail is sent as. Default: "user"' })),
			insecureTls: Type.Optional(Type.Boolean({ description: "accept a certificate that cannot be verified, as a server of one's own with a self-made one needs" })),
			local: Type.Optional(Type.Boolean({ description: "true if the server is on your owner's own network or this computer under a name that does not say so (mail.home, a bridge on this machine). Not needed for an IP address, localhost or a .local name" })),
		},
		{ additionalProperties: false },
	),
	// A mailbox that is not signed in to at its provider needs its password: asked of the owner when it is left out.
	needs: (o) => (o.signIn ? [] : ["password"]),
	plan(o) {
		const signIn = o.signIn === undefined ? undefined : String(o.signIn).trim().toLowerCase();
		if (signIn !== undefined && signIn !== "microsoft") throw new Error('"signIn" is "microsoft", for a mailbox at Outlook.com, Hotmail or Microsoft 365. Every other mailbox takes a password: leave "signIn" out');
		const clientId = String(o.clientId ?? "").trim();
		const tenant = String(o.tenant ?? "common").trim();
		if (signIn) {
			if (o.password !== undefined) throw new Error('with "signIn" there is no password: leave "password" out');
			if (!GUID.test(clientId)) throw new Error('"signIn": "microsoft" needs "clientId": the Application (client) ID of an app your owner registered at Microsoft, which looks like 11111111-2222-3333-4444-555555555555. Your owner makes one in a few minutes: the manual says how (search "sign in to an Outlook mailbox"). Ask them for the id; it is not a secret');
			if (!/^[A-Za-z0-9][A-Za-z0-9.-]{0,80}$/.test(tenant)) throw new Error('"tenant" is "common", "consumers", "organizations", or the domain or id of one organisation');
		} else if (o.clientId !== undefined || o.tenant !== undefined) throw new Error('"clientId" and "tenant" belong to "signIn": "microsoft". Leave them out for a mailbox that takes a password');
		if (!signIn && !String(o.host ?? "").trim()) throw new Error('needs "host": the IMAP server of the mailbox, e.g. imap.gmail.com. (A mailbox at Outlook.com or Microsoft 365 needs "signIn": "microsoft" instead of a password, and then no host)');
		const host = hostName(o.host ?? MICROSOFT.imap, "host");
		const user = String(o.user ?? "").trim();
		if (!user) throw new Error(`needs "user": the user name of the mailbox, usually the e-mail address`);
		const security = String(o.security ?? "tls");
		if (!["tls", "starttls", "none"].includes(security)) throw new Error('"security" is "tls", "starttls" or "none"');
		const local = o.local === true || isLocalHost(host);
		if (security === "none" && !local) throw new Error(`"security": "none" sends the password unencrypted, which is only taken for a server on this computer or your own network. Use "tls" (port 993) or "starttls" (port 143)`);
		const port = portOf(o.port, security === "starttls" ? 143 : security === "none" ? 143 : 993, "port");
		const from: string[] = (Array.isArray(o.from) ? o.from : []).map((x: unknown) => String(x).trim().toLowerCase()).filter(Boolean);
		for (const f of from) if (!(f.startsWith("@") ? /^@[^\s@]+\.[^\s@]+$/.test(f) : ADDRESS.test(f))) throw new Error(`"${f}" in "from" is neither an address (name@example.com) nor a domain (@example.com)`);
		if (o.subject !== undefined) {
			try {
				new RegExp(String(o.subject), "i");
			} catch (e) {
				throw new Error(`"subject" is not a regular expression: ${errText(e)}`);
			}
		}
		for (const key of ["maxMb", "keepDays"]) if (o[key] !== undefined && !(Number(o[key]) > 0)) throw new Error(`"${key}" must be a number above 0`);
		if (o.maxMb !== undefined && o.maxMb > 50) throw new Error('"maxMb" is at most 50');
		const sendTo: string[] = (Array.isArray(o.sendTo) ? o.sendTo : []).map((x: unknown) => String(x).trim().toLowerCase()).filter(Boolean);
		for (const a of sendTo) if (!ADDRESS.test(a)) throw new Error(`"${a}" in "sendTo" is not an e-mail address`);
		if (sendTo.length && !o.smtpHost && !signIn) throw new Error(`to send, it needs "smtpHost": the provider's SMTP server, e.g. smtp.gmail.com`);
		if (!sendTo.length && (o.smtpHost || o.smtpPort || o.sender)) throw new Error(`"smtpHost" is for sending, and sending needs "sendTo": the addresses that may be written to. Leave both out to only read mail`);
		const options: Record<string, unknown> = { ...o, host, user, ...(from.length ? { from } : {}) };
		delete options.sendTo;
		if (!from.length) delete options.from;
		if (signIn) {
			Object.assign(options, { signIn, clientId: clientId.toLowerCase() });
			if (o.tenant !== undefined) options.tenant = tenant;
		}
		const does = [
			`connect to the mailbox of ${user} on ${host}:${port}${security === "none" ? " WITHOUT encryption" : ""}${local ? " (a server on your own network or this computer)" : ""} and report every new mail in ${o.mailbox ?? "INBOX"}${from.length ? ` that says it is from ${from.join(", ")}` : ""}${o.subject ? `${from.length ? " and" : ""} whose subject matches /${o.subject}/` : ""}, with its text and its attachments up to ${o.maxMb ?? 10} MB`,
			...(signIn ? [`ask you to sign in to that mailbox at Microsoft in your browser, once, with a code pine shows you (through your app ${clientId.toLowerCase()}). pine never sees your password: it keeps what Microsoft gives it for this mailbox, and renews it`] : []),
			"only read: nothing is marked as read, moved or deleted",
			"treat every mail as outside content: who a mail says it is from can be forged",
		];
		if (sendTo.length) {
			const smtpHost = hostName(o.smtpHost ?? MICROSOFT.smtp, "smtpHost");
			// Microsoft takes mail on 587, encrypted after connecting.
			const smtpPort = portOf(o.smtpPort, signIn ? 587 : 465, "smtpPort");
			const sender = String(o.sender ?? user).trim().toLowerCase();
			if (!ADDRESS.test(sender)) throw new Error(`mail is sent as "${sender}", which is not an e-mail address. Give "sender": the address to send as`);
			Object.assign(options, { smtpHost, sendTo, sender, ...(signIn && o.smtpPort === undefined ? { smtpPort } : {}) });
			does.push(`let the agent send e-mail as ${sender} through ${smtpHost}:${smtpPort}, to ${sendTo.join(", ")} and to nobody else`);
		}
		if (o.insecureTls) does.push("without checking the server's certificate");
		return {
			options,
			does,
			opens: true,
			tell: `${signIn ? "Your owner is asked next to sign in at Microsoft: pine shows them an address and a code. Until they have, the source waits. " : ""}The mail that is in the mailbox now is the starting point and is not reported; every mail that arrives from now on is. Nothing is marked as read.`,
		};
	},
};

// ---- IMAP, as much of it as reading new mail takes -----------------------------------------------

interface Response {
	/** The line, with every literal left out where its length stood. */
	text: string;
	literals: Buffer[];
}

/** A connection to an IMAP server: responses read whole (a literal belongs to its line), commands answered in turn. */
class Imap {
	sock!: net.Socket;
	caps = new Set<string>();
	/** How often the server has said that the mailbox holds more than before. */
	news = 0;
	private buf: Buffer = Buffer.alloc(0);
	private lit: Buffer[] = [];
	private litSize = 0;
	private need = 0;
	private cur: Response = { text: "", literals: [] };
	private queue: Response[] = [];
	private waiter?: () => void;
	private closed?: Error;
	private tag = 0;
	private maxLiteral: number;

	constructor(sock: net.Socket, maxLiteral: number) {
		this.maxLiteral = maxLiteral;
		this.attach(sock);
	}

	attach(sock: net.Socket): void {
		this.sock = sock;
		sock.on("data", (d: Buffer) => this.feed(d));
		sock.on("error", (e) => this.end(e));
		sock.on("close", () => this.end(said("the connection was closed")));
	}

	/** Let go of the socket, for it to be wrapped in TLS. */
	detach(): net.Socket {
		this.sock.removeAllListeners("data");
		this.sock.removeAllListeners("error");
		this.sock.removeAllListeners("close");
		return this.sock;
	}

	private end(e: Error): void {
		this.closed ??= e;
		this.waiter?.();
	}

	private fail(message: string): void {
		this.end(said(message));
		this.sock.destroy();
	}

	private feed(chunk: Buffer): void {
		if (this.need > 0) {
			// Inside a literal nothing is searched: the pieces are put together once, when all are there.
			this.lit.push(chunk);
			this.litSize += chunk.length;
			if (this.litSize < this.need) return;
			const all = Buffer.concat(this.lit);
			this.cur.literals.push(all.subarray(0, this.need));
			this.buf = all.subarray(this.need);
			this.need = 0;
			this.lit = [];
			this.litSize = 0;
		} else this.buf = this.buf.length ? Buffer.concat([this.buf, chunk]) : chunk;
		this.parse();
	}

	private parse(): void {
		for (;;) {
			const i = this.buf.indexOf("\r\n");
			if (i < 0) {
				if (this.buf.length > LINE_MAX) this.fail("the server sent a line that does not end");
				return;
			}
			if (i > LINE_MAX || this.cur.text.length > LINE_MAX * 4) return this.fail("the server sent a line that is too long");
			const line = this.buf.subarray(0, i).toString("latin1");
			this.buf = this.buf.subarray(i + 2);
			const m = /\{(\d+)\+?\}$/.exec(line);
			if (!m) {
				this.cur.text += line;
				if (/^\* \d+ (EXISTS|RECENT)\b/i.test(this.cur.text)) this.news++;
				this.queue.push(this.cur);
				this.cur = { text: "", literals: [] };
				this.waiter?.();
				continue;
			}
			this.cur.text += line.slice(0, m.index);
			const n = Number(m[1]);
			if (n > this.maxLiteral || this.cur.literals.length > 32) return this.fail("the server sent more than was asked for");
			if (this.buf.length >= n) {
				this.cur.literals.push(this.buf.subarray(0, n));
				this.buf = this.buf.subarray(n);
				continue;
			}
			this.need = n;
			this.lit = [this.buf];
			this.litSize = this.buf.length;
			this.buf = Buffer.alloc(0);
			return;
		}
	}

	/** The next response. With `quiet`, nothing in time is no error: it returns undefined. */
	async next(ms = pace.timeout, quiet = false): Promise<Response | undefined> {
		const until = Date.now() + ms;
		while (!this.queue.length) {
			if (this.closed) throw this.closed;
			const left = until - Date.now();
			if (left <= 0) {
				if (quiet) return undefined;
				throw said("the server did not answer in time");
			}
			await new Promise<void>((resolve) => {
				const timer = setTimeout(() => {
					this.waiter = undefined;
					resolve();
				}, left);
				this.waiter = () => {
					clearTimeout(timer);
					this.waiter = undefined;
					resolve();
				};
			});
		}
		return this.queue.shift()!;
	}

	write(text: string | Buffer): void {
		if (this.closed) throw this.closed;
		this.sock.write(text);
	}

	nextTag(): string {
		return `p${++this.tag}`;
	}

	/**
	 * Send a command and collect what comes back until it is answered. A part that is bytes goes
	 * as a literal: announced, and sent when the server says to go on.
	 */
	async cmd(parts: Array<string | Buffer>, what: string, fatal = false): Promise<{ untagged: Response[]; text: string }> {
		const tag = this.nextTag();
		const untagged: Response[] = [];
		let pending = `${tag} `;
		const answered = (r: Response): { untagged: Response[]; text: string } | undefined => {
			if (!r.text.startsWith(`${tag} `)) return void untagged.push(r);
			const rest = r.text.slice(tag.length + 1);
			if (/^OK\b/i.test(rest)) return { untagged, text: rest };
			throw said(`the server refused to ${what}`, fatal);
		};
		for (const part of parts) {
			if (typeof part === "string") {
				pending += part;
				continue;
			}
			this.write(`${pending}{${part.length}}\r\n`);
			pending = "";
			for (;;) {
				const r = (await this.next())!;
				if (r.text.startsWith("+")) break;
				const done = answered(r);
				// Answered before the literal was sent: the command is over.
				if (done) return done;
			}
			this.write(part);
		}
		this.write(`${pending}\r\n`);
		for (;;) {
			const done = answered((await this.next())!);
			if (done) return done;
		}
	}

	/**
	 * Log in with what a sign-in gave instead of a password (SASL XOAUTH2). A server that refuses
	 * says why in a challenge first, which is answered with an empty line before the refusal comes.
	 */
	async xoauth2(user: string, token: string): Promise<string> {
		const tag = this.nextTag();
		const words = Buffer.from(`user=${user}\x01auth=Bearer ${token}\x01\x01`).toString("base64");
		// With the first line where the server takes it there, else when it says to go on.
		let sent = this.caps.has("SASL-IR");
		this.write(`${tag} AUTHENTICATE XOAUTH2${sent ? ` ${words}` : ""}\r\n`);
		for (;;) {
			const r = (await this.next())!;
			if (r.text.startsWith("+")) {
				this.write(sent ? "\r\n" : `${words}\r\n`);
				sent = true;
				continue;
			}
			if (!r.text.startsWith(`${tag} `)) continue;
			const rest = r.text.slice(tag.length + 1);
			if (/^OK\b/i.test(rest)) return rest;
			throw said("the sign-in at Microsoft worked, but the mailbox refused it: IMAP may be switched off for this mailbox, the app may lack the permission IMAP.AccessAsUser.All, or somebody else signed in than the mailbox's owner", true);
		}
	}

	/** What the server can do, from wherever it said so. */
	learn(text: string): boolean {
		const m = /\bCAPABILITY\b([^\]]*)/i.exec(text);
		if (!m) return false;
		this.caps = new Set(m[1].trim().toUpperCase().split(/\s+/).filter(Boolean));
		return true;
	}
}

/** A string as an IMAP command takes it: quoted where that can say it, else as a literal. */
const arg = (s: string): string | Buffer => (/^[\x20-\x7e]*$/.test(s) ? `"${s.replace(/[\\"]/g, "\\$&")}"` : Buffer.from(s, "utf8"));

function connect(host: string, port: number, secure: boolean, o: { local: boolean; insecure: boolean }): Promise<net.Socket> {
	return new Promise((resolve, reject) => {
		const opts = { host, port, ...reachOptions(host, o.local) };
		const sock: net.Socket = secure ? tls.connect({ ...opts, servername: net.isIP(host) ? undefined : host, rejectUnauthorized: !o.insecure }) : net.connect(opts);
		const timer = setTimeout(() => sock.destroy(said("it did not answer in time")), pace.timeout);
		sock.once(secure ? "secureConnect" : "connect", () => {
			clearTimeout(timer);
			sock.setKeepAlive(true, 60_000);
			resolve(sock);
		});
		sock.once("error", (e) => {
			clearTimeout(timer);
			reject(e);
		});
	});
}

/** Wrap a connection that started in the clear into TLS. */
function upgrade(plain: net.Socket, host: string, insecure: boolean): Promise<net.Socket> {
	return new Promise((resolve, reject) => {
		const sock = tls.connect({ socket: plain, servername: net.isIP(host) ? undefined : host, rejectUnauthorized: !insecure });
		const timer = setTimeout(() => sock.destroy(said("it did not answer in time")), pace.timeout);
		sock.once("secureConnect", () => {
			clearTimeout(timer);
			resolve(sock);
		});
		sock.once("error", (e) => {
			clearTimeout(timer);
			reject(e);
		});
	});
}

// ---- SMTP, as much of it as sending one message takes ----------------------------------------------

/** One header line's worth: nothing in it can start another header. */
const oneLine = (v: unknown) => String(v ?? "").replace(/[\r\n\x00]+/g, " ").trim();

/** A header value that is not plain ASCII, as words a mail program decodes. */
function encodeWords(text: string): string {
	if (/^[\x20-\x7e]*$/.test(text)) return text;
	const words: string[] = [];
	let piece = "";
	for (const ch of text) {
		if (Buffer.byteLength(piece + ch) > 42) {
			words.push(piece);
			piece = "";
		}
		piece += ch;
	}
	if (piece) words.push(piece);
	return words.map((w) => `=?utf-8?B?${Buffer.from(w).toString("base64")}?=`).join("\r\n ");
}

/** A message as it goes over the wire: headers of pine's making, the text as base64. */
export function composeMail(m: { from: string; to: string; subject: string; text: string }): string {
	const domain = m.from.split("@")[1] ?? "localhost";
	const body = Buffer.from(m.text.replace(/\r?\n/g, "\r\n"), "utf8").toString("base64").replace(/.{1,76}/g, "$&\r\n");
	return [
		`From: <${oneLine(m.from)}>`,
		`To: <${oneLine(m.to)}>`,
		`Subject: ${encodeWords(oneLine(m.subject).slice(0, 500))}`,
		`Date: ${new Date().toUTCString().replace("GMT", "+0000")}`,
		`Message-ID: <${crypto.randomBytes(12).toString("hex")}@${oneLine(domain).replace(/[^A-Za-z0-9.-]/g, "")}>`,
		"MIME-Version: 1.0",
		"Content-Type: text/plain; charset=utf-8",
		"Content-Transfer-Encoding: base64",
		"",
		body,
	].join("\r\n");
}

// ---- signing in at Microsoft instead of giving a password ---------------------------------------------

/** A word the sign-in server used for what went wrong, if it is one of its plain codes. Never a sentence of its own. */
const code = (v: unknown) => (typeof v === "string" && /^[a-z_]{1,40}$/.test(v) ? v : "no reason given");

interface SignIn {
	/** What to log in with right now: kept while it is good, renewed when it is not, asked of the owner when there is nothing to renew. */
	token(signal: AbortSignal): Promise<string>;
	/** The mailbox refused what `token` gave: the next one is fetched anew. */
	spent(): void;
}

/**
 * The owner signs in at Microsoft in a browser, with a code pine shows them (the device code
 * flow: pine itself never sees a password, and needs no address Microsoft could call). What
 * Microsoft hands over is kept in the source's own storage in pine's home, and renewed by itself.
 */
function microsoft(source: SourceApi, o: { user: string; clientId: string; tenant: string; send: boolean; say: (line: string) => void; /** The owner has been asked, and may take minutes. */ waiting: () => void }): SignIn {
	const scope = [MICROSOFT.read, ...(o.send ? [MICROSOFT.send] : []), "offline_access"].join(" ");
	const at = new URL(oauth.authority);
	const guard = isLocalHost(at.hostname) ? undefined : publicOnlyAgent(pace.timeout);
	if (guard) source.onStop(() => guard.close());
	const post = async (what: "devicecode" | "token", fields: Record<string, string>, signal: AbortSignal): Promise<any> => {
		const res = await fetch(`${oauth.authority}/${encodeURIComponent(o.tenant)}/oauth2/v2.0/${what}`, {
			method: "POST",
			headers: { "content-type": "application/x-www-form-urlencoded" },
			body: new URLSearchParams(fields).toString(),
			// What is sent here is the sign-in itself: it goes to the address it is for, and nowhere a redirect says.
			redirect: "error",
			signal: AbortSignal.any([signal, AbortSignal.timeout(pace.timeout)]),
			...(guard ? { dispatcher: guard } : {}),
		});
		return (await res.json().catch(() => ({}))) ?? {};
	};
	let now: { token: string; until: number } | undefined;
	// Asked once while the source runs: a retry that follows a "no" does not put the question again.
	let asked = false;
	let busy: Promise<string> | undefined;

	// (Neither is registered with source.secret: both are replaced about every hour, and nothing here ever puts one into an event, a log line or a status.)
	const keep = (t: any): string => {
		if (typeof t.refresh_token === "string" && t.refresh_token) source.kv.set("signin", { refresh: t.refresh_token, scope, client: o.clientId });
		now = { token: String(t.access_token), until: Date.now() + (Number(t.expires_in) > 0 ? Number(t.expires_in) : 3600) * 1000 };
		return now.token;
	};

	const ask = async (signal: AbortSignal): Promise<string> => {
		if (asked) throw said("nobody is signed in to the mailbox. To be asked again: unsubscribe and subscribe again, or restart pine", true);
		asked = true;
		const d = await post("devicecode", { client_id: o.clientId, scope }, signal);
		if (typeof d.device_code !== "string" || typeof d.user_code !== "string" || !/^[A-Za-z0-9-]{4,24}$/.test(d.user_code)) {
			throw said(`Microsoft did not start a sign-in (${code(d.error)}). Check "clientId" and "tenant", and that the app allows public client flows and personal or work accounts as the mailbox is one`, true);
		}
		// The page to open is Microsoft's own, whatever the answer says.
		let page = "https://microsoft.com/devicelogin";
		try {
			const given = new URL(String(d.verification_uri));
			if (given.protocol === "https:" && /(^|\.)(microsoft\.com|microsoftonline\.com|live\.com)$/.test(given.hostname)) page = given.href;
			else if (given.hostname === at.hostname) page = given.href;
		} catch {
			// the usual one
		}
		const summary = `sign in to the mailbox ${o.user} at Microsoft\nOpen ${page} in your browser, enter the code ${d.user_code}, and sign in as ${o.user}. pine carries on by itself once that is done.`;
		o.say(`waiting for you to sign in: open ${page} and enter the code ${d.user_code}`);
		o.waiting();
		let given: boolean | undefined;
		// The dialog only shows the code. What counts is what Microsoft says; a "no" gives up, and no answer at all changes nothing.
		void source.approvals.request(summary, "this mailbox takes no password: Microsoft asks you yourself and gives pine a sign-in that it renews. pine does not see your password. Answer no to give up", []).then((a) => {
			if (!a.allow && a.by !== "timeout") given = false;
		});
		const close = (allow: boolean) => {
			const open = source.approvals.pending().find((r) => r.summary === summary);
			if (open) source.approvals.decide(open.id, allow, "pine");
		};
		let every = Math.max(1, Number(d.interval) || 5);
		const until = Date.now() + Math.min(Number(d.expires_in) > 0 ? Number(d.expires_in) : 900, 1800) * pace.second;
		try {
			while (Date.now() < until) {
				await new Promise<void>((resolve) => {
					const done = () => (clearTimeout(timer), signal.removeEventListener("abort", done), resolve());
					const timer = setTimeout(done, every * pace.second);
					signal.addEventListener("abort", done, { once: true });
				});
				if (signal.aborted) throw said("stopped");
				if (given === false) throw said("the sign-in was not made: you answered no. To be asked again: unsubscribe and subscribe again, or restart pine", true);
				const t = await post("token", { grant_type: "urn:ietf:params:oauth:grant-type:device_code", client_id: o.clientId, device_code: d.device_code }, signal);
				if (typeof t.access_token === "string" && t.access_token) {
					if (typeof t.refresh_token !== "string" || !t.refresh_token) source.log.warn('Microsoft gave no way to renew the sign-in: it will have to be made again in about an hour. The app lacks "offline_access"');
					// Signed in: should Microsoft one day take it back, the owner is asked again. Only a "no" is not asked twice.
					asked = false;
					return keep(t);
				}
				if (t.error === "authorization_pending") continue;
				if (t.error === "slow_down") every += 5;
				else throw said(t.error === "authorization_declined" ? "the sign-in was declined at Microsoft" : t.error === "expired_token" ? "the code ran out before anybody signed in" : `Microsoft refused the sign-in (${code(t.error)})`, true);
			}
			throw said("the code ran out before anybody signed in. To be asked again: unsubscribe and subscribe again, or restart pine", true);
		} finally {
			close(now !== undefined);
		}
	};

	const fresh = async (signal: AbortSignal): Promise<string> => {
		if (now && now.until - Date.now() > 120_000) return now.token;
		now = undefined;
		const kept = source.kv.get<{ refresh?: string; scope?: string; client?: string } | null>("signin");
		// What was given for other rights, or to another app, is not what is needed now.
		if (kept?.refresh && kept.scope === scope && kept.client === o.clientId) {
			const t = await post("token", { grant_type: "refresh_token", client_id: o.clientId, refresh_token: kept.refresh, scope }, signal);
			if (typeof t.access_token === "string" && t.access_token) return keep(t);
			// Only "this is no good any more" lets go of it. Microsoft being unwell does not.
			if (t.error !== "invalid_grant" && t.error !== "interaction_required") throw said(`Microsoft did not renew the sign-in (${code(t.error)})`);
			source.kv.set("signin", null);
			source.log.info("the sign-in is no longer good (signed out, a new password, or unused for too long)");
		}
		return ask(signal);
	};

	return {
		// One at a time: IMAP and a mail being sent must not both ask the owner.
		token: (signal) => (busy ??= fresh(signal).finally(() => (busy = undefined))),
		spent: () => void (now = undefined),
	};
}

async function smtpSend(o: { host: string; port: number; user: string; password: string; token?: string; local: boolean; insecure: boolean; from: string; to: string; message: string }): Promise<void> {
	const secure = o.port === 465;
	let sock = await connect(o.host, o.port, secure, o);
	let encrypted = secure;
	try {
		let buffer = "";
		let waiter: (() => void) | undefined;
		let closed: Error | undefined;
		const listen = (s: net.Socket) => {
			s.on("data", (d: Buffer) => {
				buffer += d.toString("latin1");
				if (buffer.length > LINE_MAX * 4) s.destroy();
				waiter?.();
			});
			s.on("error", (e) => ((closed ??= e), waiter?.()));
			s.on("close", () => ((closed ??= said("the mail server closed the connection")), waiter?.()));
		};
		listen(sock);
		/** One reply, which may be several lines ("250-..." and at last "250 ..."). */
		const reply = async (): Promise<{ code: number; lines: string[] }> => {
			const until = Date.now() + pace.timeout;
			for (;;) {
				const lines = buffer.split("\r\n");
				const last = lines.findIndex((l) => /^\d{3}(?: |$)/.test(l));
				if (last >= 0 && last < lines.length - 1) {
					buffer = lines.slice(last + 1).join("\r\n");
					return { code: Number(lines[last].slice(0, 3)), lines: lines.slice(0, last + 1).map((l) => l.slice(4)) };
				}
				if (closed) throw closed;
				const left = until - Date.now();
				if (left <= 0) throw said("the mail server did not answer in time");
				await new Promise<void>((resolve) => {
					const timer = setTimeout(resolve, left);
					waiter = () => {
						clearTimeout(timer);
						waiter = undefined;
						resolve();
					};
				});
			}
		};
		const ask = async (line: string, want: number[], what: string) => {
			sock.write(`${line}\r\n`);
			const r = await reply();
			if (!want.includes(r.code)) throw said(`the mail server refused ${what} (${r.code})`);
			return r;
		};
		const hello = async () => (await ask("EHLO pine.localhost", [250], "the greeting")).lines.map((l) => l.toUpperCase());
		const greeting = await reply();
		if (greeting.code !== 220) throw said(`the mail server is not ready (${greeting.code})`);
		let caps = await hello();
		if (!encrypted && caps.some((c) => c === "STARTTLS")) {
			await ask("STARTTLS", [220], "to encrypt the connection");
			sock.removeAllListeners("data");
			sock.removeAllListeners("error");
			sock.removeAllListeners("close");
			buffer = "";
			sock = await upgrade(sock, o.host, o.insecure);
			listen(sock);
			encrypted = true;
			caps = await hello();
		}
		// A password is never sent in the clear to a server out on the internet.
		if (!encrypted && !o.local) throw said("the mail server offers no encryption on this port. Use port 465, or 587 on a server that has STARTTLS");
		const auth = caps.find((c) => c.startsWith("AUTH"))?.split(/[ =]+/).slice(1) ?? [];
		if (o.token) {
			if (!auth.includes("XOAUTH2")) throw said("the mail server takes no sign-in of this kind (XOAUTH2) on this port");
			sock.write(`AUTH XOAUTH2 ${Buffer.from(`user=${o.user}\x01auth=Bearer ${o.token}\x01\x01`).toString("base64")}\r\n`);
			let r = await reply();
			// A refusal comes as a challenge first, answered with an empty line.
			if (r.code === 334) {
				sock.write("\r\n");
				r = await reply();
			}
			if (r.code !== 235) throw said(`the mail server refused the sign-in (${r.code}): sending may be switched off for this mailbox ("Authenticated SMTP"), or the app lacks the permission SMTP.Send`);
		} else if (auth.includes("PLAIN")) await ask(`AUTH PLAIN ${Buffer.from(`\0${o.user}\0${o.password}`).toString("base64")}`, [235], "the login: check the user name and the password");
		else if (auth.includes("LOGIN")) {
			await ask("AUTH LOGIN", [334], "the login");
			await ask(Buffer.from(o.user).toString("base64"), [334], "the login");
			await ask(Buffer.from(o.password).toString("base64"), [235], "the login: check the user name and the password");
		} else if (auth.length || !o.local) throw said("the mail server offers no way to log in with a password");
		await ask(`MAIL FROM:<${o.from}>`, [250], "the sender");
		await ask(`RCPT TO:<${o.to}>`, [250, 251], "the recipient");
		await ask("DATA", [354], "the message");
		// A line that begins with a dot gets a second one, so that none of them ends the message early.
		await ask(`${o.message.replace(/\r?\n/g, "\r\n").replace(/^\./gm, "..")}\r\n.`, [250], "the message");
		sock.write("QUIT\r\n");
	} finally {
		sock.destroy();
	}
}

// ---- the source ---------------------------------------------------------------------------------

const clock = () => new Date().toTimeString().slice(0, 8);

export default async function mail(source: SourceApi): Promise<void> {
	const o = source.options;
	const signIn = o.signIn === "microsoft";
	const host = String(o.host ?? (signIn ? MICROSOFT.imap : ""));
	const user = String(o.user ?? "");
	const password = String(o.password ?? "");
	if (!host || !user || (!signIn && !password)) throw new Error(`needs "host", "user" and "password": the IMAP server and the login of the mailbox`);
	if (signIn && !GUID.test(String(o.clientId ?? ""))) throw new Error('"signIn": "microsoft" needs "clientId": the Application (client) ID of the app registered at Microsoft');
	source.secret(password || undefined);
	const security = String(o.security ?? "tls");
	const local = o.local === true || isLocalHost(host);
	if (security === "none" && !local) throw new Error(`"security": "none" is only for a server on this computer or your own network`);
	const port = Number(o.port ?? (security === "tls" ? 993 : 143));
	const insecure = o.insecureTls === true;
	const mailbox = String(o.mailbox ?? "INBOX");
	const from: string[] = (Array.isArray(o.from) ? o.from : []).map((x: unknown) => String(x).toLowerCase());
	const subject = o.subject ? new RegExp(String(o.subject), "i") : undefined;
	const maxBytes = Math.min(Number(o.maxMb ?? 10), 50) * 1024 * 1024;
	// What is fetched of one message: enough for one attachment of the largest size that is kept, as base64.
	const fetchBytes = Math.ceil(maxBytes * 1.4) + 2 * 1024 * 1024;
	const keepMs = Number(o.keepDays ?? 7) * 86_400_000;
	const dir = path.join(source.dataDir, "files");
	fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
	source.media(dir);
	pruneFiles(dir, keepMs);
	const pruner = setInterval(() => pruneFiles(dir, keepMs), 6 * 3_600_000);
	pruner.unref?.();

	let stopped = false;
	let current: net.Socket | undefined;
	let wake: (() => void) | undefined;
	let reported = 0;
	let left = 0;
	const say = (line: string) => source.status(`${line}${reported || left ? `. ${reported} reported${left ? `, ${left} left out by the filters` : ""}` : ""}`);
	// Aborted when the source stops: a question to Microsoft that is under way ends with it.
	const halt = new AbortController();
	const sendTo: string[] = (Array.isArray(o.sendTo) ? o.sendTo : []).map((x: unknown) => String(x).trim().toLowerCase());
	// Called when the owner has been asked to sign in: the source counts as started and waits, so
	// that neither the agent that set it up nor pine's own start hangs on somebody opening a browser.
	let begun: (() => void) | undefined;
	const signedIn = signIn ? microsoft(source, { user, clientId: String(o.clientId).toLowerCase(), tenant: String(o.tenant ?? "common"), send: sendTo.length > 0, say, waiting: () => begun?.() }) : undefined;

	const wanted = (m: { from: string; subject: string }) => (!from.length || from.some((f) => (f.startsWith("@") ? m.from.endsWith(f) : m.from === f))) && (!subject || subject.test(m.subject));

	const take = (raw: Buffer, size: number) => {
		const m = parseMail(raw, { attachmentBytes: maxBytes });
		// Only the beginning of a very large message is fetched: what its last file holds is not all there.
		const cut = size > raw.length;
		const lastFile = m.attachments.at(-1);
		if (cut && lastFile) Object.assign(lastFile, { skipped: true, bytes: Buffer.alloc(0) });
		if (!wanted(m)) return void left++;
		const kept = keepFiles(dir, m);
		reported++;
		source.emit("mail", { from: m.from, ...(m.fromName ? { fromName: clip(m.fromName, 200) } : {}), to: m.to.slice(0, 20), subject: clip(m.subject, 300), ...(m.date ? { date: m.date } : {}), text: clip(m.text, 6000), attachments: kept.attachments, ...(kept.images ? { images: kept.images } : {}), ...(cut ? { cut: true } : {}) });
	};

	/** One connection, from the greeting until it breaks. `ready` is called when it is logged in and watching. */
	const session = async (ready: () => void): Promise<void> => {
		const sock = await connect(host, port, security === "tls", { local, insecure });
		current = sock;
		const imap = new Imap(sock, fetchBytes + 4096);
		try {
			if (stopped) return;
			const greeting = (await imap.next())!;
			if (!/^\* (OK|PREAUTH)\b/i.test(greeting.text)) throw said("the server turned the connection away");
			const capabilities = async () => {
				const r = await imap.cmd(["CAPABILITY"], "say what it can do");
				for (const u of r.untagged) imap.learn(u.text);
			};
			if (!imap.learn(greeting.text)) await capabilities();
			if (security === "starttls") {
				if (!imap.caps.has("STARTTLS")) throw said('the server offers no STARTTLS on this port. Use "security": "tls" with port 993', true);
				await imap.cmd(["STARTTLS"], "encrypt the connection");
				const secure = await upgrade(imap.detach(), host, insecure);
				current = secure;
				imap.attach(secure);
				await capabilities();
			}
			if (signedIn) {
				if (!imap.caps.has("AUTH=XOAUTH2")) throw said("the server takes no sign-in of this kind (XOAUTH2)", true);
				const token = await signedIn.token(halt.signal);
				if (stopped) return;
				let login: string;
				try {
					login = await imap.xoauth2(user, token);
				} catch (e) {
					signedIn.spent();
					throw e;
				}
				if (!imap.learn(login)) await capabilities();
			} else if (!/^\* PREAUTH\b/i.test(greeting.text)) {
				if (imap.caps.has("LOGINDISABLED")) throw said("the server takes no login with a password on this connection", true);
				const login = await imap.cmd(["LOGIN ", arg(user), " ", arg(password)], "log in: check the user name and the password (Gmail, iCloud and Fastmail want an app password)", true);
				if (!imap.learn(login.text)) await capabilities();
			}
			const opened = await imap.cmd(["EXAMINE ", arg(mailbox)], `open the mailbox "${clip(mailbox, 60)}"`, true);
			const facts = [...opened.untagged.map((u) => u.text), opened.text].join("\n");
			const validity = Number(/\[UIDVALIDITY (\d+)\]/i.exec(facts)?.[1] ?? 0);
			const uidNext = /\[UIDNEXT (\d+)\]/i.exec(facts)?.[1];
			let at = source.kv.get<{ validity: number; last: number }>("at");
			if (!at || at.validity !== validity) {
				// The starting point: what is there now is not news. (Also when the server numbered its mail anew.)
				let last = uidNext ? Number(uidNext) - 1 : 0;
				if (!uidNext) {
					const all = await imap.cmd(["UID SEARCH ALL"], "list the mailbox");
					last = Math.max(0, ...all.untagged.flatMap((u) => (/^\* SEARCH\b/i.test(u.text) ? u.text.split(/\s+/).slice(2).map(Number).filter(Number.isFinite) : [])));
				}
				at = { validity, last };
				source.kv.set("at", at);
			}
			say(`connected to ${host} as ${user}, waiting for mail in ${clip(mailbox, 60)}`);
			ready();

			const catchUp = async () => {
				const found = await imap.cmd([`UID SEARCH UID ${at!.last + 1}:*`], "look for new mail");
				// "n:*" always names the newest mail, also when it is older than n.
				let uids = [...new Set(found.untagged.flatMap((u) => (/^\* SEARCH\b/i.test(u.text) ? u.text.split(/\s+/).slice(2).map(Number) : [])))].filter((n) => Number.isInteger(n) && n > at!.last).sort((a, b) => a - b);
				if (uids.length > MAX_CATCH_UP) {
					source.log.warn(`${uids.length} new mails at once: the oldest ${uids.length - MAX_CATCH_UP} are left out`);
					uids = uids.slice(-MAX_CATCH_UP);
				}
				for (const uid of uids) {
					if (stopped) return;
					const got = await imap.cmd([`UID FETCH ${uid} (UID RFC822.SIZE BODY.PEEK[]<0.${fetchBytes}>)`], "hand over a mail");
					const fetched = got.untagged.find((u) => /^\* \d+ FETCH\b/i.test(u.text) && u.literals.length && new RegExp(`\\bUID ${uid}\\b`, "i").test(u.text));
					if (fetched) {
						const raw = fetched.literals.reduce((a, b) => (b.length > a.length ? b : a));
						try {
							take(raw, Number(/RFC822\.SIZE (\d+)/i.exec(fetched.text)?.[1] ?? raw.length));
						} catch (e) {
							source.log.warn(`could not read mail ${uid}`, errText(e));
						}
					}
					// Remembered mail by mail: a connection that breaks half way repeats nothing.
					at = { validity, last: uid };
					source.kv.set("at", at);
				}
				if (uids.length) say(`connected to ${host} as ${user}, waiting for mail in ${clip(mailbox, 60)}`);
			};

			let idle = imap.caps.has("IDLE");
			for (;;) {
				const before = imap.news;
				await catchUp();
				if (stopped) return;
				// A mail that arrived while the last ones were fetched was announced then, and will not be again.
				if (imap.news !== before) continue;
				if (!idle) {
					// A server that cannot tell is asked once a minute.
					const until = Date.now() + pace.noop;
					while (Date.now() < until) if (!(await imap.next(until - Date.now(), true))) break;
					await imap.cmd(["NOOP"], "answer");
					continue;
				}
				const tag = imap.nextTag();
				imap.write(`${tag} IDLE\r\n`);
				let going = false;
				let over = false;
				const until = Date.now() + pace.idle;
				for (;;) {
					// Until it says "go on", an answer is due; after that, silence is what waiting looks like.
					const r = await imap.next(going ? Math.max(1, until - Date.now()) : pace.timeout, going);
					if (!r) break;
					if (r.text.startsWith("+")) going = true;
					else if (r.text.startsWith(`${tag} `)) {
						// Refused: this server only says it can.
						over = true;
						idle = false;
						break;
					} else if (/^\* \d+ (EXISTS|RECENT)\b/i.test(r.text)) break;
					else if (/^\* BYE\b/i.test(r.text)) throw said("the server ended the connection");
				}
				if (over) continue;
				imap.write("DONE\r\n");
				for (;;) {
					const r = (await imap.next())!;
					if (r.text.startsWith(`${tag} `)) break;
				}
			}
		} finally {
			current = undefined;
			imap.sock.destroy();
			sock.destroy();
		}
	};

	source.onStop(() => {
		stopped = true;
		halt.abort();
		clearInterval(pruner);
		current?.destroy();
		wake?.();
	});

	// The first connection says whether the login works; a wrong password is the reason the source is
	// not running. A server that cannot be reached right now is tried again and again instead.
	await new Promise<void>((resolve, reject) => {
		let first = true;
		const settle = (e?: Error) => {
			if (!first) return;
			first = false;
			if (e) reject(e);
			else resolve();
		};
		begun = () => settle();
		void (async () => {
			let pause = pace.retry;
			let failing = false;
			while (!stopped) {
				try {
					await session(() => {
						pause = pace.retry;
						if (failing) source.log.info("connected again");
						failing = false;
						settle();
					});
				} catch (e) {
					if (stopped) break;
					const why = reason(e);
					if (first && e instanceof Said && e.fatal) return settle(new Error(why));
					// Not signed in and not to be asked again: nothing to try until the owner does something.
					if (e instanceof Said && e.fatal && signedIn) pause = pace.retryMax;
					if (!failing) source.log.warn(`not connected: ${why}`);
					failing = true;
					say(`not connected since ${clock()}: ${why}. Trying again`);
				}
				settle();
				if (stopped) break;
				await new Promise<void>((r) => {
					const timer = setTimeout(r, pause);
					wake = () => (clearTimeout(timer), r());
				});
				wake = undefined;
				pause = Math.min(pause * 2, pace.retryMax);
			}
			settle();
		})();
	});

	// Sending: to the addresses the owner put on the list, and to nobody else.
	const smtpHost = typeof o.smtpHost === "string" ? o.smtpHost : signIn ? MICROSOFT.smtp : "";
	const sender = String(o.sender ?? user);
	source.onSend(async (m) => {
		if (!smtpHost || !sendTo.length) throw new Error("this mailbox was set up to read only: nothing can be sent through it");
		const to = String(m.to ?? (sendTo.length === 1 ? sendTo[0] : "")).trim().toLowerCase();
		if (!to) throw new Error(`say whom to write to: {"to": "...", "subject": "...", "text": "..."}. It may write to ${sendTo.join(", ")}`);
		if (!sendTo.includes(to)) throw new Error(`"${clip(to.replace(/[\r\n]+/g, " "), 100)}" is not an address this source may write to (${sendTo.join(", ")})`);
		const text = String(m.text ?? "");
		if (!text.trim()) throw new Error('there is nothing to send: give "text"');
		const title = oneLine(m.subject) || "A message from your agent";
		try {
			await smtpSend({ host: smtpHost, port: Number(o.smtpPort ?? (signIn ? 587 : 465)), user, password, token: signedIn ? await signedIn.token(halt.signal) : undefined, local: o.local === true || isLocalHost(smtpHost), insecure, from: sender, to, message: composeMail({ from: sender, to, subject: title, text }) });
		} catch (e) {
			throw new Error(`the mail was not sent: ${reason(e)}`);
		}
		return `sent to ${to}`;
	});
}
