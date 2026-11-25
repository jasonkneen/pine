import type { Meta, StoryObj } from "@storybook/react-vite";
import { BookmarkIcon, QuoteIcon, ReplyIcon } from "lucide-react";
import { useRef } from "react";
import { fn, within } from "storybook/test";
import { ScrollArea } from "@/components/ui/scroll-area";
import { SelectionToolbar as Bar, SelectionToolbarButton, useTextSelection } from "./selection-toolbar.tsx";

/** Where a selection would be: the bar opens above it, as over selected text. */
const AT = new DOMRect(160, 120, 180, 20);

const meta = { title: "Components/SelectionToolbar", component: Bar, args: { rect: AT }, parameters: { layout: "fullscreen" } } satisfies Meta<typeof Bar>;
export default meta;
type Story = StoryObj<typeof meta>;

export const SelectionToolbar: Story = {
	render: (args) => (
		<Bar {...args}>
			<SelectionToolbarButton icon={QuoteIcon} label="Quote" onClick={fn()} />
			<SelectionToolbarButton icon={ReplyIcon} label="Reply" hint="Quote the selected text and reply to it" onClick={fn()} />
			<SelectionToolbarButton icon={BookmarkIcon} label="Bookmark" onClick={fn()} />
		</Bar>
	),
};

export const WhileStreaming: Story = {
	render: (args) => (
		<Bar {...args}>
			<SelectionToolbarButton icon={QuoteIcon} label="Quote" onClick={fn()} />
			<SelectionToolbarButton icon={ReplyIcon} label="Reply" hint="Quote the selected text and reply to it" onClick={fn()} />
			<SelectionToolbarButton icon={BookmarkIcon} label="Bookmark" hint="Bookmark it once the answer is done" disabled onClick={fn()} />
		</Bar>
	),
};

function Selecting({ onQuote, onReply, onBookmark }: { onQuote: (text: string) => void; onReply: (text: string) => void; onBookmark: (text: string) => void }) {
	const root = useRef<HTMLDivElement>(null);
	const [selected, unselect] = useTextSelection(root);
	return (
		<div className="m-4 flex h-80 max-w-xl flex-col rounded-xl border bg-background">
			{/* Selectable as an answer is in the app (the page itself is select-none): selected text outside it reads as none. */}
			<ScrollArea className="min-h-0 flex-1">
				<div ref={root} className="p-7 text-sm leading-relaxed select-text">
					<p data-testid="answer">The build passed on the second run. The first failed because the cache held an old copy of the lockfile, so the install took the versions of last week.</p>
					<p className="mt-3">Clearing the cache before the install keeps it from happening again.</p>
				</div>
			</ScrollArea>
			{selected ? (
				<Bar rect={selected.rect}>
					<SelectionToolbarButton icon={QuoteIcon} label="Quote" onClick={() => (onQuote(selected.text), window.getSelection()?.removeAllRanges(), unselect())} />
					<SelectionToolbarButton icon={ReplyIcon} label="Reply" hint="Quote the selected text and reply to it" onClick={() => (onReply(selected.text), window.getSelection()?.removeAllRanges(), unselect())} />
					<SelectionToolbarButton icon={BookmarkIcon} label="Bookmark" onClick={() => (onBookmark(selected.text), window.getSelection()?.removeAllRanges(), unselect())} />
				</Bar>
			) : null}
		</div>
	);
}

export const OverSelectedText: Story = {
	render: () => <Selecting onQuote={fn()} onReply={fn()} onBookmark={fn()} />,
	// Selected as a person does, with the mouse: pressed, dragged and let go over the words.
	play: async ({ canvas, userEvent }) => {
		const answer = canvas.getByTestId("answer");
		await userEvent.pointer([{ keys: "[MouseLeft>]", target: answer, offset: 4 }, { offset: 36 }, { keys: "[/MouseLeft]" }]);
		await within(document.body).findByRole("toolbar");
	},
};
