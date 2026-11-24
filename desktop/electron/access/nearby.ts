// Being found on the local network (ADR 0005): while browser access and "Visible on this network"
// are on, the app announces this computer with Bonjour (mDNS, DNS-SD), so that the Pine app on a phone
// lists it and can ask to pair without a code. The record says only "this machine id waits at this
// meeting service": no name of the computer's, no address to connect to. There is no server behind it:
// the phone still joins the machine's meeting room through the service, as with a pairing link, and
// checks the host key against the machine id. So an announcement proves nothing, and the four
// digits shown on both screens are what the owner compares.
//
// Pure JavaScript (`bonjour-service`), one code for macOS, Windows and Linux. No Electron here, so
// that a test hands in a stand-in for the library.
import { Bonjour } from "bonjour-service";
import type { Announcement } from "./control.ts";

/** The service type: `_pine._tcp`. */
export const NEARBY_TYPE = "pine";
/**
 * The instance name: "Pine" and the start of the machine id, never the computer's own name. The id's
 * start keeps two computers on one network apart: the library does not rename a name already in use,
 * it gives up announcing.
 */
export const nearbyName = (id: string) => `Pine ${id.slice(0, 8)}`;
/**
 * The port the record names. Nothing listens there and nothing connects to it: DNS-SD requires a port,
 * and 9 is the "discard" port, which says as much. A phone reads the TXT record and nothing else.
 */
export const NEARBY_PORT = 9;
/** The version of what the record says, so that a phone can skip a record it would misread. */
export const NEARBY_VERSION = "1";

/**
 * The TXT record of an announcement: the version, the machine id, the meeting service's origin, and
 * the nonce a codeless request has to name (heard on this network only, and changed every few minutes).
 */
export const txtOf = (what: Announcement): Record<string, string> => ({ v: NEARBY_VERSION, id: what.id, service: what.service, nonce: what.nonce });

/** A DNS record as the library builds it; `flush` is mDNS's cache-flush bit. */
export interface MdnsRecord {
	name: string;
	type: string;
	ttl: number;
	data: unknown;
	flush?: boolean;
}

/** A service the library published: its records, and its withdrawal, which sends them again with a TTL of 0 (a goodbye). */
export interface MdnsService {
	records(): MdnsRecord[];
	stop(callback?: () => void): void;
}

/** What the announcer needs of the library: publish one service, and end everything. */
export interface Mdns {
	publish(config: { name: string; type: string; port: number; protocol: "tcp"; txt: Record<string, string>; disableIPv6?: boolean }): MdnsService;
	destroy(callback?: () => void): void;
}

/**
 * The records with mDNS's cache-flush bit on the ones that belong to this computer alone (the
 * service's SRV and TXT, its addresses): a device that hears them drops what it cached under the
 * same name, so a new nonce replaces the old one instead of standing beside it. The PTR records are
 * shared by every computer that announces the type, and never carry it (RFC 6762, 10.2).
 */
export const flushed = (records: MdnsRecord[]): MdnsRecord[] => records.map((r) => (r.type === "PTR" ? r : { ...r, flush: true }));

/**
 * Announces what it is told, and stops with none. A new announcement (a new nonce) first withdraws the
 * one before with a goodbye, then publishes, with the cache-flush bit, so that only the current TXT
 * record is served and cached. A socket the library cannot open (port 5353 held by another program, a
 * firewall) is no failure of the app's: the code and the link pair without it. The library (and its
 * multicast socket) exists only while something is announced: nothing listens on port 5353 while
 * visibility is off.
 */
export function createAnnouncer(make: () => Mdns = () => new Bonjour({}, () => {}) as unknown as Mdns): { announce(what: Announcement | undefined): void; stop(): void } {
	let mdns: Mdns | undefined;
	let current: MdnsService | undefined;
	/** One change after the other: a goodbye is sent before the next record. */
	let queue: Promise<void> = Promise.resolve();
	const later = (work: () => Promise<void>) => void (queue = queue.then(work).catch(() => {}));
	const withdraw = () =>
		new Promise<void>((resolve) => {
			const was = current;
			current = undefined;
			if (!was) return resolve();
			try {
				was.stop(() => resolve());
			} catch {
				resolve();
			}
		});
	const end = async () => {
		await withdraw();
		const was = mdns;
		mdns = undefined;
		try {
			was?.destroy();
		} catch {
			// a socket that is already gone
		}
	};
	return {
		announce(what) {
			later(async () => {
				if (!what) return end();
				await withdraw();
				mdns ??= make();
				// Probed every time (the default), which also makes the library announce later, after the
				// records below carry the cache-flush bit: without a probe it announces inside publish().
				const service = mdns.publish({ name: nearbyName(what.id), type: NEARBY_TYPE, port: NEARBY_PORT, protocol: "tcp", txt: txtOf(what) });
				const records = service.records.bind(service);
				service.records = () => flushed(records());
				current = service;
			});
		},
		stop: () => later(end),
	};
}

/**
 * Whether an address the system handed the app is `pine://pair`, the web client's "Open Pine on this
 * computer": exactly that, with or without a slash. Anything else under `pine:` (the mobile app's
 * `pine://pair?service=...` among them) is not the desktop app's, and is ignored.
 */
export function isPairAddress(url: string): boolean {
	return /^pine:\/\/pair\/?$/i.test(url.trim());
}
