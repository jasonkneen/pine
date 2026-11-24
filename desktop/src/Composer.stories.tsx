import type { Meta, StoryObj } from "@storybook/react-vite";
import { Composer } from "./Composer.tsx";
import { store, Tab } from "./model.ts";

// The message box as a conversation shows it, without a daemon: what the agent runs on reads
// "model" and "auto" here, as for an agent the app does not know yet.
function Box({ draft = "", files = false, outside = false, paused = false, swarm = false }: { draft?: string; files?: boolean; outside?: boolean; paused?: boolean; swarm?: boolean }) {
	const tab = new Tab("chat", "main", "main");
	tab.draft = draft;
	if (paused) tab.goal = { agent: "main", session: "main", objective: "File every invoice of March", status: "paused", round: 3, until: 10, note: "paused by you after round 3" };
	if (swarm) tab.swarm = { agent: "main", session: "main", objective: "Write a test file for each module in src/", status: "limit", round: 8, until: 8, note: "stopped after 8 rounds, which is the limit (limits.swarmRounds), with work left. /swarm resume gives it 8 more" };
	if (files) tab.attachments.push({ name: "invoice-2026-03.pdf", size: 182_400, data: "" }, { name: "notes.md", size: 2_100, data: "" });
	if (outside) store.taints.set("main:main", "a web page");
	else store.taints.delete("main:main");
	return (
		<div className="relative w-full max-w-160">
			<Composer tab={tab} />
		</div>
	);
}

const meta = { component: Box, parameters: { layout: "padded" } } satisfies Meta<typeof Box>;
export default meta;
type Story = StoryObj<typeof meta>;

export const Empty: Story = { args: {} };

/** A message being written, with files attached, in a conversation that has read outside content. */
export const Written: Story = { args: { draft: "Sum up the invoice and say what is missing from @notes.md", files: true, outside: true } };

/** A goal that waits: its banner (an Alert) above the input, with Resume and Clear. */
export const GoalPaused: Story = { args: { paused: true } };

/** A swarm that stopped with work left: its banner above the input, with Resume and Clear. */
export const SwarmStopped: Story = { args: { swarm: true } };
