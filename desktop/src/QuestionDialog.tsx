import { MessageSquareIcon } from "lucide-react";
import { useRef, useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Item, ItemActions, ItemContent, ItemMedia, ItemTitle } from "@/components/ui/item";
import { Kbd } from "@/components/ui/kbd";
import { ScrollArea } from "@/components/ui/scroll-area";
import type { Approval } from "./api.ts";
import { store } from "./model.ts";

/** A question of the agent's: the answers it offers, and a line for the owner's own words. */
export function QuestionDialog({ req }: { req: Approval }) {
	const s = store;
	const choices = req.choices ?? [];
	const [own, setOwn] = useState("");
	const [at, setAt] = useState(0);
	// The answer field, not the first answer offered: a digit typed there picks an answer.
	const field = useRef<HTMLInputElement>(null);
	const answer = (text: string) => void s.decide(req.id, true, false, { answer: text });
	return (
		<Dialog open onOpenChange={(open) => open || s.closeAsking()}>
			<DialogContent data-tone="accent" showCloseButton={false} initialFocus={field} className="sm:max-w-xl">
				<DialogHeader>
					<DialogTitle className="flex items-center gap-2"><MessageSquareIcon className="text-primary" /> {req.agent} asks</DialogTitle>
				</DialogHeader>
				<ScrollArea className="-mx-4 max-h-[50vh] min-w-0 wrap-break-word flex min-h-0 flex-col *:data-[slot=scroll-area-viewport]:scroll-fade">
				<div className="flex flex-col gap-3 px-4 select-text">
					<div className="whitespace-pre-wrap">{req.summary}</div>
					{choices.length ? (
						<div className="flex flex-col">
							{choices.map((c, i) => (
								<Item key={i} size="sm" variant={i === at && !own ? "muted" : "default"} render={<button type="button" />} onMouseMove={() => at !== i && setAt(i)} onClick={() => answer(c)}>
									<ItemMedia><Kbd>{i + 1}</Kbd></ItemMedia>
									<ItemContent>
										<ItemTitle className="line-clamp-none text-left font-normal">{c}</ItemTitle>
									</ItemContent>
									{i === 0 ? <ItemActions><Badge>recommended</Badge></ItemActions> : null}
								</Item>
							))}
						</div>
					) : null}
					<Input
						ref={field}
						placeholder={choices.length ? "Or answer in your own words" : "Your answer"}
						value={own}
						onChange={(e) => setOwn(e.target.value)}
						onKeyDown={(e) => {
							if (e.key === "Enter") return own.trim() ? answer(own.trim()) : choices.length ? answer(choices[at]) : undefined;
							if (!own && /^[1-9]$/.test(e.key) && Number(e.key) <= choices.length) return (e.preventDefault(), answer(choices[Number(e.key) - 1]));
							if (!own && (e.key === "ArrowDown" || e.key === "ArrowUp") && choices.length) (e.preventDefault(), setAt((at + (e.key === "ArrowDown" ? 1 : choices.length - 1)) % choices.length));
						}}
					/>
				</div>
				</ScrollArea>
				<DialogFooter>
					<Button variant="ghost" onClick={() => s.closeAsking()}>Later <Kbd>esc</Kbd></Button>
					<span className="min-w-0 flex-1" />
					<Button variant="ghost" onClick={() => void s.decide(req.id, false)}>No answer</Button>
					<Button disabled={!own.trim() && !choices.length} onClick={() => answer(own.trim() || choices[at])}>Answer</Button>
				</DialogFooter>
			</DialogContent>
		</Dialog>
	);
}
