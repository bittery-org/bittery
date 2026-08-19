import { describe, expect, test } from "bun:test";
import {
	getAccountInitials,
	getAccountLabel,
	hasAccountChoice,
	resolveSelectedAccountId,
} from "../lib/utils";

describe("hasAccountChoice", () => {
	test("no account is not a choice", () => {
		expect(hasAccountChoice([])).toBe(false);
	});

	test("a lone account is not a choice", () => {
		expect(hasAccountChoice([{ accountId: "a" }])).toBe(false);
	});

	test("two accounts are a choice", () => {
		expect(hasAccountChoice([{ accountId: "a" }, { accountId: "b" }])).toBe(
			true,
		);
	});
});

describe("getAccountLabel", () => {
	test("the team name wins", () => {
		expect(
			getAccountLabel({
				email: "ada@example.com",
				name: "Ada Lovelace",
				teamName: "My Team",
			}),
		).toBe("My Team");
	});

	test("falls back to the personal name", () => {
		expect(
			getAccountLabel({ email: "ada@example.com", name: "Ada Lovelace" }),
		).toBe("Ada Lovelace");
	});

	test("falls back to the email local part, never the raw address", () => {
		expect(getAccountLabel({ email: "ada@example.com" })).toBe("ada");
	});

	test("resolves the preferred account when it exists", () => {
		expect(
			resolveSelectedAccountId([{ accountId: "a" }, { accountId: "b" }], "b"),
		).toBe("b");
	});

	test("a stale or empty preference still lands on the lone account", () => {
		expect(resolveSelectedAccountId([{ accountId: "a" }], "")).toBe("a");
		expect(resolveSelectedAccountId([{ accountId: "a" }], "gone")).toBe("a");
	});

	test("resolves to nothing when there are no accounts", () => {
		expect(resolveSelectedAccountId([], "a")).toBeUndefined();
	});

	test("initials and label agree on which name they describe", () => {
		const account = {
			email: "ada@example.com",
			name: "Ada Lovelace",
			teamName: "My Team",
		};
		expect(getAccountLabel(account)).toBe("My Team");
		expect(getAccountInitials(account)).toBe("MT");
	});
});
