// The WebRTC library under the way to a paired computer, as small as the core needs it: a peer
// connection that gives one data channel. Everything above it (the meeting, the signals, the channel
// as SSH's byte stream, pairing, reconnection) is the core's own, in Peer.kt, and is the same whatever
// library is below. The Android app hands in Google's libwebrtc (mobile/android, LibWebRtc.kt); the
// core's tests hand in libdatachannel, the library the Pine app's access host runs on, so that what
// is above this interface is proven against the real access host on the JVM.
package pine.mobile.core

import java.net.URI

/** A WebRTC library that makes peer connections with one data channel each. */
interface WebRtc {
	/**
	 * Makes a peer connection that uses the servers `ice`, the one data channel `label` on it
	 * (ordered and reliable), and its offer: the offer, the candidates found, and what becomes of the
	 * channel are told to `events`, from the library's own threads. The returned channel takes the
	 * computer's answer and candidates, and the bytes to send.
	 */
	fun offer(ice: List<URI>, label: String, events: PeerEvents): PeerChannel

	/**
	 * What the computer may send on one SSH channel before the phone says it took it in (sshj's
	 * connection window), for a library that cannot take a larger burst at once; null keeps sshj's
	 * own (2 MiB).
	 */
	val sshWindow: Long? get() = null
}

/**
 * What a peer connection and its data channel tell, on the library's threads. A throw there may be
 * lost without a word, and the library's own calls may wait on themselves there: these only hand
 * things on.
 */
interface PeerEvents {
	/** The phone's own description is set: `type` is "offer". */
	fun description(type: String, sdp: String)

	/** A candidate of the phone's, as an SDP attribute without its "a=", for the media section `mid`. */
	fun candidate(candidate: String, mid: String)

	/** The data channel is open. */
	fun open()

	/** One binary message on the data channel, copied out of the library's buffer. */
	fun message(bytes: ByteArray)

	/** What waits in the channel to be sent fell to `LOW` or below. */
	fun drained()

	/** The channel closed or failed, or the connection did: nothing more comes. Told at most once. */
	fun ended()
}

/** The phone's side of a peer connection and its data channel. */
interface PeerChannel {
	/** The computer's answer. */
	fun answer(sdp: String)

	/** One of the computer's candidates, given after its answer. */
	fun candidate(candidate: String, mid: String)

	/** Sends one binary message of at most `PIECE` bytes; throws when the channel cannot take it. */
	fun send(bytes: ByteArray, offset: Int, length: Int)

	/** How many bytes wait in the channel to be sent. */
	fun buffered(): Long

	/** Closes the channel and the connection. Never called from one of the library's threads. */
	fun close()
}
