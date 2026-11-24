import Foundation
import Testing
import libdatachannel

/**
 * What one peer of the loopback hears: libdatachannel's C interface calls back through C function
 * pointers, which capture nothing, so each callback finds its peer again by the user pointer.
 */
private final class Peer: @unchecked Sendable {
	let lock = NSLock()
	var pc: Int32 = -1
	var other: Peer?
	var channel: Int32 = -1
	var opened = false
	var label = ""
	var heard = Data()
	var echo = false

	func with<T>(_ body: (Peer) -> T) -> T {
		lock.lock()
		defer { lock.unlock() }
		return body(self)
	}

	static func of(_ ptr: UnsafeMutableRawPointer?) -> Peer {
		Unmanaged<Peer>.fromOpaque(ptr!).takeUnretainedValue()
	}
}

/** Waits until `ready` holds, ten seconds at most. */
private func until(_ ready: () -> Bool) async throws {
	let end = ContinuousClock.now + .seconds(10)
	while !ready() {
		if ContinuousClock.now > end { throw CancellationError() }
		try await Task.sleep(for: .milliseconds(20))
	}
}

// The WebRTC library the paired path runs on (libdatachannel, HaishinKit's xcframework) on the Mac,
// as DataChannelTest.kt proves it on the JVM: two peers of this computer, no STUN server, the offer
// and the answer handed across by hand as the meeting service would carry them, one channel `ssh`.
struct DataChannelTests {
	@Test("two peers on this computer open a channel and bytes cross it both ways")
	func loopback() async throws {
		var config = rtcConfiguration()
		let offerer = Peer()
		let answerer = Peer()
		offerer.other = answerer
		answerer.other = offerer
		answerer.echo = true
		for peer in [offerer, answerer] {
			peer.pc = rtcCreatePeerConnection(&config)
			#expect(peer.pc >= 0)
			rtcSetUserPointer(peer.pc, Unmanaged.passUnretained(peer).toOpaque())
			// Signalling: descriptions and trickled candidates go straight to the other peer.
			rtcSetLocalDescriptionCallback(peer.pc) { _, sdp, type, ptr in
				rtcSetRemoteDescription(Peer.of(ptr).other!.pc, sdp, type)
			}
			rtcSetLocalCandidateCallback(peer.pc) { _, candidate, mid, ptr in
				rtcAddRemoteCandidate(Peer.of(ptr).other!.pc, candidate, mid)
			}
		}
		defer {
			rtcDeletePeerConnection(offerer.pc)
			rtcDeletePeerConnection(answerer.pc)
		}

		rtcSetDataChannelCallback(answerer.pc) { _, dc, ptr in
			let peer = Peer.of(ptr)
			rtcSetUserPointer(dc, ptr)
			var buffer = [CChar](repeating: 0, count: 64)
			rtcGetDataChannelLabel(dc, &buffer, Int32(buffer.count))
			let label = String(cString: buffer)
			peer.with { $0.channel = dc; $0.label = label }
			hear(dc)
		}
		let dc = rtcCreateDataChannel(offerer.pc, "ssh")
		#expect(dc >= 0)
		offerer.with { $0.channel = dc }
		rtcSetUserPointer(dc, Unmanaged.passUnretained(offerer).toOpaque())
		rtcSetOpenCallback(dc) { _, ptr in Peer.of(ptr).with { $0.opened = true } }
		hear(dc)

		try await until { offerer.with { $0.opened } && answerer.with { $0.channel >= 0 } }
		#expect(answerer.with { $0.label } == "ssh")

		let sent = Array("SSH-2.0-pine".utf8)
		sent.withUnsafeBufferPointer { bytes in
			bytes.withMemoryRebound(to: CChar.self) { _ = rtcSendMessage(dc, $0.baseAddress, Int32($0.count)) }
		}
		try await until { offerer.with { $0.heard.count } == sent.count }
		#expect(answerer.with { $0.heard } == Data(sent))
		#expect(String(decoding: offerer.with { $0.heard }, as: UTF8.self) == "enip-0.2-HSS")
	}
}

/** Binary messages of channel `dc` are added to what its peer heard; the answerer sends them back reversed. */
private func hear(_ dc: Int32) {
	rtcSetMessageCallback(dc) { id, message, size, ptr in
		// A negative size is a text message; the paired path sends bytes only.
		guard let message, size >= 0 else { return }
		let bytes = Data(bytes: message, count: Int(size))
		let peer = Peer.of(ptr)
		peer.with { $0.heard.append(bytes) }
		if peer.echo {
			let back = Array(bytes.reversed())
			back.withUnsafeBufferPointer { b in
				b.withMemoryRebound(to: CChar.self) { _ = rtcSendMessage(id, $0.baseAddress, Int32($0.count)) }
			}
		}
	}
}
