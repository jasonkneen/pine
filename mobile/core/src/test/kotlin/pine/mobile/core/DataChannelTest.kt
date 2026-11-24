package pine.mobile.core

import tel.schich.libdatachannel.DataChannel
import tel.schich.libdatachannel.DataChannelCallback
import tel.schich.libdatachannel.LibDataChannelArchDetect
import tel.schich.libdatachannel.PeerConnection
import tel.schich.libdatachannel.PeerConnectionConfiguration
import tel.schich.libdatachannel.SessionDescriptionType
import java.io.ByteArrayOutputStream
import java.nio.ByteBuffer
import java.util.concurrent.CompletableFuture
import java.util.concurrent.TimeUnit
import kotlin.test.Test
import kotlin.test.assertContentEquals
import kotlin.test.assertEquals

/**
 * The WebRTC library the paired path runs on (libdatachannel, through tel.schich's binding) on the
 * JVM: two peers of this computer, no STUN server, the offer and the answer handed across by hand as
 * the meeting service would carry them, one channel labelled `ssh` as the web client opens it.
 */
class DataChannelTest {
	@Test
	fun `two peers on this computer open a channel and bytes cross it both ways`() {
		// On the JVM the native library is picked by the system and processor (the Android app has its own).
		LibDataChannelArchDetect.initialize()
		val config = PeerConnectionConfiguration.DEFAULT
		PeerConnection.createPeer(config).use { offerer ->
			PeerConnection.createPeer(config).use { answerer ->
				// Signalling: descriptions and trickled candidates go straight to the other peer.
				offerer.onLocalDescription.register { _, sdp, type -> answerer.setRemoteDescription(sdp, type) }
				answerer.onLocalDescription.register { _, sdp, type ->
					assertEquals(SessionDescriptionType.ANSWER, type)
					offerer.setRemoteDescription(sdp, type)
				}
				offerer.onLocalCandidate.register { _, candidate, mid -> answerer.addRemoteCandidate(candidate, mid) }
				answerer.onLocalCandidate.register { _, candidate, mid -> offerer.addRemoteCandidate(candidate, mid) }

				val heard = ByteArrayOutputStream()
				val answeredWith = CompletableFuture<String>()
				val atAnswerer = CompletableFuture<DataChannel>()
				answerer.onDataChannel.register { _, channel ->
					channel.onMessage.register(DataChannelCallback.Message.handleBinary { ch, buffer ->
						val bytes = ByteArray(buffer.remaining()).also { buffer.get(it) }
						synchronized(heard) { heard.write(bytes) }
						ch.sendMessage(direct(bytes.reversedArray()))
					})
					atAnswerer.complete(channel)
				}

				val opened = CompletableFuture<Unit>()
				val channel = offerer.createDataChannel("ssh")
				channel.onOpen.register { opened.complete(Unit) }
				channel.onMessage.register(DataChannelCallback.Message.handleBinary { _, buffer ->
					answeredWith.complete(String(ByteArray(buffer.remaining()).also { buffer.get(it) }))
				})
				opened.get(10, TimeUnit.SECONDS)
				assertEquals("ssh", atAnswerer.get(10, TimeUnit.SECONDS).label())

				val sent = "SSH-2.0-pine".toByteArray()
				channel.sendMessage(direct(sent))
				assertEquals("enip-0.2-HSS", answeredWith.get(10, TimeUnit.SECONDS))
				assertContentEquals(sent, synchronized(heard) { heard.toByteArray() })
			}
		}
	}

	// The binding sends only a direct buffer (it hands the native side its address) and throws on any
	// other; a throw inside a callback is lost without a word, so the bytes simply never arrive.
	private fun direct(bytes: ByteArray): ByteBuffer = ByteBuffer.allocateDirect(bytes.size).put(bytes).flip()
}
