import type { Page, Route } from "@playwright/test";
import { nanoid } from "nanoid";
import { expect, generateTestUser, signUp, test } from "../fixtures/auth";
import { runE2eSql, sqlString } from "../fixtures/e2e-database";
import {
	createItem,
	itemRow,
	VAULT_READY_TIMEOUT_MS,
	vaultNavLink,
} from "../fixtures/vault";

const TEST_BUDGET_MS = 420_000;
const TRANSIENT_FAILURES = 6;

type ReplicaContents = Record<string, unknown[]>;

async function replicaContents(page: Page): Promise<ReplicaContents> {
	return page.evaluate(async () => {
		const database = await new Promise<IDBDatabase>((resolve, reject) => {
			const request = indexedDB.open("bittery_replica");
			request.onsuccess = () => resolve(request.result);
			request.onerror = () => reject(request.error);
		});
		try {
			const stores = [...database.objectStoreNames];
			const transaction = database.transaction(stores, "readonly");
			const entries = await Promise.all(
				stores.map(
					(storeName) =>
						new Promise<[string, unknown[]]>((resolve, reject) => {
							const request = transaction.objectStore(storeName).getAll();
							request.onsuccess = () =>
								resolve([storeName, request.result as unknown[]]);
							request.onerror = () => reject(request.error);
						}),
				),
			);
			return Object.fromEntries(entries);
		} finally {
			database.close();
		}
	});
}

function operationId(route: Route): string | undefined {
	return route.request().headers()["idempotency-key"];
}

async function openRuntimeVault(page: Page, vaultId: string): Promise<void> {
	await page.getByRole("link", { name: "Vaults", exact: true }).first().click();
	await page.waitForURL("**/vaults");
	await expect(vaultNavLink(page, vaultId)).toBeVisible({
		timeout: VAULT_READY_TIMEOUT_MS,
	});
	await vaultNavLink(page, vaultId).click();
	await page.waitForURL(`**/vaults/${vaultId}`);
	await expect(page.getByTestId("new-item-button")).toBeVisible({
		timeout: VAULT_READY_TIMEOUT_MS,
	});
}

test("the Rust Runtime durably reconciles an offline create after restart and repeated transport loss", async ({
	browser,
}) => {
	test.setTimeout(TEST_BUDGET_MS);

	const context = await browser.newContext();
	const page = await context.newPage();
	const suffix = nanoid(6);
	const title = `Runtime durable ${suffix}`;
	const plaintextMarker = `PLAINTEXT-RUNTIME-${suffix}`;
	const requestBodies: string[] = [];
	const observedOperationIds: string[] = [];
	const consoleMessages: string[] = [];
	let putAttempts = 0;
	let refreshes = 0;
	let successfulResponseLost = false;
	let hiddenOutcomeOnce = false;

	page.on("console", (message) => consoleMessages.push(message.text()));

	try {
		// Ticket 30 owns long-held SSE reconnect policy. This reconciliation test
		// supplies one deterministic finite wakeup frame, so it exercises the real
		// Runtime transport without inventing reconnect or backoff behaviour here.
		await page.route("**/api/v1/sync/events", (route) =>
			route.fulfill({
				status: 200,
				contentType: "text/event-stream",
				body: "event: ping\ndata: {}\n\n",
			}),
		);
		const user = await signUp(page, generateTestUser());
		const vaultId = runE2eSql(`
			SELECT vault.id
			FROM vault
			JOIN "user" ON "user".id = vault.created_by_id
			WHERE "user".email = '${sqlString(user.email)}' AND vault.type = 'personal'
			LIMIT 1;
		`)
			.split("\n")
			.find((line) => /^[0-9a-f-]{36}$/.test(line.trim()))
			?.trim();
		if (!vaultId) throw new Error("Signup did not create a personal Vault.");
		await openRuntimeVault(page, vaultId);

		await context.route("**/api/v1/**", async (route) => {
			const request = route.request();
			const pathname = new URL(request.url()).pathname;
			if (pathname === "/api/v1/sessions/current/refresh") {
				refreshes += 1;
				await route.continue();
				return;
			}

			if (
				request.method() === "GET" &&
				pathname.startsWith("/api/v1/operations/") &&
				successfulResponseLost &&
				!hiddenOutcomeOnce
			) {
				hiddenOutcomeOnce = true;
				await route.fulfill({ status: 404, body: "" });
				return;
			}

			if (
				request.method() !== "PUT" ||
				!pathname.startsWith(`/api/v1/vaults/${vaultId}/items/`)
			) {
				await route.continue();
				return;
			}

			putAttempts += 1;
			requestBodies.push(request.postData() ?? "");
			const id = operationId(route);
			if (id) observedOperationIds.push(id);

			if (putAttempts <= TRANSIENT_FAILURES) {
				await route.abort("connectionreset");
				return;
			}
			if (putAttempts === TRANSIENT_FAILURES + 1) {
				await route.fulfill({ status: 401, body: "" });
				return;
			}
			if (putAttempts === TRANSIENT_FAILURES + 2) {
				await route.fetch();
				successfulResponseLost = true;
				await route.abort("connectionreset");
				return;
			}
			await route.continue();
		});

		await createItem(page, "login", async (sheet) => {
			await sheet.locator("#title").fill(title);
			await sheet.locator("#username").fill(plaintextMarker);
			await sheet.locator("#password").fill(`Password-${suffix}!`);
		});
		const itemId = await page
			.getByTestId("item-detail-pane")
			.getAttribute("data-item-id");
		expect(itemId).toBeTruthy();
		await expect(page.getByTestId("item-detail-status-pending")).toBeVisible();

		const acceptedReplica = await replicaContents(page);
		expect(acceptedReplica.operations).toHaveLength(1);
		expect(acceptedReplica.optimistic_items).toHaveLength(1);
		expect(JSON.stringify(acceptedReplica)).not.toContain(plaintextMarker);

		// Reloading tears down the process-owned Worker. The route remains intercepted,
		// so the new Worker can only restore the accepted Operation from IndexedDB.
		await page.reload();
		await page.waitForLoadState("domcontentloaded");
		const restoredReplica = await replicaContents(page);
		expect(restoredReplica.operations).toHaveLength(1);
		expect(restoredReplica.optimistic_items).toHaveLength(1);
		await expect(
			page.getByRole("button", { name: "Unlock Vault", exact: true }),
		).toBeVisible({ timeout: VAULT_READY_TIMEOUT_MS });
		await page.locator("#password").fill(user.password);
		await page
			.getByRole("button", { name: "Unlock Vault", exact: true })
			.click();
		await page.waitForURL("**/home", { timeout: VAULT_READY_TIMEOUT_MS });

		// Leaving the vault removes the initiating Items subscription. Dispatch belongs
		// to the Runtime process and must continue without that UI observer.
		await expect
			.poll(() => putAttempts, { timeout: 240_000 })
			.toBeGreaterThanOrEqual(TRANSIENT_FAILURES + 3);
		expect(refreshes).toBeGreaterThanOrEqual(1);
		expect(successfulResponseLost).toBe(true);
		expect(hiddenOutcomeOnce).toBe(true);
		expect(new Set(requestBodies).size).toBe(1);
		expect(new Set(observedOperationIds).size).toBe(1);

		await openRuntimeVault(page, vaultId);
		await expect(itemRow(page, title)).toHaveCount(1);
		await expect(page.getByTestId("item-status-pending")).toHaveCount(0);
		await expect(page.getByTestId("item-status-failed")).toHaveCount(0);

		const operation = observedOperationIds[0];
		if (!itemId || !operation) {
			throw new Error("The accepted create did not expose durable identities.");
		}
		const reconciledReplica = await replicaContents(page);
		expect(reconciledReplica.operations).toHaveLength(0);
		expect(reconciledReplica.optimistic_items).toHaveLength(0);
		expect(reconciledReplica.operation_receipts).toHaveLength(1);
		expect(JSON.stringify(reconciledReplica)).not.toContain(plaintextMarker);

		const serverFacts = runE2eSql(`
			WITH subject AS (
				SELECT id FROM "user" WHERE email = '${sqlString(user.email)}'
			)
			SELECT json_build_object(
				'items', (SELECT count(*) FROM item WHERE id = '${sqlString(itemId)}'),
				'audits', (SELECT count(*) FROM audit_log WHERE user_id = (SELECT id FROM subject) AND entity_id = '${sqlString(itemId)}' AND action = 'item_created'),
				'item_events', (SELECT count(*) FROM sync_event WHERE user_id = (SELECT id FROM subject) AND entity_id = '${sqlString(itemId)}' AND event_type = 'item_created'),
				'outcomes', (SELECT count(*) FROM operation_outcome WHERE user_id = (SELECT id FROM subject) AND operation_id = '${sqlString(operation)}'),
				'operation_events', (SELECT count(*) FROM sync_event WHERE user_id = (SELECT id FROM subject) AND entity_id = '${sqlString(operation)}' AND event_type = 'operation_resolved'),
				'plaintext', (
					SELECT count(*) FROM (
						SELECT encrypted_data AS value FROM item WHERE id = '${sqlString(itemId)}'
						UNION ALL SELECT metadata FROM audit_log WHERE user_id = (SELECT id FROM subject)
						UNION ALL SELECT metadata FROM sync_event WHERE user_id = (SELECT id FROM subject)
						UNION ALL SELECT rejection_details::text FROM operation_outcome WHERE user_id = (SELECT id FROM subject)
					) diagnostics WHERE value LIKE '%${sqlString(plaintextMarker)}%'
				)
			)::text;
		`);
		const facts = JSON.parse(serverFacts.match(/\{.*\}/s)?.[0] ?? "{}");
		expect(facts).toEqual({
			items: 1,
			audits: 1,
			item_events: 1,
			outcomes: 1,
			operation_events: 1,
			plaintext: 0,
		});
		expect(consoleMessages.join("\n")).not.toContain(plaintextMarker);
	} finally {
		await context.close();
	}
});
