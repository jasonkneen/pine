# Designing pine's page

pine's page (the Pine app, the web client and the mobile app draw the same `src/`) is stock shadcn
on Base UI with Tailwind v4, in the style `components.json` names. The shadcn skill says how shadcn
works; this file says how pine holds to it. Read the skill (`.agents/skills/shadcn/SKILL.md` and
its `rules/`), then this, before you change `src/` and when you review such a change.
`npm run check` enforces what can be checked mechanically (`scripts/stock-check.mjs`).

## Stock is the design

**Compose before you write.** Every part is stock components, composed the way shadcn's docs and
examples compose them, with their own variants, sizes and gaps. A page of a kind (settings, a
list, an empty state, a framed block, a conversation) is the stock composition of that kind: find
shadcn's example for it and follow it. A good page reads like a shadcn example with pine's words
in it.

**The registry owns `components/ui`.** Its files are what the shadcn CLI writes for
`components.json`, and change only through the CLI. What stock cannot say in place is a
composition in `src/components/` that wraps the stock part; a wrapper that only renames or
bundles stock parts has no place.

**`className` places, the component styles.** A class says what the component cannot know: how
wide, where it aligns, whether it wraps, grows or truncates. Colour, type and spacing inside a
component are the component's. Classes are on Tailwind's default scale; an arbitrary value is for
what no utility can say, and carries its reason in the stock check's allow-list.

**Colour is a role.** Every colour is a semantic token, so that every theme reaches it; a raw
colour reaches none. Where shadcn has no name for a role, pine adds the role to the theme
(`src/index.css`), never a colour to the markup.

**Space comes from containers.** Vertical rhythm is the stock containers' own gaps, nested as
shadcn nests them. A gap of your own is for parts no stock container holds, and takes a step the
stock ones use.

**The stylesheet is a bridge.** `src/index.css` holds stock Tailwind and shadcn, the theme's
tokens, and what no `className` can reach. A look belongs in the markup.

## When pine departs from stock

pine departs from stock only for a reason that holds across the page, never for one screen. These
are the reasons; a departure that fits none of them is not made.

**Reading comes first.** Text the owner reads at length is at the body's size; the controls
around it stay stock. A stock behaviour that serves the reader is kept even when it looks like
something to fix (fields at 16px on small screens, so iOS does not zoom on focus).

**Shapes stay put.** A part keeps its shape and its line when its state or its room changes: a
badge does not raise the line it sits on, a button that loses its label stays a button, a field's
text keeps the form's font, items in a row stay apart enough to read as several.

**Quiet over busy.** Nothing draws attention it has not earned: no focus ring where focus is
always, no fade where nothing hides, and what runs all the time costs nearly nothing to draw
(a stepped fade, never a shimmer that repaints every frame; `test/view-perf.test.ts` measures it).

**Content is not chrome.** The theme colours the app, not what the app shows: a QR code, a web
page or a picture keeps its own colours.

## When a request and stock disagree

Stock wins, unless one of the reasons above covers the request. Build the stock version and name
the gap in your answer: what was asked, what stock does instead, what departing would cost. When
the owner chooses to depart, the change says which reason it follows, or adds a reason here.
