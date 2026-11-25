# Designing pine's page

pine's page (the Pine app, the web client and the mobile app draw the same `src/`) is stock shadcn
on Base UI with Tailwind v4, in the style `components.json` names. This file says how pine applies
that; the shadcn skill says how shadcn works. Read the skill first
(`.agents/skills/shadcn/SKILL.md` and its `rules/`), then this, before you change `src/` and when
you review such a change. `npm run check` runs the mechanical part (`scripts/stock-check.mjs`).

## Principles

**Stock first.** Build every part from stock components, composed as shadcn's docs and examples
compose them, with their own variants, sizes and gaps. Before writing markup, look for the
component (`npx shadcn@latest search`, `docs <name>`) and for the example that already shows the
composition. A good page reads like a shadcn example with pine's words in it.

**`components/ui` is the registry's.** Every file there is what the shadcn CLI writes for
`components.json`: add and update with `npx shadcn@latest add`, compare with `--diff`. This holds
for the chat components too (`npx shadcn add message`): AI Elements is shadcn's pages of
patterns, code to compose in pine's own files, never Vercel's `@ai-elements` registry, which is
written on Radix. A part stock cannot say in place goes in `src/components/`, wrapping the stock
one; a wrapper that only renames or bundles stock parts has no place.

**`className` for layout.** Use it for what the stock parts cannot know: width, alignment,
wrapping, growing, truncating, which side of a container. Write it on Tailwind's default scale
(`max-w-2xl`, `basis-80`, `gap-4`). Colour, type and spacing inside a component come from the
component. An arbitrary value (`[...]`) is for what no utility can say, and goes on the allow-list
in `scripts/stock-check.mjs` with its reason.

**Semantic tokens.** Colour comes from shadcn's tokens (`bg-muted`, `text-muted-foreground`,
`border`) and, where shadcn has no name, from pine's few role utilities (`text-warn`,
`text-faint`, `text-add`...). A theme sets every one of them; a raw colour would not follow it.
`docs/references/desktop.md` ("How the page is drawn") lists the roles and how a theme reaches
them.

**One rhythm.** Vertical space comes from the stock containers' own gaps (`FieldGroup`,
`FieldSet`, `Card`, `Empty`, `Item`), nested as shadcn nests them. Reach for a gap of your own
only between parts no stock container holds, and then on the same steps the stock ones use.

**Stylesheet.** `src/index.css` is stock Tailwind and shadcn, the theme bridge (pine's roles and
shadcn's tokens pointing at them), and what a `className` cannot reach (the window's chrome,
selection and find highlights, the portal's drag region). Every other look lives in the markup.

## Pages as stock compositions

| Part | Stock composition |
|---|---|
| A settings page | `FieldGroup` of `FieldSet`s (`FieldLegend`, `FieldDescription`, `Field`s), a `FieldSeparator` between sets; aligned to the start beside its menu, at a readable max width |
| A row of a list | `Item` (`ItemMedia`, `ItemContent`, `ItemActions`) in an `ItemGroup` |
| Something framed | `Card` with its header, content and footer parts |
| Nothing to show yet | `Empty` (`EmptyHeader`, `EmptyMedia`, `EmptyTitle`, `EmptyDescription`, `EmptyContent`) |
| A notice in place | `Alert` |
| Loading with a known shape | `Skeleton` of that shape; `Pulse` for work under way (`docs/references/desktop.md`, "Loading") |
| The conversation and its input | The chat components and patterns (`rules/chat.md`), as `Conversation.tsx` and `Composer.tsx` compose them |

A button's variant says what it does, the same on every page: the table in
`docs/references/desktop.md` ("How the page is drawn").

## Where pine departs from stock

pine departs from stock only for one of the reasons below. Each names where it shows today, so
that you recognise it and leave it as it is. A new departure fits one of them, or is not made.

**Reading text reads at the body's size.** What the owner reads at length (a conversation's
answers, their own messages, the message box) is `text-base` with `leading-snug`; the controls
around it stay stock `text-sm` (`TRANSCRIPT` in `Conversation.tsx`, `Composer.tsx`).

**Small things sit on the line they belong to.** A badge in a field's title is `h-4`, so the
title keeps its height. Items in a row (tabs, Settings' menu) stand `gap-1` apart, so they read
as a list and not as one block.

**A control keeps its shape when it changes.** A button that loses its label at a narrow width
becomes the square icon button of its size. A number in a field is text of the form, in the
app's font. The message box, where typing always goes, shows no focus ring.

**What runs all the time costs nearly nothing.** Work under way is `Pulse`, one dot that ticks
in steps everywhere, in place of `Spinner`; a trace line at work fades in steps in place of the
stock shimmer, which repaints every frame (`STEPPED` in `Conversation.tsx`; `test/view-perf.test.ts`
measures both).

**Content keeps its own colours.** The theme colours the app, not what it shows: a QR code stays
black on white for its contrast, a web page keeps its own white backdrop.

**Stock that looks deliberate is kept.** Some stock choices look like something to fix and are
not: fields are 16px below `md` (iOS zooms into a smaller one on focus), and the conversation
fades at the bottom only (`MessageScrollerViewport` carries `scroll-fade-b`). Leave them.

## When a request and stock disagree

Stock wins, unless one of the reasons above covers the request. Otherwise build the stock
version and name the gap in your answer: what was asked, what stock does instead, what a
departure would cost. When the owner then chooses a departure, say in this file which reason it
follows, or add the reason, in the same change.
