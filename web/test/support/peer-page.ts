// The peer test's page: the real web bridge with the real SSH core and the real peer transport,
// as bridge-main.ts wires them, on a store in memory. It counts what the transport makes (peer
// connections, their channels and the servers they were given), and hands the tests `start`.
import type { ServiceState } from "../../../desktop/src/bridge.ts";
import { webBridge, type Store } from "../../src/host.ts";
import { takePairLink } from "../../src/pairing.ts";
import { channelTransport, peerStream } from "../../src/peer.ts";
import { connect, relayStream } from "../../src/ssh.ts";

/** What the transport made in this document. */
const made = { connections: 0, ice: [] as RTCIceServer[][], labels: [] as string[], opened: 0, sends: 0, largest: 0, buffered: 0 };
// Every piece a data channel is handed: how large it was, and how much waited in the channel then.
const send = RTCDataChannel.prototype.send;
RTCDataChannel.prototype.send = function (this: RTCDataChannel, data: any) {
	made.sends++;
	made.largest = Math.max(made.largest, data.byteLength ?? data.length ?? 0);
	made.buffered = Math.max(made.buffered, this.bufferedAmount);
	return send.call(this, data);
};
const Real = RTCPeerConnection;
globalThis.RTCPeerConnection = class extends Real {
	constructor(config?: RTCConfiguration) {
		super(config);
		made.connections++;
		made.ice.push(config?.iceServers ?? []);
	}
	override createDataChannel(label: string, init?: RTCDataChannelInit) {
		made.labels.push(label);
		return super.createDataChannel(label, init);
	}
} as typeof RTCPeerConnection;

function memoryStore(): Store {
	const kept = new Map<string, unknown>();
	return { get: async (name) => kept.get(name), set: async (name, value) => void kept.set(name, value) };
}

const config = async () => (await fetch(new URL("meet/config", location.href))).json();

/** A bridge on a store of its own; with `link`, the address of a pairing link it was opened with. */
function start(link?: string) {
	const states: ServiceState[] = [];
	const address = new URL(link ?? location.href);
	const { link: pairLink } = takePairLink(address, () => {});
	const bridge = webBridge({
		connect,
		store: memoryStore(),
		relay: (host, port) => relayStream(`ws://127.0.0.1:1/ssh?host=${host}&port=${port}`),
		peer: (id) => {
			const open = peerStream(id, { service: location.href, config, openMs: 5000 });
			return async () => {
				const transport = await open();
				made.opened++;
				return transport;
			};
		},
		pairLink,
		userAgent: navigator.userAgent,
		config,
		clipboard: async () => {},
		version: "test",
		wait: () => new Promise((r) => setTimeout(r, 50)),
		serviceMs: 5000,
	});
	bridge.on("service", (s) => states.push(s as ServiceState));
	return { bridge, states };
}

/** Waits until `check` holds, a little at a time. */
async function until<T>(check: () => T | undefined | false, what: string, ms = 15_000): Promise<T> {
	const end = Date.now() + ms;
	for (;;) {
		const value = check();
		if (value) return value;
		if (Date.now() > end) throw new Error(`never: ${what}`);
		await new Promise((r) => setTimeout(r, 20));
	}
}

/**
 * Two peer connections of this page joined by hand, and the transport over the offering side's
 * channel: what one write of `size` bytes does to the channel, and whether the other side got it whole.
 */
async function loopback(size: number) {
	const a = new Real();
	const b = new Real();
	a.onicecandidate = (e) => e.candidate && void b.addIceCandidate(e.candidate);
	b.onicecandidate = (e) => e.candidate && void a.addIceCandidate(e.candidate);
	const dc = a.createDataChannel("ssh");
	dc.binaryType = "arraybuffer";
	const far = new Promise<RTCDataChannel>((resolve) => (b.ondatachannel = (e) => resolve(e.channel)));
	await a.setLocalDescription(await a.createOffer());
	await b.setRemoteDescription(a.localDescription!);
	await b.setLocalDescription(await b.createAnswer());
	await a.setRemoteDescription(b.localDescription!);
	await new Promise((resolve) => (dc.onopen = resolve));
	const other = await far;
	other.binaryType = "arraybuffer";
	let got = 0;
	let ok = true;
	const whole = new Promise<void>((resolve) => {
		other.onmessage = (e) => {
			const bytes = new Uint8Array(e.data as ArrayBuffer);
			for (let i = 0; i < bytes.length; i++) if (bytes[i] !== (got + i) % 251) ok = false;
			got += bytes.length;
			if (got >= size) resolve();
		};
	});
	const transport = channelTransport(a, dc);
	const bytes = new Uint8Array(size).map((_, i) => i % 251);
	const before = { sends: made.sends, largest: made.largest, buffered: made.buffered };
	made.largest = made.buffered = 0;
	await transport.write(bytes);
	await whole;
	const seen = { pieces: made.sends - before.sends, largest: made.largest, buffered: made.buffered, got, ok };
	made.largest = Math.max(made.largest, before.largest);
	made.buffered = Math.max(made.buffered, before.buffered);
	transport.close();
	b.close();
	return seen;
}

/** Why the way to `id` could not be opened: the name and reason of what the opener threw, and how long it took. */
async function refusal(id: string, openMs: number) {
	const began = Date.now();
	try {
		const transport = await peerStream(id, { service: location.href, config, openMs })();
		transport.close();
		return { opened: true };
	} catch (error) {
		return { name: (error as Error).name, reason: (error as { reason?: string }).reason, ms: Date.now() - began };
	}
}

Object.assign(globalThis, { start, made, until, loopback, refusal });
