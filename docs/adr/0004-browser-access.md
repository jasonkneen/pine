# 0004: Browser access to the Pine app's pine

Status: accepted. Amends what ADR 0001 says about a network of the app's own, and ADR 0003 on
how a host key is trusted and what the Worker carries. Amended since: the mobile app pairs too
(see the end), and a device on the same network pairs without a code
([0005](0005-pairing-from-nearby-devices.md)).

## Context

An owner who installs the Pine app on a Mac from a disk image is in their conversations at once:
the app carries pine and starts the daemon. To have the same conversations on a phone or another
computer, the web client (ADR 0003) and the mobile apps (ADR 0001) need SSH: Remote Login turned
on, the computer's address, a key pasted into `authorized_keys`, a host key fingerprint compared, and
away from home Tailscale Funnel or a server with a public address. Few owners get through that.

ADR 0001 says the mobile app "embeds no network of its own": how a machine is reached is the
owner's business. That stays true of the mobile apps. This decision gives the Pine app a way in of its
own, for its own pine alone, which the owner turns on. The app runs on a Mac today, and is packed
for other systems later: nothing below depends on macOS but the keychain the host key is kept
with, which is the system's own on each.

## Decision

**The app runs an SSH server of its own, the access server.** In the app's main process
(`desktop/electron/access/server.ts`), on `ssh2` without its native binding, with Ed25519 host and
client keys, ECDH (Curve25519 or P-256, the web client's SSH library has no Curve25519) and
AES-GCM. It does two things and nothing else: it answers the one remote command the web client
sends (`remoteCommand()` in `src/remote.ts`, compared as a string, no shell) with the service
line of this computer's own daemon, and it opens direct-tcpip channels to exactly that daemon's
loopback port. A shell, a pty, sftp, every other command, every other destination, a password and
keyboard-interactive are refused. Only keys paired at that computer are accepted. SSH was kept, rather
than a protocol of pine's, because the web client already speaks it end to end and the daemon
stays on the loopback, unchanged: the app gets the token from `pine service` as before, and hands
the line to an authenticated SSH client as `sshd` would.

**Pairing by a QR code.** "Add a device" opens a pairing: a random 128-bit code, for one use, two
minutes, cancelled when the dialog closes. The link is `<service>/#pair=<machine id>.<code>`;
both values are in the fragment, which no server sees. The machine id is the fingerprint of the
computer's host key, so the link is how the browser trusts that key: a second way, beside the owner's
press on "Trust this key", for that machine alone, and never over a key kept already. The
browser shows four digits and the app asks the owner with the device's name and the same digits:
only Allow stores the key. Pairing happens at that computer and nowhere else. *(Amended by
[0005](0005-pairing-from-nearby-devices.md): a device on the same network may start a pairing
without a code; the owner still allows it at that computer and nowhere else.)*

**Named as the browser knows it.** The browser cannot tell what kind of computer it pairs with.
It keeps a paired computer among its machines as `paired:<machine id>`, and names it by the name
the computer gives with its yes (its computer name), which the owner may rename; before that, and
where there is no name, "your computer": no text of the web client calls it a Mac. The app names
itself by its platform, as the rest of its page does: "This Mac" on macOS, "This computer"
elsewhere (`computerWord` in `desktop/src/machines.ts`).

**Peer to peer.** The browser and the computer talk over one WebRTC data channel that carries the
SSH bytes. In the app `node-datachannel` (libdatachannel, prebuilt), chosen in ticket 01: it loads in
the packed, hardened-runtime app on arm64 and under Rosetta, so `werift`, kept in reserve, was not
needed. In the browser the peer connection lives in the web bridge, the top-level document, never
in the page's iframe. Peer to peer means no server carries the conversation, and costs nothing per
byte.

**A meeting service that keeps sockets and nothing else.** Routes of the existing Worker under
`/meet/`, at the web client's own address so that the bridge's policy needs no change. One Durable
Object per machine id, with hibernating WebSockets, so a waiting computer costs no duration; it keeps
no storage. A computer waits under its machine id only after it signed a challenge with that key; a newer
proven socket replaces an older one. A browser that asks for a machine id gets a few opaque
messages passed both ways (at most 64, of 16 KiB each, within 30 seconds), and the service is out
of it. It logs nothing. The meeting logic (`web/relay/src/meet.ts`) has no Cloudflare in it; the
Durable Object is one adapter.

**No relay fallback.** *(Superseded in part by the amendment below: a computer's owner may now name a
relay of their own, and that took no release of the web client.)* No TURN server and no carrying of the bytes by the Worker. Where two
devices cannot connect directly (some cellular networks behind carrier NAT), the owner is told so
and advised to try another network. The STUN servers that help a connection (`ICE`) are the service's
configuration, read by both sides. A relay (TURN) is not carried today: the app keeps only `stun:`
and `stuns:` addresses, and both sides keep only each server's `urls`, without a username or a
credential, so a fallback needs a release of the Pine app and of the web client.

Amended: the project still runs no relay, and the service still names none, but the owner of a
computer may name a relay (TURN) server of their own, in the Pine app only (Settings > Browser
access). Only the computer's side uses it: it reserves an address on the relay and offers it as one
more candidate, and once the browser's checks reach that address the connection is relayed. So the
browser is given nothing, and neither the web client nor the service changes. ICE still prefers a
direct path. The relay's password is kept like the host key, in the file the keychain encrypts, and
never reaches the page; a TURN entry from the service's list is still dropped.

**One official service.** The project runs the Worker `pine-main` at
`https://pine-main.drcmda.workers.dev`: the web client, the meeting service and the SSH relay,
deployed from every push to `main`. It is the app's default (`OFFICIAL_SERVICE`); an owner who
runs their own deployment (the same configuration under a name of their own, `--name`) names it
in the settings.

*Amended:* the official service was first the Worker `pine` (`--env official`, deployed by hand),
and pull request previews were versions of another Worker, `pine-relay`, uploaded under preview
aliases from a configuration with no Durable Object: Cloudflare gives a Worker that holds one no
version preview addresses. So a preview had no meeting service, and pairing could not be tried
before a merge. Now `wrangler.jsonc` has one configuration, a whole deployment, and every channel
is a Worker of its own made from it: `pine-main` from `main`, `pine-next` from `next`, and
`pine-pr-<number>` for a pull request, deleted when it is closed
(`.github/workflows/web-preview.yml`). The old addresses were dropped without a transition: pine
is below 1.0, and each device paired with the old service pairs once again.

*Amended:* the official service first had the SSH relay off, and offered pairing only. It has
the relay on now, for three reasons. The previews already ran the relay in public, on
the same account, so leaving it off on one address shut nothing that was not open beside it. It
costs one request a session: the WebSocket that carries SSH is one request however long it lasts.
And an owner whose pine runs where there is no Pine app (a server, a VPS) had no other way in from
a browser. What that opens is an SSH relay open to anyone, limited to 20 connections a minute per
client address, that carries SSH only and reaches public addresses only. The first screen keeps
pairing first and puts SSH behind a link, and the SSH view names the relay in one line, so that
nobody forgets that it is there.

## Alternatives considered

**Remote Login (the system's `sshd`) with a key the app adds.** Rejected: it gives a paired
browser a shell on the computer, and the computer's SSH access to other machines; it needs an admin's yes in
System Settings, and still an address to reach.

**A port on the local network, or the control API behind a login.** Rejected: rule 10 keeps the
daemon on the loopback, and a port of the network reaches nobody away from home.

**A relay that carries the bytes (TURN, or the Worker).** Left out, not rejected: it would cost
per byte on a free plan that has no such allowance, and adding it takes a release of both clients
besides the service's configuration. Its absence is the accepted risk below. *(Superseded in part
by the amendment to "No relay fallback": the project still runs none, but a relay the computer's
owner names in the Pine app is used by the computer's side alone, which needed no release of the
web client.)*

**`werift` (pure TypeScript) for the app's data channel.** Kept as the fallback behind the same
small interface; not needed once `node-datachannel` loaded in the packed, signed app.

**The meeting service storing who waits.** Rejected: open sockets are the state. A record of
machines would be a list of every owner's computers, kept by the project.

## Consequences

- Rule 10 gains a second way a host key is trusted in the web client (the pairing link), and the
  Worker carries small opaque meeting messages beside SSH for the relay, keeping no storage.
- The access server's two permissions (the remote command's answer, a channel to the daemon's
  loopback port) are an invariant: a change that widens them needs a test that shows why it is
  safe.
- A share of connections from cellular data to a computer behind a home router fails, an estimated 20
  to 40 percent over IPv4; IPv6 on both sides helps.
- The official address is a commitment: a browser's key and its paired machines belong to it, so
  moving the service makes every owner pair again.
- A locked phone drops the connection; it is made again when the owner returns. Work goes on at
  the computer. The computer has to be awake and the app open.
- The crossing of real networks is proven by no test: it is tried by hand before a release, from
  a phone on cellular data, on another Wi-Fi and on the same Wi-Fi.

## Amended: the mobile app pairs too

Pairing was the browser's alone: a phone with the mobile app that scanned the QR code paired its
browser, and the mobile app itself needed SSH. Now the mobile app pairs with the same QR code and
reaches the computer over the same kind of data channel, carrying the same SSH
([0001](0001-mobile-app.md), "Amended: the app pairs with the Pine app"). Nothing on the
computer's side changed: the access server, pairing at the computer, the meeting protocol and the
Pine app's settings are as above, and a native client is told apart from a browser nowhere (the
meeting service checks no origin, the access server sees SSH only). Released browsers and apps
keep working.

- **The phone is a device like a browser.** It signs in with its own Ed25519 key, the one it has for
  SSH, and is listed in Settings > Browser access by its name, "Pine on" and the phone's model
  ("Pine on Pixel 9"; "Pine on iPhone", since iOS gives no model name). Remove there shuts it out;
  Forget in the app removes the entry on the phone only.
- **The host key is trusted by the link here too.** The native cores check the key the computer
  presents against the machine id during key exchange, before the phone's key is offered, and keep
  nothing else for a paired computer: the id is the trusted key. A computer that presents another
  key is refused for good.
- **`https` only.** The app takes the meeting service a link names when it is `https`, and shows
  its host before the owner confirms when it is not the official one. No setting accepts `http`;
  the tests reach an `http` helper through a seam of their own.
- **How the link reaches the app.** On Android, App Links: the official service serves
  `/.well-known/assetlinks.json` for the release-signed app once its configuration names the
  release key's fingerprint (`ANDROID_CERT_SHA256`). On an iPhone or iPad the link opens the
  browser, and the web client offers "Open in the Pine app" (a `pine:` address) or "Continue in
  this browser" before it uses the code, which works once for whichever pairs first. That choice and
  the statement file are the only changes to the web client and its Worker; the choice is shown on
  no other device.
- **The libraries.** The computer and the iOS app run libdatachannel; the Android app runs Google's
  libwebrtc, which needs one more permission there, `ACCESS_NETWORK_STATE`
  ([0001](0001-mobile-app.md)). The two interoperate over the same protocol; that is proven on the
  emulator against the real access host, not yet on a real phone or over cellular.
- **The ICE servers** are the service's STUN servers. A TURN server a service names cannot be used
  by the app, as by no client today: the service and every client keep only each server's `urls`, so
  no user name or credential reaches them. The app has no relay setting of its own. A relay the
  computer's owner names serves the phone as it serves a browser, from the computer's side.
