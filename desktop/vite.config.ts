import path from "node:path";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig, type Plugin } from "vite";

/**
 * Two pages where desktop/ is the root: the app's, and the frame a view of the owner's runs in (view.html,
 * src/view-frame.ts). The mobile app and the web client build this page with this configuration too, from
 * a root of their own: they run no view, and get no frame.
 */
function viewFrame(): Plugin {
	return {
		name: "pine-view-frame",
		apply: "build",
		// Only the app's own build: Storybook builds from this folder too, with an input of its own (iframe.html).
		config: (c) => (path.resolve(c.root ?? process.cwd()) === import.meta.dirname && !c.build?.rollupOptions?.input && !c.build?.rolldownOptions?.input ? { build: { rollupOptions: { input: { main: path.resolve(import.meta.dirname, "index.html"), view: path.resolve(import.meta.dirname, "view.html") } } } } : undefined),
	};
}

export default defineConfig({
	base: "./",
	// No lightningcss on the CSS, neither Tailwind's pass nor Vite's minifier: lightningcss (1.33) folds
	// `animation-timeline` into the `animation` shorthand, which Chromium drops whole, and shadcn's
	// `scroll-fade` then never fades in a build (it does with `vite dev`). esbuild keeps the longhand.
	plugins: [react(), tailwindcss({ optimize: false }), viewFrame()],
	// "@/": the page's sources, the alias shadcn's components are written with.
	// The page's stand-in for the preload's bridge is for `npm run dev:preview` only (scripts/preview.ts
	// sets this true): in the app, in Storybook and in a build it is false, and the stand-in is left out.
	define: { __PINE_PREVIEW__: "false" },
	resolve: { alias: { "@": path.resolve(import.meta.dirname, "src") } },
	// The one file from outside this folder that the page is made of: the bars of a sound are measured by
	// pine's own code. A build takes it as it is; `vite dev` serves nothing from outside unless it is named.
	// The views' module (src/view-kit.ts) too: the frame gives it to the view it runs.
	server: { fs: { allow: [import.meta.dirname, path.resolve(import.meta.dirname, "../src/tui/levels.ts"), path.resolve(import.meta.dirname, "../src/view-kit.ts")] } },
	// PINE_DESKTOP_DEBUG=1: a build that can be read, for an error that only says where it is in the bundle.
	build: { outDir: "dist", emptyOutDir: true, target: "chrome140", chunkSizeWarningLimit: 4000, minify: !process.env.PINE_DESKTOP_DEBUG, cssMinify: process.env.PINE_DESKTOP_DEBUG ? false : "esbuild" },
});
