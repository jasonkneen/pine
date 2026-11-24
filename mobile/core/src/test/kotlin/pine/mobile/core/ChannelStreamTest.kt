package pine.mobile.core

import tel.schich.libdatachannel.DataChannel
import tel.schich.libdatachannel.DataChannelCallback
import tel.schich.libdatachannel.LibDataChannelArchDetect
import tel.schich.libdatachannel.PeerConnection
import tel.schich.libdatachannel.PeerConnectionConfiguration
import tel.schich.libdatachannel.SessionDescriptionType
import java.io.ByteArrayOutputStream
import java.nio.ByteBuffer
import java.security.SecureRandom
import java.util.Collections
import java.util.concurrent.CompletableFuture
import java.util.concurrent.CountDownLatch
import java.util.concurrent.Executors
import java.util.concurrent.TimeUnit
import kotlin.concurrent.thread
import kotlin.test.AfterTest
import kotlin.test.Test
import kotlin.test.assertContentEquals
import kotlin.test.assertEquals
import kotlin.test.assertTrue

// The data channel as SSH's byte stream (ChannelStream), between two peers of this computer with
// the signals handed across by hand: the phone's side is the stream, the other a bare channel that
// records what it is sent, as the computer's would.
class ChannelStreamTest {
	private val other: PeerConnection
	private val stream: ChannelStream
	private val far: DataChannel
	private val pieces = Collections.synchronizedList(mutableListOf<Int>())
	private val heard = ByteArrayOutputStream()
	/** Held shut, the other side takes nothing in, so that the phone's side has to wait. */
	private var gate = CountDownLatch(0)

	init {
		LibDataChannelArchDetect.initialize()
		other = PeerConnection.createPeer(PeerConnectionConfiguration.DEFAULT)
		// The phone's side through the core's interface (WebRtc.kt), as the app's library is used.
		val phone = CompletableFuture<PeerChannel>()
		// Handed across in order on a thread of their own: never waited for inside the library's callbacks.
		val toPhone = Executors.newSingleThreadExecutor()
		other.onLocalDescription.register { _, sdp, _ -> toPhone.execute { phone.get(10, TimeUnit.SECONDS).answer(sdp) } }
		other.onLocalCandidate.register { _, c, mid -> toPhone.execute { phone.get(10, TimeUnit.SECONDS).candidate(c.removePrefix("a="), mid) } }
		val arrived = CompletableFuture<DataChannel>()
		other.onDataChannel.register { _, dc ->
			dc.onMessage.register(DataChannelCallback.Message.handleBinary { _, buffer ->
				gate.await(10, TimeUnit.SECONDS)
				pieces.add(buffer.remaining())
				val bytes = ByteArray(buffer.remaining()).also { buffer.get(it) }
				synchronized(heard) { heard.write(bytes) }
			})
			// What the computer says first (SSH's banner), sent as soon as its side is there.
			dc.onOpen.register { it.sendMessage(direct("SSH-2.0-computer\r\n".toByteArray())) }
			arrived.complete(dc)
		}
		val signals = object : PeerEvents {
			override fun description(type: String, sdp: String) {
				other.setRemoteDescription(sdp, SessionDescriptionType.OFFER)
			}

			override fun candidate(candidate: String, mid: String) {
				other.addRemoteCandidate(candidate, mid)
			}

			override fun open() = Unit
			override fun message(bytes: ByteArray) = Unit
			override fun drained() = Unit
			override fun ended() = Unit
		}
		stream = ChannelStream({ events -> LibDataChannelRtc.offer(emptyList(), LABEL, events).also { phone.complete(it) } }, signals)
		stream.opened.get(10, TimeUnit.SECONDS)
		far = arrived.get(10, TimeUnit.SECONDS)
	}

	@AfterTest
	fun end() {
		gate.countDown()
		stream.close()
		runCatching { other.close() }
	}

	private fun direct(bytes: ByteArray): ByteBuffer = ByteBuffer.allocateDirect(bytes.size).put(bytes).flip()

	@Test
	fun `bytes the computer sends before anybody reads are kept`() {
		Thread.sleep(300)
		val line = ByteArray(18)
		var at = 0
		while (at < line.size) at += stream.input.read(line, at, line.size - at).also { assertTrue(it > 0) }
		assertEquals("SSH-2.0-computer\r\n", String(line))
	}

	@Test
	fun `a large write goes out whole and in order, in pieces of 16 KiB, waiting while a megabyte is buffered`() {
		gate = CountDownLatch(1)
		val sent = ByteArray(6 * 1024 * 1024).also { SecureRandom().nextBytes(it) }
		var most = 0L
		val writer = thread {
			stream.output.write(sent)
		}
		val watcher = thread {
			while (writer.isAlive) {
				most = maxOf(most, stream.buffered())
				Thread.sleep(1)
			}
		}
		writer.join(1_500)
		assertTrue(writer.isAlive, "the writer waits while the other side takes nothing")
		assertTrue(stream.buffered() <= HIGH + PIECE, "at most a megabyte and a piece waits: ${stream.buffered()}")
		gate.countDown()
		writer.join(30_000)
		watcher.join()
		assertTrue(most <= HIGH + PIECE, "at most a megabyte and a piece waited: $most")
		within(10_000, "everything arrived") { synchronized(heard) { heard.size() } == sent.size }
		assertContentEquals(sent, synchronized(heard) { heard.toByteArray() })
		assertEquals(PIECE, pieces.max())
	}

	@Test
	fun `megabytes the computer sends arrive whole and in order`() {
		val sent = ByteArray(6 * 1024 * 1024).also { SecureRandom().nextBytes(it) }
		thread {
			var at = 0
			while (at < sent.size) {
				while (far.bufferedAmount() > HIGH) Thread.sleep(1)
				val n = minOf(PIECE, sent.size - at)
				far.sendMessage(direct(sent.copyOfRange(at, at + n)))
				at += n
			}
		}
		val got = ByteArrayOutputStream()
		val banner = "SSH-2.0-computer\r\n".length
		val buffer = ByteArray(64 * 1024)
		while (got.size() < banner + sent.size) {
			val n = stream.input.read(buffer)
			assertTrue(n > 0, "the stream ended after ${got.size()} bytes")
			got.write(buffer, 0, n)
		}
		assertContentEquals(sent, got.toByteArray().copyOfRange(banner, got.size()))
	}

	@Test
	fun `a channel that closes ends the stream for its reader and its writer`() {
		val read = thread {
			val buffer = ByteArray(64)
			// The banner, then the end.
			while (stream.input.read(buffer) >= 0) Unit
		}
		far.close()
		read.join(5_000)
		assertTrue(!read.isAlive, "the reader got the end")
		assertTrue(!stream.isOpen)
		assertTrue(runCatching { stream.output.write(ByteArray(10)) }.isFailure)
	}
}
