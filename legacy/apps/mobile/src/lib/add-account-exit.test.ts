/// <reference types="bun" />
/**
 * Leaving `/login?addAccount=true` without signing in. The system Back button
 * already pops the stack; this is the same decision the in-app cancel uses.
 */

import { describe, expect, test } from "bun:test";
import { resolveAddAccountExit } from "./add-account-exit";

describe("resolveAddAccountExit", () => {
	test("pops history when the user came from the switcher or unlock", () => {
		expect(
			resolveAddAccountExit({ canGoBack: true, isUnlocked: true }),
		).toEqual({ kind: "back" });
		expect(
			resolveAddAccountExit({ canGoBack: true, isUnlocked: false }),
		).toEqual({ kind: "back" });
	});

	test("returns to the vault when there is no history and the account is still unlocked", () => {
		expect(
			resolveAddAccountExit({ canGoBack: false, isUnlocked: true }),
		).toEqual({ kind: "navigate", to: "/vault" });
	});

	test("returns to unlock when there is no history and the vault is locked", () => {
		expect(
			resolveAddAccountExit({ canGoBack: false, isUnlocked: false }),
		).toEqual({ kind: "navigate", to: "/unlock" });
	});
});
