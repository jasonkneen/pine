// The top-level document of the web client: the web bridge, and the page in an iframe sandboxed
// with scripts only. The bridge holds the browser's key, the SSH connection and the daemon's token;
// the page, under an opaque origin, reaches none of them and asks by message (serve.ts).
import { chooseApp, choiceView, onIosDevice } from "./app-choice.ts";
import { isDesktopBrowser } from "../../desktop/src/machines.ts";
import { webBridge } from "./host.ts";
import { idbStore } from "./idb-store.ts";
import { takePairLink } from "./pairing.ts";
import { peerStream } from "./peer.ts";
import { serve } from "./serve.ts";
import { connect, relayStream } from "./ssh.ts";
import { unsupported } from "./supported.ts";

declare const __PINE_WEB_VERSION__: string;

/** The relay of this deployment, for a host and port: the same host, at /ssh. */
function relay(host: string, port: number) {
	const url = new URL("ssh", location.href);
	url.protocol = location.protocol === "https:" ? "wss:" : "ws:";
	url.search = new URLSearchParams({ host, port: String(port) }).toString();
	return relayStream(url.toString());
}

/**
 * The deployment's configuration: the servers that help a peer connection, and whether the relay
 * carries SSH. `null` for a 404, which a deployment without the meeting service answers; any other
 * failure (a 429 of the rate limiter, a 5xx, the network) throws, so that it is read again.
 */
async function config(): Promise<unknown> {
	const answer = await fetch(new URL("meet/config", location.href));
	if (answer.status === 404) return null;
	if (!answer.ok) throw new Error(`The service's configuration could not be read (${answer.status}).`);
	return answer.json();
}

async function main() {
	// Before anything else: the pairing code leaves the address, so that no history entry, bookmark or reload keeps it.
	const { link, problem } = takePairLink(location, (url) => history.replaceState(history.state, "", url));
	if (problem) console.warn(problem);
	const said = await unsupported(crypto.subtle);
	if (said) {
		const p = document.createElement("p");
		p.className = "unsupported";
		p.textContent = said;
		document.body.append(p);
		return;
	}
	const bridge = webBridge({
		connect,
		store: idbStore(),
		relay,
		// A paired computer, peer to peer: the meeting service at this deployment's address, the peer connection in this document.
		peer: (id) => peerStream(id, { service: location.href, config }),
		pairLink: link,
		// On an iPhone or iPad a link opens the browser, never the app: the owner chooses before the code is used.
		choose: onIosDevice(navigator.userAgent, navigator.maxTouchPoints) ? (pairing) => chooseApp(pairing, location.href, choiceView(document), (url) => location.assign(url)) : undefined,
		userAgent: navigator.userAgent,
		config,
		serviceHost: location.host,
		clipboard: (text) => navigator.clipboard.writeText(text),
		share: typeof navigator.share === "function" ? (title, text) => navigator.share({ title, text }) : undefined,
		version: __PINE_WEB_VERSION__,
		// A new tab that gets no handle on this document, and is not told where it was opened from.
		open: (url) => void window.open(url, "_blank", "noopener,noreferrer"),
		// From this document, the top one: the browser asks the owner before it hands the address to the app.
		openApp: isDesktopBrowser(navigator.userAgent, navigator.maxTouchPoints) ? () => location.assign("pine://pair") : undefined,
		save: (name, text) => {
			const a = document.createElement("a");
			a.href = URL.createObjectURL(new Blob([text], { type: "text/plain;charset=utf-8" }));
			a.download = name;
			a.click();
			setTimeout(() => URL.revokeObjectURL(a.href), 60_000);
		},
	});
	const frame = document.createElement("iframe");
	// Scripts and nothing else: no same origin (so no storage of the bridge's), no popups, no top navigation, no forms.
	frame.setAttribute("sandbox", "allow-scripts");
	frame.title = "Pine";
	serve(bridge, window, () => frame.contentWindow);
	// A connection being made again is tried at once when the network is back or the tab is looked at again.
	window.addEventListener("online", () => bridge.wake());
	document.addEventListener("visibilitychange", () => document.visibilityState === "visible" && bridge.wake());
	// The page is loaded once. A frame that loads anything again was navigated by what it drew:
	// the whole client starts anew, so that nothing is told to another document in its place.
	let loads = 0;
	frame.addEventListener("load", () => {
		if (++loads > 1) location.reload();
	});
	frame.src = "page/";
	document.body.append(frame);
}

void main();
