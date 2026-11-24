// Builds the app into dist/ (the page) and dist-electron/ (main process and preload).
//   node scripts/build.mjs            everything
//   node scripts/build.mjs --main     only the main process and the preload (what `dev` needs)
import { build } from "esbuild";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";

const root = path.resolve(import.meta.dirname, "..");

/** The main process and the preload, into `<app>/dist-electron`. */
export async function buildMain(app = root) {
	const common = { bundle: true, platform: "node", target: "node24", external: ["electron", "node-pty", "node-datachannel", "ssh2", "bonjour-service"], sourcemap: true, logLevel: "warning", absWorkingDir: root };
	// A module bundled into it that is CommonJS (ws, of the agent's browser in the window) requires Node's own: an ES module has no require of its own.
	const require = "import { createRequire as pineRequire } from 'node:module'; const require = pineRequire(import.meta.url);";
	await build({ ...common, entryPoints: ["electron/main.ts"], outfile: path.join(app, "dist-electron", "main.js"), format: "esm", banner: { js: require } });
	// A sandboxed preload is loaded as a classic script.
	await build({ ...common, entryPoints: ["electron/preload.ts"], outfile: path.join(app, "dist-electron", "preload.cjs"), format: "cjs" });
}

/** The page, into `<app>/dist`. */
function buildPage(app = root) {
	// Built elsewhere (for the tests), quietly.
	const elsewhere = app === root ? [] : ["--outDir", path.join(app, "dist"), "--emptyOutDir", "--logLevel", "warn"];
	execFileSync(process.execPath, [path.join(root, "node_modules", "vite", "bin", "vite.js"), "build", ...elsewhere], { cwd: root, stdio: "inherit" });
}

/**
 * The whole app built into a folder of its own (`into`), for the tests: a run tests what it
 * built, and two runs at once (two checkouts, or two files of one run) never read a build that
 * another one is writing. Returns the folder Electron is started with: `<into>/desktop`, laid out
 * as desktop/ is in the checkout, so that the app finds this checkout's pine one folder up
 * (`findPine`). What is not built is linked, not copied.
 */
export async function buildApp(into) {
	const app = path.join(into, "desktop");
	fs.mkdirSync(app, { recursive: true });
	await buildMain(app);
	buildPage(app);
	fs.copyFileSync(path.join(root, "package.json"), path.join(app, "package.json"));
	for (const name of ["node_modules", "assets"]) fs.symlinkSync(path.join(root, name), path.join(app, name));
	for (const name of ["bin", "src"]) fs.symlinkSync(path.join(root, "..", name), path.join(into, name));
	// Electron's own program is fetched on its first use, not by `npm install`. Fetched here, once:
	// two tests that start the app at once in a fresh checkout would each fetch it into the same place.
	createRequire(import.meta.url)("electron");
	return app;
}

if (import.meta.filename === process.argv[1]) {
	await buildMain();
	if (!process.argv.includes("--main")) buildPage();
}
