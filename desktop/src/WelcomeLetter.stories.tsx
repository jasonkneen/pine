import type { Meta, StoryObj } from "@storybook/react-vite";
import { WelcomeLetter } from "./WelcomeLetter.tsx";

const meta = {
	component: WelcomeLetter,
	decorators: [(Story) => <div className="mx-auto max-w-3xl p-7"><Story /></div>],
	args: { main: "main", home: "~/.pine", here: true, settings: () => {}, reveal: () => {}, say: () => {} },
} satisfies Meta<typeof WelcomeLetter>;
export default meta;

type Story = StoryObj<typeof meta>;

export const Welcome: Story = {};

/** Another machine's pine: its home is named, not shown in the Finder. */
export const OnAnotherMachine: Story = {
	args: { home: "/home/pi/.pine", here: false },
};
