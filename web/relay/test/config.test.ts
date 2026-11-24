// The configuration that is deployed, read as wrangler reads it: one configuration, from which every
// channel of .github/workflows/web-preview.yml (pine-main, pine-next, pine-pr-<number>) is a Worker of
// its own under its own name. Each is a whole deployment: the web client, the relay and the meeting
// service, on workers.dev. None of them has any logs.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";

const root = path.join(import.meta.dirname, "..");
/** wrangler.jsonc without its comments, which here stand on lines of their own. */
const config = JSON.parse(
	readFileSync(path.join(root, "wrangler.jsonc"), "utf8")
		.split("\n")
		.filter((line) => !/^\s*\/\//.test(line))
		.join("\n"),
);

test("one configuration and no environment: every channel is the same deployment under its own name", () => {
	assert.equal(config.env, undefined);
	assert.equal(typeof config.name, "string");
});

test("the relay is on", () => {
	assert.equal(config.vars.RELAY, "on");
});

test("each deployment has an address of its own on workers.dev and asks for no version addresses", () => {
	assert.equal(config.workers_dev, true);
	assert.equal(config.preview_urls, false);
});

test("the meeting's Durable Object is declared, backed by SQLite as the free plan requires", () => {
	assert.deepEqual(config.durable_objects.bindings, [{ name: "MEET", class_name: "Meeting" }]);
	assert.ok(config.migrations.some((m: any) => m.new_sqlite_classes?.includes("Meeting")));
	assert.ok(!config.migrations.some((m: any) => m.new_classes?.includes("Meeting")), "a key-value class is not on the free plan");
	assert.ok(config.vars.ICE.every((s: any) => /^stun:/.test(s.urls)));
});

test("the rate limit and the web client's files", () => {
	assert.ok(config.ratelimits.some((r: any) => r.name === "LIMITER"));
	assert.equal(config.assets.binding, "ASSETS");
});

test("observability stays off", () => {
	assert.equal(config.observability.enabled, false);
});

test("the workflow deploys each channel under its own name and deletes a pull request's when it closes", () => {
	const workflow = readFileSync(path.join(root, "..", "..", ".github", "workflows", "web-preview.yml"), "utf8");
	assert.match(workflow, /wrangler deploy --name "\$WORKER"/);
	assert.match(workflow, /-X DELETE[\s\S]*\/workers\/scripts\/\$WORKER\?force=true/);
	assert.doesNotMatch(workflow, /--env|versions upload|preview-alias/);
});

test("nothing of a meeting is logged", () => {
	for (const file of ["meet.ts", "meet-object.ts", "site.ts", "worker.ts"]) {
		assert.doesNotMatch(readFileSync(path.join(root, "src", file), "utf8"), /\bconsole\./, file);
	}
});
