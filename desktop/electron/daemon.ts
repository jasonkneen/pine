// What the page may ask the daemon for, and how it is asked: one control API call, a picture,
// video or sound served straight from the daemon, the live events in small batches, and the page's
// content security policy. Whoever holds the daemon's token (the app's main process) makes these
// calls for the page with these rules. No Electron here: plain Node, given the daemon's address
// and token.

/** Where a daemon answers and the token it takes. */
export interface Daemon {
	base: string;
	token: string;
}

/** What a call of the control API comes back as: JSON, or a picture as bytes and their kind. */
export interface CallResult {
	ok: boolean;
	status: number;
	data: any;
}

/** One call of the control API in the owner's name. The page never holds the token. */
export async function callDaemon(daemon: Daemon | undefined, method: string, url: string, body?: unknown): Promise<CallResult> {
	if (!daemon) return { ok: false, status: 503, data: { error: "pine is not running yet" } };
	if ((method !== "GET" && method !== "POST") || typeof url !== "string" || !url.startsWith("/") || url.startsWith("//")) return { ok: false, status: 400, data: { error: "not a call of the control API" } };
	try {
		const res = await fetch(daemon.base + url, {
			method,
			headers: { authorization: `Bearer ${daemon.token}`, ...(body !== undefined ? { "content-type": "application/json" } : {}) },
			body: body !== undefined ? JSON.stringify(body) : undefined,
		});
		const type = res.headers.get("content-type") ?? "";
		if (type.startsWith("application/json")) return { ok: res.ok, status: res.status, data: await res.json().catch(() => ({})) };
		// A picture: bytes and their kind.
		return { ok: res.ok, status: res.status, data: { mime: type, base64: Buffer.from(await res.arrayBuffer()).toString("base64") } };
	} catch (e) {
		return { ok: false, status: 0, data: { error: `pine does not answer (${e instanceof Error ? e.message : e})` } };
	}
}

/** What the page may show straight from the daemon: pictures, videos and sounds. Nothing else is served this way. */
export const MEDIA = [/^\/media\/tool\/[^/]+$/, /^\/tasks\/\d+\/images\/\d+$/, /^\/agents\/[^/]+\/image$/, /^\/agents\/[^/]+\/browser\/frame$/];

/** One of the daemon's media, by its path on the daemon (and the query that goes with it). */
export async function mediaFromDaemon(daemon: Daemon | undefined, method: string, pathname: string, search: string): Promise<Response> {
	if (!daemon || method !== "GET" || !MEDIA.some((m) => m.test(pathname))) return new Response("not found", { status: 404 });
	try {
		const res = await fetch(daemon.base + pathname + search, { headers: { authorization: `Bearer ${daemon.token}` } });
		if (!res.ok) return new Response("not found", { status: 404 });
		const type = res.headers.get("content-type") ?? "application/octet-stream";
		// Only what is drawn or played. A page of HTML or a script under this name would be content from outside.
		if (!/^(image|video|audio)\//.test(type) || type.startsWith("image/svg")) return new Response("not shown", { status: 415 });
		// With its size: a player is told by it how long a video or a sound runs.
		const size = res.headers.get("content-length");
		return new Response(res.body, { status: 200, headers: { "content-type": type, "cache-control": "no-store", "x-content-type-options": "nosniff", ...(size ? { "content-length": size } : {}) } });
	} catch {
		return new Response("not found", { status: 404 });
	}
}

/** What the reader of the event stream tells its caller. */
export interface EventHandlers {
	/** A few events at a time. */
	batch(events: unknown[]): void;
	/** The stream was opened (true) or was lost (false). */
	connection(up: boolean): void;
	/** After each loss, with how many in a row: true stops the reading (the caller does something else about it). */
	lost?(times: number): boolean;
}

/**
 * The daemon's live events, read until `signal` aborts and handed on in small batches: a model that
 * writes fast sends a hundred events a second, and each as a message of its own would keep the
 * page busy with the post office. A lost stream is opened again a second later.
 */
export function followEvents(daemon: Daemon, signal: AbortSignal, on: EventHandlers): void {
	let batch: unknown[] = [];
	let timer: NodeJS.Timeout | undefined;
	const flush = () => {
		timer = undefined;
		if (batch.length && !signal.aborted) on.batch(batch);
		batch = [];
	};
	const loop = async () => {
		let down = 0;
		while (!signal.aborted) {
			try {
				const res = await fetch(`${daemon.base}/events/stream?topic=%23`, { headers: { authorization: `Bearer ${daemon.token}` }, signal });
				if (!res.ok || !res.body) throw new Error(`HTTP ${res.status}`);
				down = 0;
				on.connection(true);
				let buf = "";
				const decoder = new TextDecoder();
				for await (const chunk of res.body as any) {
					buf += decoder.decode(chunk, { stream: true });
					for (let i = buf.indexOf("\n\n"); i >= 0; i = buf.indexOf("\n\n")) {
						const block = buf.slice(0, i);
						buf = buf.slice(i + 2);
						if (!block.startsWith("data: ")) continue;
						try {
							batch.push(JSON.parse(block.slice(6)));
							timer ??= setTimeout(flush, 24);
						} catch {
							// A malformed frame is skipped; the stream goes on.
						}
					}
				}
			} catch {
				// fall through to the retry
			}
			if (signal.aborted) return;
			on.connection(false);
			down++;
			if (on.lost?.(down)) return;
			await new Promise((r) => setTimeout(r, 1000));
		}
	};
	void loop();
}

/**
 * The page's content security policy. `media` are the sources pictures, video and sound come from
 * besides the page's own origin (the app's scheme for them by default); `connect` adds to where the
 * page may connect (a development server's socket for reloading); `script` adds to where scripts
 * come from (the nonce of the scripts a development server writes into the page).
 */
export function pageCsp(opts: { media?: string[]; connect?: string[]; script?: string[]; frame?: string[] } = {}): string {
	const media = (opts.media ?? ["pine-media:"]).map((s) => ` ${s}`).join("");
	const frame = opts.frame?.length ? opts.frame.join(" ") : "'none'";
	const connect = (opts.connect ?? []).map((s) => ` ${s}`).join("");
	const script = (opts.script ?? []).map((s) => ` ${s}`).join("");
	return [
		"default-src 'none'",
		`script-src 'self'${script}`,
		// The editor writes its styles into the page as it goes.
		"style-src 'self' 'unsafe-inline'",
		// No address on the web: a picture an answer points at is fetched by the daemon, on a click.
		`img-src 'self' data: blob:${media}`,
		`media-src 'self' blob:${media}`,
		"font-src 'self' data:",
		`connect-src 'self'${connect}`,
		"base-uri 'none'",
		"form-action 'none'",
		`frame-src ${frame}`,
		"object-src 'none'",
	].join("; ");
}

/**
 * The policy of the frame a view of the owner's runs in (view.html, src/view-frame.ts): scripts from the
 * app and from the view's own code (a blob the frame makes of it), and nothing else. No address at all:
 * not the daemon, not the web, not a frame of its own. With the frame's sandbox (scripts only, an opaque
 * origin) the view reaches neither the bridge nor the page's storage, and can tell nobody what it saw.
 */
export const VIEW_CSP = [
	"default-src 'none'",
	"script-src 'self' blob:",
	"style-src 'self' 'unsafe-inline'",
	"img-src data: blob:",
	"font-src 'self' data:",
	"connect-src 'none'",
	"media-src 'none'",
	"worker-src 'none'",
	"base-uri 'none'",
	"form-action 'none'",
	"frame-src 'none'",
	"object-src 'none'",
].join("; ");
