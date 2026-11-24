// Development: the page from Vite's server (it reloads as you edit), the main process built once.
// The page is served at this checkout's own port (scripts/launch-json.mjs; $PORT wins, and the next
// free one is taken when it is in use). Electron, and the daemon it started, end with this process,
// and this process ends with whatever started it (scripts/leash.mjs).
//   npm run dev
import { spawn } from "node:child_process";
import path from "node:path";
import { createServer } from "vite";
import { buildMain } from "./build.mjs";
import { ports } from "./launch-json.mjs";
import { whenParentGone } from "./leash.mjs";
import { devElectron } from "./dev-electron.mjs";

const root = path.resolve(import.meta.dirname, "..");
let server;
let child;
let leaving = false;

// Armed before anything starts, so that a starter that dies during the build or Vite's start
// leaves nothing behind. Electron quits on SIGTERM and stops the daemon it started; one that does
// not is ended. Before Electron runs there is only the server to close.
whenParentGone(() => {
	leaving = true;
	if (!child || child.exitCode !== null) return void Promise.resolve(server?.close()).finally(() => process.exit(0));
	child.kill("SIGTERM");
	setTimeout(() => child.kill("SIGKILL"), 15_000).unref();
});

await buildMain();
server = await createServer({ root, server: { port: Number(process.env.PORT ?? ports().dev), strictPort: false } });
await server.listen();
// The starter went while Vite was starting: Electron is not started for nobody.
if (leaving) process.exit(0);
const url = server.resolvedUrls.local[0];
// Started as Pine, so that the menu bar and the Dock say Pine (scripts/dev-electron.mjs).
child = spawn(devElectron(), [root, ...process.argv.slice(2)], { stdio: "inherit", env: { ...process.env, PINE_DESKTOP_DEV_URL: url } });
child.on("close", async (code) => {
	await server.close();
	process.exit(code ?? 0);
});
