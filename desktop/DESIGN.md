# Designing pine's page

pine's page (the Pine app, the web client and the mobile app draw the same `src/`) is stock shadcn
on Base UI with Tailwind v4, in the style `components.json` names. The shadcn skill says how shadcn
works; this file says how pine holds to it. Read the skill (`.agents/skills/shadcn/SKILL.md` and
its `rules/`), then this, before you change `src/` and when you review such a change.
`npm run check` enforces what can be checked mechanically (`scripts/stock-check.mjs`).

The examples below illustrate a rule; they are not the code of any page.

## Stock is the design

**Compose before you write.** Every part is stock components, composed the way shadcn's docs and
examples compose them, with their own variants, sizes and gaps. A page of a kind (settings, a
list, an empty state, a framed block, a conversation) is the stock composition of that kind: find
shadcn's example for it and follow it. A good page reads like a shadcn example with pine's words
in it.

```tsx
// Do: a settings page as shadcn composes a form.
<FieldGroup>
  <FieldSet>
    <FieldLegend>Updates</FieldLegend>
    <Field orientation="horizontal">…</Field>
  </FieldSet>
  <FieldSeparator />
  <FieldSet>…</FieldSet>
</FieldGroup>

// Don't: the same page as headings and boxes of your own.
<div className="flex flex-col gap-6">
  <h3 className="text-sm font-medium">Updates</h3>
  <div className="rounded-lg border p-4">…</div>
</div>
```

**The registry owns `components/ui`.** Its files are what the shadcn CLI writes for
`components.json`, and change only through the CLI. What stock cannot say in place is a
composition in `src/components/` that wraps the stock part; a wrapper that only renames or
bundles stock parts has no place.

```tsx
// Do: the stock part where it is used.
<Button variant="outline" size="sm">Rename</Button>

// Don't: a new variant written into components/ui/button.tsx, or a wrapper that only renames.
const SmallButton = (props) => <Button variant="outline" size="sm" {...props} />
```

**`className` places, the component styles.** A class says what the component cannot know: how
wide, where it aligns, whether it wraps, grows or truncates. Colour, type and spacing inside a
component are the component's. Classes are on Tailwind's default scale; an arbitrary value is for
what no utility can say, and carries its reason in the stock check's allow-list.

```tsx
// Do: where the card goes and how wide it gets.
<Card className="w-full max-w-2xl self-start">

// Don't: restyling the card, or sizes off the scale.
<Card className="rounded-md p-3 text-[13px] max-w-[42rem]">
```

**Colour is a role.** Every colour is a semantic token, so that every theme reaches it; a raw
colour reaches none. Where shadcn has no name for a role, pine adds the role to the theme
(`src/index.css`), never a colour to the markup.

```tsx
// Do: a token, or a role the theme defines.
<span className="text-muted-foreground">…</span>
<span className="text-warn">…</span>

// Don't: a colour no theme can change.
<span className="text-[#fffac2]">…</span>
```

**Space comes from containers.** Vertical rhythm is the stock containers' own gaps, nested as
shadcn nests them. A gap of your own is for parts no stock container holds, and takes a step the
stock ones use.

```tsx
// Do: the container's gap.
<FieldGroup>
  <Field>…</Field>
  <Field>…</Field>
</FieldGroup>

// Don't: margins that fight it.
<FieldGroup>
  <Field className="mb-5">…</Field>
  <Field className="mt-1">…</Field>
</FieldGroup>
```

**The stylesheet is a bridge.** `src/index.css` holds stock Tailwind and shadcn, the theme's
tokens, and what no `className` can reach. A look belongs in the markup.

```css
/* Do: a role for the theme. */
@theme inline {
  --color-warn: var(--warn);
}

/* Don't: a look in the stylesheet, which changes every stock part it reaches. */
[data-slot="card"] {
  box-shadow: none;
}
```

## When pine departs from stock

pine departs from stock only for a reason that holds across the page, never for one screen. These
are the reasons; a departure that fits none of them is not made.

**Reading comes first.** Text the owner reads at length is at the body's size; the controls
around it stay stock. A stock behaviour that serves the reader is kept even when it looks like
something to fix (fields at 16px on small screens, so iOS does not zoom on focus).

```tsx
// Do: long text at the body's size, the controls left as they are.
<MessageContent className="text-base leading-snug">…</MessageContent>

// Don't: "fix" stock's text-base md:text-sm on a field.
<Input className="text-sm" />
```

**Shapes stay put.** A part keeps its shape and its line when its state or its room changes: a
badge does not raise the line it sits on, a button that loses its label stays a button, a field's
text keeps the form's font, items in a row stay apart enough to read as several.

```tsx
// Do: the badge fits the line; the label hides, the button stays.
<FieldTitle>Model <Badge variant="secondary" className="h-4">after a restart</Badge></FieldTitle>
<Button variant="outline"><PlusIcon data-icon="inline-start" /><span className="max-md:hidden">New</span></Button>

// Don't: a badge that makes the title taller; a labelled button squeezed to an odd shape.
```

**Quiet over busy.** Nothing draws attention it has not earned: no focus ring where focus is
always, no fade where nothing hides, and what runs all the time costs nearly nothing to draw
(a stepped fade rather than a shimmer that repaints every frame: measure it).

```tsx
// Do: an animation the system draws once per step.
<span className="animate-pulse [animation-timing-function:steps(4,jump-none)]" />

// Don't: a gradient swept across text for as long as work runs.
<span className="shimmer">Working…</span>
```

**Content is not chrome.** The theme colours the app, not what the app shows: a QR code, a web
page or a picture keeps its own colours.

```tsx
// Do: content in its own colours.
<svg className="bg-white fill-black">…</svg>

// Don't: a QR code in the theme's colours, unreadable in a dark one.
<svg className="bg-background fill-foreground">…</svg>
```

## When a request and stock disagree

Stock wins, unless one of the reasons above covers the request. Build the stock version and name
the gap in your answer: what was asked, what stock does instead, what departing would cost. When
the owner chooses to depart, the change says which reason it follows, or adds a reason here.
