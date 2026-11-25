import type { Meta, StoryObj } from "@storybook/react-vite";
import { useEffect, useState } from "react";
import { Printed } from "./printed.tsx";

const lines = Array.from({ length: 30 }, (_, i) => `\u001b[32mok\u001b[0m line ${i + 1} of what the program printed`).join("\n");

// What a tool or a program printed, with its terminal colors; `sm` caps its height where several follow each other.
const meta = {
	title: "Components/Printed",
	component: Printed,
	args: { text: "$ npm test\n\u001b[32m✔\u001b[0m 42 tests passed" },
	parameters: { layout: "padded" },
} satisfies Meta<typeof Printed>;
export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {};

export const Failed: Story = { args: { text: "$ npm test\n\u001b[31m✖\u001b[0m 1 test failed", failed: true } };

export const Small: Story = { args: { text: lines, sm: true } };

function Printing() {
	const [n, setN] = useState(5);
	useEffect(() => {
		const t = setInterval(() => setN((k) => (k < 200 ? k + 1 : k)), 250);
		return () => clearInterval(t);
	}, []);
	return <Printed sm text={Array.from({ length: n }, (_, i) => `line ${i + 1} of a program that keeps printing`).join("\n")} />;
}

/** A program still printing: the block follows its end, holds still once scrolled up, and its button goes back. No docs page: it never settles. */
export const StillPrinting: Story = { tags: ["!autodocs"], render: () => <Printing /> };

/** While it loads: its own shape, from stock Skeleton blocks. */
export const PrintedSkeleton: Story = { args: { skeleton: true } as never };
