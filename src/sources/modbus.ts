import net from "node:net";
import { Type } from "typebox";
import { isLocalHost, reachOptions } from "../net.ts";
import type { SourceType } from "../source-types.ts";
import type { SourceApi } from "../sources.ts";
import { errText, parseDuration } from "../util.ts";
import { harmless } from "../watching.ts";

/**
 * A Modbus TCP device, read again and again: reports the values that changed. For what speaks
 * Modbus on the network: solar inverters, batteries, heat pumps, wall boxes, energy meters.
 *
 * options: { host, read, port?, unit?, every?, local? }
 *   read   the values to read, 1 to 32: { name, address, kind?, type?, scale?, step?, words? }
 *            address  the register's number as the protocol counts it, from 0
 *            kind     "holding" (default), "input", "coil" or "discrete"
 *            type     "u16" (default), "i16", "u32", "i32" or "f32" (the last three are two registers)
 *            scale    the raw value is multiplied by it (0.1 for a value in tenths)
 *            step     how far the value must have moved since it was last reported
 *            words    "be" (default) or "le": which of the two registers of a 32-bit value comes first
 *   unit   the device's unit id (1 by default)
 *   every  how often to read ("30s" by default)
 *
 * event "changed": { name, value, previous }   one for each value that moved
 *
 * It reads and nothing else: only the four reading functions of the protocol (1 to 4) are ever
 * sent, so nothing on the device can be switched or set through it. The first look is the
 * starting point and reports nothing.
 */
const MIN = 2000;
const TIMEOUT = 5000;
const KINDS: Record<string, number> = { coil: 1, discrete: 2, holding: 3, input: 4 };
const TYPES = ["u16", "i16", "u32", "i32", "f32"];
const EXCEPTIONS: Record<number, string> = {
	1: "illegal function",
	2: "illegal data address",
	3: "illegal data value",
	4: "device failure",
	5: "acknowledge",
	6: "device busy",
	8: "memory parity error",
	10: "gateway path unavailable",
	11: "gateway target device failed to respond",
};

export interface Reading {
	name: string;
	address: number;
	kind: string;
	type: string;
	scale: number;
	step?: number;
	words: "be" | "le";
}

/** The list of values as it is used: checked one by one, defaults filled in. Throws a sentence for what cannot work. */
export function readings(raw: unknown): Reading[] {
	if (!Array.isArray(raw) || !raw.length) throw new Error('needs "read": the values to read, e.g. [{"name": "power", "address": 40083, "type": "i16"}]');
	if (raw.length > 32) throw new Error('"read" takes 32 values at most. Set up a second source for more');
	const names = new Set<string>();
	return raw.map((r: any, i) => {
		const at = `read[${i}]`;
		if (!r || typeof r !== "object") throw new Error(`${at} must be an object: {"name": "...", "address": 0}`);
		const name = String(r.name ?? "");
		if (!/^[A-Za-z][A-Za-z0-9_.-]{0,39}$/.test(name)) throw new Error(`${at}: "name" is a short word for the value: letters, digits, _ . and -, starting with a letter`);
		if (names.has(name)) throw new Error(`two values are called "${name}": give each a different name`);
		names.add(name);
		const kind = String(r.kind ?? "holding");
		if (!(kind in KINDS)) throw new Error(`${name}: "kind" is holding, input, coil or discrete`);
		const bit = kind === "coil" || kind === "discrete";
		const type = bit ? "bit" : String(r.type ?? "u16");
		if (!bit && !TYPES.includes(type)) throw new Error(`${name}: "type" is u16, i16, u32, i32 or f32`);
		const address = Number(r.address);
		const last = address + (/32/.test(type) ? 1 : 0);
		if (!Number.isInteger(address) || address < 0 || last > 65535) throw new Error(`${name}: "address" is the register's number counted from 0, up to 65535. A list that counts from 40001 or 30001 means the number minus that`);
		const scale = r.scale === undefined ? 1 : Number(r.scale);
		if (!Number.isFinite(scale) || scale === 0) throw new Error(`${name}: "scale" is a number the raw value is multiplied by, e.g. 0.1`);
		const step = r.step === undefined ? undefined : Number(r.step);
		if (step !== undefined && !(step > 0)) throw new Error(`${name}: "step" is how far the value must move to be reported, a number above 0`);
		const words = r.words === undefined ? "be" : r.words;
		if (words !== "be" && words !== "le") throw new Error(`${name}: "words" is "be" (the high word first) or "le" (the low word first)`);
		return { name, address, kind, type, scale, ...(step !== undefined && !bit ? { step } : {}), words };
	});
}

const hostOk = (host: string) => net.isIP(host) !== 0 || /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)*$/i.test(host);

export const type: SourceType = {
	summary: "a Modbus TCP device read again and again: reports the values that changed. For solar inverters, batteries, heat pumps, wall boxes, energy meters. It only reads",
	options: Type.Object(
		{
			host: Type.String({ description: "the device's address on the network, e.g. 192.168.1.60" }),
			read: Type.Array(
				Type.Object(
					{
						name: Type.String({ description: 'a short word for the value, e.g. "power"' }),
						address: Type.Number({ description: "the register's number counted from 0. A register list that counts from 40001 (holding) or 30001 (input) means the number minus that" }),
						kind: Type.Optional(Type.String({ description: '"holding" (default), "input", "coil" or "discrete"' })),
						type: Type.Optional(Type.String({ description: '"u16" (default), "i16", "u32", "i32" or "f32". The last three take two registers' })),
						scale: Type.Optional(Type.Number({ description: "the raw value is multiplied by this, e.g. 0.1 for a value given in tenths" })),
						step: Type.Optional(Type.Number({ description: "report the value only when it has moved at least this far since the last report, e.g. 100 for watts. Without it every change counts" })),
						words: Type.Optional(Type.String({ description: 'for a 32-bit value: "be" (default, the high word first) or "le" (the low word first)' })),
					},
					{ additionalProperties: false },
				),
				{ description: 'the values to read, 1 to 32, e.g. [{"name": "power", "address": 40083, "type": "i16", "step": 100}]. The device\'s Modbus register list says which register holds what' },
			),
			port: Type.Optional(Type.Number({ description: "the port. Default 502" })),
			unit: Type.Optional(Type.Number({ description: "the device's unit id (also called slave id). Default 1" })),
			every: Type.Optional(Type.String({ description: 'how often to read, e.g. "30s", "5m". Default "30s", at least "2s"' })),
			local: Type.Optional(Type.Boolean({ description: "true if the address is a name on your owner's own network that does not say so (inverter.lan). Not needed for an IP address or a .local name" })),
		},
		{ additionalProperties: false },
	),
	plan(o) {
		const host = String(o.host ?? "").trim();
		if (!hostOk(host)) throw new Error(`"${host}" is not an address. A Modbus device's looks like 192.168.1.60`);
		const port = o.port ?? 502;
		if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('"port" must be a port number. Modbus TCP uses 502');
		const unit = o.unit ?? 1;
		if (!Number.isInteger(unit) || unit < 0 || unit > 255) throw new Error('"unit" is the device\'s unit id, a number from 0 to 255');
		const every = o.every ?? "30s";
		if (parseDuration(every) < MIN) throw new Error('"every" must be at least "2s"');
		const read = readings(o.read);
		return {
			options: { ...o, host, read },
			does: [
				`connect to the Modbus device at ${host}:${port}${o.local || isLocalHost(host) ? " (an address on your own network or this computer)" : ""}, unit ${unit}, every ${every} and read ${read.length} value${read.length === 1 ? "" : "s"} (${read.map((r) => r.name).join(", ")})`,
				"report each value when it changes. It only reads: nothing on the device is switched or set",
			],
			opens: true,
			tell: "The first look is the starting point and reports nothing; from then on only a value that moved does. The sources tool shows what it read at the last look.",
		};
	},
};

/** One question and its answer on an open connection. Rejects when the answer does not come in time or the connection ends. */
function exchange(sock: net.Socket, frame: Buffer, signal: AbortSignal): Promise<Buffer> {
	return new Promise((resolve, reject) => {
		let got = Buffer.alloc(0);
		const done = (err?: Error, answer?: Buffer) => {
			clearTimeout(timer);
			sock.off("data", data).off("error", fail).off("close", closed);
			signal.removeEventListener("abort", stopped);
			if (err) reject(err);
			else resolve(answer!);
		};
		const data = (d: Buffer) => {
			got = Buffer.concat([got, d]);
			if (got.length > 300) return done(new Error("it answered with something that is not Modbus"));
			if (got.length >= 6 && got.length >= 6 + got.readUInt16BE(4)) done(undefined, got.subarray(0, 6 + got.readUInt16BE(4)));
		};
		const fail = (e: NodeJS.ErrnoException) => done(new Error(e.code === "ECONNRESET" || e.code === "EPIPE" ? "it closed the connection" : errText(e)));
		const closed = () => done(new Error("it closed the connection"));
		const stopped = () => done(new Error("stopped"));
		const timer = setTimeout(() => done(new Error(`it did not answer within ${TIMEOUT / 1000} s`)), TIMEOUT);
		// Gone between two questions: said at once, not after the time an answer may take.
		if (sock.destroyed || !sock.writable) return done(new Error("it closed the connection"));
		sock.on("data", data).on("error", fail).on("close", closed);
		signal.addEventListener("abort", stopped, { once: true });
		sock.write(frame);
	});
}

/** What the registers or bits of an answer say, as the value's type reads them. */
function decode(r: Reading, data: Buffer): number | boolean | null {
	if (r.type === "bit") return (data[0] & 1) === 1;
	if (r.type === "u16") return tidy(data.readUInt16BE(0) * r.scale);
	if (r.type === "i16") return tidy(data.readInt16BE(0) * r.scale);
	const four = r.words === "le" ? Buffer.concat([data.subarray(2, 4), data.subarray(0, 2)]) : data.subarray(0, 4);
	if (r.type === "u32") return tidy(four.readUInt32BE(0) * r.scale);
	if (r.type === "i32") return tidy(four.readInt32BE(0) * r.scale);
	const f = four.readFloatBE(0);
	// A float of 32 bits carries seven digits; the rest is noise that would look like a change.
	return Number.isFinite(f) ? tidy(Number((f * r.scale).toPrecision(7))) : null;
}

/** Without the tail a multiplication in binary leaves (0.1 * 3 is not 0.3). */
const tidy = (n: number) => Number(n.toPrecision(12));

export default function modbus(source: SourceApi): void {
	const o = source.options;
	const host = String(o.host ?? "").trim();
	if (!hostOk(host)) throw new Error(`needs "host": the device's address, e.g. 192.168.1.60`);
	const port = Number(o.port ?? 502);
	const unit = Number(o.unit ?? 1);
	const read = readings(o.read);
	let tid = 0;

	source.poll(o.every ?? "30s", async (signal) => {
		const sock = net.connect({ host, port, ...reachOptions(host, o.local === true) });
		sock.setNoDelay(true);
		const values: Array<number | boolean | null> = [];
		try {
			await new Promise<void>((resolve, reject) => {
				const timer = setTimeout(() => reject(new Error(`${host}:${port} did not take the connection within ${TIMEOUT / 1000} s`)), TIMEOUT);
				sock.once("connect", () => (clearTimeout(timer), resolve()));
				sock.once("error", (e) => (clearTimeout(timer), reject(new Error(errText(e)))));
				signal.addEventListener("abort", () => (clearTimeout(timer), reject(new Error("stopped"))), { once: true });
			});
			// An error between two questions is found by the next question, not thrown into the daemon.
			sock.on("error", () => {});
			for (const r of read) {
				const fc = KINDS[r.kind];
				const count = /32/.test(r.type) ? 2 : 1;
				tid = (tid + 1) & 0xffff;
				const frame = Buffer.alloc(12);
				frame.writeUInt16BE(tid, 0);
				frame.writeUInt16BE(6, 4);
				frame[6] = unit;
				frame[7] = fc;
				frame.writeUInt16BE(r.address, 8);
				frame.writeUInt16BE(count, 10);
				const answer = await exchange(sock, frame, signal);
				if (answer.length < 9 || answer.readUInt16BE(0) !== tid || answer.readUInt16BE(2) !== 0 || answer[6] !== unit) throw new Error(`it answered something else than what was asked for ${r.name}`);
				if (answer[7] === (fc | 0x80)) throw new Error(`the device says: ${EXCEPTIONS[answer[8]] ?? "an error"} (${answer[8]}) for ${r.name}`);
				const need = r.type === "bit" ? 1 : count * 2;
				if (answer[7] !== fc || answer[8] < need || answer.length < 9 + need) throw new Error(`it answered something else than what was asked for ${r.name}`);
				values.push(decode(r, answer.subarray(9, 9 + need)));
			}
		} finally {
			sock.destroy();
		}
		if (signal.aborted) return;
		source.status(`${read.length} value${read.length === 1 ? "" : "s"}: ${read.slice(0, 4).map((r, i) => `${r.name} ${harmless(values[i])}`).join(", ")}${read.length > 4 ? ", ..." : ""}`);
		read.forEach((r, i) => {
			const value = values[i];
			// What was last reported, not what was last read: a value that creeps is reported once it has crept a step.
			const was = source.kv.get<{ value: number | boolean | null }>(`value:${r.name}`);
			if (!was) return void source.kv.set(`value:${r.name}`, { value });
			const moved = r.step !== undefined && typeof value === "number" && typeof was.value === "number" ? Math.abs(value - was.value) >= r.step : value !== was.value;
			if (!moved) return;
			source.kv.set(`value:${r.name}`, { value });
			source.emit("changed", { name: r.name, value, previous: was.value });
		});
	});
}
