import { expect, test } from "bun:test";
import { subscribeToActiveAccountLock } from "./use-vault-key-rotation";

test("serializes lock events behind the initial unlocked snapshot", async () => {
	let resolveUnlocked: ((accounts: string[]) => void) | undefined;
	let onChanged: ((accounts: string[]) => void) | undefined;
	let locks = 0;
	const unsubscribe = subscribeToActiveAccountLock(
		{
			getActiveAccount: async () => "account_1",
			getUnlockedAccounts: () =>
				new Promise((resolve) => {
					resolveUnlocked = resolve;
				}),
			onUnlockStateChanged(listener) {
				onChanged = listener;
				return () => undefined;
			},
		},
		() => {
			locks += 1;
		},
	);

	onChanged?.([]);
	expect(locks).toBe(0);
	resolveUnlocked?.(["account_1"]);
	await new Promise((resolve) => setTimeout(resolve, 0));
	expect(locks).toBe(1);
	unsubscribe();
});

test("does not invent a lock transition without an active account", async () => {
	let onChanged: ((accounts: string[]) => void) | undefined;
	let locks = 0;
	subscribeToActiveAccountLock(
		{
			getActiveAccount: async () => null,
			getUnlockedAccounts: async () => ["other_account"],
			onUnlockStateChanged(listener) {
				onChanged = listener;
				return () => undefined;
			},
		},
		() => {
			locks += 1;
		},
	);

	onChanged?.([]);
	await Promise.resolve();
	await Promise.resolve();
	expect(locks).toBe(0);
});
