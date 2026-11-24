package pine.mobile.core

import tel.schich.libdatachannel.DataChannelCallback
import tel.schich.libdatachannel.LibDataChannelArchDetect
import tel.schich.libdatachannel.PeerConnection
import tel.schich.libdatachannel.PeerConnectionConfiguration
import tel.schich.libdatachannel.PeerState
import tel.schich.libdatachannel.SessionDescriptionType
import java.net.URI
import java.nio.ByteBuffer
import java.util.concurrent.atomic.AtomicBoolean

/**
 * The core's WebRTC (WebRtc.kt) on libdatachannel, through tel.schich's binding, for the tests on
 * the JVM: the library the Pine app's access host runs on, so that the meeting, the channel as SSH's
 * stream, pairing and reconnection are proven against the real access host without a device. The app
 * carries libwebrtc instead (mobile/android, LibWebRtc.kt), proven on the emulator.
 *
 * The binding's libdatachannel (0.24.1) loses the connection when the Pine app's (node-datachannel on
 * 0.24.6) sends more than about a megabyte at once: ICE goes to failed at once, with nothing logged (a
 * 2 MiB answer under sshj's own window of 2 MiB fails; JVM to JVM, and the way up, are fine). Its SSH
 * window is therefore half a megabyte, under which 4 MiB answers cross. That is this library's fault
 * and this library's window: the app's libwebrtc keeps sshj's own.
 */
object LibDataChannelRtc : WebRtc {
	init {
		// On the JVM the native library is picked by the system and processor.
		LibDataChannelArchDetect.initialize()
	}

	override val sshWindow: Long = 512L * 1024

	override fun offer(ice: List<URI>, label: String, events: PeerEvents): PeerChannel {
		val pc = PeerConnection.createPeer(PeerConnectionConfiguration.DEFAULT.withIceServers(ice))
		val ended = AtomicBoolean()
		val end = { if (ended.compareAndSet(false, true)) events.ended() }
		pc.onLocalDescription.register { _, sdp, type -> events.description(type.name.lowercase(), sdp) }
		pc.onLocalCandidate.register { _, candidate, mid -> events.candidate(candidate.removePrefix("a="), mid) }
		pc.onStateChange.register { _, state -> if (state == PeerState.RTC_FAILED || state == PeerState.RTC_CLOSED) end() }
		// The channel makes the offer (libdatachannel negotiates by itself).
		val dc = pc.createDataChannel(label)
		dc.bufferedAmountLowThreshold(LOW)
		dc.onOpen.register { events.open() }
		dc.onMessage.register(DataChannelCallback.Message.handleBinary { _, buffer -> events.message(ByteArray(buffer.remaining()).also { buffer.get(it) }) })
		dc.onBufferedAmountLow.register { events.drained() }
		dc.onClosed.register { end() }
		dc.onError.register { _, _ -> end() }
		return object : PeerChannel {
			override fun answer(sdp: String) {
				pc.setRemoteDescription(sdp, SessionDescriptionType.ANSWER)
			}

			override fun candidate(candidate: String, mid: String) {
				pc.addRemoteCandidate(candidate, mid)
			}

			// The binding sends only a direct buffer: it hands the native side its address.
			override fun send(bytes: ByteArray, offset: Int, length: Int) {
				dc.sendMessage(ByteBuffer.allocateDirect(length).put(bytes, offset, length).flip())
			}

			override fun buffered(): Long = dc.bufferedAmount().toLong()

			override fun close() {
				runCatching { dc.close() }
				runCatching { pc.close() }
			}
		}
	}
}
