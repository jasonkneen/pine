// A relay (TURN) server for the tests of browser access: node-turn on a loopback UDP port, with one
// user name and password (TURN's long-term credentials). No network: it relays between addresses
// of this computer only. And a UDP port that nobody answers on, for a relay that is not there.
import dgram from "node:dgram";
import { createRequire } from "node:module";

/** The user name and password the test's relay takes. */
export const TURN_USER = "relay-user";
export const TURN_PASSWORD = "relay-password-that-must-never-be-seen";

export interface TestRelay {
	port: number;
	/** How many addresses it handed out. */
	allocations(): number;
	close(): Promise<void>;
}

/** A UDP port that was free a moment ago. Nothing listens on it once this returns. */
export function freeUdpPort(): Promise<number> {
	return new Promise((resolve, reject) => {
		const socket = dgram.createSocket("udp4");
		socket.once("error", reject);
		socket.bind(0, "127.0.0.1", () => {
			const { port } = socket.address();
			socket.close(() => resolve(port));
		});
	});
}

/** A UDP port with a socket that reads and never answers: a relay that is down, or a firewall that drops. */
export async function silentUdpPort(): Promise<{ port: number; close(): Promise<void> }> {
	const socket = dgram.createSocket("udp4");
	await new Promise<void>((resolve) => socket.bind(0, "127.0.0.1", () => resolve()));
	socket.on("message", () => {});
	return { port: socket.address().port, close: () => new Promise((r) => socket.close(() => r())) };
}

export async function startTurn(): Promise<TestRelay> {
	const Turn = createRequire(import.meta.url)("node-turn");
	// node-turn takes no port 0 (it reads 0 as "the default"): a free one is found first.
	const port = await freeUdpPort();
	const server = new Turn({
		listeningPort: port,
		listeningIps: ["127.0.0.1"],
		relayIps: ["127.0.0.1"],
		authMech: "long-term",
		credentials: { [TURN_USER]: TURN_PASSWORD },
		debugLevel: "OFF",
	});
	server.start();
	let made = 0;
	server.on("allocate", () => made++);
	// Its allocations keep a timer and a socket each, which its own stop leaves: they go with it.
	return {
		port,
		allocations: () => made,
		async close() {
			for (const allocation of Object.values(server.allocations ?? {}) as any[]) {
				clearTimeout(allocation?.timer);
				for (const socket of allocation?.sockets ?? []) {
					try {
						socket.close();
					} catch {
						// closed
					}
				}
			}
			server.stop();
		},
	};
}
