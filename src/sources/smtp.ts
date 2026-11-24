import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import { Type } from "typebox";
import { keepFiles, parseMail, pruneFiles } from "../mime.ts";
import { timingSafeEqual } from "../security.ts";
import type { SourceType } from "../source-types.ts";
import type { SourceApi } from "../sources.ts";
import { errText } from "../util.ts";
import { capped, clip } from "../watching.ts";

/**
 * A mail drop: a small mail server that accepts messages and nothing else. For devices and
 * programs whose only way of reporting is "send an e-mail": a NAS, a printer or scanner, a UPS,
 * a camera, a router, cron on a server.
 *
 * options: { port, user?, password?, host?, allow?, to?, maxMb?, keepDays? }
 *   port, user, password  what you enter in the device. The password must have 8 characters or more.
 *   allow      only these client addresses, as prefixes: ["192.168.1.40", "192.168.2."]. With it
 *              and without a password, no login is asked for (for devices that cannot log in)
 *   host       address to listen on. Default "0.0.0.0": devices on your network have to reach it.
 *   to         recipient addresses it accepts; mail for any other is refused. Default: any
 *   maxMb      largest message accepted (default 10)
 *   keepDays   received attachments are deleted after this many days (default 7)
 *
 * event "mail": { from, fromName?, to, subject, text, attachments: [{ file, path?, type, size }], images?, client }
 *
 * It speaks plain SMTP, as these devices do: the password and the mail cross your network
 * unencrypted. It only receives. Nothing is passed on to anybody (it is no relay), nothing can be
 * read back, and every attachment lands under a name of pine's choosing inside the source's own folder.
 */

/** How many messages a minute are taken; a device that sends more is told to try again later. */
const PER_MINUTE = 30;
const LINE_MAX = 4096;

const ADDRESS = /^[^\s@<>,;"]+@[^\s@<>,;"]+$/;

export const type: SourceType = {
	summary: "a mail drop: a small mail server that only accepts. For a NAS, printer, scanner, UPS, camera or server whose only way of reporting is \"send an e-mail\"",
	options: Type.Object(
		{
			port: Type.Number({ description: "port to listen on, e.g. 2525" }),
			user: Type.Optional(Type.String({ description: 'user name the device logs in with. Default "device"' })),
			password: Type.Optional(Type.String({ description: 'password the device logs in with, 8 characters or more. Leave it out and pine makes one (or, with "allow", no login is asked for)', secret: true })),
			allow: Type.Optional(Type.Array(Type.String(), { description: 'only these client addresses, as prefixes: ["192.168.1.40", "192.168.2."]. For a device that cannot log in, give the device\'s address here and no password' })),
			host: Type.Optional(Type.String({ description: 'address to listen on. Default "0.0.0.0", so that devices on the network reach it' })),
			to: Type.Optional(Type.Array(Type.String(), { description: 'recipient addresses it accepts, e.g. ["alerts@pine.home"]; mail for any other is refused. Default: any recipient' })),
			maxMb: Type.Optional(Type.Number({ description: "largest message accepted, in MB. Default 10" })),
			keepDays: Type.Optional(Type.Number({ description: "received attachments are deleted after this many days. Default 7" })),
		},
		{ additionalProperties: false },
	),
	plan(o, setup) {
		if (!Number.isInteger(o.port) || o.port < 1 || o.port > 65535) throw new Error(`"port" must be a port number, for example 2525`);
		if (o.password !== undefined && String(o.password).length < 8) throw new Error("the password must have 8 characters or more");
		const allow: string[] = (Array.isArray(o.allow) ? o.allow : []).map((a: unknown) => String(a).trim()).filter(Boolean);
		for (const a of allow) if (!/^[0-9a-fA-F.:]+$/.test(a)) throw new Error(`"${a}" in "allow" is not an address or the beginning of one. It looks like "192.168.1.40" or "192.168.2."`);
		const to: string[] = (Array.isArray(o.to) ? o.to : []).map((a: unknown) => String(a).trim().toLowerCase()).filter(Boolean);
		for (const a of to) if (!ADDRESS.test(a)) throw new Error(`"${a}" in "to" is not an e-mail address`);
		for (const key of ["maxMb", "keepDays"]) if (o[key] !== undefined && !(Number(o[key]) > 0)) throw new Error(`"${key}" must be a number above 0`);
		if (o.maxMb !== undefined && o.maxMb > 50) throw new Error('"maxMb" is at most 50');
		// Either the device proves itself, or it is known by where it stands: without one of the two anyone
		// on the network could hand text to an agent.
		const login = o.password !== undefined || !allow.length;
		const made = login && o.password === undefined;
		const user = String(o.user ?? "device");
		if (!login && o.user !== undefined) throw new Error('"user" without a "password" does nothing: leave both out to accept the addresses on "allow" without a login, or leave only the password out and pine makes one');
		const options: Record<string, unknown> = { ...o, ...(allow.length ? { allow } : {}), ...(to.length ? { to } : {}) };
		if (login) Object.assign(options, { user, password: o.password ?? setup.random(9) });
		return {
			options,
			does: [
				`open a mail server on port ${o.port} of this computer that accepts mail${login ? ` from the user "${user}"${made ? " with a password made now" : ""}` : " without a login"}${allow.length ? `${login ? "," : ""} from the addresses ${allow.join(", ")}` : ""}${to.length ? `, addressed to ${to.join(", ")}` : ""}, and passes nothing on to anybody`,
				`speak plain SMTP as these devices do: ${login ? "the password and " : ""}the mail cross your network unencrypted`,
				"treat every mail as outside content, whoever it says it is from",
			],
			opens: true,
			tell: `In the device, enter this computer's address as the mail (SMTP) server, port ${o.port}, without encryption (no SSL, no TLS)${login ? `, and the user "${user}". The password is in pine's .env file as ${setup.envName("password")}, where your owner reads it` : ", and no login"}. ${to.length ? `The recipient must be ${to.join(" or ")}` : "Any recipient address will do"}; the sender address can be anything.`,
		};
	},
};

export default async function smtp(source: SourceApi): Promise<void> {
	const o = source.options;
	const port = Number(o.port);
	if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error(`needs "port" (for example 2525)`);
	const allow: string[] = (Array.isArray(o.allow) ? o.allow : []).map(String);
	const user = String(o.user ?? "");
	const password = String(o.password ?? "");
	const login = password !== "";
	if (login ? password.length < 8 || !user : !allow.length) throw new Error(`needs a "user" and a "password" of 8 characters or more, or "allow" with the addresses of the devices: without either anyone on the network could hand mail to your agents`);
	source.secret(password || undefined);
	const host = String(o.host ?? "0.0.0.0");
	const accept: string[] = (Array.isArray(o.to) ? o.to : []).map((a: unknown) => String(a).toLowerCase());
	const maxBytes = Math.min(Number(o.maxMb ?? 10), 50) * 1024 * 1024;
	const keepMs = Number(o.keepDays ?? 7) * 86_400_000;
	const dir = path.join(source.dataDir, "files");
	fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
	source.media(dir);
	pruneFiles(dir, keepMs);
	const pruner = setInterval(() => pruneFiles(dir, keepMs), 6 * 3_600_000);
	pruner.unref?.();

	const plain = (addr: string | undefined) => (addr ?? "").replace(/^::ffff:/, "");
	const open = new Set<net.Socket>();
	const cap = capped(PER_MINUTE);
	let received = 0;
	let refused = 0;
	const say = () => source.status(`accepting mail on port ${port}${login ? ` from the user ${user}` : ""}${allow.length ? ` from ${allow.join(", ")}` : ""}. ${received} received${refused ? `, ${refused} refused` : ""}`);
	say();

	/** The address in "MAIL FROM:<a@b> SIZE=1" or "RCPT TO:<a@b>". */
	const pathOf = (rest: string) => (/^\s*<([^<>]*)>/.exec(rest)?.[1] ?? /^\s*(\S+)/.exec(rest)?.[1] ?? "").trim().toLowerCase();

	const server = net.createServer((sock) => {
		const remote = plain(sock.remoteAddress);
		if (open.size >= 20 || (allow.length && !allow.some((a) => remote === a || (/[.:]$/.test(a) && remote.startsWith(a))))) {
			refused++;
			say();
			return void sock.destroy();
		}
		open.add(sock);
		sock.setTimeout(60_000, () => sock.destroy());
		sock.on("close", () => open.delete(sock));
		sock.on("error", () => {});
		const reply = (line: string) => sock.writable && sock.write(`${line}\r\n`);

		let authed = !login;
		let failures = 0;
		let from: string | undefined;
		let to: string[] = [];
		/** What the next line is: a command, part of a login, or (in `data`) the message itself. */
		let expect: "command" | "plain" | "login-user" | "login-pass" = "command";
		let name = "";
		const reset = () => {
			from = undefined;
			to = [];
		};
		const auth = (u: string, p: string) => {
			authed = timingSafeEqual(u, user) && timingSafeEqual(p, password);
			if (authed) return reply("235 Authenticated");
			refused++;
			say();
			if (++failures >= 3) return void (reply("535 Bye"), sock.end());
			return reply("535 Login incorrect");
		};
		const decode = (b64: string) => Buffer.from(b64.trim(), "base64").toString("utf8");

		const take = (raw: Buffer) => {
			if (raw.length > maxBytes) {
				refused++;
				say();
				return reply("552 Message too large");
			}
			// More than a device has to say: it is told to come back, which a mail program does by itself.
			if (!cap.ok()) return void (refused++, say(), reply("451 Too many messages, try again later"));
			let m: ReturnType<typeof parseMail>;
			try {
				m = parseMail(raw, { attachmentBytes: maxBytes });
			} catch (e) {
				source.log.debug("could not read a message", errText(e));
				return reply("554 Could not read the message");
			}
			const kept = keepFiles(dir, m);
			received++;
			say();
			try {
				// Who it is from is what the message says, and failing that what the device said when it handed it over.
				source.emit("mail", { from: m.from || clip(from ?? "", 320), ...(m.fromName ? { fromName: clip(m.fromName, 200) } : {}), to, subject: clip(m.subject, 300), text: clip(m.text, 6000), attachments: kept.attachments, ...(kept.images ? { images: kept.images } : {}), client: remote });
			} catch (e) {
				source.log.warn("could not report a mail", errText(e));
			}
			return reply("250 Accepted");
		};

		const handle = (line: string) => {
			if (expect === "plain") {
				expect = "command";
				const [, u = "", p = ""] = decode(line).split("\0");
				return auth(u, p);
			}
			if (expect === "login-user") {
				name = decode(line);
				expect = "login-pass";
				return reply("334 UGFzc3dvcmQ6");
			}
			if (expect === "login-pass") {
				expect = "command";
				return auth(name, decode(line));
			}
			const cmd = line.trim().split(/\s+/, 1)[0].toUpperCase();
			const rest = line.trim().slice(cmd.length).trim();
			if (cmd === "QUIT") return void (reply("221 Bye"), sock.end());
			if (cmd === "NOOP") return reply("250 OK");
			if (cmd === "RSET") return void (reset(), reply("250 OK"));
			if (cmd === "HELO") return void (reset(), reply("250 pine"));
			if (cmd === "EHLO") return void (reset(), reply([`250-pine`, `250-SIZE ${maxBytes}`, "250-8BITMIME", ...(login ? ["250-AUTH PLAIN LOGIN"] : []), "250 OK"].join("\r\n")));
			if (cmd === "AUTH") {
				if (!login) return reply("503 No login is needed");
				if (authed) return reply("503 Already logged in");
				const [mechanism = "", initial] = rest.split(/\s+/);
				if (mechanism.toUpperCase() === "PLAIN") {
					if (initial === undefined) return void ((expect = "plain"), reply("334 "));
					const [, u = "", p = ""] = decode(initial).split("\0");
					return auth(u, p);
				}
				if (mechanism.toUpperCase() === "LOGIN") {
					if (initial !== undefined) {
						name = decode(initial);
						expect = "login-pass";
						return reply("334 UGFzc3dvcmQ6");
					}
					expect = "login-user";
					return reply("334 VXNlcm5hbWU6");
				}
				return reply("504 Only AUTH PLAIN and AUTH LOGIN");
			}
			if (cmd === "MAIL") {
				if (!authed) return reply("530 Log in first");
				if (!/^FROM:/i.test(rest)) return reply("501 MAIL FROM:<address>");
				const size = Number(/\bSIZE=(\d+)/i.exec(rest)?.[1] ?? 0);
				if (size > maxBytes) return void (refused++, say(), reply("552 Message too large"));
				reset();
				from = pathOf(rest.slice(5));
				return reply("250 OK");
			}
			if (cmd === "RCPT") {
				if (!authed) return reply("530 Log in first");
				if (from === undefined) return reply("503 MAIL first");
				if (!/^TO:/i.test(rest)) return reply("501 RCPT TO:<address>");
				const rcpt = pathOf(rest.slice(3));
				// Nothing is passed on: a recipient is only a name the device gave, and where a list says which names count, the others are turned away.
				if (!rcpt || (accept.length && !accept.includes(rcpt))) return void (refused++, say(), reply("550 No such recipient here"));
				if (to.length >= 20) return reply("452 Too many recipients");
				to.push(clip(rcpt, 320));
				return reply("250 OK");
			}
			if (cmd === "DATA") {
				if (!authed) return reply("530 Log in first");
				if (from === undefined || !to.length) return reply("503 MAIL and RCPT first");
				inData = true;
				chunks = [];
				size = 0;
				return reply("354 Send it, end with a line that holds only a dot");
			}
			// STARTTLS, VRFY, EXPN, TURN and whatever else: not here.
			return reply("502 Not implemented");
		};

		let buffer: Buffer = Buffer.alloc(0);
		let inData = false;
		let chunks: Buffer[] = [];
		let size = 0;
		let tail: Buffer = Buffer.alloc(0);
		const END = Buffer.from("\r\n.\r\n");

		const feed = (chunk: Buffer): void => {
			while (chunk.length) {
				if (!inData) {
					buffer = buffer.length ? Buffer.concat([buffer, chunk]) : chunk;
					chunk = Buffer.alloc(0);
					for (;;) {
						if (inData) {
							// What follows the DATA command in the same packet is the message already.
							chunk = buffer;
							buffer = Buffer.alloc(0);
							// The line break that ended "DATA" counts as the one before a first line of only a dot.
							tail = Buffer.from("\r\n");
							break;
						}
						const i = buffer.indexOf("\n");
						if (i < 0) {
							if (buffer.length > LINE_MAX) return void sock.destroy();
							break;
						}
						const line = buffer.subarray(0, i).toString("utf8").replace(/\r$/, "");
						buffer = buffer.subarray(i + 1);
						handle(line);
					}
					continue;
				}
				// The end of a message is searched for where the last piece ended, so that an end cut in two is found.
				const joined = Buffer.concat([tail, chunk]);
				const at = joined.indexOf(END);
				if (at < 0) {
					const keep = Math.max(0, joined.length - (END.length - 1));
					const body = joined.subarray(0, keep);
					size += body.length;
					// A message that is too large is read to its end and not kept: the device gets its answer, and no memory is spent on it.
					if (size <= maxBytes + END.length) chunks.push(body);
					else chunks = [];
					if (size > maxBytes * 2 + 1024 * 1024) return void sock.destroy();
					tail = joined.subarray(keep);
					return;
				}
				const body = joined.subarray(0, at);
				size += body.length;
				const whole = size <= maxBytes + END.length ? Buffer.concat([...chunks, body]) : undefined;
				chunk = joined.subarray(at + END.length);
				inData = false;
				chunks = [];
				tail = Buffer.alloc(0);
				if (!whole) {
					refused++;
					say();
					reply("552 Message too large");
				} else {
					// The first two bytes are the line break that was put in front; a line that began with two dots began with one.
					take(Buffer.from(whole.subarray(2).toString("latin1").replace(/(^|\r\n)\.\./g, "$1."), "latin1"));
				}
				reset();
			}
		};
		sock.on("data", (chunk: Buffer) => {
			try {
				feed(chunk);
			} catch (e) {
				source.log.debug("smtp connection failed", errText(e));
				sock.destroy();
			}
		});
		reply("220 pine mail drop");
	});

	await new Promise<void>((resolve, reject) => {
		server.once("error", reject);
		server.listen(port, host, () => (server.removeListener("error", reject), resolve()));
	});
	source.onStop(
		() =>
			new Promise<void>((resolve) => {
				clearInterval(pruner);
				for (const s of open) s.destroy();
				server.close(() => resolve());
			}),
	);
	source.log.info(`accepting mail on ${host}:${port}`);
}
