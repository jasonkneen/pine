// The Worker: the relay at /ssh, with Cloudflare's own connect(), WebSocket pair and a name
// lookup over DNS-over-HTTPS, the meeting service at /meet/ (one Durable Object per machine id),
// and the web client's built files beside them (site.ts). Everything the relay decides is in
// relay.ts, and everything the meeting decides in meet.ts.
import { connect } from "cloudflare:sockets";
import { relay } from "./relay.ts";
import { site, type SiteEnv } from "./site.ts";

/**
 * A and AAAA records of a name, from Cloudflare's resolver: both asked at once, the A records
 * first, and neither waited for longer than a few seconds, so that a stalled lookup cannot hold
 * the upgrade. A lookup that fails or runs out of time adds nothing.
 */
async function resolve(name: string): Promise<string[]> {
	const lookups = ["A", "AAAA"].map(async (type) => {
		try {
			const response = await fetch(`https://cloudflare-dns.com/dns-query?name=${encodeURIComponent(name)}&type=${type}`, {
				headers: { Accept: "application/dns-json" },
				signal: AbortSignal.timeout(3000),
			});
			if (!response.ok) return [];
			const answer = (await response.json()) as { Answer?: { type: number; data: string }[] };
			// Type 1 is A and 28 is AAAA; a CNAME's record (5) is followed by the resolver already.
			return (answer.Answer ?? []).filter((record) => record.type === 1 || record.type === 28).map((record) => record.data);
		} catch {
			return [];
		}
	});
	return (await Promise.all(lookups)).flat();
}

const upgrade = () => {
	const pair = new WebSocketPair();
	return { socket: pair[1], response: new Response(null, { status: 101, webSocket: pair[0] }) };
};

const handle = relay({
	// allowHalfOpen: false is connect()'s own default, which its type wants written out.
	connect: (address, options) => (options ? connect(address, { ...options, allowHalfOpen: false }) : connect(address)),
	resolve,
	upgrade,
	timeoutMs: 5000,
});

export { Meeting } from "./meet-object.ts";

export default { fetch: site({ relay: handle, upgrade }) } satisfies ExportedHandler<SiteEnv>;
