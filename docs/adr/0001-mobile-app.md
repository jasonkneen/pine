# 0001: The Pine app on phones

Status: accepted

## Context

An owner's pine runs on a computer: a Mac with the Pine app, a Linux server, a VPS. Away from it,
the only way to reach it from a phone today is Telegram. Telegram gives a conversation and approval
buttons, but none of the Pine app's page: the agents, the conversations as tabs, the code pane,
settings, the browser panel, questions with free text, secrets typed into a request.

The owner wants the Pine app on the phone, as it is on the Mac, for any pine reachable over SSH.

The desktop app already reaches the pine of another machine over SSH (Settings > Environments,
`src/remote.ts`): it runs `pine service` there and talks to that daemon's control API on its
loopback through the SSH connection. Its page holds no token and has no Node (rule 10 in
`AGENTS.md`): Electron's main process holds the token and makes every call.

## Decision

**The goal.** As on the Mac: the phone is a client now, and may run a daemon of its own later.

**No daemon on iOS.** The App Store does not let an app keep a server running in the background:
background services only for their intended purposes (guideline 2.5.4), no unrelated background
processes that drain the battery (2.4.2). Node on iOS (nodejs-mobile)
is stuck on Node 18, which has no `node:sqlite`, and pine's store needs it.

**A daemon on Android later, through Termux.** Whether pine runs in Termux itself (native) or in a
Linux distribution inside it (proot-distro) is still open, and is settled when that step starts.

**One page, two shells.** The desktop stays on Electron, unchanged. The phone gets Capacitor around
the very same page (`desktop/src`), built by a Vite configuration that extends the desktop's. Every
change to the page lands on both. The page gains only two small changes: `state()` may say there is
no local machine, and the base of media addresses may come from the bridge.

**The token stays out of the page.** A native plugin (Kotlin, inside the Capacitor project) holds
it and makes every call, as Electron's main process does. Rule 10 holds on the phone; the plugin is
the other place that holds the token.

**SSH lives in the plugin, modelled on `src/remote.ts`.** The plugin runs the exact remote command
that `src/remote.ts` builds, reads the `pine service` line, checks the daemon's address as
`loopbackEnd` does, and words its failures as `sshTrouble` does. HTTP to the daemon goes through
SSH channels, never through a port on the phone, which every app on the phone could reach.

**Any SSH destination.** `user@host` or `user@host:port`, checked against the same rules as the
desktop's (no option for ssh, no spaces, no `;`), but with the user required: see "As built".
How the machine is reachable (same Wi-Fi, a VPN, a server with public SSH) is the owner's business:
the app embeds no network of its own.

**pi's SSH tool operations are not used.** They run an agent's tools on another machine. The app
needs a client connection to a daemon, which is a different thing.

**Keys.** On first use the app makes an Ed25519 key pair; the private key is encrypted with a key
of the Android Keystore. The app shows the public key to copy into the server's `authorized_keys`.
Host keys are trusted on first use: an unknown key is shown by its fingerprint for the owner to
confirm, and a changed key is refused, with a way to forget the stored one on purpose.

**No notifications at first.** Telegram is pine's only channel to the owner today. A foreground
service or push (FCM, APNs) is later work.

**Scope.** Everything the page does, except what needs Electron: the terminal, dictation, app
updates, the folder picker, running `pine init`, anything about "this Mac".

**Layout.** A package `mobile/` beside `desktop/`, with its own `package.json`, not part of what
goes to npm. The page moves into a package of its own, `app/`, later, when a third client appears.

**Distribution.** The APK is attached to every GitHub release from `main`, next to the Mac disk
images. The Play Store comes later.

**Tests.** Two seams. The mobile bridge is tested under `node:test` against a fake native plugin,
and type-checks as Electron's `Bridge`. The plugin's Kotlin core is tested on the JVM against an
in-process SSH server and a stand-in daemon. A root test fails when the remote command differs
between `src/remote.ts` and the plugin. End to end on an emulator is a manual script, outside CI.
`npm test` at the root stays as it is.

**Order.** The Android client first, then iOS, then the Termux daemon. The details of iOS are
settled when that step starts: they are in [0002](0002-ios-app.md).

## Alternatives considered

**Tauri 2 for both desktop and phone.** Rejected. It means a rewrite of the desktop shell in Rust,
three web engines to test against instead of one Chromium, and no Node on the phone either, so it
does not bring the daemon to the phone.

**A PWA.** Kept in reserve. A page served to a browser cannot keep the token from the page, cannot
hold an SSH connection, and would need the control API on a network. It stays an option if the
native app turns out to cost too much. For the browser, [0003](0003-web-client.md) supersedes this
paragraph: the top-level document holds the key and the token, the page runs in a sandboxed iframe,
and SSH runs in the browser.

**A daemon on the phone first.** Rejected for now: impossible on iOS, and on Android it waits for
the Termux question. A client covers what the owner asked for.

## Consequences

- The page has one more client to keep working: a change to the page is checked at phone width too,
  which Chromatic already snapshots.
- The `Bridge` type is now a contract between two implementations; the type check fails when they
  drift.
- The remote command has two homes, TypeScript and Kotlin, held together by a test.
- The release workflow gains a job that builds and signs the APK, and skips with a notice while its
  secrets are absent.
- The owner makes the machine reachable and adds the phone's key; the manual says how.
- The phone does nothing while the app is closed, until notifications are added.

## As built

What the first version settled that the decision above did not say, or said otherwise.

- **The bridge.** The page gained three optional bridge parts, not two: `local: false` in
  `state()` (no machine of its own), `mediaBase` (where the plugin answers media) and
  `deviceKey` (the phone's public key, with Copy and Share). Besides them, `trustHostKey`: an
  unknown host key is trusted only by an explicit "Trust this key" button beside its
  fingerprint. "Try again" only retries the connection and trusts nothing.
- **The Gate.** Under a bridge with no local machine, the first screen lists the machines and
  the field to add one, also while a machine is being connected to. The machine in use can be
  forgotten there when it is not reached, so that a dead machine does not lock the app.
- **The back button.** It closes what the page has open (a dialog, a sheet, a menu), else it
  leaves the app.
- **Hosts.** On the phone a host is `user@host` or `user@host:port`. A bare host is refused:
  the phone has no user name of its own to fall back on, as `ssh` on a computer does.
- **minSdk 26** (Android 8).
- **The page's policy is unchanged.** Capacitor injects its bridge as a script at document
  start, which runs under `script-src 'self'` without an inline script. A WebView too old to
  inject scripts that way is refused rather than the policy loosened for it.
- **The manual's synonyms.** "phone" was left out of `SYNONYMS` in `src/manual.ts`: it pulled
  questions about the `presence` source (is my phone at home) to the mobile app's part.
- **Tests.** The WebView's hardening (permissions, windows, file access, navigation) and the
  back button are proven by the smoke run on an emulator (`npm run smoke` in `mobile/`), which
  is run by hand before a release that changes `mobile/` or upgrades Capacitor. The Release
  workflow runs `npm run check` and `npm test` of `mobile/` before it builds the APK.

## Amended: the app pairs with the Pine app

The decision above said the app "embeds no network of its own": how a machine is reached was the
owner's business, over SSH on TCP. That kept out the owners who cannot set up Remote Login, an
address and a key in `authorized_keys`, and a phone that scanned the Pine app's QR code paired its
browser, not the app. So the app now pairs with a computer that runs the Pine app, by that QR
code, and reaches it peer to peer as a paired browser does ([0004](0004-browser-access.md)).

- **A second transport under the same SSH.** Each core opens the byte stream SSH runs on either
  as a TCP socket or as one WebRTC data channel (`ssh`, ordered, reliable) to a paired computer,
  set up through the meeting service the pairing link names. Everything above it (the remote
  command, direct-tcpip calls, the event stream, media) is the same code. The daemon's token and
  the phone's key stay in native code; the data channel lives there too, never in the WebView.
  `user@host` works as before.
- **Pairing in the cores.** A link is read by one parser on each side, replayed from shared cases
  (`mobile/cases/pair-links.json`, also read by the page): `https` services only, a machine id
  and a code of the expected shape. Pairing is an SSH session as `pair.<code>` with the phone's
  own key; the computer's host key must be the link's machine id before that key is offered. A
  paired computer is the machine `paired:<machine id>`, with its service and name kept beside it.
  Forget removes the entry on the phone and closes no access: Remove in the Pine app does.
- **The library differs by platform.** The plan was libdatachannel on both, for one API and for
  builds that run on the JVM and the Mac. On Android the owner chose Google's libwebrtc instead
  (`io.github.webrtc-sdk:android-prefixed-stripped`, LiveKit's build): libdatachannel's Android
  binding is aligned for 4 KB memory pages only, so it may not load on a phone with 16 KB pages,
  and the same binding (0.24.1), tried on the JVM against the Pine app's 0.24.6, lost the
  connection on bursts above about 1 MiB. libwebrtc
  comes stripped and aligned for 16 KB pages on 64-bit, and the release APK carries it for
  arm64-v8a and armeabi-v7a alone (about 22 MB instead of 43 MB with libdatachannel's four ABIs).
  It has no JVM build, so the Kotlin core reaches it through an interface (`WebRtc` in
  `mobile/core`), implemented in the app (`LibWebRtc.kt`) and, for the core's tests on the JVM,
  by the libdatachannel binding, a test dependency only. Should that binding stop serving the
  tests, `dev.onvoid.webrtc:webrtc-java` (libwebrtc for the desktop JVM) can take its place behind
  the same interface.
- **One more permission on Android.** libwebrtc reads the phone's networks and aborts the app
  without `ACCESS_NETWORK_STATE`. It is a normal permission: granted at install, never asked of
  the owner, and it reads only whether and which networks there are. The app asks for no camera:
  it has no scanner, and the phone's own camera reads the code.
- **How a link reaches the app.** On Android by App Links, for the official service's address and
  the release-signed APK only: the relay serves `/.well-known/assetlinks.json` once its
  configuration names the release key's fingerprint (`ANDROID_CERT_SHA256`), a step the
  maintainer does once by hand. Any other service or build opens the browser, as before, and the
  app takes a pasted link. On iOS by the `pine:` scheme ([0002](0002-ios-app.md)). Either way the
  link starts nothing: the page asks the owner first.
- **No background work.** Nothing keeps a connection alive: a locked phone drops it, and on
  return the health check makes it again whole (a new meeting, a new channel, a new SSH session),
  with a growing wait for the troubles that may pass. A key the computer no longer knows, or a
  changed host key, is final.
- **What proves it.** The cores' suites (`npm run test:core`, `swift test`) pair, call, reconnect
  and are refused against the Pine app's real access host, run under Node by a helper
  (`mobile/test/support/access-host.ts`). The smoke runs pair from end to end on the emulator and
  the simulator; on Android an instrumented test is the only proof of libwebrtc. A smoke run reaches
  its access host through a TLS front with a certificate authority of its own, trusted by the debug
  build (and the simulator) alone; no product code accepts `http`, and the cores' tests reach the
  helper's `http` service through a seam only a test can use. Not tried: a real phone, a
  16 KB-page device, cellular networks, AltStore or Sideloadly with the new IPA, a cold start by a
  `pine:` address.
