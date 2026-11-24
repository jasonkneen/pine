// The feed a release carries for the app's updater (scripts/update-feed.ts, written by scripts/pack.mjs).
import assert from "node:assert/strict";
import { test } from "node:test";
import { updateFeed } from "../scripts/update-feed.ts";

const when = new Date("2026-11-20T10:00:00.000Z");

test("update feed: names the zip and the feed after the version and the kind of Mac", () => {
	assert.deepEqual(updateFeed("0.40.1", "arm64", when).files, { zip: "Pine-0.40.1-arm64.zip", feed: "Pine-arm64.json" });
	assert.deepEqual(updateFeed("0.40.1", "x64", when).files, { zip: "Pine-0.40.1-x64.zip", feed: "Pine-x64.json" });
});

test("update feed: is a Squirrel.Mac JSON feed whose url is the zip on that release's tag", () => {
	assert.deepEqual(updateFeed("0.40.1", "arm64", when).json, {
		url: "https://github.com/pmndre/pine/releases/download/v0.40.1/Pine-0.40.1-arm64.zip",
		name: "0.40.1",
		pub_date: "2026-11-20T10:00:00.000Z",
	});
	assert.equal(updateFeed("1.2.3", "x64", when).json.url, "https://github.com/pmndre/pine/releases/download/v1.2.3/Pine-1.2.3-x64.zip");
});

test("update feed: refuses what is not a release version or a kind of Mac", () => {
	assert.throws(() => updateFeed("0.40.1-next.3", "arm64", when), /version/);
	assert.throws(() => updateFeed("../0.40.1", "arm64", when), /version/);
	assert.throws(() => updateFeed("0.40.1", "ia32", when), /arm64 or x64/);
});
