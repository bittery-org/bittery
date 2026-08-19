import { describe, expect, test } from "bun:test";
import {
	getNewTerminalCommandCount,
	subscribeToNewTerminalCommands,
} from "../terminal-command-status";

describe("terminal command status notifications", () => {
	test("ignores pending and retrying command changes", () => {
		expect(
			getNewTerminalCommandCount(
				{ pending: 2, retrying: 0, conflicted: 0, failed: 0 },
				{ pending: 1, retrying: 1, conflicted: 0, failed: 0 },
			),
		).toBe(0);
	});

	test("reports only newly terminal failed and conflicted commands", () => {
		expect(
			getNewTerminalCommandCount(
				{ pending: 1, retrying: 1, conflicted: 1, failed: 2 },
				{ pending: 0, retrying: 0, conflicted: 2, failed: 3 },
			),
		).toBe(2);
	});

	test("does not notify again for retained terminal history", () => {
		expect(
			getNewTerminalCommandCount(
				{ pending: 0, retrying: 0, conflicted: 2, failed: 3 },
				{ pending: 1, retrying: 0, conflicted: 2, failed: 3 },
			),
		).toBe(0);
	});

	test("subscribes after restore without resurfacing retained failures", () => {
		let summary = { pending: 0, retrying: 0, conflicted: 1, failed: 1 };
		let emit = () => {};
		const notifications: number[] = [];
		const unsubscribe = subscribeToNewTerminalCommands(
			{
				getCommandSummary: () => summary,
				subscribe: (listener) => {
					emit = listener;
					return () => {
						emit = () => {};
					};
				},
			},
			(count) => notifications.push(count),
		);

		emit();
		summary = { pending: 0, retrying: 1, conflicted: 1, failed: 1 };
		emit();
		summary = { pending: 0, retrying: 0, conflicted: 1, failed: 2 };
		emit();
		emit();

		expect(notifications).toEqual([1]);
		unsubscribe();
	});
});
