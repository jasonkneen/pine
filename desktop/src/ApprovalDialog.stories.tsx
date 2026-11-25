import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect, within } from "storybook/test";
import { ApprovalDialog as Dialog } from "./ApprovalDialog.tsx";

// No docs page: it would open every story's dialog at once, one over the other.
const meta = { component: Dialog, tags: ["!autodocs"], parameters: { layout: "fullscreen" } } satisfies Meta<typeof Dialog>;
export default meta;

type Story = StoryObj<typeof meta>;
const approval: Story["args"] = { req: { id: "a1", agent: "main", task: 12, tool: "bash", summary: "echo hello", why: "bash is on your approve list.", expires: 0, remember: "bash" } };

export const ApprovalDialog: Story = { args: approval };

/** Something only the owner has, typed here and sent to the daemon alone. */
export const ApprovalDialogWithSecret: Story = {
	args: { req: { id: "a2", agent: "main", task: 13, tool: "add_source", summary: "telegram source: chat with you", why: "it needs a token.", expires: 0, inputs: [{ name: "TELEGRAM_TOKEN", label: "TELEGRAM_TOKEN: the bot's token from @BotFather" }] } },
};

/** "Save and allow" with nothing typed: the value is marked as missing, and nothing is allowed. */
export const ApprovalDialogWithSecretMissing: Story = {
	args: ApprovalDialogWithSecret.args,
	play: async ({ userEvent }) => {
		const dialog = within(document.body).getByRole("dialog");
		await userEvent.click(within(dialog).getByRole("button", { name: "Save and allow" }));
		await expect(within(dialog).getByLabelText("TELEGRAM_TOKEN")).toHaveAttribute("aria-invalid", "true");
	},
};

/** A long line with nowhere to break, such as a sign-in address, wraps inside the dialog and does not widen it. */
export const ApprovalDialogLongLine: Story = {
	args: { req: { ...approval.req!, id: "a3", summary: "curl https://claude.ai/oauth/authorize?code=true&client_id=9d1c250a-e61b-44d9-88ed-5944d1962f5e&response_type=code&redirect_uri=http%3A%2F%2Flocalhost%3A53692%2Fcallback&scope=org%3Acreate_api_key+user%3Aprofile+user%3Ainference", why: "it opens https://claude.ai/oauth/authorize?code=true&client_id=9d1c250a-e61b-44d9-88ed-5944d1962f5e&response_type=code&redirect_uri=http%3A%2F%2Flocalhost%3A53692%2Fcallback&state=wNksy2qMnpoNppegVo6Vhs9bq4axuelqcQci2zHAN9s." } },
};
