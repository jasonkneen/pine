import { type ComponentProps, useLayoutEffect, useRef } from "react";
import { cn } from "@/lib/utils";

/**
 * Something going on (an agent at work, a page loading): a small grey dot that fades out and in, in
 * place of the stock spinner. Every dot in the window is in step, however late it came: its fade is
 * started at the beginning of the page's timeline, so all of them are at the same point of the beat.
 * The fade goes in steps, a few a second: a smooth one makes the system draw the whole window at the
 * screen's rate for as long as an agent works, which cost a fifth of a core (desktop/test/view-perf.test.ts).
 */
export function Pulse({ className, label = "Working", ...props }: ComponentProps<"span"> & { label?: string }) {
	const ref = useRef<HTMLSpanElement>(null);
	useLayoutEffect(() => {
		for (const a of ref.current?.getAnimations?.() ?? []) a.startTime = 0;
	}, []);
	return <span ref={ref} data-slot="pulse" role="status" aria-label={label} className={cn("inline-block size-2 shrink-0 animate-pulse rounded-full bg-muted-foreground [animation-timing-function:steps(4,jump-none)]", className)} {...props} />;
}
