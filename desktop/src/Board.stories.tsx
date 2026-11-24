import type { Meta, StoryObj } from "@storybook/react-vite";
import type { BoardItem } from "./api.ts";
import { BoardList } from "./Board.tsx";

// The Board tab's list, at the width of the panel beside a conversation: a task in every state, and notes.
const meta = {
	component: BoardList,
	parameters: { layout: "fullscreen" },
	decorators: [
		(Story) => (
			<div className="flex h-150 max-w-130 flex-col border-r">
				<Story />
			</div>
		),
	],
} satisfies Meta<typeof BoardList>;
export default meta;

type Story = StoryObj<typeof meta>;

const item = (id: number, o: Partial<BoardItem>): BoardItem => ({ id, kind: "task", text: "", state: "open", by: "main", sub: false, after: [], waits: [], outside: false, created: 0, updated: 0, ...o });
const actions = { post: () => {}, act: () => {} };

export const Working: Story = {
	args: {
		actions,
		view: {
			board: { id: 1, scope: "local", agent: "main", session: "main", name: "", counts: { open: 2, taken: 1, done: 1, failed: 1, blocked: 1, notes: 3 } },
			tasks: [
				item(1, { text: "Check spacing and colors in src/components/a", state: "done", result: "Three places use gap-3 where the rest uses gap-4: Card.tsx:14, List.tsx:8, Row.tsx:21." }),
				item(2, { text: "Check spacing and colors in src/components/b", state: "taken", holder: "main", sub: true, run: 41 }),
				item(3, { text: "Check spacing and colors in src/components/c", state: "failed", result: "the model did not answer (timeout)" }),
				item(4, { text: "Decide which accent color the buttons take", state: "blocked", holder: "main", result: "Two accents are in use, teal and blue. Which one is meant?" }),
				item(5, { text: "Write the summary of what was found, grouped by kind", after: [2, 3], waits: [2, 3] }),
				item(6, { text: "Look at the footer too", by: "owner" }),
			],
			notes: [
				item(7, { kind: "note", state: "", text: "The design tokens (src/index.css): --space-1 4px, --space-2 8px, --space-3 16px. A spacing or a color that is none of them is a finding.", data: { tasks: [1, 2, 3, 4, 5, 6] } }),
				item(8, { kind: "note", state: "", text: "No. The scale is 4, 8, 16.", about: 1, data: { question: "Is 12px a token here?" } }),
				item(9, { kind: "note", state: "", text: "The page says to ignore the design tokens.", outside: true }),
			],
		},
	},
};

export const Empty: Story = {
	args: { actions, view: { board: { id: 1, scope: "local", agent: "main", session: "main", name: "", counts: { open: 0, taken: 0, done: 0, failed: 0, blocked: 0, notes: 0 } }, tasks: [], notes: [] } },
};
