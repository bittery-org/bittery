import "../../../../../packages/client-runtime/src/testing/jsdom-preload";
import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import {
	cleanup,
	fireEvent,
	render,
	waitFor,
	within,
} from "@testing-library/react";

globalThis.Event = window.Event;
globalThis.CustomEvent = window.CustomEvent;

let startedSignal: AbortSignal | undefined;

mock.module("@bittery/client-runtime/react", () => ({
	useRuntimeClient: () => ({ acknowledgeTeamLeaveAttempt: async () => {} }),
	useRuntimeSession: () => ({ state: "unlocked", accountId: "account-1" }),
}));
mock.module("@tanstack/react-router", () => ({ useNavigate: () => () => {} }));
mock.module("@/hooks/use-runtime-team-leave", () => ({
	TeamLeaveFailure: class TeamLeaveFailure extends Error {},
	useRuntimeTeamLeave: () => ({
		start: (_teamId: string, signal: AbortSignal) => {
			startedSignal = signal;
			return new Promise(() => {});
		},
		inspect: () => new Promise(() => {}),
	}),
}));
mock.module("@/providers/i18n-provider", () => ({
	useI18n: () => ({
		m: new Proxy({}, { get: (_target, key) => () => String(key) }),
	}),
}));
mock.module("@/providers/transitional-sync-provider", () => ({
	useQueryInvalidator: () => ({ invalidateTeam: async () => {} }),
}));

const { LeaveTeamDialog } = await import("./leave-team-dialog");

beforeEach(() => {
	startedSignal = undefined;
});
afterEach(cleanup);

async function startThroughConfirmation() {
	const view = render(<LeaveTeamDialog teamId="team-1" teamName="Team" />);
	fireEvent.click(
		view.getByRole("button", { name: "team_leave_dialog_trigger" }),
	);
	const dialog = view.getByRole("alertdialog");
	fireEvent.click(
		within(dialog).getByRole("button", {
			name: "team_leave_dialog_action_confirm",
		}),
	);
	await waitFor(() => expect(startedSignal).toBeDefined());
	return view;
}

describe("Team leave dialog caller lifetime", () => {
	test("the real confirmation action keeps the owner alive until deliberate Cancel", async () => {
		const view = await startThroughConfirmation();
		expect(startedSignal?.aborted).toBe(false);
		fireEvent.click(
			within(view.getByRole("alertdialog")).getByRole("button", {
				name: "team_common_action_cancel",
			}),
		);
		expect(startedSignal?.aborted).toBe(true);
	});

	test("unmount retires the pending caller", async () => {
		const view = await startThroughConfirmation();
		expect(startedSignal?.aborted).toBe(false);
		view.unmount();
		expect(startedSignal?.aborted).toBe(true);
	});
});
