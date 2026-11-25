// The stock check (scripts/stock-check.mjs) on texts of the test's own: what it lets through and what it
// names. Without the registry, which `npm run check` asks.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { classProblems, cssProblems } from "../scripts/stock-check.mjs";

const what = (found: Array<{ what: string }>) => found.map((p) => p.what);

test("stock check: the page as it is passes", () => {
	assert.deepEqual(cssProblems(fs.readFileSync(path.join(import.meta.dirname, "..", "src", "index.css"), "utf8")), []);
});

test("stock check: the default scale, variants and allowed values pass; other arbitrary values and raw colours do not", () => {
	assert.deepEqual(what(classProblems(`<div className="flex max-w-xl gap-4 data-[side=left]:pl-2 has-[>svg]:gap-2 md:text-sm [-webkit-app-region:drag]" />`)), []);
	assert.deepEqual(what(classProblems(`cn("mt-[13px]", "hover:max-w-[37rem]!", "[mask-image:none]")`)), ["mt-[13px]", "max-w-[37rem]", "[mask-image:none]"]);
	assert.deepEqual(what(classProblems(`"bg-[#1b1e28] text-[rgb(1,2,3)] text-blue-500 border-t-red-600/50 bg-background"`)), ["bg-[#1b1e28]", "text-[rgb(1,2,3)]", "text-blue-500", "border-t-red-600/50"]);
	assert.deepEqual(what(classProblems(`const first = list[0]; const re = /s[0-9a-z]/;`)), []);
});

test("stock check: index.css keeps to the theme bridge and the rules already there", () => {
	const stock = `@import "tailwindcss";\n:root { --bg: #000; }\n@theme inline { --color-x: var(--x); }\n@layer base {\n\t/* a comment { } */\n\tbody { @apply bg-transparent; }\n}\n`;
	assert.deepEqual(cssProblems(stock), []);
	const more = `${stock}@utility glow { box-shadow: 0 0 1px; }\n.card { padding: 0; }\n@layer components { .x { color: red; } }\n@layer base { a { @apply underline; } body { @apply mt-4; } }\n`;
	assert.deepEqual(what(cssProblems(more)), ["@utility glow", ".card", "@layer components", "a", "@apply underline", "@apply mt-4"]);
});
