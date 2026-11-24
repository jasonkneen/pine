// `npm run build`: the web client into dist/, which the relay's Worker serves (web/relay,
// wrangler.jsonc). dist/page/ is the desktop page built by Vite (vite.config.ts); dist/index.html
// and dist/bridge.js are the web bridge, the top-level document, bundled with the SSH core.
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { build as vite } from "vite";
import { bundle } from "./bundle.ts";

const here = path.resolve(import.meta.dirname, "..");
const dist = path.join(here, "dist");
const version = JSON.parse(readFileSync(path.join(here, "..", "package.json"), "utf8")).version as string;

await vite({ configFile: path.join(here, "vite.config.ts"), logLevel: "warn" });

const script = await bundle(path.join(here, "src", "bridge-main.ts"), { define: { __PINE_WEB_VERSION__: JSON.stringify(version) }, minify: true });
writeFileSync(path.join(dist, "bridge.js"), script);

// The bridge's own policy: its script, its relay on the same host, and the page's frame; nothing from elsewhere.
const csp = ["default-src 'none'", "script-src 'self'", "style-src 'unsafe-inline'", "connect-src 'self'", "frame-src 'self'", "base-uri 'none'", "form-action 'none'", "object-src 'none'"].join("; ");
writeFileSync(
	path.join(dist, "index.html"),
	`<!doctype html>
<html lang="en">
	<head>
		<meta charset="utf-8" />
		<meta http-equiv="Content-Security-Policy" content="${csp}" />
		<meta name="viewport" content="width=device-width, initial-scale=1" />
		<meta name="color-scheme" content="light dark" />
		<title>Pine</title>
		<style>
			html, body { margin: 0; height: 100%; background: #1b1e28; color: #e4e6ee; font: 16px system-ui, sans-serif; }
			iframe { display: block; border: 0; width: 100%; height: 100%; }
			.unsupported { max-width: 32rem; margin: 20vh auto; padding: 0 16px; line-height: 1.5; }
			.choice { position: fixed; inset: 0; overflow: auto; box-sizing: border-box; padding: 20vh max(16px, calc(50% - 16rem)) 16px; background: #1b1e28; line-height: 1.5; }
			.choice h1 { font-size: 1.25rem; margin: 0 0 0.5rem; }
			.choice p { margin: 0 0 1.5rem; }
			.choice .note { margin: 1rem 0 0; }
			.choice button { display: block; width: 100%; margin: 0 0 0.75rem; padding: 0.75rem 1rem; border: 1px solid #3a3f52; border-radius: 0.5rem; background: transparent; color: inherit; font: inherit; }
			.choice button[data-choice="app"] { background: #e4e6ee; color: #1b1e28; border-color: #e4e6ee; }
		</style>
	</head>
	<body>
		<script src="bridge.js"></script>
	</body>
</html>
`,
);
console.log(`web client ${version} built into ${path.relative(process.cwd(), dist) || "."}`);
