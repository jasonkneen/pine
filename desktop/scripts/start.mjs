// npm start (npm run desktop at the top of the checkout): the app, built by scripts/build.mjs just
// before, started as Pine (scripts/dev-electron.mjs). It ends when the app ends, with the app's code.
import { spawn } from "node:child_process";
import path from "node:path";
import { devElectron } from "./dev-electron.mjs";

const root = path.resolve(import.meta.dirname, "..");
const child = spawn(devElectron(), [root, ...process.argv.slice(2)], { stdio: "inherit" });
for (const signal of ["SIGINT", "SIGTERM"]) process.on(signal, () => child.kill(signal));
child.on("close", (code, signal) => process.exit(code ?? (signal ? 1 : 0)));
