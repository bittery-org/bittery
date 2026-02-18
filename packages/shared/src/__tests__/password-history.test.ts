import { describe, expect, test } from "bun:test";
import {
	applyPasswordHistoryOnPasswordChange,
	normalizePasswordHistory,
} from "../password-history";

function entry(password: string, changedAt: string) {
	return { password, changedAt };
}

describe("password history helpers", () => {
	test("no-op when password is unchanged", () => {
		const history = [entry("old-password", "2024-01-01T00:00:00.000Z")];

		const result = applyPasswordHistoryOnPasswordChange({
			passwordHistory: history,
			previousPassword: "current-password",
			nextPassword: "current-password",
			changedAt: "2024-02-01T00:00:00.000Z",
		});

		expect(result).toEqual(history);
	});

	test("adds previous password when password changes", () => {
		const result = applyPasswordHistoryOnPasswordChange({
			passwordHistory: [entry("older-password", "2024-01-01T00:00:00.000Z")],
			previousPassword: "old-password",
			nextPassword: "new-password",
			changedAt: "2024-02-01T00:00:00.000Z",
		});

		expect(result).toEqual([
			entry("old-password", "2024-02-01T00:00:00.000Z"),
			entry("older-password", "2024-01-01T00:00:00.000Z"),
		]);
	});

	test("dedupes passwords with most recent entry winning", () => {
		const result = applyPasswordHistoryOnPasswordChange({
			passwordHistory: [
				entry("alpha", "2024-01-03T00:00:00.000Z"),
				entry("beta", "2024-01-02T00:00:00.000Z"),
				entry("alpha", "2024-01-01T00:00:00.000Z"),
				entry("gamma", "2023-12-31T00:00:00.000Z"),
			],
			previousPassword: "beta",
			nextPassword: "delta",
			changedAt: "2024-02-01T00:00:00.000Z",
		});

		expect(result).toEqual([
			entry("beta", "2024-02-01T00:00:00.000Z"),
			entry("alpha", "2024-01-03T00:00:00.000Z"),
			entry("gamma", "2023-12-31T00:00:00.000Z"),
		]);
	});

	test("history excludes the current password", () => {
		const result = normalizePasswordHistory(
			[
				entry("current-password", "2024-01-02T00:00:00.000Z"),
				entry("old-password", "2024-01-01T00:00:00.000Z"),
			],
			"current-password",
		);

		expect(result).toEqual([entry("old-password", "2024-01-01T00:00:00.000Z")]);
	});

	test("history is capped at 10 entries", () => {
		const history = Array.from({ length: 12 }, (_, index) =>
			entry(
				`password-${index}`,
				`2024-01-${String(index + 1).padStart(2, "0")}T00:00:00.000Z`,
			),
		);

		const result = normalizePasswordHistory(history, "current-password");

		expect(result?.length).toBe(10);
		expect(result?.[0]?.password).toBe("password-0");
		expect(result?.[9]?.password).toBe("password-9");
	});

	test("restore archives replaced current password and removes restored current", () => {
		const result = applyPasswordHistoryOnPasswordChange({
			passwordHistory: [
				entry("password-a", "2024-01-10T00:00:00.000Z"),
				entry("password-c", "2024-01-09T00:00:00.000Z"),
			],
			previousPassword: "password-b",
			nextPassword: "password-a",
			changedAt: "2024-02-01T00:00:00.000Z",
		});

		expect(result).toEqual([
			entry("password-b", "2024-02-01T00:00:00.000Z"),
			entry("password-c", "2024-01-09T00:00:00.000Z"),
		]);
	});
});
