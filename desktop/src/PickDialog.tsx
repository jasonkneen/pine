import { useMemo, useState } from "react";
import { cn } from "cn";
import { AlertDialog, AlertDialogContent, AlertDialogDescription, AlertDialogHeader, AlertDialogTitle } from "@/components/ui/alert-dialog";
import { Command, CommandDialog, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList } from "@/components/ui/command";
import { useNamedLine } from "./lists.tsx";
import type { Picker } from "./model.ts";
import { fuzzy } from "./text.ts";
import { Skeleton } from "@/components/ui/skeleton";

export function PickDialog({ p }: { p: Picker }) {
	const [query, setQuery] = useState("");
	const shown = useMemo(() => (query && !p.free ? p.items.map((i) => ({ i, rank: Math.min(...[fuzzy(query, i.label), fuzzy(query, i.about ?? "") + 10].filter((r) => r >= 0), 99) })).filter((x) => x.rank < 99).sort((a, b) => a.rank - b.rank).map((x) => x.i) : p.items), [query, p]);
	// The list starts on the one in use.
	const line = useNamedLine(query, p.current, !p.loading);
	const description = p.free ? "Type a name and press Enter." : "Type to narrow the list, or choose with the arrows and Enter.";
	const list = (
		<Command
			{...line}
			shouldFilter={false}
			loop
			onKeyDown={(e) => {
				// Words of the owner's own count before the list where both are possible.
				if (e.key === "Enter" && p.free && query.trim()) (e.preventDefault(), p.done(query.trim()));
			}}
		>
			<CommandInput placeholder={p.placeholder ?? "Type to narrow the list"} value={query} onValueChange={setQuery} />
			<CommandList className="scroll-fade" aria-busy={p.loading || undefined}>
				{/* The title shows as the group's heading: the dialog's own title is for screen readers. */}
				<CommandGroup heading={p.title}>
					{p.loading
						? ["w-1/2", "w-2/3", "w-2/5"].map((w) => (
								<div key={w} className="flex h-8 items-center px-2">
									<Skeleton className={cn("h-4", w)} />
								</div>
							))
						: shown.map((i) => (
								<CommandItem key={i.value} value={i.value} data-checked={i.value === p.current} onSelect={() => p.done(i.value)}>
									<span className={cn("max-w-3/5 flex-none truncate", i.tone === "bad" && "text-destructive")}>{i.label}</span>
									{i.about ? <span className="min-w-0 truncate text-xs text-muted-foreground">{i.about}</span> : null}
								</CommandItem>
							))}
				</CommandGroup>
				{p.free || p.loading ? null : <CommandEmpty>Nothing fits.</CommandEmpty>}
			</CommandList>
		</Command>
	);
	const close = (open: boolean) => open || p.done(undefined);
	// A choice that cannot be taken back stays an alert dialog: announced as one, and not closed by a click beside it.
	// Its padding is the Command's alone, as in CommandDialog, so that both look alike.
	if (p.items.some((i) => i.tone === "bad"))
		return (
			<AlertDialog open onOpenChange={close}>
				<AlertDialogContent className="top-1/3 translate-y-0 gap-0 overflow-hidden p-0 data-[size=default]:sm:max-w-xl">
					<AlertDialogHeader className="sr-only">
						<AlertDialogTitle>{p.title}</AlertDialogTitle>
						<AlertDialogDescription>{description}</AlertDialogDescription>
					</AlertDialogHeader>
					{list}
				</AlertDialogContent>
			</AlertDialog>
		);
	return (
		<CommandDialog open onOpenChange={close} title={p.title} description={description} className="sm:max-w-xl">
			{list}
		</CommandDialog>
	);
}
