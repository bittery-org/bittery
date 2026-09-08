import type { BrowserContext, Locator, Page } from "@playwright/test";
import { expect, generateTestUser, signUp, test } from "../fixtures/auth";
import { uiText } from "../fixtures/messages";
import { recoverySetupBudget } from "../fixtures/recovery-setup";

const DATABASES = [
	"bittery_replica",
	"bittery_attachment_artifacts",
	"bittery-vault-image-artifacts",
];
const FAMILY_LOCK = "bittery:runtime-storage-family";

/** No app imports: browser storage can be removed only after the real owner retires. */
async function storagePage(context: BrowserContext): Promise<Page> {
	const page = await context.newPage();
	await page.route("**/ticket42-storage-loss", (route) =>
		route.fulfill({
			contentType: "text/html",
			body: "<!doctype html><title>Storage loss fixture</title>",
		}),
	);
	await page.goto("/ticket42-storage-loss");
	return page;
}

async function closeOwner(page: Page, observer: Page): Promise<void> {
	const worker = page
		.workers()
		.find((value) => value.url().includes("runtime.worker"));
	if (!worker) throw new Error("Expected the production Runtime Worker");
	await page.close();
	// Firefox can retire the actual Worker without emitting Playwright's Worker close event.
	await expect(worker.evaluate(() => true)).rejects.toThrow(
		"Target page, context or browser has been closed",
	);
	await expect
		.poll(() =>
			observer.evaluate(
				async (name) =>
					(await navigator.locks.query()).held?.filter(
						(lock) => lock.name === name,
					).length ?? 0,
				FAMILY_LOCK,
			),
		)
		.toBe(0);
}

async function inspect(page: Page): Promise<Locator> {
	await page
		.getByRole("button", {
			name: uiText("replica_recovery_title"),
			exact: true,
		})
		.click();
	const dialog = page.getByTestId("replica-recovery-dialog");
	await dialog
		.getByRole("button", {
			name: uiText("replica_recovery_inspect"),
			exact: true,
		})
		.click();
	await expect(
		dialog.getByRole("button", {
			name: uiText("replica_recovery_inspect_again"),
			exact: true,
		}),
	).toBeEnabled({ timeout: 30_000 });
	return dialog;
}

async function replicaHeadCount(page: Page): Promise<number> {
	return page.evaluate(async () => {
		const db = await new Promise<IDBDatabase>((resolve, reject) => {
			const request = indexedDB.open("bittery_replica");
			request.onupgradeneeded = () => {
				request.transaction?.abort();
				reject(new Error("Expected existing Replica"));
			};
			request.onerror = () => reject(request.error);
			request.onsuccess = () => resolve(request.result);
		});
		try {
			return await new Promise<number>((resolve, reject) => {
				const request = db
					.transaction("heads", "readonly")
					.objectStore("heads")
					.count();
				request.onsuccess = () => resolve(request.result);
				request.onerror = () => reject(request.error);
			});
		} finally {
			db.close();
		}
	});
}

async function deleteDatabases(page: Page, names: string[]): Promise<void> {
	await page.evaluate(async (databases) => {
		for (const name of databases) {
			await new Promise<void>((resolve, reject) => {
				const request = indexedDB.deleteDatabase(name);
				request.onsuccess = () => resolve();
				request.onerror = () => reject(request.error);
				request.onblocked = () =>
					reject(new Error("Storage deletion still has a live owner"));
			});
		}
	}, names);
}

async function expectFreshProfile(page: Page): Promise<void> {
	await page.goto("/login");
	await expect(
		page.getByRole("button", {
			name: uiText("auth_signin_button_unlock_vault"),
			exact: true,
		}),
	).toHaveCount(0);
	await expect(page.locator("#email")).toBeVisible({ timeout: 30_000 });
	await expect(
		page.getByRole("heading", {
			name: uiText("runtime_storage_unavailable_title"),
			exact: true,
		}),
	).toHaveCount(0);
	const dialog = await inspect(page);
	await expect(
		dialog.getByText(uiText("replica_recovery_fresh_unknown"), { exact: true }),
	).toBeVisible();
	await expect(dialog.getByTestId("recovery-account-diagnostics")).toHaveCount(
		0,
	);
	await expect(
		dialog.getByRole("button", {
			name: uiText("replica_recovery_repair"),
			exact: true,
		}),
	).toHaveCount(0);
	await expect(
		dialog.getByRole("button", {
			name: uiText("replica_recovery_rebootstrap"),
			exact: true,
		}),
	).toHaveCount(0);
	await expect(replicaHeadCount(page)).resolves.toBe(0);
}

test("deleted Replica with a surviving catalog reports loss, and clearing all local storage becomes fresh or unknown", async ({
	browser,
}) => {
	const setup = recoverySetupBudget(browser, 150_000);
	test.setTimeout(setup.testTimeoutMs);
	const context = await browser.newContext();
	try {
		const page = await context.newPage();
		const user = await signUp(page, generateTestUser(), setup.signupOptions);
		await expect.poll(() => replicaHeadCount(page)).toBe(1);
		const observer = await storagePage(context);
		await closeOwner(page, observer);
		const catalog = await catalogFingerprint(observer);
		expect(catalog.keyCount).toBeGreaterThan(0);
		await deleteDatabases(observer, ["bittery_replica"]);
		expect(await catalogFingerprint(observer)).toEqual(catalog);
		const missing = await context.newPage();
		await missing.goto("/login");
		await expect(
			missing.getByRole("heading", {
				name: uiText("runtime_storage_unavailable_title"),
				exact: true,
			}),
		).toBeVisible({ timeout: 30_000 });
		const dialog = await inspect(missing);
		await expect(dialog.locator("#recovery-account option")).toHaveCount(1);
		await expect(dialog.locator("#recovery-account option")).toContainText(
			user.email,
		);
		await expect(
			dialog.getByText(uiText("replica_recovery_state_missing"), {
				exact: true,
			}),
		).toBeVisible();
		await expect(
			dialog.getByRole("button", {
				name: uiText("replica_recovery_rebootstrap"),
				exact: true,
			}),
		).toBeDisabled();
		await expect(
			dialog.getByRole("button", {
				name: uiText("replica_recovery_repair"),
				exact: true,
			}),
		).toBeDisabled();
		expect(await replicaHeadCount(missing)).toBe(0);
		await closeOwner(missing, observer);
		await deleteDatabases(observer, DATABASES);
		await observer.evaluate(async () => {
			localStorage.clear();
			sessionStorage.clear();
			const root = await navigator.storage.getDirectory();
			await root
				.removeEntry("bittery-encrypted-recovery-v1", { recursive: true })
				.catch((error) => {
					if (
						!(error instanceof DOMException) ||
						error.name !== "NotFoundError"
					)
						throw error;
				});
		});
		await context.clearCookies();
		expect(await observer.evaluate(() => localStorage.length)).toBe(0);
		await expectFreshProfile(await context.newPage());
	} finally {
		await context.close();
	}
});

test("closing a nonpersistent browser context loses its local Account without claiming recovery", async ({
	browser,
}) => {
	const setup = recoverySetupBudget(browser, 120_000);
	test.setTimeout(setup.testTimeoutMs);
	const original = await browser.newContext();
	try {
		const page = await original.newPage();
		await signUp(page, generateTestUser(), setup.signupOptions);
		await expect.poll(() => replicaHeadCount(page)).toBe(1);
		expect(await page.evaluate(() => localStorage.length)).toBeGreaterThan(0);
	} finally {
		await original.close();
	}
	// This proves Playwright's isolated nonpersistent context lifetime, not every private browsing mode.
	const fresh = await browser.newContext();
	try {
		const observer = await storagePage(fresh);
		expect(await observer.evaluate(() => localStorage.length)).toBe(0);
		expect(
			await observer.evaluate(async () =>
				(await indexedDB.databases()).map((db) => db.name),
			),
		).not.toContain("bittery_replica");
		await expectFreshProfile(await fresh.newPage());
	} finally {
		await fresh.close();
	}
});

/** Compare physical source bytes without printing catalog keys, credentials, or record payloads. */
async function storageFingerprint(page: Page): Promise<string> {
	return page.evaluate(async (names) => {
		const databases: unknown[] = [];
		for (const name of names) {
			const db = await new Promise<IDBDatabase>((resolve, reject) => {
				const request = indexedDB.open(name);
				request.onupgradeneeded = () => {
					request.transaction?.abort();
					reject(new Error("Expected existing source database"));
				};
				request.onerror = () => reject(request.error);
				request.onsuccess = () => resolve(request.result);
			});
			try {
				const stores = [...db.objectStoreNames];
				const tx = db.transaction(stores, "readonly");
				const rows = await Promise.all(
					stores.map(
						(store) =>
							new Promise<unknown[]>((resolve, reject) => {
								const request = tx.objectStore(store).getAll();
								request.onsuccess = () => resolve(request.result);
								request.onerror = () => reject(request.error);
							}),
					),
				);
				databases.push({ name, version: db.version, stores, rows });
			} finally {
				db.close();
			}
		}
		const json = JSON.stringify(databases, (_key, value) => {
			if (value instanceof ArrayBuffer) return [...new Uint8Array(value)];
			if (value instanceof Uint8Array) return [...value];
			return value;
		});
		return [
			...new Uint8Array(
				await crypto.subtle.digest("SHA-256", new TextEncoder().encode(json)),
			),
		]
			.map((byte) => byte.toString(16).padStart(2, "0"))
			.join("");
	}, DATABASES);
}

test("an injected Worker OPFS quota failure preserves recovery sources and publishes no completed export", async ({
	browser,
}) => {
	const setup = recoverySetupBudget(browser, 120_000);
	test.setTimeout(setup.testTimeoutMs);
	const context = await browser.newContext();
	try {
		const page = await context.newPage();
		await signUp(page, generateTestUser(), setup.signupOptions);
		await page.goto("/login");
		await expect(
			page.getByRole("button", {
				name: uiText("auth_signin_button_unlock_vault"),
				exact: true,
			}),
		).toBeVisible({ timeout: 30_000 });
		const dialog = await inspect(page);
		const original = await storageFingerprint(page);
		const worker = page
			.workers()
			.find((value) => value.url().includes("runtime.worker"));
		if (!worker) throw new Error("Expected the production Runtime Worker");
		// Real browser write primitive, injected error. This is not physical disk exhaustion.
		await worker.evaluate(() => {
			const scope = globalThis as unknown as {
				FileSystemSyncAccessHandle: {
					prototype: { write: (...args: unknown[]) => number };
				};
				__recoveryQuota?: { calls: number; restore: () => void };
			};
			const prototype = scope.FileSystemSyncAccessHandle.prototype;
			const write = prototype.write;
			const fault = {
				calls: 0,
				restore: () => {
					prototype.write = write;
				},
			};
			scope.__recoveryQuota = fault;
			prototype.write = () => {
				fault.calls += 1;
				throw new DOMException(
					"Injected recovery spool write refusal",
					"QuotaExceededError",
				);
			};
		});
		try {
			await dialog
				.getByLabel(uiText("replica_recovery_password"), { exact: true })
				.fill("Independent recovery export password 42!");
			await dialog
				.getByRole("button", {
					name: uiText("replica_recovery_export"),
					exact: true,
				})
				.click();
			await expect(
				dialog.getByText(uiText("replica_recovery_quota"), { exact: true }),
			).toBeVisible({ timeout: 30_000 });
			expect(
				await worker.evaluate(
					() =>
						(globalThis as unknown as { __recoveryQuota: { calls: number } })
							.__recoveryQuota.calls,
				),
			).toBe(1);
			await expect(dialog.getByTestId("recovery-prepared-file")).toHaveCount(0);
			expect(await storageFingerprint(page)).toBe(original);
			await dialog
				.getByRole("button", {
					name: uiText("replica_recovery_retained_scan"),
					exact: true,
				})
				.click();
			await expect(
				dialog.getByRole("button", {
					name: uiText("replica_recovery_retained_scan"),
					exact: true,
				}),
			).toBeEnabled();
			await expect(dialog.getByTestId("recovery-prepared-file")).toHaveCount(0);
			const files = await worker.evaluate(async () => {
				const root = await navigator.storage.getDirectory();
				const directory = await root.getDirectoryHandle(
					"bittery-encrypted-recovery-v1",
				);
				const entries = directory as unknown as {
					keys(): AsyncIterable<string>;
				};
				let count = 0;
				for await (const _name of entries.keys()) count += 1;
				return count;
			});
			expect(files).toBe(0);
		} finally {
			await worker.evaluate(() => {
				const scope = globalThis as unknown as {
					__recoveryQuota?: { restore(): void };
				};
				scope.__recoveryQuota?.restore();
				delete scope.__recoveryQuota;
			});
		}
	} finally {
		await context.close();
	}
});

async function catalogFingerprint(
	page: Page,
): Promise<{ keyCount: number; digest: string }> {
	return page.evaluate(async () => {
		const entries = Object.entries(localStorage).sort(([left], [right]) =>
			left.localeCompare(right),
		);
		const bytes = new TextEncoder().encode(JSON.stringify(entries));
		const digest = [
			...new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)),
		]
			.map((byte) => byte.toString(16).padStart(2, "0"))
			.join("");
		return { keyCount: entries.length, digest };
	});
}
