import { fileURLToPath } from "node:url";
import type { Page } from "@playwright/test";
import { expect, generateTestUser, signUp, test } from "../fixtures/auth";
import { uiText } from "../fixtures/messages";
import { VAULT_READY_TIMEOUT_MS } from "../fixtures/vault";

// Authentication in this file necessarily handles real passwords and Secret Keys. Keep
// Playwright from persisting browser state or API-call arguments in retry artifacts.
test.use({ trace: "off", screenshot: "off", video: "off" });

const RUNTIME_STORAGE_PREFIX = "bittery:runtime:platform-storage:";
const ACCOUNT_DELETION_MARKER_KEY = "bittery_account_deletion";
const TRANSITIONAL_SENTINEL = "e2e-non-secret-transitional-preservation";

async function signUpWithoutCredentialArtifacts(
	page: Page,
	user: ReturnType<typeof generateTestUser>,
) {
	try {
		return await signUp(page, user);
	} catch (error) {
		// Playwright 1.62 still writes an ARIA error-context attachment when all
		// configured media artifacts are off. Never leave a credential ceremony in
		// that snapshot when setup itself fails.
		await page.goto("about:blank").catch(() => undefined);
		throw error;
	}
}

async function openLogOutDialog(page: Page): Promise<void> {
	await page.getByTestId("user-menu").click();
	await page.getByTestId("sign-out-button").click();
	await expect(page.getByTestId("log-out-dialog")).toBeVisible();
}

async function openDeleteDialog(page: Page, email: string): Promise<void> {
	await page.locator('a[href="/settings"]').first().click();
	await expect(page.getByTestId("settings-tab-account")).toBeVisible({
		timeout: VAULT_READY_TIMEOUT_MS,
	});
	await page.getByTestId("settings-tab-general").click();
	await page
		.getByRole("button", {
			name: uiText("settings_delete_account_dialog_trigger"),
		})
		.click();
	const dialog = page.getByTestId("delete-account-dialog");
	await dialog.locator("#confirmEmail").fill(email);
	await dialog
		.locator("#confirmText")
		.fill(uiText("settings_delete_account_dialog_confirm_phrase"));
}

async function accountNames(page: Page) {
	const names = await page.evaluate(() => {
		const rawAccounts = localStorage.getItem("bittery_accounts_list");
		const accounts = rawAccounts
			? (JSON.parse(rawAccounts) as {
					accounts?: Array<{ accountId: string; email: string }>;
				})
			: null;
		return {
			loginAccountId: localStorage.getItem("bittery_active_account"),
			runtimeAccountId: localStorage.getItem("bittery_runtime_account_id"),
			syntheticAccountId: localStorage.getItem("bittery_web_account_id"),
			listedAccountIds:
				accounts?.accounts?.map((account) => account.accountId) ?? [],
		};
	});
	if (!names.loginAccountId || !names.runtimeAccountId) {
		throw new Error(
			`The signed-in Account names are incomplete: ${JSON.stringify(names)}`,
		);
	}
	return names as {
		loginAccountId: string;
		runtimeAccountId: string;
		syntheticAccountId: string | null;
		listedAccountIds: string[];
	};
}

async function forceRuntimeAccountRemovalFailure(page: Page): Promise<void> {
	await page.evaluate((prefix) => {
		const original = Storage.prototype.removeItem;
		Storage.prototype.removeItem = function (key: string) {
			if (key.startsWith(prefix)) {
				throw new Error("forced persistent Runtime Account removal failure");
			}
			return original.call(this, key);
		};
	}, RUNTIME_STORAGE_PREFIX);
}

async function sidebarAccountEvidence(
	page: Page,
	secretKeyName: string,
	expectedSentinel: string,
) {
	return page.evaluate(
		async ({ expectedSentinel, secretKeyName }) => {
			const cryptoModuleUrl = "/src/lib/crypto.ts";
			const routerModuleUrl = "/src/router.tsx";
			const [{ runtimeClient }, { queryClient }] = await Promise.all([
				import(/* @vite-ignore */ cryptoModuleUrl),
				import(/* @vite-ignore */ routerModuleUrl),
			]);
			const runtimeAccountId = localStorage.getItem(
				"bittery_runtime_account_id",
			);
			const rawAccounts = localStorage.getItem("bittery_accounts_list");
			const listedAccountIds = rawAccounts
				? ((
						JSON.parse(rawAccounts) as {
							accounts?: Array<{ accountId: string }>;
						}
					).accounts?.map((account) => account.accountId) ?? [])
				: [];
			return {
				activeAccountId: localStorage.getItem("bittery_active_account"),
				webAccountId: localStorage.getItem("bittery_web_account_id"),
				runtimeAccountId,
				resolvedRuntimeAccountId:
					runtimeClient.resolveAccount(runtimeAccountId),
				listedAccountIds,
				secretKeyMatches:
					localStorage.getItem(secretKeyName) === expectedSentinel,
				cached: queryClient.getQueryData(["e2e", "teardown-cache"]),
			};
		},
		{ expectedSentinel, secretKeyName },
	);
}

test("Sidebar Log out confirms before destruction, cancels, then clears cache and navigates", async ({
	page,
}) => {
	test.setTimeout(300000);
	await signUpWithoutCredentialArtifacts(page, generateTestUser());
	const names = await accountNames(page);
	expect(names.listedAccountIds).toContain(names.loginAccountId);
	if (names.syntheticAccountId !== null) {
		expect(names.loginAccountId).not.toBe(names.syntheticAccountId);
		expect(names.listedAccountIds).not.toContain(names.syntheticAccountId);
	}
	const loginSecretKey = `bittery_account_${names.loginAccountId}_secret_key`;
	// The signup fixture's Runtime handoff legitimately consumes its temporary
	// transitional Secret Key. Put an explicitly non-secret sentinel under the real
	// listed Account's key name so this proof cannot expose or sweep the old seed.
	await page.evaluate(({ key, value }) => localStorage.setItem(key, value), {
		key: loginSecretKey,
		value: TRANSITIONAL_SENTINEL,
	});
	await expect
		.poll(() =>
			page.evaluate(
				({ expected, key }) => localStorage.getItem(key) === expected,
				{ expected: TRANSITIONAL_SENTINEL, key: loginSecretKey },
			),
		)
		.toBe(true);

	await page.evaluate(async () => {
		// @ts-expect-error Vite serves this browser-only module path to the E2E page.
		const { queryClient } = await import("/src/router.tsx");
		queryClient.setQueryData(["e2e", "teardown-cache"], "sensitive");
		const original = queryClient.clear.bind(queryClient);
		queryClient.clear = () => {
			localStorage.setItem("__e2e_query_cache_clear", "called");
			original();
		};
	});
	const untouched = {
		activeAccountId: names.loginAccountId,
		webAccountId: names.syntheticAccountId,
		runtimeAccountId: names.runtimeAccountId,
		resolvedRuntimeAccountId: names.runtimeAccountId,
		listedAccountIds: names.listedAccountIds,
		secretKeyMatches: true,
		cached: "sensitive",
	};

	await openLogOutDialog(page);
	expect(
		await sidebarAccountEvidence(page, loginSecretKey, TRANSITIONAL_SENTINEL),
	).toEqual(untouched);
	await page.getByTestId("log-out-cancel").click();
	await expect(page.getByTestId("log-out-dialog")).toBeHidden();
	expect(
		await sidebarAccountEvidence(page, loginSecretKey, TRANSITIONAL_SENTINEL),
	).toEqual(untouched);

	await openLogOutDialog(page);
	await page.getByTestId("log-out-confirm").click();
	await page.waitForURL("**/login", { timeout: VAULT_READY_TIMEOUT_MS });
	expect(
		await page.evaluate(() => localStorage.getItem("__e2e_query_cache_clear")),
	).toBe("called");
	expect(
		await page.evaluate(async () => {
			// @ts-expect-error Vite serves this browser-only module path to the E2E page.
			const { queryClient } = await import("/src/router.tsx");
			return queryClient.getQueryData(["e2e", "teardown-cache"]);
		}),
	).toBeUndefined();
	expect(
		await page.evaluate(
			(key) => localStorage.getItem(key) === null,
			loginSecretKey,
		),
	).toBe(true);
});

test("Sidebar Log out reports incomplete phases, stays put, and exposes its escape only after the second failure", async ({
	page,
}) => {
	test.setTimeout(300000);
	await signUpWithoutCredentialArtifacts(page, generateTestUser());
	const names = await accountNames(page);
	const originalPath = new URL(page.url()).pathname;
	await forceRuntimeAccountRemovalFailure(page);
	await openLogOutDialog(page);

	await page.getByTestId("log-out-confirm").click();
	await expect(page.getByTestId("log-out-incomplete-areas")).toBeVisible();
	await expect(
		page.getByTestId("log-out-incomplete-areas").getByRole("listitem"),
	).toHaveText([uiText("teardown_area_platform_storage")]);
	await expect(page.getByTestId("log-out-confirm")).toBeEnabled();
	await expect(page.getByTestId("log-out-clear-browser-data")).toHaveCount(0);
	expect(new URL(page.url()).pathname).toBe(originalPath);

	await page.getByTestId("log-out-confirm").click();
	await expect(page.getByTestId("log-out-clear-browser-data")).toBeVisible();
	await expect
		.poll(() =>
			page.evaluate(() => localStorage.getItem("bittery_runtime_account_id")),
		)
		.toBe(names.runtimeAccountId);
	await page.getByTestId("log-out-clear-browser-data").click();
	await expect(
		page.getByRole("heading", {
			name: uiText("nav_log_out_browser_cleared_title"),
		}),
	).toBeVisible();
	await expect(page.getByTestId("log-out-dialog")).toHaveAttribute(
		"data-teardown-status",
		"browserDataCleared",
	);
	await expect(page.getByTestId("log-out-confirm")).toHaveCount(0);
	await expect(page.getByTestId("log-out-clear-browser-data")).toHaveCount(0);
	expect(new URL(page.url()).pathname).toBe(originalPath);
	expect(
		await page.evaluate(() =>
			localStorage.getItem("bittery_runtime_account_id"),
		),
	).toBe(names.runtimeAccountId);
});

test("Sidebar Log out re-enables controls when manager.refresh throws", async ({
	page,
}) => {
	test.setTimeout(300000);
	await signUpWithoutCredentialArtifacts(page, generateTestUser());
	const managerModuleUrl = `/@fs${fileURLToPath(
		new URL(
			"../../../../packages/core/src/services/account-session-manager.ts",
			import.meta.url,
		),
	)}`;
	await page.evaluate(async (moduleUrl) => {
		const { AccountSessionManager } = (await import(
			/* @vite-ignore */ moduleUrl
		)) as {
			AccountSessionManager: {
				prototype: { refresh: () => Promise<never> };
			};
		};
		AccountSessionManager.prototype.refresh = async () => {
			localStorage.setItem("__e2e_manager_refresh_throw", "called");
			throw new Error("forced manager.refresh failure");
		};
	}, managerModuleUrl);
	await openLogOutDialog(page);
	await page.getByTestId("log-out-confirm").click();
	await expect
		.poll(() =>
			page.evaluate(() => localStorage.getItem("__e2e_manager_refresh_throw")),
		)
		.toBe("called");
	await expect(page.getByTestId("log-out-confirm")).toBeEnabled();
	await expect(page.getByTestId("log-out-cancel")).toBeEnabled();
	await expect(page.getByTestId("log-out-incomplete-areas")).toBeVisible();
	await expect(page).not.toHaveURL(/\/login/);
});

test("Sidebar Log out re-enables controls when localStorage throws", async ({
	page,
}) => {
	test.setTimeout(300000);
	await signUpWithoutCredentialArtifacts(page, generateTestUser());
	await page.evaluate(() => {
		const original = Storage.prototype.removeItem;
		Storage.prototype.removeItem = function (key: string) {
			if (key === "bittery_web_account_id") {
				localStorage.setItem("__e2e_local_storage_throw", "called");
				throw new Error("forced localStorage failure");
			}
			return original.call(this, key);
		};
	});
	await openLogOutDialog(page);
	await page.getByTestId("log-out-confirm").click();
	await expect
		.poll(() =>
			page.evaluate(() => localStorage.getItem("__e2e_local_storage_throw")),
		)
		.toBe("called");
	await expect(page.getByTestId("log-out-confirm")).toBeEnabled();
	await expect(page.getByTestId("log-out-cancel")).toBeEnabled();
	await expect(page).not.toHaveURL(/\/login/);
});

test("Use a different account exposes Session retirement only after a second failure and re-enables email", async ({
	page,
}) => {
	test.setTimeout(300000);
	await signUpWithoutCredentialArtifacts(page, generateTestUser());
	const names = await accountNames(page);
	await page.goto("/login");
	const originalPath = new URL(page.url()).pathname;
	const retry = page.getByTestId("use-different-account");
	const escapeButton = page.getByTestId("use-different-account-escape");
	await expect(retry).toBeVisible();
	await page.evaluate(async () => {
		// @ts-expect-error Vite serves this browser-only module path to the E2E page.
		const { webWorkerOwner } = await import("/src/lib/crypto.ts");
		await webWorkerOwner.close();
	});

	await retry.click();
	await expect(retry).toBeEnabled();
	await expect(escapeButton).toHaveCount(0);
	await retry.click();
	await expect(escapeButton).toBeVisible();
	expect(
		await page.evaluate(() =>
			localStorage.getItem("bittery_runtime_account_id"),
		),
	).toBe(names.runtimeAccountId);
	await escapeButton.click();
	await expect(
		page.locator("[data-sonner-toast]").filter({
			hasText: uiText("auth_signin_different_account_forgotten"),
		}),
	).toBeVisible();
	await expect(page.getByTestId("signin-form").locator("#email")).toBeEnabled();
	await expect(page.getByTestId("signin-form")).toHaveAttribute(
		"data-teardown-status",
		"browserSessionForgotten",
	);
	await expect(retry).toHaveCount(0);
	await expect(escapeButton).toHaveCount(0);
	expect(new URL(page.url()).pathname).toBe(originalPath);
	expect(
		await page.evaluate(() =>
			localStorage.getItem("bittery_runtime_account_id"),
		),
	).toBe(names.runtimeAccountId);
});

test("Danger Zone deletion keeps its first Account through fallback activation and a second local failure", async ({
	page,
	browser,
}) => {
	test.setTimeout(300000);
	const fallbackContext = await browser.newContext();
	const fallback = await signUpWithoutCredentialArtifacts(
		await fallbackContext.newPage(),
		generateTestUser(),
	);
	await fallbackContext.close();
	const disposable = await signUpWithoutCredentialArtifacts(
		page,
		generateTestUser(),
	);
	const names = await accountNames(page);
	const fallbackRuntimeAccountId = await page.evaluate(
		async ({ activeRuntimeAccountId, activePassword, fallback }) => {
			const cryptoModuleUrl = "/src/lib/crypto.ts";
			const authServerModuleUrl = "/src/lib/auth-server.ts";
			const [{ runtimeClient }, { getServerUrl }] = await Promise.all([
				import(/* @vite-ignore */ cryptoModuleUrl),
				import(/* @vite-ignore */ authServerModuleUrl),
			]);
			await runtimeClient.lock(activeRuntimeAccountId);
			const signedIn = await runtimeClient.signIn({
				serverUrl: getServerUrl(),
				email: fallback.email,
				masterPassword: fallback.password,
				secretKey: fallback.secretKey,
				insecureTransportConfirmed: false,
			});
			const originalRemoveAccount =
				runtimeClient.removeAccount.bind(runtimeClient);
			runtimeClient.removeAccount = async (
				accountId: string,
				options?: { signal?: AbortSignal },
			) => {
				const removed = JSON.parse(
					localStorage.getItem("__e2e_removed_runtime_accounts") ?? "[]",
				) as string[];
				removed.push(accountId);
				localStorage.setItem(
					"__e2e_removed_runtime_accounts",
					JSON.stringify(removed),
				);
				return originalRemoveAccount(accountId, options);
			};
			await runtimeClient.quickUnlock({
				accountId: activeRuntimeAccountId,
				masterPassword: activePassword,
			});
			runtimeClient.selectAccount(activeRuntimeAccountId);
			return signedIn.accountId;
		},
		{
			activeRuntimeAccountId: names.runtimeAccountId,
			activePassword: disposable.password,
			fallback,
		},
	);
	await expect
		.poll(() =>
			page.evaluate(() => localStorage.getItem("bittery_runtime_account_id")),
		)
		.toBe(names.runtimeAccountId);
	let deleteRequests = 0;
	await page.route("**/api/v1/users/me", async (route) => {
		if (route.request().method() === "DELETE") deleteRequests += 1;
		await route.continue();
	});
	await forceRuntimeAccountRemovalFailure(page);
	await openDeleteDialog(page, disposable.email);
	const dialog = page.getByTestId("delete-account-dialog");
	const originalPath = new URL(page.url()).pathname;
	await expect(dialog).toHaveAttribute(
		"data-account-id",
		names.runtimeAccountId,
	);
	await expect(dialog).toHaveAttribute("data-account-email", disposable.email);

	await dialog.getByTestId("delete-account-confirm").click();
	await expect(
		dialog.getByTestId("delete-account-incomplete-areas"),
	).toBeVisible({
		timeout: VAULT_READY_TIMEOUT_MS,
	});
	await expect
		.poll(() =>
			page.evaluate(
				(key) => JSON.parse(localStorage.getItem(key) ?? "null")?.phase,
				ACCOUNT_DELETION_MARKER_KEY,
			),
		)
		.toBe("serverDeleted");
	expect(deleteRequests).toBe(1);
	await expect
		.poll(() =>
			page.evaluate(async () => {
				// @ts-expect-error Vite serves this browser-only module path to the page.
				const { runtimeClient } = await import("/src/lib/crypto.ts");
				return runtimeClient.resolveAccount();
			}),
		)
		.toBe(fallbackRuntimeAccountId);
	await expect(dialog).toHaveAttribute(
		"data-account-id",
		names.runtimeAccountId,
	);
	await expect(dialog).toHaveAttribute("data-account-email", disposable.email);
	await expect(dialog).not.toContainText(fallback.email);
	await dialog.getByTestId("delete-account-cancel").click();
	await expect(dialog).toBeHidden();
	await page
		.getByRole("button", {
			name: uiText("settings_delete_account_dialog_trigger"),
		})
		.click();
	await expect(
		dialog.getByTestId("delete-account-incomplete-areas"),
	).toBeVisible();
	await expect(dialog).toHaveAttribute(
		"data-account-id",
		names.runtimeAccountId,
	);
	await expect(dialog).toHaveAttribute("data-account-email", disposable.email);
	await expect(dialog).not.toContainText(fallback.email);
	await expect(
		dialog.getByTestId("delete-account-clear-browser-data"),
	).toHaveCount(0);
	await dialog.getByTestId("delete-account-confirm").click();
	expect(deleteRequests).toBe(1);
	expect(
		await page.evaluate(() =>
			JSON.parse(
				localStorage.getItem("__e2e_removed_runtime_accounts") ?? "[]",
			),
		),
	).toEqual([names.runtimeAccountId, names.runtimeAccountId]);
	await expect(
		dialog.getByTestId("delete-account-clear-browser-data"),
	).toBeVisible();
	expect(
		await page.evaluate(() =>
			localStorage.getItem("bittery_runtime_account_id"),
		),
	).toBe(names.runtimeAccountId);
	await dialog.getByTestId("delete-account-clear-browser-data").click();
	await expect(
		dialog.getByRole("heading", {
			name: uiText("settings_delete_account_dialog_browser_cleared_title"),
		}),
	).toBeVisible();
	await expect(dialog).toHaveAttribute(
		"data-teardown-status",
		"browserDataCleared",
	);
	await expect(dialog.getByTestId("delete-account-confirm")).toHaveCount(0);
	await expect(
		dialog.getByTestId("delete-account-clear-browser-data"),
	).toHaveCount(0);
	expect(new URL(page.url()).pathname).toBe(originalPath);
	expect(
		await page.evaluate(() =>
			localStorage.getItem("bittery_runtime_account_id"),
		),
	).toBe(names.runtimeAccountId);
	expect(
		await page.evaluate(
			(key) => localStorage.getItem(key),
			ACCOUNT_DELETION_MARKER_KEY,
		),
	).toBeNull();
});

test("Sidebar Log out clears a truly abandoned pre-transport prepared deletion", async ({
	page,
}) => {
	test.setTimeout(300000);
	const signedUp = await signUpWithoutCredentialArtifacts(
		page,
		generateTestUser(),
	);
	let deleteRequests = 0;
	await page.route("**/api/v1/users/me", async (route) => {
		if (route.request().method() === "DELETE") deleteRequests += 1;
		await route.continue();
	});
	await openDeleteDialog(page, signedUp.email);
	await page.evaluate((markerKey) => {
		const original = Storage.prototype.setItem;
		Storage.prototype.setItem = function (key: string, value: string) {
			if (
				key === markerKey &&
				(JSON.parse(value) as { phase?: string }).phase === "dispatchedUnknown"
			) {
				throw new Error("forced pre-transport marker promotion failure");
			}
			return original.call(this, key, value);
		};
	}, ACCOUNT_DELETION_MARKER_KEY);
	const deleteDialog = page.getByTestId("delete-account-dialog");
	await deleteDialog.getByTestId("delete-account-confirm").click();
	await expect
		.poll(() =>
			page.evaluate(
				(key) => JSON.parse(localStorage.getItem(key) ?? "null")?.phase,
				ACCOUNT_DELETION_MARKER_KEY,
			),
		)
		.toBe("prepared");
	expect(deleteRequests).toBe(0);
	await deleteDialog.getByTestId("delete-account-cancel").click();
	await openLogOutDialog(page);
	await page.getByTestId("log-out-confirm").click();
	await page.waitForURL("**/login", { timeout: VAULT_READY_TIMEOUT_MS });
	expect(
		await page.evaluate(
			(key) => localStorage.getItem(key),
			ACCOUNT_DELETION_MARKER_KEY,
		),
	).toBeNull();
});
