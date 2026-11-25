import { type ComponentProps, type ComponentType, type RefObject, useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { HoverTooltip } from "@/components/hover-tooltip";
import { Button } from "@/components/ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";

export type Selected = { text: string; rect: DOMRect };

/** What a press on the bar is: not one that ends the selection. */
const BAR = "[data-selection-toolbar]";

const FIELD = "input, textarea, [contenteditable=''], [contenteditable='true']";

function within(root: HTMLElement, node: Node | null): boolean {
	if (!node || !root.contains(node)) return false;
	const el = node instanceof Element ? node : node.parentElement;
	return !el?.closest(FIELD);
}

function read(root: HTMLElement | null): Selected | undefined {
	const sel = window.getSelection();
	if (!root || !sel || sel.isCollapsed || !sel.rangeCount) return undefined;
	if (!within(root, sel.anchorNode) || !within(root, sel.focusNode)) return undefined;
	const text = sel.toString();
	if (!text.trim()) return undefined;
	const range = sel.getRangeAt(0);
	const rects = [...range.getClientRects()].filter((r) => r.width > 0 && r.height > 0);
	const all = range.getBoundingClientRect();
	if (!rects.length) return { text, rect: all };
	const top = Math.min(...rects.map((r) => r.top));
	const first = rects.filter((r) => r.top < top + r.height / 2);
	const left = Math.min(...first.map((r) => r.left));
	const right = Math.max(...first.map((r) => r.right));
	return { text, rect: new DOMRect(left, top, right - left, all.bottom - top) };
}

export function useTextSelection(root: RefObject<HTMLElement | null>): [Selected | undefined, () => void] {
	const [selected, setSelected] = useState<Selected | undefined>();
	const shown = useRef(false);
	shown.current = Boolean(selected);
	const pressing = useRef(false);
	const hide = useCallback(() => setSelected(undefined), []);
	useEffect(() => {
		let timer: ReturnType<typeof setTimeout> | undefined;
		const settle = (wait: number) => {
			clearTimeout(timer);
			timer = setTimeout(() => {
				if (!pressing.current) setSelected(read(root.current));
			}, wait);
		};
		const down = (e: MouseEvent) => {
			if (e.button !== 0 || (e.target instanceof Element && e.target.closest(BAR))) return;
			pressing.current = true;
			setSelected(undefined);
		};
		const up = () => {
			if (!pressing.current) return;
			pressing.current = false;
			settle(0);
		};
		const changed = () => {
			if (pressing.current) return;
			if (!read(root.current)) return setSelected(undefined);
			settle(150);
		};
		const key = (e: KeyboardEvent) => {
			if (e.key !== "Escape" || !shown.current || (e.target instanceof Element && e.target.closest(FIELD))) return;
			e.stopPropagation();
			setSelected(undefined);
		};
		const scrolled = (e: Event) => {
			if (shown.current && e.target instanceof Node && root.current?.contains(e.target)) setSelected(undefined);
		};
		document.addEventListener("mousedown", down, true);
		document.addEventListener("mouseup", up, true);
		document.addEventListener("selectionchange", changed);
		document.addEventListener("keydown", key, true);
		document.addEventListener("scroll", scrolled, { capture: true, passive: true });
		window.addEventListener("resize", hide);
		return () => {
			clearTimeout(timer);
			document.removeEventListener("mousedown", down, true);
			document.removeEventListener("mouseup", up, true);
			document.removeEventListener("selectionchange", changed);
			document.removeEventListener("keydown", key, true);
			document.removeEventListener("scroll", scrolled, true);
			window.removeEventListener("resize", hide);
		};
	}, [root, hide]);
	return [selected, hide];
}

/**
 * A bar of actions over the selected text: the stock Popover, open while it is drawn, anchored to the
 * selection. Its anchor is a box laid over the selection's first line, in the page's own layer (where a
 * fixed box is where the selection is, whatever the conversation's frame does), that nothing can press
 * or reach by the keyboard; the popover places itself above it, or below where there is no room, and
 * neither takes the focus from the text nor gives it to the anchor when it goes.
 */
export function SelectionToolbar({ rect, className, children, ...props }: ComponentProps<"div"> & { rect: DOMRect }) {
	return (
		<Popover open modal={false}>
			{createPortal(<PopoverTrigger nativeButton={false} tabIndex={-1} aria-hidden render={<span data-slot="selection-anchor" className="pointer-events-none invisible fixed" style={{ top: rect.top, left: rect.left, width: rect.width, height: rect.height }} />} />, document.body)}
			<PopoverContent data-selection-toolbar="" side="top" sideOffset={8} initialFocus={false} finalFocus={false} className="w-auto p-0.5 select-none" onMouseDown={(e) => e.preventDefault()}>
				<div role="toolbar" aria-orientation="horizontal" aria-label="Selected text" data-slot="selection-toolbar" className={cn("flex gap-0.5", className)} {...props}>
					{children}
				</div>
			</PopoverContent>
		</Popover>
	);
}

export function SelectionToolbarButton({ icon: Icon, label, hint, ...props }: ComponentProps<typeof Button> & { icon: ComponentType; label: string; hint?: string }) {
	return (
		<HoverTooltip>
			<TooltipTrigger render={<Button variant="ghost" size="sm" {...props} />}>
				<Icon data-icon="inline-start" />
				{label}
			</TooltipTrigger>
			<TooltipContent>{hint ?? `${label} the selected text`}</TooltipContent>
		</HoverTooltip>
	);
}
