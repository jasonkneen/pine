// Capacitor's configuration: the page comes from the app itself and goes nowhere else.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { OFFICIAL_SERVICE } from "../../desktop/src/machines.ts";
import { ORIGINS } from "../src/plugin.ts";

const config = JSON.parse(fs.readFileSync(path.join(import.meta.dirname, "../capacitor.config.json"), "utf8"));

test("no remote content: the page is the built one, served by the app", () => {
	assert.equal(config.server.url, undefined);
	assert.equal(config.webDir, "dist");
	assert.equal(config.android?.allowMixedContent, false);
});

test("no navigation away from the page", () => {
	assert.deepEqual(config.server.allowNavigation, []);
});

test("the page's origin is the one its media base and policy name", () => {
	assert.equal(`${config.server.androidScheme}://${config.server.hostname}`, ORIGINS.android.app);
});

test("on iOS the page's origin is Capacitor's own scheme: WKWebView keeps https for itself", () => {
	assert.equal(`${config.server.iosScheme ?? "capacitor"}://${config.server.hostname}`, ORIGINS.ios.app);
});

test("the plugin intercepts the media base the bridge gives, on the origin it keeps the page to", () => {
	const links = fs.readFileSync(path.join(import.meta.dirname, "../core/src/main/kotlin/pine/mobile/core/Links.kt"), "utf8");
	const constant = (name: string) => links.match(new RegExp(`const val ${name} = "([^"]*)"`))?.[1];
	assert.equal(constant("APP_ORIGIN"), ORIGINS.android.app);
	assert.equal(`${constant("APP_ORIGIN")}${constant("MEDIA_PATH")}`, ORIGINS.android.media);
});

test("the iOS app: iOS 17 and later, and a sentence for the local network prompt", () => {
	const project = fs.readFileSync(path.join(import.meta.dirname, "../ios/App/App.xcodeproj/project.pbxproj"), "utf8");
	const targets = [...project.matchAll(/IPHONEOS_DEPLOYMENT_TARGET = ([\d.]+);/g)].map((m) => m[1]);
	assert.ok(targets.length > 0);
	assert.deepEqual(new Set(targets), new Set(["17.0"]));
	const plist = fs.readFileSync(path.join(import.meta.dirname, "../ios/App/App/Info.plist"), "utf8");
	assert.match(plist, /<key>NSLocalNetworkUsageDescription<\/key>\s*<string>[^<]{20,}<\/string>/);
	assert.match(project, /PRODUCT_BUNDLE_IDENTIFIER = dev\.pmndre\.pine;/);
});

test("the iOS app asks for nothing but the local network (no camera: a pairing link comes by its pine: address), and takes that scheme", () => {
	const plist = fs.readFileSync(path.join(import.meta.dirname, "../ios/App/App/Info.plist"), "utf8");
	assert.deepEqual([...plist.matchAll(/<key>(NS\w*UsageDescription)<\/key>/g)].map((m) => m[1]), ["NSLocalNetworkUsageDescription"]);
	assert.match(plist, /<key>CFBundleURLSchemes<\/key>\s*<array>\s*<string>pine<\/string>\s*<\/array>/);
});

test("on iOS the web view takes the whole screen (the page keeps itself inside the safe area), does not scroll, and shows no link previews", () => {
	assert.equal(config.ios?.contentInset, "never");
	assert.equal(config.ios?.scrollEnabled, false);
	assert.equal(config.ios?.allowsLinkPreview, false);
});

const manifest = fs.readFileSync(path.join(import.meta.dirname, "../android/app/src/main/AndroidManifest.xml"), "utf8");

test("the Android app asks for the network and the network's state (libwebrtc's, given at install) and nothing else: no camera, a pairing link comes as an App Link", () => {
	assert.deepEqual([...manifest.matchAll(/<uses-permission\s+android:name="([^"]+)"/g)].map((m) => m[1]).sort(), ["android.permission.ACCESS_NETWORK_STATE", "android.permission.INTERNET"]);
	assert.doesNotMatch(manifest, /<uses-feature|<permission\b|uses-permission-sdk/);
});

test("only a debug build trusts an authority besides the system's (the smoke run's), and only as Android's debug-overrides, which a debuggable app alone applies", () => {
	assert.doesNotMatch(manifest, /networkSecurityConfig|usesCleartextTraffic/);
	const debug = fs.readFileSync(path.join(import.meta.dirname, "../android/app/src/debug/res/xml/smoke_network_security.xml"), "utf8").replace(/<!--[\s\S]*?-->/g, "");
	const [base, overrides] = [debug.match(/<base-config[\s\S]*?<\/base-config>/)?.[0] ?? "", debug.match(/<debug-overrides>[\s\S]*?<\/debug-overrides>/)?.[0] ?? ""];
	assert.match(base, /cleartextTrafficPermitted="false"/);
	assert.deepEqual([...base.matchAll(/src="([^"]+)"/g)].map((m) => m[1]), ["system"]);
	assert.deepEqual([...overrides.matchAll(/src="([^"]+)"/g)].map((m) => m[1]), ["@raw/smoke_authority"]);
	assert.doesNotMatch(debug, /src="user"|domain-config/);
});

test("the Android app opens the official service's address, https only, verified by the statement the service serves (App Links)", () => {
	const filters = [...manifest.matchAll(/<intent-filter([^>]*)>([\s\S]*?)<\/intent-filter>/g)].filter((m) => m[2].includes("android.intent.action.VIEW"));
	assert.equal(filters.length, 1);
	const [, attrs, body] = filters[0];
	assert.match(attrs, /android:autoVerify="true"/);
	assert.match(body, /android\.intent\.category\.BROWSABLE/);
	assert.match(body, /android\.intent\.category\.DEFAULT/);
	const data = [...body.matchAll(/<data\s([^>]*?)\/>/g)].map((m) => Object.fromEntries([...m[1].matchAll(/android:(\w+)="([^"]*)"/g)].map(([, k, v]) => [k, v])));
	assert.deepEqual(data, [{ scheme: "https", host: new URL(OFFICIAL_SERVICE).host, path: "/" }]);
});
