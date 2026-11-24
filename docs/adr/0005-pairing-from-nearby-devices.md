# 0005: Pairing from nearby devices

Status: accepted. Amends what ADR 0004 says of pairing, "Pairing happens at that computer and
nowhere else": a device on the same network may now start a pairing without a code. The owner
still allows it at that computer, and nowhere else.

## Context

Pairing a phone or a browser with the Pine app started at the computer (ADR 0004): Settings >
Browser access > Add a device showed a QR code (a 128-bit code, for one use, two minutes), the
device scanned it, the owner compared four digits and pressed Allow. Three things were slow:
finding the dialog, scanning the code, and the question itself, an alert that existed only inside
that section of Settings. A phone on the same Wi-Fi as the computer, which is how most owners pair,
should find the computer by itself.

## Decision

**The computer announces itself on the local network.** With Bonjour (mDNS and DNS-SD), through
the `bonjour-service` package, pure JavaScript, in the app's main process
(`desktop/electron/access/nearby.ts`): one code for macOS, Windows and Linux. The service type is
`_pine._tcp`. The instance name is "Pine" and the first 8 characters of the machine id
(`Pine 3fK9x2Qa`), never the computer's own name. The record names port 9, the discard port:
DNS-SD requires a port, nothing listens there and nothing connects to it. Its TXT record says four
things: `v=1`, `id=<machine id>`, `service=<the https origin of the meeting service>` and
`nonce=<16 random bytes, base64url>`. The service is there because a computer may wait at its
owner's own deployment, not Pine's. The nonce changes every five minutes while the computer is
announced (`NONCE_MS`), and each change is announced anew. The
library, and its socket on port 5353, exist only while something is announced. The computer is
announced while browser access is on, the host waits at the service, "Visible on this network" is
on, and no suspension holds (below).

**"Visible on this network"**, a switch under Browser access in Settings > Browser access. On by
default (`access.visible` in the app's `prefs.json` is written only as `false`). Off: nothing is
announced and a request without a code is refused. The QR code and the link work as before.

**No new transport.** The record only says "this machine id waits at this meeting service". A
device that found it joins the machine's meeting room at that service by that id, as with a
pairing link, over the same WebRTC data channel and SSH, and checks the host key against the
machine id during key exchange. The computer's real name is told to the device only over that
connection.

**A pairing request without a code.** The device connects under the SSH user name
`nearby.<nonce>` (`NEARBY_USER`), beside `pair.<code>`, with the nonce of the announcement it
heard, and runs the same `pine-pair` command. The computer takes the current nonce or the one
before it, compared in constant time, and nothing else. So only a device that hears the
announcement, on the same network, can ask: the machine id alone, which every pairing link and
every announcement ever heard carry, is not enough. From then on it is the request a code makes:
four random digits written to the channel, the owner asked with the device's name and the same
digits, and only Allow stores the key. The first line the computer writes is now
`{"code","computer","service"}` for both kinds of request: the four digits, the computer's name, so
that a device that found "Pine 3fK9x2" can say "Confirm on Studio Mac", and the meeting service it
waits at. The phone keeps that service, said by the computer that holds the key, and refuses a
codeless pairing whose announcement named another one: a forged record cannot make it keep a
service of someone else's.

**One question, one answer.** Each question has an id. The owner's Allow or Refuse names it, and
the app refuses an answer to a question that is no longer the one asked. A codeless request never
stands beside a code's, nor the reverse, checked again when the request is made. Allow is inert for
a second after a question appears, so that a click meant for something else allows nothing.

**Limits on requests without a code.** An unpaired device has no identity to count by, so the
limits are global (`desktop/electron/access/pairing.ts`):

- let in only while the computer is visible, read at each request;
- one at a time: refused while another codeless session holds its place, and while the owner is
  asked about a code's request;
- a session let in has 10 seconds to make its request; one that leaves gives its place back; and
  two sessions are let in no closer than 3 seconds apart, so that one that never asks cannot hold
  the place without a break;
- a request that ends without a yes counts as a refusal: the owner refused it, or the requester
  hung up or let it expire after it was shown. Otherwise hanging up would ask again and again for
  free;
- 30 seconds of refusals after such an end;
- three such ends within ten minutes suspend visibility, the announcement and the requests, for an
  hour. A toast says "Visibility paused after 3 refusals", with "Turn on now"; turning the switch
  on ends the suspension;
- what is refused is refused silently: no toast, no notification. Only a request that reaches the
  owner shows anything.

Each is a test in `desktop/test/access-pairing.test.ts` (the `nearby:` tests),
`desktop/test/access-control.test.ts` and `desktop/test/access-nearby.test.ts`.

**How the question is shown, for both kinds of request.** Window in front: a toast at the root of
the app (`desktop/src/DevicePairing.tsx`, Base UI's toast), wherever the owner is: "<device> wants
to connect", the four digits large, Refuse and Allow. It never takes the keyboard's focus (an Enter
typed in the input must not answer it), and stays while the question stands. It replaces the alert
of Settings > Browser access: one way. Window not in front: a system notification, "<device>
wants to connect", "Allow it in Pine if the device shows 1234.", with no Allow in it; a click
brings Pine forward. It is shown whatever the notification setting, as a question that waits for
the owner is.

**Add a device from anywhere.** "Add a Device…" in the Pine menu (the File menu on other systems),
`⌘⇧D` (`Ctrl+Shift+D`), in the Dock's menu, and `device` in the palette. Each opens the Add a device
dialog with its QR code.

**`pine://pair`, for a browser on the same computer.** The web client, in a browser on a computer
(not a phone or a tablet), offers "Open Pine on this computer": its top document opens
`pine://pair`. The app registers the `pine` scheme (electron-builder's `protocols`,
`app.setAsDefaultProtocolClient` in a packed app, or from a checkout with
`PINE_DESKTOP_PROTOCOL=1`, never in a test), and is handed the address by `open-url` on macOS and
as an argument on Windows and Linux. On exactly `pine://pair`, while browser access is on, it opens
a pairing as Add a device does, opens its link in the default browser, and shows the same pairing
in the Add a device dialog, for a browser that is not the default one. With browser access off it
does nothing, and any other `pine:` address (the mobile app's `pine://pair?service=...`) is ignored.

**The mobile app looks.** Android with `NsdManager`, which needs no permission beyond `INTERNET`;
iOS with `NWBrowser`, with `NSBonjourServices` (`_pine._tcp`) and `NSLocalNetworkUsageDescription`
in `Info.plist`. It looks only while the pairing view is shown, so that iOS asks for the local
network then and never at launch. The view lists each computer as "Pine" and the first 6
characters of its id. A tap starts the request without a code.

## Why an announcement proves nothing, and what does

Anyone on the network can announce anything, so the machine id a device learns there is not
trusted. Two cases:

- **An impostor announces the owner's machine id.** The device goes to that id's meeting room, at
  the service the record names, and checks the host key during key exchange. Only the owner's
  computer holds the key whose fingerprint is that id. So the device reaches the owner's computer
  or nobody: a service of the impostor's that sends it elsewhere gets it refused.
- **An impostor announces its own id.** That is another computer, the impostor's, and the device
  can pair with it if the impostor allows it there. The owner's computer is not touched: no
  question appears on its screen, and nothing of the owner's is opened. What protects the owner is
  the question on their own screen: a phone that says "Confirm on Studio Mac" while Studio Mac asks
  nothing is not talking to Studio Mac. The name in "Confirm on" is the computer's own word and
  proves nothing either.

The other way round, a device that asks the owner's computer without a code has to be on the same
network, since it needs the nonce it heard there. It gets nothing without Allow at that computer,
and the four digits tie that Allow to the device the owner holds: a request whose digits no screen
in front of the owner shows is refused. The limits above keep such requests from becoming a stream
of questions.

What a device on the same network can still do: hear the machine id and the service, and learn the
computer's name by asking (the name comes with the digits, before the owner answers); put up to
three questions in front of the owner, then have visibility suspended for an hour, which keeps the
owner's own phone from finding the computer meanwhile (the code still works); and hold the one
place for requests most of the time, by connecting again every few seconds, with the same effect.
None of it pairs anything. On a network you do not trust, turn "Visible on this network" off.

## Alternatives considered

**A local server: the device connects to the computer over the local network.** Rejected: rule 10
keeps the daemon on the loopback, the access server is reached only through the data channel, and
a second transport would be a second thing to secure. The meeting service and WebRTC already find
the direct path on the same Wi-Fi.

**Discovery in the web client.** Not possible: a page cannot browse mDNS. The web client keeps the
QR code and the link, and on a computer it gets `pine://pair`.

**The name "Pine" alone.** `bonjour-service` does not rename an instance whose name is taken on
the network: it gives up announcing. So with one name only one computer per network could be found.
The start of the machine id keeps them apart without telling the network the computer's name.

**The computer's own name in the record.** Rejected: a record is read by everyone on the network.
The name is told over the connection, after the host key was checked.

**An Allow button in the system notification.** Rejected: one place to answer, in the app, where
the digits are large and the owner is looking at Pine.

**Limits per device.** Not possible: an unpaired device's key and name are its own to choose.

## Consequences

- Rule 10 is unchanged: the transport, the access server's two permissions and the meeting
  protocol are as in ADR 0004. What changed is who may start a request, never who answers it.
- While visible, the machine id is announced on every network the computer joins. It is a public
  key's fingerprint and opens nothing, but it recognises the computer from one network to the next.
  A device on that network that asks also learns the computer's name before the owner answers;
  the nonce keeps that to the network the computer is on. On a network you do not trust, turn
  "Visible on this network" off.
- Every site can open `pine://pair`, but while a pairing is open or a device asks, the address does
  nothing: it never replaces the owner's pairing.
- Every site can open `pine://pair`. The browser asks first, the link goes only to this computer's
  default browser, and nothing is kept without Allow. At worst a pairing opens on its own, with its
  page in the browser and the Add a device dialog, and the owner closes them.
- macOS 15 and later may ask whether Pine may find devices on the local network the first time the
  app announces itself. The packed app's `Info.plist` says why (`NSLocalNetworkUsageDescription`)
  and names `_pine._tcp` (`NSBonjourServices`); an app run from a checkout is Electron's, without them.
- On Windows, the firewall is likely to ask about Pine the first time it opens its multicast
  socket.
- On some Linux systems avahi holds port 5353 for itself, and `bonjour-service` cannot announce.
  A fallback would be avahi's D-Bus interface. The code and the link work without it.
- On Linux the `pine` scheme needs a `.desktop` entry with `MimeType=x-scheme-handler/pine`
  (the AppImage), which is not written yet.
- Left for later: a notification when a device that still has a computer's id asks again, and
  discovery in the web client.
