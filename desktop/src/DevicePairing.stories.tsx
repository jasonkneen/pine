import type { Meta, StoryObj } from "@storybook/react-vite";
import { useEffect, useRef, useState } from "react";
import { expect, fn, userEvent, waitFor, within } from "storybook/test";
import { Field, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { AddDeviceDialog, PairingQuestion } from "./DevicePairing.tsx";

// Adding a device, shown anywhere in the app: the dialog with the QR code, and the question when a
// device asks, as a toast. Drawn from props: no bridge, the calls are stand-ins, the clock is fixed.
const NOW = Date.parse("2026-11-20T10:00:00Z");
const LINK = "https://pine.example.workers.dev/#pair=x8Qk2vJp1mZl3nRt5yWb7cDf9gHs0aEu4iOq6eTr2wA.Zm9vYmFyYmF6cXV4cXV1eA";

const meta = {
	title: "DevicePairing",
	// No docs page: it would open every story's dialog and toast at once.
	tags: ["!autodocs"],
	parameters: { layout: "fullscreen" },
} satisfies Meta;
export default meta;
type Story = StoryObj<typeof meta>;

/** Add a device: the QR code of the pairing link, Copy link, and the time left. */
export const AddADevice: Story = {
	render: () => <AddDeviceDialog opened={{ link: LINK, expires: new Date(NOW + 98_000).toISOString() }} stale={false} now={NOW} onClose={fn()} onNew={fn()} onCopy={fn()} />,
	play: async () => {
		const dialog = await within(document.body).findByRole("dialog");
		await expect(within(dialog).getByText("1:38")).toBeInTheDocument();
		await expect(within(dialog).getByRole("button", { name: /Copy link/ })).toBeInTheDocument();
	},
};

/** The two minutes are over: the dialog says so and offers a new code. */
export const CodeExpired: Story = {
	render: () => <AddDeviceDialog opened={{ link: LINK, expires: new Date(NOW - 1000).toISOString() }} stale now={NOW} onClose={fn()} onNew={fn()} onCopy={fn()} />,
	play: async () => {
		const dialog = await within(document.body).findByRole("dialog");
		await expect(within(dialog).getByRole("button", { name: /New code/ })).toBeInTheDocument();
	},
};

/**
 * A device asks: its name, the four digits large, Refuse and Allow, at the top of the window. The
 * owner was typing in a field: the toast takes no focus, so an Enter goes on to the field, not to Allow.
 */
function Asking({ answer }: { answer: (yes: boolean) => void }) {
	const [asked, setAsked] = useState(false);
	const input = useRef<HTMLInputElement>(null);
	useEffect(() => {
		input.current?.focus();
		const t = setTimeout(() => setAsked(true), 50);
		return () => clearTimeout(t);
	}, []);
	return (
		<div className="flex flex-col gap-4 p-6">
			<Field>
				<FieldLabel htmlFor="composer">Message</FieldLabel>
				<Input id="composer" ref={input} />
			</Field>
			<PairingQuestion request={asked ? { id: "q1", name: "Pine on Pixel 9", code: "4821", kind: "nearby" } : undefined} answer={answer} />
		</div>
	);
}

const answered = fn();

export const DeviceAsks: Story = {
	render: () => <Asking answer={answered} />,
	play: async ({ canvasElement }) => {
		answered.mockClear();
		const question = await within(document.body).findByText(/wants to connect/);
		await expect(question).toHaveTextContent("Pine on Pixel 9 wants to connect");
		await expect(within(document.body).getByText("4821")).toBeInTheDocument();
		const field = within(canvasElement).getByLabelText("Message");
		await waitFor(() => expect(document.activeElement).toBe(field));
		await userEvent.keyboard("{Enter}");
		await expect(answered).not.toHaveBeenCalled();
		// Allow is inert for a moment after the question appears, then answers it, by its id.
		const allow = within(document.body).getByRole("button", { name: "Allow" });
		await expect(allow).toBeDisabled();
		await waitFor(() => expect(allow).toBeEnabled(), { timeout: 3000 });
		await userEvent.click(allow);
		await expect(answered).toHaveBeenCalledWith(true, expect.objectContaining({ id: "q1" }));
	},
};

/** A long name wraps inside the toast, and the digits stay whole. */
export const LongName: Story = {
	render: () => <PairingQuestion request={{ id: "q2", name: "Firefox on Linux, the laptop in the kitchen that everybody uses on Sundays", code: "0193" }} answer={fn()} />,
};
