import { type ChildProcess, execFile, spawn } from "node:child_process";
import dgram from "node:dgram";
import dns from "node:dns";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import { Type } from "typebox";
import { isPrivateAddress } from "../net.ts";
import type { SourceType } from "../source-types.ts";
import type { SourceApi } from "../sources.ts";
import { parseDuration } from "../util.ts";
import { clip } from "../watching.ts";

/**
 * Who is on the owner's own network: reports when a device joins it and when it has left.
 * For "is my phone home", a TV or a console that was switched on, a printer that came online.
 *
 * options: { hosts?, services?, every?, away? }
 *   hosts     the devices to look for, name → address: { "phone": "192.168.1.23", "tv": "tv.local" }
 *   services  kinds of device that announce themselves on the network (mDNS, also called Bonjour),
 *             by their service type: ["_airplay._tcp", "_ipp._tcp"]. Every device of that kind counts
 *   every     how often to look ("30s" by default)
 *   away      how long a device must have been silent before it counts as gone ("10m" by default)
 *
 * event "arrived": { name, address?, service?, awayFor? }   awayFor: seconds it was gone
 * event "left":    { name, address?, service?, lastSeen }   lastSeen: when it last answered
 *
 * A host is there when it answers a ping, or answers a connection at all, even by refusing it.
 * Only addresses on one's own network are looked for. Nothing is sent to a device beyond that
 * one packet and a question to the network at large about who offers a service. The first look
 * is the starting point and reports nothing.
 */
const MIN = 10_000;
const GROUP = "224.0.0.251";
const MDNS = 5353;
/** Ports tried when a device does not answer a ping: one nearly nothing listens on, the web, and the one an iPhone keeps open. */
const PORTS = [7, 80, 62078];
/** The system's own Bonjour browser on a Mac. It knows what the system knows, and needs no permission of its own to listen on the network. */
const DNSSD = "/usr/bin/dns-sd";
/** How long one device is given to answer, and how long answers to a question about services are waited for. A test shortens them. */
export const timing = { probeMs: 1500, listenMs: 1200 };
/** What a test puts in place of asking an address: the network the test runs on is not one it can count on. */
export const standIn: { answers?: (ip: string) => Promise<boolean> } = {};

// ---- DNS, as much of it as asking who offers a service takes ---------------------------------

export interface DnsRecord {
	name: string[];
	type: number;
	ttl: number;
	/** PTR: the name it points at. */
	ptr?: string[];
	/** SRV: where the service is. */
	srv?: { port: number; target: string[] };
	/** A, AAAA */
	address?: string;
}

/** A question "who has a PTR record for these names". `unicast` asks for the answer to be sent back to the asker alone. */
export function dnsQuery(names: string[], unicast = false): Buffer {
	const head = Buffer.alloc(12);
	head.writeUInt16BE(names.length, 4);
	const parts = names.map((name) => {
		const labels = name.split(".").filter(Boolean).map((l) => Buffer.from(l, "utf8").subarray(0, 63));
		const tail = Buffer.alloc(5);
		tail.writeUInt16BE(12, 1);
		tail.writeUInt16BE(unicast ? 0x8001 : 1, 3);
		return Buffer.concat([...labels.flatMap((l) => [Buffer.from([l.length]), l]), tail]);
	});
	return Buffer.concat([head, ...parts]);
}

/**
 * The records of a DNS message: answers, authority and additional ones alike. Anybody on the
 * network can send one, so nothing in it is believed to be well formed: a name that points in
 * circles, a length that leads out of the message or a record of an odd size ends the reading,
 * and what was read until then is what comes back.
 */
export function dnsRead(buf: Buffer): { response: boolean; records: DnsRecord[] } {
	const records: DnsRecord[] = [];
	if (buf.length < 12) return { response: false, records };
	const response = (buf[2] & 0x80) !== 0;
	const name = (start: number): [string[], number] => {
		const labels: string[] = [];
		let at = start;
		let end = -1;
		let jumps = 0;
		for (;;) {
			if (at >= buf.length) throw new Error("short");
			const len = buf[at];
			if (len === 0) return [labels, end < 0 ? at + 1 : end];
			if ((len & 0xc0) === 0xc0) {
				if (at + 1 >= buf.length || ++jumps > 20) throw new Error("loop");
				if (end < 0) end = at + 2;
				at = ((len & 0x3f) << 8) | buf[at + 1];
				continue;
			}
			if (len > 63 || at + 1 + len > buf.length || labels.length >= 20) throw new Error("label");
			labels.push(buf.toString("utf8", at + 1, at + 1 + len));
			at += 1 + len;
		}
	};
	try {
		let at = 12;
		for (let i = buf.readUInt16BE(4); i > 0; i--) at = name(at)[1] + 4;
		const count = Math.min(buf.readUInt16BE(6) + buf.readUInt16BE(8) + buf.readUInt16BE(10), 100);
		for (let i = 0; i < count; i++) {
			const [owner, next] = name(at);
			if (next + 10 > buf.length) break;
			const type = buf.readUInt16BE(next);
			const ttl = buf.readUInt32BE(next + 4);
			const len = buf.readUInt16BE(next + 8);
			const data = next + 10;
			if (data + len > buf.length) break;
			const rec: DnsRecord = { name: owner, type, ttl };
			if (type === 12) rec.ptr = name(data)[0];
			else if (type === 33 && len >= 7) rec.srv = { port: buf.readUInt16BE(data + 4), target: name(data + 6)[0] };
			else if (type === 1 && len === 4) rec.address = [...buf.subarray(data, data + 4)].join(".");
			else if (type === 28 && len === 16) rec.address = Array.from({ length: 8 }, (_, k) => buf.readUInt16BE(data + k * 2).toString(16)).join(":");
			records.push(rec);
			at = data + len;
		}
	} catch {
		// what was read until here
	}
	return { response, records };
}

/** A line of the system's Bonjour browser (`dns-sd -B`): a device of a kind appeared ("Add") or is gone ("Rmv"), on one network interface. */
export function browseLine(line: string): { add: boolean; iface: string; service: string; name: string } | undefined {
	// Timestamp, A/R, Flags, if, Domain, Service Type, Instance Name (which may have spaces in it)
	const m = /^\s*\d+:\d+:\d+\.\d+\s+(Add|Rmv)\s+\S+\s+(\S+)\s+\S+\s+(_\S+?)\.?\s+(.+?)\s*$/.exec(line);
	return m ? { add: m[1] === "Add", iface: m[2], service: m[3].toLowerCase(), name: m[4] } : undefined;
}

// ---- who is there ------------------------------------------------------------------------------

export interface Known {
	there: boolean;
	/** When it last answered. */
	last?: number;
	/** When it was found gone: the time it had last answered. */
	left?: number;
	name: string;
	address?: string;
	service?: string;
}

export interface Change {
	event: "arrived" | "left";
	payload: { name: string; address?: string; service?: string; awayFor?: number; lastSeen?: string };
}

/**
 * Turns "it answered" and "it did not" into arrivals and departures. A device that answered is
 * there. One that does not is still there until it has been silent for `awayMs`: a phone that
 * sleeps answers only now and then. `quiet` is for the look that is the starting point: what is
 * found is noted and nothing is reported.
 */
export function tracker(awayMs: number, state: Record<string, Known> = {}) {
	const about = (k: Known) => ({ name: k.name, ...(k.address ? { address: k.address } : {}), ...(k.service ? { service: k.service } : {}) });
	return {
		state,
		sight(key: string, seen: boolean, now: number, quiet: boolean, info: { name: string; address?: string; service?: string }): Change | undefined {
			const k = state[key];
			if (!k) {
				if (!seen && !quiet) return undefined;
				state[key] = { ...info, there: seen, ...(seen ? { last: now } : {}) };
				return seen && !quiet ? { event: "arrived", payload: about(state[key]) } : undefined;
			}
			if (seen) {
				Object.assign(k, { ...info, last: now });
				if (k.there) return undefined;
				k.there = true;
				const awayFor = k.left !== undefined ? Math.max(0, Math.round((now - k.left) / 1000)) : undefined;
				delete k.left;
				return { event: "arrived", payload: { ...about(k), ...(awayFor !== undefined ? { awayFor } : {}) } };
			}
			if (!k.there || now - (k.last ?? 0) < awayMs) return undefined;
			return this.gone(key);
		},
		/** It said goodbye, or was silent for long enough. */
		gone(key: string): Change | undefined {
			const k = state[key];
			if (!k?.there) return undefined;
			k.there = false;
			k.left = k.last;
			return { event: "left", payload: { ...about(k), lastSeen: new Date(k.last ?? Date.now()).toISOString() } };
		},
	};
}

const first = (...files: string[]) => files.find((f) => fs.existsSync(f));

/** Whether this computer is on a local network at all. When it is not, nobody answering says nothing about who is at home. */
const onNetwork = () => Object.values(os.networkInterfaces()).some((list) => (list ?? []).some((a) => !a.internal && a.family === "IPv4" && /^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(a.address)));

/** Whether anything is at this address right now: it answers a ping, or it answers a connection, be it with a no. */
export function answers(ip: string): Promise<boolean> {
	// Never anything but an address goes to a program or a socket.
	if (!net.isIP(ip)) return Promise.resolve(false);
	return new Promise((resolve) => {
		let open = PORTS.length + 1;
		let done = false;
		const socks: net.Socket[] = [];
		const say = (yes: boolean) => {
			if (done || (!yes && --open > 0)) return;
			done = true;
			clearTimeout(timer);
			for (const s of socks) s.destroy();
			child?.kill("SIGKILL");
			resolve(yes);
		};
		const timer = setTimeout(() => {
			open = 1;
			say(false);
		}, timing.probeMs);
		const v6 = net.isIPv6(ip);
		const ping = v6 && process.platform === "darwin" ? first("/sbin/ping6") : first("/sbin/ping", "/bin/ping", "/usr/bin/ping", "/usr/sbin/ping");
		const child = ping ? execFile(ping, ["-c", "1", "-n", ip], { timeout: timing.probeMs + 200 }, (err) => say(!err)) : undefined;
		if (!child) say(false);
		for (const port of PORTS) {
			const s = net.connect({ host: ip, port });
			socks.push(s);
			s.once("connect", () => say(true));
			s.once("error", (e: NodeJS.ErrnoException) => say(e.code === "ECONNREFUSED"));
		}
	});
}

const NAME = /^[A-Za-z0-9][A-Za-z0-9_-]{0,39}$/;
const LOCAL = /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)*\.local$/i;
const SERVICE = /^_[a-z0-9]([a-z0-9-]{0,30}[a-z0-9])?\._(tcp|udp)$/;

/** An address of one's own network: a private one of a single device, or a .local name. */
const own = (address: string) => {
	if (net.isIPv4(address)) return isPrivateAddress(address) && !/^(0|22[4-9]|2[3-5]\d)\./.test(address) && !address.endsWith(".255");
	if (net.isIPv6(address)) return isPrivateAddress(address) && !/^ff/i.test(address) && address !== "::";
	return LOCAL.test(address);
};

function hostsOf(raw: unknown): Array<{ name: string; address: string }> {
	if (raw === undefined || raw === null) return [];
	if (typeof raw !== "object" || Array.isArray(raw)) throw new Error('"hosts" is an object of name and address: {"phone": "192.168.1.23"}');
	const list = Object.entries(raw as Record<string, unknown>).map(([name, a]) => ({ name, address: String(a ?? "").trim().toLowerCase() }));
	if (list.length > 32) throw new Error('"hosts" takes 32 devices at most');
	for (const h of list) {
		if (!NAME.test(h.name)) throw new Error(`"${h.name}" is not a usable name for a device: letters, digits, - and _`);
		if (!own(h.address)) throw new Error(`${h.name}: "${h.address}" is not an address on your owner's own network. Give the device's IP address there (192.168.1.23) or the device's .local name; this is not for addresses on the internet (the http type looks whether one of those answers)`);
	}
	return list;
}

function servicesOf(raw: unknown): string[] {
	const list = (Array.isArray(raw) ? raw : raw === undefined || raw === null || raw === "" ? [] : String(raw).split(",")).map((s) => String(s).trim().toLowerCase().replace(/\.local\.?$/, "").replace(/\.$/, "")).filter(Boolean);
	if (list.length > 16) throw new Error('"services" takes 16 service types at most');
	for (const s of list) if (!SERVICE.test(s)) throw new Error(`"${s}" is not a service type. One looks like _airplay._tcp, _ipp._tcp (printers), _googlecast._tcp, _hap._tcp (HomeKit), _smb._tcp`);
	return [...new Set(list)];
}

export const type: SourceType = {
	summary: "who is on your owner's own network: reports when a device joins it and when it has left. For a phone coming home, a TV or printer switched on",
	options: Type.Object(
		{
			hosts: Type.Optional(Type.Record(Type.String(), Type.String(), { description: 'the devices to look for, as name and address on the network: {"phone": "192.168.1.23", "tv": "tv.local"}. An IP address the router always gives that device, or the device\'s .local name' })),
			services: Type.Optional(Type.Array(Type.String(), { description: 'kinds of device that announce themselves on the network (Bonjour), by service type: ["_airplay._tcp", "_ipp._tcp", "_googlecast._tcp"]. Each device of that kind is reported by name' })),
			every: Type.Optional(Type.String({ description: 'how often to look, e.g. "30s", "2m". Default "30s", at least "10s"' })),
			away: Type.Optional(Type.String({ description: 'how long a device must have been silent before it counts as gone. Default "10m": a phone that sleeps answers only now and then' })),
		},
		{ additionalProperties: false },
	),
	plan(o) {
		const hosts = hostsOf(o.hosts);
		const services = servicesOf(o.services);
		if (!hosts.length && !services.length) throw new Error('needs "hosts" (devices by address: {"phone": "192.168.1.23"}) or "services" (kinds of device: ["_airplay._tcp"]), or both');
		const every = o.every ?? "30s";
		if (parseDuration(every) < MIN) throw new Error('"every" must be at least "10s"');
		const away = o.away ?? "10m";
		if (parseDuration(away) < parseDuration(every)) throw new Error('"away" must not be shorter than "every": a device is gone when it was silent for that long');
		return {
			options: { ...(hosts.length ? { hosts: Object.fromEntries(hosts.map((h) => [h.name, h.address])) } : {}), ...(services.length ? { services } : {}), ...(o.every ? { every: o.every } : {}), ...(o.away ? { away: o.away } : {}) },
			does: [
				...(hosts.length ? [`look every ${every} whether ${hosts.map((h) => `${h.name} (${h.address})`).join(", ")} ${hosts.length === 1 ? "is" : "are"} on your network, with one ping each`] : []),
				...(services.length ? [`ask your network every ${every} which devices offer ${services.join(", ")}`] : []),
				`report a device when it joins, and when it has not answered for ${away}`,
			],
			opens: true,
			tell: "Who is there now is the starting point and is not reported; from then on an arrival and a departure are. The sources tool shows how many are there.",
		};
	},
};

export default async function presence(source: SourceApi): Promise<void> {
	const o = source.options;
	const hosts = hostsOf(o.hosts);
	const services = servicesOf(o.services);
	if (!hosts.length && !services.length) throw new Error('needs "hosts" or "services"');
	const awayMs = parseDuration(o.away ?? "10m");
	const track = tracker(awayMs, source.kv.get<Record<string, Known>>("state") ?? {});
	const text = (s: string, n: number) => clip(s.replace(/[\u0000-\u001f\u007f-\u009f]+/g, " ").trim(), n);
	const report = (c: Change | undefined) => c && source.emit(c.event, c.payload);

	// ---- devices that announce themselves --------------------------------------------------------
	/** What was heard since the last look: by its full name, when, and what it is. */
	const heard = new Map<string, { at: number; name: string; service: string; address?: string }>();
	/** What the system's browser says is there right now, with the network interfaces it is seen on. */
	const held = new Map<string, { name: string; service: string; ifaces: Set<string> }>();
	let sock: dgram.Socket | undefined;
	/** On the port every device talks on, where all of it is heard; or, if that port cannot be shared, on one of its own, with answers asked for by name. */
	let shared = false;
	/** The system refused to send the question to the network. */
	let blocked = false;
	const browsing = services.length > 0 && process.platform === "darwin" && fs.existsSync(DNSSD);
	const hear = (msg: Buffer, from: dgram.RemoteInfo) => {
		// These announcements do not cross a router: one from elsewhere is not one.
		if (!isPrivateAddress(from.address)) return;
		const { response, records } = dnsRead(msg);
		if (!response) return;
		for (const r of records) {
			if (r.type !== 12 || !r.ptr?.length) continue;
			const service = services.find((s) => r.name.join(".").toLowerCase() === `${s}.local`);
			if (!service) continue;
			const key = `service:${r.ptr.join(".").toLowerCase().slice(0, 300)}`;
			if (r.ttl === 0) {
				heard.delete(key);
				report(track.gone(key));
				continue;
			}
			if (heard.size >= 500 && !heard.has(key)) continue;
			const srv = records.find((x) => x.srv && x.name.join(".").toLowerCase() === r.ptr!.join(".").toLowerCase())?.srv;
			const address = (srv && records.find((x) => x.address && net.isIPv4(x.address) && x.name.join(".").toLowerCase() === srv.target.join(".").toLowerCase())?.address) || from.address;
			heard.set(key, { at: Date.now(), name: text(r.ptr[0], 100), service, address });
		}
	};
	if (browsing) {
		// One browser per kind, each started by its path with the service type (checked to be one) as its argument.
		let stopped = false;
		const children = new Set<ChildProcess>();
		const timers = new Set<NodeJS.Timeout>();
		const browse = (service: string, wait: number) => {
			if (stopped) return;
			const child = spawn(DNSSD, ["-B", service, "local."], { stdio: ["ignore", "pipe", "ignore"] });
			children.add(child);
			let rest = "";
			child.stdout!.on("data", (d: Buffer) => {
				rest += d.toString("utf8");
				const all = rest.split("\n");
				rest = (all.pop() ?? "").slice(-2000);
				for (const line of all) {
					const b = browseLine(line);
					if (!b || b.service !== service) continue;
					const key = `service:${`${b.name}.${service}.local`.toLowerCase().slice(0, 300)}`;
					const h = held.get(key);
					if (b.add) {
						if (h) h.ifaces.add(b.iface);
						else if (held.size < 500) held.set(key, { name: text(b.name, 100), service, ifaces: new Set([b.iface]) });
					} else if (h) {
						h.ifaces.delete(b.iface);
						if (h.ifaces.size) continue;
						// Gone from every interface it was seen on: the system knows it left.
						held.delete(key);
						report(track.gone(key));
					}
				}
			});
			child.on("error", () => {});
			child.on("close", () => {
				children.delete(child);
				for (const [key, h] of held) if (h.service === service) held.delete(key);
				if (stopped) return;
				const t = setTimeout(() => (timers.delete(t), browse(service, Math.min(wait * 2, 60_000))), wait);
				t.unref?.();
				timers.add(t);
			});
		};
		for (const s of services) browse(s, 2000);
		source.onStop(() => {
			stopped = true;
			for (const t of timers) clearTimeout(t);
			for (const c of children) c.kill("SIGKILL");
		});
	} else if (services.length) {
		sock = await new Promise<dgram.Socket>((resolve) => {
			const own = () => {
				const s = dgram.createSocket("udp4");
				s.bind(0, () => resolve(s));
			};
			const s = dgram.createSocket({ type: "udp4", reuseAddr: true });
			s.once("error", () => {
				s.close();
				own();
			});
			s.bind(MDNS, () => {
				try {
					s.addMembership(GROUP);
					s.removeAllListeners("error");
					shared = true;
					resolve(s);
				} catch {
					s.close();
					own();
				}
			});
		});
		sock.on("error", (e: NodeJS.ErrnoException) => void (blocked ||= ["EHOSTUNREACH", "ENETUNREACH", "EPERM", "EACCES"].includes(e.code ?? "")));
		sock.on("message", hear);
		sock.unref();
		source.onStop(() => void sock?.close());
	}

	let before = Date.now();
	source.poll(o.every ?? "30s", async (signal) => {
		const began = Date.now();
		// The first look of all is where things stand.
		const quiet = !source.kv.get("began");
		const found = await Promise.all(
			hosts.map(async (h) => {
				let ip = h.address;
				if (!net.isIP(ip)) {
					try {
						ip = (await dns.promises.lookup(ip, { family: 4 })).address;
					} catch {
						// A device that is off has no name on the network.
						return { h, ip: undefined, there: false };
					}
					if (!isPrivateAddress(ip)) throw new Error(`${h.name}: that name leads to an address that is not on your own network`);
				}
				return { h, ip, there: await (standIn.answers ?? answers)(ip) };
			}),
		);
		if (sock) {
			blocked = false;
			const ask = dnsQuery(services.map((s) => `${s}.local`), !shared);
			await new Promise<void>((resolve) => sock!.send(ask, MDNS, GROUP, (e) => (e && (blocked = true), resolve())));
		}
		// The system's browser says what there is as soon as it runs; the first look gives it a moment to.
		if (sock || (browsing && quiet)) {
			await new Promise<void>((resolve) => {
				const t = setTimeout(resolve, timing.listenMs);
				signal.addEventListener("abort", () => (clearTimeout(t), resolve()), { once: true });
			});
		}
		if (signal.aborted) return;
		// Nobody answers and this computer has no network: that says nothing about who is at home.
		if (hosts.length && !found.some((f) => f.there) && !onNetwork()) throw new Error("this computer is not on a local network right now");
		const now = Date.now();
		for (const f of found) report(track.sight(`host:${f.h.name}`, f.there, now, quiet || !track.state[`host:${f.h.name}`], { name: f.h.name, address: f.ip ?? (net.isIP(f.h.address) ? f.h.address : undefined) }));
		// Asked, and the question never left this computer: who is there is not known, which is not the same as nobody.
		const deaf = Boolean(sock) && blocked && ![...heard.values()].some((h) => h.at >= began);
		if (services.length && !deaf) {
			for (const key of new Set([...held.keys(), ...heard.keys(), ...Object.keys(track.state).filter((k) => k.startsWith("service:"))])) {
				const h = heard.get(key);
				const b = held.get(key);
				const k = track.state[key];
				// Held by the system's browser, or heard since the look before this one began: an announcement between two looks counts.
				report(track.sight(key, Boolean(b || (h && h.at >= before)), now, quiet, b ? { name: b.name, service: b.service } : h ? { name: h.name, service: h.service, address: h.address } : { name: k.name, service: k.service, address: k.address }));
			}
			for (const [key, h] of heard) if (h.at < began) heard.delete(key);
			// Devices of a kind come and go; the ones that left long ago are forgotten, the oldest first.
			const gone = Object.entries(track.state).filter(([k, v]) => k.startsWith("service:") && !v.there).sort((a, b) => (a[1].last ?? 0) - (b[1].last ?? 0));
			for (const [k] of gone.slice(0, Math.max(0, Object.keys(track.state).length - 200))) delete track.state[k];
		}
		before = began;
		source.kv.set("state", track.state);
		// Where things stand is only known once the network could be asked.
		if (quiet && !deaf) source.kv.set("began", true);
		const there = hosts.filter((h) => track.state[`host:${h.name}`]?.there).length;
		const offered = Object.entries(track.state).filter(([k, v]) => k.startsWith("service:") && v.there).length;
		source.status([hosts.length ? `${there} of ${hosts.length} there` : "", services.length ? `${offered} announced on the network` : ""].filter(Boolean).join(", "));
		if (deaf) throw new Error("the question who offers a service could not be sent to the network: this computer does not let pine onto it");
	});
}
