// The web client's bridge runs the same command on the other machine as the Pine app does,
// over an exec channel of its own SSH: it keeps a copy (web/src/remote-command.ts, since the
// browser build cannot load src/remote.ts), which has to be what src/remote.ts builds.
import assert from "node:assert/strict";
import { test } from "node:test";
import { remoteCommand } from "../src/remote.ts";
import { REMOTE_COMMAND } from "../web/src/remote-command.ts";

test("web: the bridge's remote command is the one src/remote.ts builds", () => {
	assert.equal(REMOTE_COMMAND, remoteCommand(), "copy the output of remoteCommand() into REMOTE_COMMAND in web/src/remote-command.ts");
});
