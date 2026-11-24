// The mobile app's native cores (mobile/core on Android, the iOS one) run the same command on the
// other machine as the Pine app does: they read it from one shared file, which has to be what
// src/remote.ts builds.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { remoteCommand } from "../src/remote.ts";

const file = path.join(import.meta.dirname, "..", "mobile", "cases", "remote-command.txt");

test("mobile: the native cores' remote command is the one src/remote.ts builds", () => {
	assert.equal(fs.readFileSync(file, "utf8"), remoteCommand(), `write the output of remoteCommand() into ${path.relative(process.cwd(), file)}, without a line break at the end`);
});
