// What the page in its iframe may ask of the web bridge at the top, and how. This is the whole
// list: a method that is not here is refused, and each one's arguments are checked here before
// the bridge sees them, as desktop/electron/main.ts checks what comes through its IPC.

/** A machine as the page names it: user@host, user@host:port or paired:<machine id> (`host.ts` reads it). */
const host = (v: unknown) => typeof v === "string" && v.length > 0 && v.length <= 300;
const none = (args: unknown[]) => args.length === 0;
/** A host key's fingerprint as OpenSSH prints it: SHA256 and 43 characters of unpadded base64. */
export const FINGERPRINT = /^SHA256:[A-Za-z0-9+/]{43}$/;

/**
 * A path on the daemon that is written into a request line of HTTP/1.1 (tunnel.ts) as it is: a
 * space, a control character or a fragment would add headers or a second request with the token,
 * which the desktop's fetch would have encoded.
 */
export const daemonPath = (p: string) => p.startsWith("/") && !p.startsWith("//") && !/[\s\0-\x1f\x7f#]/.test(p);

/** Each method the bridge answers, and whether a list of arguments is one it takes. */
export const METHODS = {
	state: none,
	ready: none,
	retry: none,
	/** One call of the control API: a path on the daemon (`daemonPath`), never an address. */
	call: (args: unknown[]) =>
		args.length >= 2 && args.length <= 3 && (args[0] === "GET" || args[0] === "POST") && typeof args[1] === "string" && args[1].length <= 4096 && daemonPath(args[1]),
	prefs: (args: unknown[]) => args.length === 1 && typeof args[0] === "object" && args[0] !== null && !Array.isArray(args[0]),
	use: (args: unknown[]) => args.length === 0 || (args.length === 1 && (args[0] === undefined || host(args[0]))),
	addHost: (args: unknown[]) => args.length === 1 && host(args[0]),
	forgetHost: (args: unknown[]) => args.length === 1 && host(args[0]),
	/** A machine of the list and the name the owner gives it; the bridge cleans and cuts the name. */
	renameHost: (args: unknown[]) => args.length === 2 && host(args[0]) && typeof args[1] === "string" && args[1].length <= 200,
	/** Back to the machines: the one in use is let go of, and kept. */
	disconnect: none,
	trustHostKey: (args: unknown[]) => args.length === 2 && host(args[0]) && typeof args[1] === "string" && FINGERPRINT.test(args[1]),
	/** The browser's public key, as a line of authorized_keys. */
	deviceKey: none,
	/** The public key onto the clipboard, or into the system's share sheet: the top does it, since the frame may not. */
	copyKey: none,
	shareKey: none,
	/** One of the daemon's pictures, videos or sounds by its path and query; the bridge checks it against the desktop's `MEDIA`. */
	media: (args: unknown[]) => args.length === 1 && typeof args[0] === "string" && args[0].length <= 4096,
	/** An address to open in a new tab; the bridge opens only http(s). */
	open: (args: unknown[]) => args.length === 1 && typeof args[0] === "string" && args[0].length <= 8192,
	/** `pine://pair`, opened by the top document: the Pine app on this computer adds this browser. Nothing else. */
	openApp: none,
	/** A file's name and its text, saved by the browser as a download. */
	saveText: (args: unknown[]) => args.length === 2 && typeof args[0] === "string" && args[0].length <= 1000 && typeof args[1] === "string" && args[1].length <= 64 * 1024 * 1024,
} satisfies Record<string, (args: unknown[]) => boolean>;

export type Method = keyof typeof METHODS;

/** Whether a name is one of the list's own, and not something every object has (`constructor`, `toString`). */
export const isMethod = (name: unknown): name is Method => typeof name === "string" && Object.hasOwn(METHODS, name);

/** What the bridge tells the page without being asked. */
export const EVENTS = ["service", "events", "connection", "focus"] as const;
export type BridgeEvent = (typeof EVENTS)[number];

/** A window a message is posted to: the page's iframe, or its parent. */
export type Target = { postMessage(data: unknown, targetOrigin: string): void };
/** A window whose messages are heard, with the window each came from. */
export type MessageSource = { addEventListener(type: "message", fn: (event: { data: unknown; source: unknown }) => void): void };

/** The page asks. */
export type Ask = { pine: "call"; id: number; method: Method; args: unknown[] };
/** The bridge answers one ask, with a value or an error's message. */
export type Reply = { pine: "reply"; id: number; value?: unknown; error?: string };
/** The bridge tells. */
export type Tell = { pine: "event"; event: BridgeEvent; value: unknown };
