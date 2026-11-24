// The one deployment: /ssh is the relay (while it is on), /meet/ the meeting service, and
// everything else the web client's built files (web/dist, Cloudflare's static assets), served
// with the headers the two documents need.
//
// The bridge's document (/) holds the browser's key and the daemon's token: no other site may
// frame it. The page (/page/) runs in the bridge's iframe sandboxed with scripts only, under an
// opaque origin, so its module scripts, styles and fonts are fetched cross-origin and need
// `Access-Control-Allow-Origin`; they are public files of the build, and nothing else gets it.
//
// The meeting service lives at the web client's own address, so that the bridge's policy
// (`connect-src 'self'`) reaches it unchanged. Each machine id has one Durable Object, which
// holds the sockets of that id's meeting (meet-object.ts). A configuration without that binding
// (the default one, whose versions the preview workflow uploads) has no meeting routes at all.
import { CLOSE, meetConfig, route } from "./meet.ts";
import type { Env, RelaySocket } from "./relay.ts";

/** The Durable Object namespace of the meetings, as far as the Worker uses it. */
export type MeetNamespace = {
	idFromName(name: string): unknown;
	get(id: any): { fetch(request: Request): Promise<Response> };
};

export type SiteEnv = Env & {
	ASSETS: { fetch(request: Request): Promise<Response> };
	/** The meetings' objects: every deployment of wrangler.jsonc has them; a configuration of one's own may leave them out. */
	MEET?: MeetNamespace;
	/** "on" serves the SSH relay at /ssh; anything else, or nothing, refuses it. */
	RELAY?: string;
	/** The servers that help a connection (STUN), as `RTCIceServer`s; a public STUN server when none are given. */
	ICE?: unknown;
	/**
	 * The SHA-256 fingerprint of the key the Android app's releases are signed with (`AA:BB:...`, as
	 * `keytool -list` or `apksigner verify --print-certs` writes it). With it the service serves the
	 * statement App Links read, and its pairing links open that app; without it they open the browser.
	 */
	ANDROID_CERT_SHA256?: string;
};

export type SiteDeps = {
	relay(request: Request, env: Env): Promise<Response>;
	/** A WebSocket pair, to close a meeting socket with a code the client can read. */
	upgrade(): RelaySocket;
};

const PAGE = "/page/";
/** The Android app's package name (mobile/android/app/build.gradle's applicationId). */
const ANDROID_APP = "dev.pmndre.pine";
const FINGERPRINT = /^[0-9A-F]{2}(:[0-9A-F]{2}){31}$/;

export function site(deps: SiteDeps) {
	const limited = async (request: Request, env: SiteEnv) => {
		const ip = request.headers.get("CF-Connecting-IP") ?? "unknown";
		return !(await env.LIMITER.limit({ key: ip })).success;
	};

	return async function fetch(request: Request, env: SiteEnv): Promise<Response> {
		const url = new URL(request.url);
		if (url.pathname === "/ssh") {
			if (env.RELAY !== "on") return text(404, "The SSH relay is off on this service. Pair a computer from the Pine app instead.");
			return deps.relay(request, env);
		}
		const meets = url.pathname === "/meet/config" || url.pathname === "/meet/host" || url.pathname === "/meet/join";
		if (meets && !env.MEET) return text(404, "There is no meeting service on this deployment.");
		if (url.pathname === "/meet/config") {
			if (await limited(request, env)) return text(429, "Too many requests from this address. Wait a minute and try again.");
			return new Response(JSON.stringify(meetConfig(env.ICE, env.RELAY === "on")), { headers: { "Content-Type": "application/json", "Cache-Control": "no-store" } });
		}
		if (url.pathname === "/meet/host" || url.pathname === "/meet/join") {
			if (request.headers.get("Upgrade")?.toLowerCase() !== "websocket") return text(426, "A WebSocket upgrade is needed.");
			const where = route(url);
			if (!where) return text(400, "Name a machine id: ?id=<43 characters of base64url>.");
			if (await limited(request, env)) {
				// A refused upgrade reaches a browser's script as a bare error; a close code says why.
				const { socket, response } = deps.upgrade();
				socket.accept();
				socket.close(CLOSE.limits, "Too many connections from this address. Wait a minute and try again.");
				return response;
			}
			return env.MEET!.get(env.MEET!.idFromName(where.id)).fetch(request);
		}
		if (url.pathname === "/.well-known/assetlinks.json") return appLinks(env.ANDROID_CERT_SHA256);
		const served = await env.ASSETS.fetch(request);
		const response = new Response(served.body, served);
		response.headers.set("X-Content-Type-Options", "nosniff");
		response.headers.set("Referrer-Policy", "no-referrer");
		const page = url.pathname.startsWith(PAGE);
		if (page) response.headers.set("Access-Control-Allow-Origin", "*");
		if ((response.headers.get("content-type") ?? "").startsWith("text/html")) response.headers.set("Content-Security-Policy", page ? "frame-ancestors 'self'" : "frame-ancestors 'none'");
		return response;
	};
}

/**
 * The statement Android reads before it lets the Pine app open this service's links (App Links): the
 * app, signed with the release key the configuration names. Nothing where no such key is named, or
 * where the value is not a fingerprint: a phone then opens the link in its browser.
 */
function appLinks(value: unknown): Response {
	const fingerprint = typeof value === "string" ? value.trim().toUpperCase() : "";
	if (!FINGERPRINT.test(fingerprint)) return text(404, "This service names no Android app.");
	const statement = [{ relation: ["delegate_permission/common.handle_all_urls"], target: { namespace: "android_app", package_name: ANDROID_APP, sha256_cert_fingerprints: [fingerprint] } }];
	return new Response(JSON.stringify(statement), { headers: { "Content-Type": "application/json", "X-Content-Type-Options": "nosniff" } });
}

function text(status: number, message: string) {
	return new Response(message + "\n", { status, headers: { "Content-Type": "text/plain; charset=utf-8" } });
}
