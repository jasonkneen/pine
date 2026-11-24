// The way to a paired computer: the web bridge's second stream opener (ssh.ts `OpenStream`). It
// joins the meeting service under the computer's machine id, makes a WebRTC peer connection in this, the
// top-level document (never in the page's iframe), and hands SSH the data channel labelled `ssh`
// as its byte stream. The meeting service only passes the few messages that set the connection up;
// what crosses the channel is SSH, end to end, checked against the machine id's host key.
import { PeerClosed, type OpenStream, type Transport } from "./ssh.ts";

/** The channel the browser makes and the paired computer takes. */
export const LABEL = "ssh";
/** Writes are cut to this: the size every data channel carries without trouble. */
export const PIECE = 16 * 1024;
/** A writer waits while more than this waits in the channel, and goes on once it fell to `LOW`. */
export const HIGH = 1024 * 1024;
const LOW = 256 * 1024;

/** The meeting's close codes (relay/src/meet.ts `CLOSE`) that say why a meeting ended. */
const ABSENT = 4404;
const TIMEOUT = 4408;
const LIMITS = 4429;

export type PeerOptions = {
	/** An address of the deployment: the meeting service answers at `meet/join` beside it. */
	service: string;
	/** Reads the deployment's configuration (`GET /meet/config`: `{ice, relay}`), whose `ice` are the servers that help a connection. */
	config(): Promise<unknown>;
	/** How long the paired computer has to be reached, from the join to the open channel; none: 20 seconds. */
	openMs?: number;
};

/** The servers that help a connection, as the configuration names them; anything that is not a STUN or TURN address is left out. */
export function iceOf(config: unknown): RTCIceServer[] {
	const ice = config && typeof config === "object" ? (config as { ice?: unknown }).ice : undefined;
	if (!Array.isArray(ice)) return [];
	const url = (u: unknown) => typeof u === "string" && /^(stun|stuns|turn|turns):[^\s]+$/.test(u);
	return ice.filter((s) => s && typeof s === "object" && (url(s.urls) || (Array.isArray(s.urls) && s.urls.length > 0 && s.urls.every(url)))).map((s) => ({ urls: s.urls }));
}

/** A meeting that ended before the channel opened, in the bridge's terms. */
function whyClosed(code: number): PeerClosed {
	if (code === ABSENT) return new PeerClosed("absent");
	if (code === LIMITS) return new PeerClosed("limits");
	if (code === TIMEOUT) return new PeerClosed("no-path");
	// The computer ended the meeting (it has as many browsers as it takes), or the service went: no way this time.
	return new PeerClosed("no-path", `The meeting ended before a connection to the computer was made (${code}).`);
}

/**
 * A data channel, open, as SSH's transport: writes cut into pieces of `PIECE` and held while more
 * than `HIGH` waits in the channel. `early`: what arrived before, kept for the listener.
 */
export function channelTransport(pc: RTCPeerConnection, dc: RTCDataChannel, early: Uint8Array[] = []): Transport {
	let listener: ((bytes: Uint8Array) => void) | undefined;
	dc.onmessage = (e) => {
		const bytes = new Uint8Array(e.data as ArrayBuffer);
		if (listener) listener(bytes);
		else early.push(bytes);
	};
	let over = false;
	let room: (() => void) | undefined;
	dc.bufferedAmountLowThreshold = LOW;
	dc.onbufferedamountlow = () => {
		const go = room;
		room = undefined;
		go?.();
	};
	let finish!: () => void;
	const ended = new Promise<Error | undefined>((resolve) => (finish = () => resolve(undefined)));
	const end = () => {
		if (over) return;
		over = true;
		room?.();
		room = undefined;
		try {
			dc.close();
			pc.close();
		} catch {}
		finish();
	};
	dc.onclose = end;
	dc.onerror = end;
	pc.addEventListener("connectionstatechange", () => (pc.connectionState === "failed" || pc.connectionState === "closed") && end());
	// One write at a time, so that the pieces of two writes never interleave while one waits for room.
	let queue = Promise.resolve();
	const send = async (bytes: Uint8Array) => {
		for (let at = 0; at < bytes.length; ) {
			if (over) throw new Error("The connection to the computer is closed.");
			if (dc.bufferedAmount > HIGH) {
				await new Promise<void>((resolve) => (room = resolve));
				continue;
			}
			const piece = bytes.subarray(at, at + PIECE);
			at += piece.length;
			dc.send(piece as Uint8Array<ArrayBuffer>);
		}
	};
	return {
		write(bytes) {
			const done = queue.then(() => send(bytes));
			queue = done.catch(() => {});
			return done;
		},
		onData(next) {
			listener = next;
			for (const bytes of early.splice(0)) next(bytes);
		},
		ended,
		close: end,
	};
}

/**
 * Opens the way to the paired computer `id`: the join socket of the meeting service, the offer and
 * the `ssh` channel, the computer's answer. Throws `PeerClosed` when no computer waits ("absent"), when the meeting
 * service is over its limits ("limits"), or when no connection was made in time ("no-path"). Once the
 * channel is open the join socket is closed: the meeting has done its part.
 */
export function peerStream(id: string, options: PeerOptions): OpenStream {
	return async () => {
		const ice = iceOf(await options.config().catch(() => undefined));
		const url = new URL(`meet/join?id=${encodeURIComponent(id)}`, options.service);
		url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
		const ms = options.openMs ?? 20_000;
		return new Promise<Transport>((resolve, reject) => {
			const socket = new WebSocket(url);
			let pc: RTCPeerConnection | undefined;
			let settled = false;
			const fail = (error: Error) => {
				if (settled) return;
				settled = true;
				clearTimeout(timer);
				socket.close();
				pc?.close();
				reject(error);
			};
			const timer = setTimeout(() => fail(new PeerClosed("no-path")), ms);
			const signal = (d: unknown) => socket.readyState === WebSocket.OPEN && socket.send(JSON.stringify({ t: "signal", d }));
			// The computer's candidates may come before its answer is set: they wait for it.
			const pending: RTCIceCandidateInit[] = [];
			let answered = false;
			socket.onerror = () => {};
			socket.onclose = (e) => {
				if (settled) return;
				// A socket that never opened: the service could not be reached, or refused it outright.
				if (e.code === 1006 && !pc) return fail(new Error("The meeting service could not be reached. Check the network, then try again."));
				fail(whyClosed(e.code));
			};
			socket.onmessage = async (e) => {
				let message: { t?: unknown; d?: any };
				try {
					message = JSON.parse(String(e.data));
				} catch {
					return;
				}
				if (message.t === "ready" && !pc) {
					const peer = (pc = new RTCPeerConnection({ iceServers: ice }));
					peer.onicecandidate = (c) => c.candidate && c.candidate.candidate && signal({ ice: { candidate: c.candidate.candidate, sdpMid: c.candidate.sdpMid, sdpMLineIndex: c.candidate.sdpMLineIndex } });
					peer.onconnectionstatechange = () => peer.connectionState === "failed" && fail(new PeerClosed("no-path"));
					const dc = peer.createDataChannel(LABEL, { ordered: true });
					dc.binaryType = "arraybuffer";
					// Bytes the computer sends as soon as the channel opens (SSH's banner) are kept for SSH.
					const early: Uint8Array[] = [];
					dc.onmessage = (m) => early.push(new Uint8Array(m.data as ArrayBuffer));
					dc.onopen = () => {
						if (settled) return;
						settled = true;
						clearTimeout(timer);
						socket.close(1000, "The channel is open.");
						resolve(channelTransport(peer, dc, early));
					};
					try {
						await peer.setLocalDescription(await peer.createOffer());
						signal({ sdp: { type: peer.localDescription!.type, sdp: peer.localDescription!.sdp } });
					} catch (error) {
						fail(new PeerClosed("no-path", `No connection could be offered to the computer: ${error instanceof Error ? error.message : error}`));
					}
					return;
				}
				if (message.t !== "signal" || !pc || !message.d || typeof message.d !== "object") return;
				const d = message.d;
				try {
					if (d.sdp && d.sdp.type === "answer" && typeof d.sdp.sdp === "string") {
						await pc.setRemoteDescription({ type: "answer", sdp: d.sdp.sdp });
						answered = true;
						for (const candidate of pending.splice(0)) await pc.addIceCandidate(candidate);
					} else if (d.ice && typeof d.ice.candidate === "string" && d.ice.candidate) {
						const candidate: RTCIceCandidateInit = { candidate: d.ice.candidate, sdpMid: d.ice.sdpMid ?? null, sdpMLineIndex: d.ice.sdpMLineIndex ?? null };
						if (answered) await pc.addIceCandidate(candidate);
						else pending.push(candidate);
					}
				} catch {
					// A message that does not fit this connection changes nothing: the time limit ends the attempt.
				}
			};
		});
	};
}
