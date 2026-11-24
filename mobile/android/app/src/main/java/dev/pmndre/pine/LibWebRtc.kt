// The core's WebRTC (pine.mobile.core.WebRtc) on Google's libwebrtc, LiveKit's build without video
// codecs (io.github.webrtc-sdk:android-prefixed-stripped, its classes under livekit.org.webrtc): a
// peer connection with one data channel, and nothing else of the library is used. No track, no
// capturer, no audio is ever made, so nothing asks for the camera or the microphone. The meeting,
// the signals and the channel as SSH's stream are the core's (Peer.kt), which its tests prove on
// libdatachannel; this file is proven on the emulator (androidTest/.../LibWebRtcTest.kt, run by
// `npm run smoke -- --transport-only` in mobile/).
package dev.pmndre.pine

import android.content.Context
import livekit.org.webrtc.DataChannel
import livekit.org.webrtc.IceCandidate
import livekit.org.webrtc.MediaConstraints
import livekit.org.webrtc.MediaStream
import livekit.org.webrtc.PeerConnection
import livekit.org.webrtc.PeerConnectionFactory
import livekit.org.webrtc.RtpReceiver
import livekit.org.webrtc.SdpObserver
import livekit.org.webrtc.SessionDescription
import pine.mobile.core.LOW
import pine.mobile.core.PeerChannel
import pine.mobile.core.PeerEvents
import pine.mobile.core.WebRtc
import java.net.URI
import java.nio.Buffer
import java.nio.ByteBuffer
import java.util.concurrent.atomic.AtomicBoolean

class LibWebRtc(context: Context) : WebRtc {
	private val app = context.applicationContext

	// Made when first needed, on the thread that connects: loading the library and starting its threads
	// takes a moment, and an app that never reaches a paired computer never pays for it.
	private val factory: PeerConnectionFactory by lazy {
		PeerConnectionFactory.initialize(PeerConnectionFactory.InitializationOptions.builder(app).createInitializationOptions())
		PeerConnectionFactory.builder().createPeerConnectionFactory()
	}

	// libwebrtc takes the Pine app's bursts of several megabytes: sshj keeps its own window (null).

	override fun offer(ice: List<URI>, label: String, events: PeerEvents): PeerChannel {
		val config = PeerConnection.RTCConfiguration(ice.map(::server)).apply {
			sdpSemantics = PeerConnection.SdpSemantics.UNIFIED_PLAN
			continualGatheringPolicy = PeerConnection.ContinualGatheringPolicy.GATHER_ONCE
		}
		val ended = AtomicBoolean()
		val end = { if (ended.compareAndSet(false, true)) events.ended() }
		val pc = factory.createPeerConnection(config, object : PeerConnection.Observer {
			override fun onIceCandidate(candidate: IceCandidate) = events.candidate(candidate.sdp.removePrefix("a="), candidate.sdpMid ?: "0")

			override fun onConnectionChange(state: PeerConnection.PeerConnectionState) {
				if (state == PeerConnection.PeerConnectionState.FAILED || state == PeerConnection.PeerConnectionState.CLOSED) end()
			}

			override fun onIceConnectionChange(state: PeerConnection.IceConnectionState) {
				if (state == PeerConnection.IceConnectionState.FAILED) end()
			}

			override fun onSignalingChange(state: PeerConnection.SignalingState) = Unit
			override fun onIceConnectionReceivingChange(receiving: Boolean) = Unit
			override fun onIceGatheringChange(state: PeerConnection.IceGatheringState) = Unit
			override fun onIceCandidatesRemoved(candidates: Array<out IceCandidate>) = Unit
			override fun onAddStream(stream: MediaStream) = Unit
			override fun onRemoveStream(stream: MediaStream) = Unit
			// The computer opens no channel of its own: one that came would be closed with the connection.
			override fun onDataChannel(channel: DataChannel) = Unit
			override fun onRenegotiationNeeded() = Unit
			override fun onAddTrack(receiver: RtpReceiver, streams: Array<out MediaStream>) = Unit
		}) ?: throw IllegalStateException("libwebrtc made no peer connection.")

		val dc = pc.createDataChannel(label, DataChannel.Init().apply { ordered = true })
		dc.registerObserver(object : DataChannel.Observer {
			override fun onStateChange() {
				when (dc.state()) {
					DataChannel.State.OPEN -> events.open()
					DataChannel.State.CLOSING, DataChannel.State.CLOSED -> end()
					else -> Unit
				}
			}

			// The buffer is the library's, valid only during this call: copied out.
			override fun onMessage(buffer: DataChannel.Buffer) {
				if (!buffer.binary) return
				events.message(ByteArray(buffer.data.remaining()).also { buffer.data.get(it) })
			}

			// libwebrtc tells every change of the amount; the core waits for it to fall to LOW.
			override fun onBufferedAmountChange(previous: Long) {
				if (previous > LOW && dc.bufferedAmount() <= LOW) events.drained()
			}
		})

		// The offer: made, set as the phone's own, then told (with its candidates trickled after it).
		pc.createOffer(object : Sdp() {
			override fun onCreateSuccess(description: SessionDescription) {
				pc.setLocalDescription(object : Sdp() {
					override fun onSetSuccess() = events.description("offer", description.description)
				}, description)
			}
		}, MediaConstraints())

		return object : PeerChannel {
			override fun answer(sdp: String) = pc.setRemoteDescription(Sdp(), SessionDescription(SessionDescription.Type.ANSWER, sdp))

			override fun candidate(candidate: String, mid: String) {
				pc.addIceCandidate(IceCandidate(mid, 0, candidate))
			}

			override fun send(bytes: ByteArray, offset: Int, length: Int) {
				val piece = ByteBuffer.allocateDirect(length).put(bytes, offset, length)
				// Through Buffer: ByteBuffer's own flip() is Java 9's, which older Androids do not have.
				(piece as Buffer).flip()
				if (!dc.send(DataChannel.Buffer(piece, true))) throw IllegalStateException("The data channel took nothing.")
			}

			override fun buffered(): Long = dc.bufferedAmount()

			override fun close() {
				runCatching { dc.unregisterObserver() }
				runCatching { dc.close() }
				runCatching { pc.close() }
				end()
				runCatching { dc.dispose() }
				runCatching { pc.dispose() }
			}
		}
	}

	/** An ICE server: a STUN or TURN address, with the name and password a TURN address may carry. */
	private fun server(uri: URI): PeerConnection.IceServer {
		val info = uri.rawUserInfo
		if (info == null) return PeerConnection.IceServer.builder(uri.toString()).createIceServer()
		val (user, password) = info.split(":", limit = 2).let { it[0] to it.getOrElse(1) { "" } }
		val plain = URI(uri.scheme, uri.rawSchemeSpecificPart.substringAfter("@"), null).toString()
		return PeerConnection.IceServer.builder(plain).setUsername(user).setPassword(password).createIceServer()
	}

	/** An SDP observer that does nothing: what is not overridden only fails quietly, as the time limit then decides. */
	private open class Sdp : SdpObserver {
		override fun onCreateSuccess(description: SessionDescription) = Unit
		override fun onSetSuccess() = Unit
		override fun onCreateFailure(error: String?) = Unit
		override fun onSetFailure(error: String?) = Unit
	}
}
