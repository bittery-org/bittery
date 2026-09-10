import { readFile } from "node:fs/promises";
import type { Locator, Page, Worker } from "@playwright/test";
import { nanoid } from "nanoid";
import {
	expect,
	generateTestUser,
	signUp,
	test,
	waitForAppReady,
} from "../fixtures/auth";
import { uiText } from "../fixtures/messages";
import { recoverySetupBudget } from "../fixtures/recovery-setup";
import { vaultNavLink } from "../fixtures/vault";

const PNG = Buffer.from(
	"iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jWZkAAAAASUVORK5CYII=",
	"base64",
);
// Historical layouts are specified independently of the current opener under test.
type LegacyLayout = [string, string | string[], [string, string | string[]][]];
const LEGACY_DATABASES: {
	name: string;
	version: number;
	layout: LegacyLayout[];
}[] = [
	{
		name: "bittery_replica",
		version: 7,
		layout: [
			["heads", "accountId", []],
			...[
				"optimistic_items",
				"operations",
				"attachment_move_preparations",
				"share_capabilities",
				"operation_receipts",
				"replica_metadata",
				"bootstrap_generations",
				"bootstrap_pages",
				"authority_vaults",
				"authority_items",
			].map(
				(store): LegacyLayout => [
					store,
					["accountId", "recordId"],
					[["by_account", "accountId"]],
				],
			),
		],
	},
	{
		name: "bittery_attachment_artifacts",
		version: 2,
		layout: [
			["artifacts", ["accountId", "artifactId"], [["by_account", "accountId"]]],
			[
				"chunks",
				["accountId", "artifactId", "chunkIndex"],
				[
					["by_account", "accountId"],
					["by_artifact", ["accountId", "artifactId"]],
				],
			],
			[
				"provisional_artifacts",
				["accountId", "operationId", "attachmentId", "generation"],
				[
					["by_account", "accountId"],
					["by_scope", ["accountId", "operationId", "attachmentId"]],
				],
			],
			[
				"provisional_chunks",
				[
					"accountId",
					"operationId",
					"attachmentId",
					"generation",
					"chunkIndex",
				],
				[
					["by_account", "accountId"],
					[
						"by_generation",
						["accountId", "operationId", "attachmentId", "generation"],
					],
				],
			],
		],
	},
	{
		name: "bittery-vault-image-artifacts",
		version: 1,
		layout: [
			[
				"artifacts",
				["accountId", "operationId"],
				[["by_account", "accountId"]],
			],
			[
				"chunks",
				["accountId", "operationId", "chunkIndex"],
				[
					["by_account", "accountId"],
					["by_scope", ["accountId", "operationId"]],
				],
			],
		],
	},
];

async function priorVersionResults(page: Page): Promise<string[]> {
	return page.evaluate(
		async (databases) =>
			Promise.all(
				databases.map(
					({ name, version }) =>
						new Promise<string>((resolve, reject) => {
							const open = indexedDB.open(name, version);
							open.onerror = () => resolve(open.error?.name ?? "unknown error");
							open.onsuccess = () => {
								open.result.close();
								reject(new Error(`Old ${name} opener unexpectedly succeeded`));
							};
						}),
				),
			),
		LEGACY_DATABASES,
	);
}

const EXPORT_PASSWORD = "Separate recovery export password 42!";
type StoredRow = { accountId: string; recordId: string; payloadJson: string };
type Head = {
	accountId: string;
	incarnation: string;
	replicaRevision: string;
	lockEpoch: string;
};
type StoredImage = {
	accountId: string;
	operationId: string;
	byteLength: string;
	sha256: string;
	published: boolean;
};
type StoredChunk = {
	accountId: string;
	operationId: string;
	chunkIndex: number;
	bytes: number[];
};
type PhysicalSnapshot = {
	heads: Head[];
	operations: StoredRow[];
	receipts: StoredRow[];
	vaults: StoredRow[];
	images: StoredImage[];
	chunks: StoredChunk[];
};

/** Read literal persisted records; fixture inspection never decrypts or reconstructs authority. */
async function snapshot(page: Page): Promise<PhysicalSnapshot> {
	return page.evaluate(async () => {
		async function read(name: string, stores: string[]) {
			const db = await new Promise<IDBDatabase>((resolve, reject) => {
				const open = indexedDB.open(name);
				open.onsuccess = () => resolve(open.result);
				open.onerror = () => reject(open.error);
				open.onupgradeneeded = () => {
					open.transaction?.abort();
					reject(new Error("Expected existing fixture database"));
				};
			});
			try {
				const tx = db.transaction(stores, "readonly");
				return await Promise.all(
					stores.map(
						(store) =>
							new Promise<unknown[]>((resolve, reject) => {
								const request = tx.objectStore(store).getAll();
								request.onsuccess = () => resolve(request.result);
								request.onerror = () => reject(request.error);
							}),
					),
				);
			} finally {
				db.close();
			}
		}
		const [heads, operations, receipts, vaults] = await read(
			"bittery_replica",
			["heads", "operations", "operation_receipts", "authority_vaults"],
		);
		const [images, chunks] = await read("bittery-vault-image-artifacts", [
			"artifacts",
			"chunks",
		]);
		if (!heads || !operations || !receipts || !vaults || !images || !chunks)
			throw new Error("Physical snapshot is incomplete");
		return {
			heads,
			operations,
			receipts,
			vaults,
			images,
			chunks: chunks.map((chunk) => {
				const row = chunk as { bytes: Uint8Array };
				return { ...row, bytes: [...row.bytes] };
			}),
		};
	}) as Promise<PhysicalSnapshot>;
}

async function openRecovery(page: Page): Promise<Locator> {
	await page
		.getByRole("button", {
			name: uiText("replica_recovery_title"),
			exact: true,
		})
		.click();
	const dialog = page.getByTestId("replica-recovery-dialog");
	await expect(dialog).toBeVisible();
	return dialog;
}

async function inspect(dialog: Locator, again = false): Promise<void> {
	await dialog
		.getByRole("button", {
			name: uiText(
				again ? "replica_recovery_inspect_again" : "replica_recovery_inspect",
			),
			exact: true,
		})
		.click();
	await expect(
		dialog.getByRole("button", {
			name: uiText("replica_recovery_inspect_again"),
			exact: true,
		}),
	).toBeEnabled({ timeout: 30_000 });
}

async function submitRepair(
	dialog: Locator,
	encrypted: Buffer,
	password = EXPORT_PASSWORD,
): Promise<void> {
	await dialog
		.getByLabel(uiText("replica_recovery_archive"), { exact: true })
		.setInputFiles({
			name: "recovery.btrrec",
			mimeType: "application/octet-stream",
			buffer: encrypted,
		});
	await dialog
		.getByLabel(uiText("replica_recovery_password"), { exact: true })
		.fill(password);
	await dialog
		.getByRole("button", {
			name: uiText("replica_recovery_repair"),
			exact: true,
		})
		.click();
}

/** Lose an actual Worker only after a chosen physical transaction has committed. */
async function armRepairCrash(
	page: Page,
	boundary: "imageAdded" | "replicaRepaired",
): Promise<Worker> {
	const worker = page
		.workers()
		.find((worker) => worker.url().includes("runtime.worker"));
	if (!worker) throw new Error("The actual Runtime Worker is missing");
	await worker.evaluate(
		({ boundary, replicaStores }) => {
			const state = { committed: false };
			Object.assign(globalThis, { ticket42Crash: state });
			const original = IDBDatabase.prototype.transaction;
			IDBDatabase.prototype.transaction = function (
				this: IDBDatabase,
				...args: Parameters<typeof original>
			) {
				const tx = Reflect.apply(original, this, args) as IDBTransaction;
				const names = [...tx.objectStoreNames].sort();
				const matches =
					tx.mode === "readwrite" &&
					(boundary === "imageAdded"
						? this.name === "bittery-vault-image-artifacts" &&
							JSON.stringify(names) === '["chunks"]'
						: this.name === "bittery_replica" &&
							JSON.stringify(names) === JSON.stringify(replicaStores));
				if (matches)
					tx.addEventListener(
						"complete",
						(event) => {
							state.committed = true;
							// Installed before adapter listeners: durable commit happened, acknowledgement cannot escape.
							event.stopImmediatePropagation();
						},
						{ once: true },
					);
				return tx;
			};
		},
		{
			boundary,
			replicaStores: [
				...(LEGACY_DATABASES[0]?.layout.map(([store]) => store) ?? []),
				"recovery_input",
			].sort(),
		},
	);
	return worker;
}
async function awaitCrashBoundary(worker: Worker): Promise<void> {
	await expect
		.poll(
			() =>
				worker.evaluate(
					() =>
						(
							globalThis as typeof globalThis & {
								ticket42Crash: { committed: boolean };
							}
						).ticket42Crash.committed,
				),
			{ timeout: 30_000 },
		)
		.toBe(true);
}
async function crashAndReload(page: Page, worker: Worker): Promise<void> {
	const oldLocks = await worker.evaluate(
		async () =>
			(await navigator.locks.query()).held?.filter(
				(lock) => lock.name === "bittery:runtime-storage-family",
			) ?? [],
	);
	expect(oldLocks).toHaveLength(1);
	expect(oldLocks[0]?.mode).toBe("exclusive");
	const oldClientId = oldLocks[0]?.clientId;
	expect(oldClientId).toBeTruthy();
	await page.reload();
	await expect(worker.evaluate(() => true)).rejects.toThrow(
		"Target page, context or browser has been closed",
	);
	await expect
		.poll(() =>
			page.evaluate(
				async (clientId) =>
					(await navigator.locks.query()).held?.filter(
						(lock) =>
							lock.name === "bittery:runtime-storage-family" &&
							lock.clientId === clientId,
					).length ?? 0,
				oldClientId,
			),
		)
		.toBe(0);
	await expect
		.poll(
			() =>
				page
					.workers()
					.filter(
						(current) =>
							current.url().includes("runtime.worker") && current !== worker,
					).length,
		)
		.toBe(1);
}
async function damageRecoverableStorage(
	page: Page,
	accountId: string,
	operationId: string,
	vaultRow: StoredRow | undefined,
): Promise<void> {
	await page.evaluate(
		async ({ accountId, operationId, vaultRow }) => {
			async function change(
				name: string,
				stores: string[],
				mutate: (tx: IDBTransaction) => void,
			) {
				const db = await new Promise<IDBDatabase>((resolve, reject) => {
					const open = indexedDB.open(name);
					open.onsuccess = () => resolve(open.result);
					open.onerror = () => reject(open.error);
				});
				try {
					await new Promise<void>((resolve, reject) => {
						const tx = db.transaction(stores, "readwrite");
						tx.oncomplete = () => resolve();
						tx.onabort = () => reject(tx.error);
						tx.onerror = () => reject(tx.error);
						mutate(tx);
					});
				} finally {
					db.close();
				}
			}
			await change("bittery-vault-image-artifacts", ["chunks"], (tx) =>
				tx.objectStore("chunks").delete([accountId, operationId, 0]),
			);
			if (!vaultRow)
				throw new Error(
					"Expected actual derived Vault authority before corruption",
				);
			await change("bittery_replica", ["authority_vaults"], (tx) =>
				tx
					.objectStore("authority_vaults")
					.put({ ...vaultRow, payloadJson: "{malformed-derived-authority" }),
			);
		},
		{ accountId, operationId, vaultRow },
	);
}

async function acceptImageVault(page: Page, name: string, filename: string) {
	return (await page.evaluate(
		async ({ png, name, filename }) => {
			const compositionPath = "/src/lib/crypto.ts";
			const imagePath = "/src/lib/runtime-vault-image.ts";
			const { runtimeClient } = await import(compositionPath);
			const { grantRuntimeVaultImage } = await import(imagePath);
			const session = runtimeClient.session().getSnapshot();
			const accountId = session.accounts.find(
				(account: { access: string }) => account.access === "unlocked",
			)?.accountId;
			if (!accountId) throw new Error("Actual Runtime Account did not unlock");
			const grant = grantRuntimeVaultImage(
				accountId,
				new File([new Uint8Array(png)], filename, {
					type: "image/png",
				}),
			);
			try {
				return {
					accountId,
					...(await runtimeClient.createVault({
						accountId,
						name,
						icon: "folder",
						vaultType: "personal",
						imageSource: grant.input,
					})),
				};
			} finally {
				await grant.discard();
			}
		},
		{ png: [...PNG], name, filename },
	)) as { accountId: string; operationId: string; vaultId: string };
}

test("locked recovery excludes another tab and repairs exact accepted Vault work and image bytes from a protected export", async ({
	browser,
}) => {
	const setup = recoverySetupBudget(browser, 240_000);
	test.setTimeout(setup.testTimeoutMs);
	const context = await browser.newContext();
	const page = await context.newPage();
	let blockedImageGrants = 0;
	let blockImageGrant = true;
	try {
		const user = await signUp(page, generateTestUser(), setup.signupOptions);
		// Only transport fails. The actual combined Worker accepts and persists the image intent.
		await context.route(
			"**/api/v1/operations/*/vault-image-staging/grants",
			async (route) => {
				if (blockImageGrant && route.request().method() === "POST") {
					blockedImageGrants += 1;
					await route.abort("failed");
				} else {
					await route.continue();
				}
			},
		);
		const accepted = await acceptImageVault(
			page,
			`Recovery Vault ${nanoid(6)}`,
			"recovery.png",
		);
		await expect.poll(() => blockedImageGrants).toBeGreaterThan(0);
		await page.goto("/login");
		await expect(
			page.getByRole("button", {
				name: uiText("auth_signin_button_unlock_vault"),
				exact: true,
			}),
		).toBeVisible({ timeout: 30_000 });
		const peer = await context.newPage();
		await peer.goto("/login");
		await expect(
			peer.getByRole("button", {
				name: uiText("auth_signin_button_unlock_vault"),
				exact: true,
			}),
		).toBeVisible({ timeout: 30_000 });
		const peerWorker = peer
			.workers()
			.find((worker) => worker.url().includes("runtime.worker"));
		if (peerWorker === undefined)
			throw new Error("Peer Runtime Worker was not observed");
		const original = await snapshot(page);
		expect(await priorVersionResults(peer)).toEqual([
			"VersionError",
			"VersionError",
			"VersionError",
		]);
		expect(await snapshot(page)).toEqual(original);
		expect(original.operations).toHaveLength(1);
		expect(
			JSON.parse(original.operations[0]?.payloadJson ?? "{}"),
		).toMatchObject({
			operationId: accepted.operationId,
			kind: "create_vault",
			target: { type: "vault", vaultId: accepted.vaultId },
		});
		expect(original.images).toHaveLength(1);
		expect(original.images[0]).toMatchObject({
			accountId: accepted.accountId,
			operationId: accepted.operationId,
			published: true,
			byteLength: String(PNG.length),
		});
		expect(original.chunks).toHaveLength(1);
		expect(original.chunks[0]?.bytes).toEqual([...PNG]);

		const dialog = await openRecovery(page);
		await inspect(dialog);
		await expect(
			dialog.getByText(uiText("replica_recovery_busy"), { exact: true }),
		).toBeVisible();
		expect((await snapshot(page)).operations).toEqual(original.operations);
		expect((await snapshot(page)).chunks).toEqual(original.chunks);
		await peer.close();
		await expect(peerWorker.evaluate(() => true)).rejects.toThrow(
			"Target page, context or browser has been closed",
		);
		// Worker close events differ by browser; the dead execution context and released
		// family lease are the actual retirement evidence before the single explicit retry.
		await expect
			.poll(() =>
				page.evaluate(async () => {
					const { held } = await navigator.locks.query();
					return (held ?? []).filter(
						(lock) => lock.name === "bittery:runtime-storage-family",
					).length;
				}),
			)
			.toBe(0);
		await inspect(dialog, true);
		await expect(
			dialog.getByText(uiText("replica_recovery_busy"), { exact: true }),
		).toHaveCount(0);
		await expect(
			dialog.getByTestId("recovery-account-diagnostics"),
		).toContainText(`${uiText("replica_recovery_operations")}: 1`);
		await dialog
			.getByLabel(uiText("replica_recovery_password"), { exact: true })
			.fill(EXPORT_PASSWORD);
		await dialog
			.getByRole("button", {
				name: uiText("replica_recovery_export"),
				exact: true,
			})
			.click();
		const prepared = dialog.getByTestId("recovery-prepared-file");
		await expect(prepared).toContainText(uiText("replica_recovery_complete"), {
			timeout: 30_000,
		});
		await expect(
			dialog.getByLabel(uiText("replica_recovery_password"), { exact: true }),
		).toHaveValue("");
		const downloading = page.waitForEvent("download");
		await prepared
			.getByRole("button", {
				name: uiText("replica_recovery_download"),
				exact: true,
			})
			.click();
		const download = await downloading;
		const file = await download.path();
		if (file === null)
			throw new Error("Recovery export did not finish downloading");
		expect(await download.failure()).toBeNull();
		const encrypted = await readFile(file);
		expect(encrypted.subarray(0, 8).toString("ascii")).toBe("BTRREC01");
		for (const secret of [
			PNG,
			Buffer.from(user.password),
			Buffer.from(EXPORT_PASSWORD),
			Buffer.from(original.operations[0]?.payloadJson ?? ""),
		]) {
			expect(encrypted.includes(secret)).toBe(false);
		}
		await expect(prepared).toContainText(
			uiText("replica_recovery_download_requested"),
		);

		// The first owner is paused. Inject only physical loss/corruption, preserving accepted bytes.
		await damageRecoverableStorage(
			page,
			accepted.accountId,
			accepted.operationId,
			original.vaults[0],
		);
		const damaged = await snapshot(page);
		expect(damaged.operations).toEqual(original.operations);
		expect(damaged.chunks).toHaveLength(0);
		await page.reload();
		await expect(
			page.getByRole("heading", {
				name: uiText("runtime_storage_unavailable_title"),
				exact: true,
			}),
		).toBeVisible({ timeout: 30_000 });
		let failedOwnerDialog = await openRecovery(page);
		// A restarted owner discovers ciphertext, but cannot infer whether that old export completed.
		await failedOwnerDialog
			.getByRole("button", {
				name: uiText("replica_recovery_retained_scan"),
				exact: true,
			})
			.click();
		const retained = failedOwnerDialog.getByTestId("recovery-prepared-file");
		await expect(retained).toHaveCount(1);
		await expect(retained).toContainText(
			uiText("replica_recovery_retained_unknown"),
		);
		const retainedDownload = page.waitForEvent("download");
		await retained
			.getByRole("button", {
				name: uiText("replica_recovery_download"),
				exact: true,
			})
			.click();
		const downloadedAgain = await retainedDownload;
		const retainedPath = await downloadedAgain.path();
		if (retainedPath === null)
			throw new Error("Retained ciphertext download did not finish");
		expect(await downloadedAgain.failure()).toBeNull();
		expect(await readFile(retainedPath)).toEqual(encrypted);
		await retained
			.getByRole("button", {
				name: uiText("replica_recovery_release"),
				exact: true,
			})
			.click();
		await expect(retained).toHaveCount(0);
		await failedOwnerDialog
			.getByRole("button", {
				name: uiText("replica_recovery_retained_scan"),
				exact: true,
			})
			.click();
		await expect(
			failedOwnerDialog.getByRole("button", {
				name: uiText("replica_recovery_retained_scan"),
				exact: true,
			}),
		).toBeEnabled();
		await expect(retained).toHaveCount(0);
		expect(await snapshot(page)).toEqual(damaged);
		// The downloaded File remains independent of the explicitly released local spool;
		// all password/EOF refusal and successful repairs below still consume its exact bytes.
		await inspect(failedOwnerDialog);
		await expect(
			failedOwnerDialog.getByRole("button", {
				name: uiText("replica_recovery_rebootstrap"),
				exact: true,
			}),
		).toBeDisabled();
		const repair = failedOwnerDialog.getByRole("button", {
			name: uiText("replica_recovery_repair"),
			exact: true,
		});
		await expect(repair).toBeEnabled();
		const beforeRepair = await snapshot(page);
		// Authentication and actual EOF must succeed before any missing image bytes are restored.
		for (const invalid of [
			{ buffer: encrypted, password: "A different recovery password 42!" },
			{
				buffer: encrypted.subarray(0, encrypted.length - 1),
				password: EXPORT_PASSWORD,
			},
		]) {
			await submitRepair(failedOwnerDialog, invalid.buffer, invalid.password);
			await expect(failedOwnerDialog.getByRole("alert")).toHaveText(
				uiText("replica_recovery_error"),
				{ timeout: 30_000 },
			);
			expect(await snapshot(page)).toEqual(beforeRepair);
			await expect(repair).toBeEnabled();
		}
		const beforeLogicalWorker = await armRepairCrash(page, "imageAdded");
		await submitRepair(failedOwnerDialog, encrypted);
		await awaitCrashBoundary(beforeLogicalWorker);
		const addedOnly = await snapshot(page);
		expect(addedOnly.heads).toEqual(beforeRepair.heads);
		expect(addedOnly.operations).toEqual(beforeRepair.operations);
		expect(addedOnly.vaults).toEqual(beforeRepair.vaults);
		expect(addedOnly.receipts).toEqual(beforeRepair.receipts);
		expect(addedOnly.images).toEqual(original.images);
		expect(addedOnly.chunks).toEqual(original.chunks);
		await crashAndReload(page, beforeLogicalWorker);
		await expect(
			page.getByRole("heading", {
				name: uiText("runtime_storage_unavailable_title"),
				exact: true,
			}),
		).toBeVisible({ timeout: 30_000 });
		expect(await snapshot(page)).toEqual(addedOnly);
		failedOwnerDialog = await openRecovery(page);
		await inspect(failedOwnerDialog);
		await submitRepair(failedOwnerDialog, encrypted);

		await expect(
			failedOwnerDialog.getByText(uiText("replica_recovery_repaired"), {
				exact: true,
			}),
		).toBeVisible({ timeout: 30_000 });
		const restored = await snapshot(page);
		expect(restored.operations).toEqual(original.operations);
		expect(restored.images).toEqual(original.images);
		expect(restored.chunks).toEqual(original.chunks);
		expect(restored.vaults).toEqual(original.vaults);
		expect(restored.heads[0]?.incarnation).toBe(
			beforeRepair.heads[0]?.incarnation,
		);
		expect(BigInt(restored.heads[0]?.replicaRevision ?? "-1")).toBe(
			BigInt(beforeRepair.heads[0]?.replicaRevision ?? "-1") + 1n,
		);
		expect(BigInt(restored.heads[0]?.lockEpoch ?? "-1")).toBe(
			BigInt(beforeRepair.heads[0]?.lockEpoch ?? "-1") + 1n,
		);

		// Repeat from the same exact bundle, this time losing the Worker after the atomic repair.
		await damageRecoverableStorage(
			page,
			accepted.accountId,
			accepted.operationId,
			original.vaults[0],
		);
		await inspect(failedOwnerDialog, true);
		const beforePostCommit = await snapshot(page);
		const afterLogicalWorker = await armRepairCrash(page, "replicaRepaired");
		await submitRepair(failedOwnerDialog, encrypted);
		await awaitCrashBoundary(afterLogicalWorker);
		const committedWithoutReply = await snapshot(page);
		expect(committedWithoutReply.operations).toEqual(original.operations);
		expect(committedWithoutReply.vaults).toEqual(original.vaults);
		expect(committedWithoutReply.images).toEqual(original.images);
		expect(committedWithoutReply.chunks).toEqual(original.chunks);
		expect(committedWithoutReply.heads[0]?.incarnation).toBe(
			beforePostCommit.heads[0]?.incarnation,
		);
		expect(
			BigInt(committedWithoutReply.heads[0]?.replicaRevision ?? "-1"),
		).toBe(BigInt(beforePostCommit.heads[0]?.replicaRevision ?? "-1") + 1n);
		expect(BigInt(committedWithoutReply.heads[0]?.lockEpoch ?? "-1")).toBe(
			BigInt(beforePostCommit.heads[0]?.lockEpoch ?? "-1") + 1n,
		);
		await crashAndReload(page, afterLogicalWorker);
		await expect(
			page.getByRole("button", {
				name: uiText("auth_signin_button_unlock_vault"),
				exact: true,
			}),
		).toBeVisible({ timeout: 30_000 });
		const reopened = await snapshot(page);
		expect(reopened.operations).toEqual(original.operations);
		expect(reopened.vaults).toEqual(original.vaults);
		expect(reopened.chunks).toEqual(original.chunks);
		expect(reopened.images).toEqual(original.images);
		expect(reopened.receipts).toEqual(committedWithoutReply.receipts);
		expect(reopened.heads).toHaveLength(1);
		expect(reopened.heads[0]).toMatchObject({
			accountId: accepted.accountId,
			incarnation: committedWithoutReply.heads[0]?.incarnation,
		});
		expect(
			BigInt(reopened.heads[0]?.replicaRevision ?? "-1"),
		).toBeGreaterThanOrEqual(
			BigInt(committedWithoutReply.heads[0]?.replicaRevision ?? "-1"),
		);
		expect(BigInt(reopened.heads[0]?.lockEpoch ?? "-1")).toBeGreaterThanOrEqual(
			BigInt(committedWithoutReply.heads[0]?.lockEpoch ?? "-1"),
		);
		blockImageGrant = false;

		await page.locator("#password").fill(user.password);
		await page
			.getByRole("button", {
				name: uiText("auth_signin_button_unlock_vault"),
				exact: true,
			})
			.click();
		await waitForAppReady(page);
		await page
			.getByRole("link", { name: "Vaults", exact: true })
			.first()
			.click();
		await expect(vaultNavLink(page, accepted.vaultId)).toBeVisible({
			timeout: 60_000,
		});
		await expect
			.poll(async () => (await snapshot(page)).operations.length, {
				timeout: 30_000,
			})
			.toBe(0);
		const completed = await snapshot(page);
		expect(
			completed.receipts.map((row) => JSON.parse(row.payloadJson)),
		).toContainEqual(
			expect.objectContaining({
				operationId: accepted.operationId,
				target: { type: "vault", vaultId: accepted.vaultId },
				result: { type: "vaultApplied", vaultId: accepted.vaultId },
			}),
		);
	} finally {
		await context.close();
	}
});

test("held prior-version connections block every recovery database upgrade until each old owner closes", async ({
	browser,
}) => {
	test.setTimeout(120_000);
	const context = await browser.newContext();
	const legacy = await context.newPage();
	const current = await context.newPage();
	try {
		await legacy.route("**/ticket42-legacy-storage", (route) =>
			route.fulfill({
				status: 200,
				contentType: "text/html",
				body: "<!doctype html><title>Held historical storage connections</title>",
			}),
		);
		await legacy.goto("/ticket42-legacy-storage");
		const before = await legacy.evaluate(async (databases) => {
			const held = new Map<string, IDBDatabase>();
			const changes: string[] = [];
			Object.assign(globalThis, { ticket42Legacy: { held, changes } });
			const snapshots: Record<string, unknown> = {};
			for (const { name, version, layout } of databases) {
				const db = await new Promise<IDBDatabase>((resolve, reject) => {
					const open = indexedDB.open(name, version);
					open.onupgradeneeded = () => {
						for (const [storeName, keyPath, indexes] of layout) {
							const store = open.result.createObjectStore(storeName, {
								keyPath,
							});
							for (const [index, key] of indexes) store.createIndex(index, key);
						}
					};
					open.onsuccess = () => resolve(open.result);
					open.onerror = () => reject(open.error);
				});
				db.onversionchange = () => changes.push(name); // A real old context deliberately refuses to close.
				held.set(name, db);
				await new Promise<void>((resolve, reject) => {
					const tx = db.transaction([...db.objectStoreNames], "readwrite");
					tx.oncomplete = () => resolve();
					tx.onabort = () => reject(tx.error);
					for (const storeName of db.objectStoreNames)
						for (const accountId of ["old-account-a", "old-account-b"])
							tx.objectStore(storeName).put({
								accountId,
								recordId: "opaque-row",
								artifactId: "opaque-artifact",
								operationId: "old-operation",
								attachmentId: "old-attachment",
								generation: "old-generation",
								chunkIndex: 0,
								payloadJson: '{ "historical": [2,1] }',
								// A malformed head can still be captured as plain JSON evidence.
								...(storeName === "heads"
									? {}
									: { bytes: new Uint8Array([0, 255, 3]) }),
							});
				});
				const tx = db.transaction([...db.objectStoreNames], "readonly");
				snapshots[name] = await Promise.all(
					[...db.objectStoreNames].map(
						(store) =>
							new Promise<unknown>((resolve, reject) => {
								const request = tx.objectStore(store).getAll();
								request.onsuccess = () => resolve([store, request.result]);
								request.onerror = () => reject(request.error);
							}),
					),
				);
			}
			return JSON.parse(
				JSON.stringify(snapshots, (_key, value) =>
					value instanceof Uint8Array ? [...value] : value,
				),
			);
		}, LEGACY_DATABASES);

		for (const { name } of LEGACY_DATABASES) {
			await current.goto("/login");
			await expect(
				current.getByRole("heading", {
					name: uiText("runtime_storage_unavailable_title"),
					exact: true,
				}),
			).toBeVisible({ timeout: 30_000 });
			await expect
				.poll(() =>
					legacy.evaluate((databaseName) => {
						const state = (
							globalThis as typeof globalThis & {
								ticket42Legacy: { changes: string[] };
							}
						).ticket42Legacy;
						return state.changes.includes(databaseName);
					}, name),
				)
				.toBe(true);
			await legacy.evaluate((databaseName) => {
				const state = (
					globalThis as typeof globalThis & {
						ticket42Legacy: { held: Map<string, IDBDatabase> };
					}
				).ticket42Legacy;
				const db = state.held.get(databaseName);
				if (!db) throw new Error("Historical owner already closed");
				db.close();
				state.held.delete(databaseName);
			}, name);
		}
		// The same failed Runtime can now acquire maintenance after the final physical barrier clears.
		const dialog = await openRecovery(current);
		await inspect(dialog);
		await expect(
			dialog.getByRole("button", {
				name: uiText("replica_recovery_export"),
				exact: true,
			}),
		).toBeEnabled();
		await expect(
			dialog.getByText(uiText("replica_recovery_unavailable"), { exact: true }),
		).toHaveCount(0);
		expect(await priorVersionResults(legacy)).toEqual([
			"VersionError",
			"VersionError",
			"VersionError",
		]);
		const after = await legacy.evaluate(async (databases) => {
			const snapshots: Record<string, unknown> = {};
			for (const { name, version, layout } of databases) {
				const db = await new Promise<IDBDatabase>((resolve, reject) => {
					const open = indexedDB.open(name);
					open.onsuccess = () => resolve(open.result);
					open.onerror = () => reject(open.error);
				});
				try {
					if (db.version !== version + 1)
						throw new Error("Wrong migrated database version");
					const stores = layout.map(([name]) => name).sort();
					const tx = db.transaction(stores, "readonly");
					for (const [store, keyPath, indexes] of layout) {
						const actual = tx.objectStore(store);
						if (JSON.stringify(actual.keyPath) !== JSON.stringify(keyPath))
							throw new Error("Historical key path changed");
						for (const [index, key] of indexes)
							if (
								JSON.stringify(actual.index(index).keyPath) !==
								JSON.stringify(key)
							)
								throw new Error("Historical index changed");
					}
					snapshots[name] = await Promise.all(
						stores.map(
							(store) =>
								new Promise<unknown>((resolve, reject) => {
									const request = tx.objectStore(store).getAll();
									request.onsuccess = () => resolve([store, request.result]);
									request.onerror = () => reject(request.error);
								}),
						),
					);
				} finally {
					db.close();
				}
			}
			return JSON.parse(
				JSON.stringify(snapshots, (_key, value) =>
					value instanceof Uint8Array ? [...value] : value,
				),
			);
		}, LEGACY_DATABASES);
		expect(after).toEqual(before);
	} finally {
		await context.close();
	}
});

test("explicit re-Bootstrap preserves accepted Vault work and image bytes before authenticated authority hydration", async ({
	browser,
}) => {
	const setup = recoverySetupBudget(browser, 150_000);
	test.setTimeout(setup.testTimeoutMs);
	const context = await browser.newContext();
	const page = await context.newPage();
	let blockImageGrant = true;
	let blockedImageGrants = 0;
	let bootstrapResponses = 0;
	try {
		const user = await signUp(page, generateTestUser(), setup.signupOptions);
		await context.route(
			"**/api/v1/operations/*/vault-image-staging/grants",
			async (route) => {
				if (blockImageGrant && route.request().method() === "POST") {
					blockedImageGrants++;
					await route.abort("failed");
				} else await route.continue();
			},
		);
		const accepted = await acceptImageVault(
			page,
			`Rebootstrap Vault ${nanoid(6)}`,
			"rebootstrap.png",
		);
		await expect.poll(() => blockedImageGrants).toBeGreaterThan(0);
		await page.goto("/login");
		await expect(
			page.getByRole("button", {
				name: uiText("auth_signin_button_unlock_vault"),
				exact: true,
			}),
		).toBeVisible({ timeout: 30_000 });
		const original = await snapshot(page);
		expect(original.operations).toHaveLength(1);
		expect(
			JSON.parse(original.operations[0]?.payloadJson ?? "{}"),
		).toMatchObject({
			operationId: accepted.operationId,
			kind: "create_vault",
			target: { type: "vault", vaultId: accepted.vaultId },
		});
		expect(original.chunks).toHaveLength(1);
		expect(original.chunks[0]?.bytes).toEqual([...PNG]);
		const originalHead = original.heads.find(
			(head) => head.accountId === accepted.accountId,
		);
		const originalVault = original.vaults.find(
			(row) => row.accountId === accepted.accountId,
		);
		if (!originalHead || !originalVault)
			throw new Error("Expected authoritative initial Replica");
		const pause = await openRecovery(page);
		await inspect(pause);
		await expect(
			pause.getByRole("button", {
				name: uiText("replica_recovery_rebootstrap"),
				exact: true,
			}),
		).toBeDisabled();
		// Corrupt derived authority only, after the real maintenance owner has drained normal work.
		await page.evaluate(async (row) => {
			const db = await new Promise<IDBDatabase>((resolve, reject) => {
				const open = indexedDB.open("bittery_replica");
				open.onsuccess = () => resolve(open.result);
				open.onerror = () => reject(open.error);
			});
			try {
				await new Promise<void>((resolve, reject) => {
					const tx = db.transaction("authority_vaults", "readwrite");
					tx.oncomplete = () => resolve();
					tx.onabort = () => reject(tx.error);
					tx.objectStore("authority_vaults").put({
						...row,
						payloadJson: "{malformed-derived-authority",
					});
				});
			} finally {
				db.close();
			}
		}, originalVault);
		await page.reload();
		await expect(
			page.getByRole("heading", {
				name: uiText("runtime_storage_unavailable_title"),
				exact: true,
			}),
		).toBeVisible({ timeout: 30_000 });
		const dialog = await openRecovery(page);
		await inspect(dialog);
		const rebootstrap = dialog.getByRole("button", {
			name: uiText("replica_recovery_rebootstrap"),
			exact: true,
		});
		await expect(rebootstrap).toBeEnabled();
		const guardedHead = (await snapshot(page)).heads.find(
			(head) => head.accountId === accepted.accountId,
		);
		if (!guardedHead) throw new Error("Guarded recovery head is missing");
		expect(guardedHead.incarnation).toBe(originalHead.incarnation);
		await rebootstrap.click();
		await expect(
			dialog.getByText(uiText("replica_recovery_repaired"), { exact: true }),
		).toBeVisible({ timeout: 30_000 });
		const repaired = await snapshot(page);
		expect(repaired.operations).toEqual(original.operations);
		expect(repaired.receipts).toEqual(original.receipts);
		expect(repaired.images).toEqual(original.images);
		expect(repaired.chunks).toEqual(original.chunks);
		expect(repaired.vaults).toEqual([]);
		const repairedHead = repaired.heads.find(
			(head) => head.accountId === accepted.accountId,
		);
		expect(repairedHead?.incarnation).toBe(originalHead.incarnation);
		expect(repairedHead?.replicaRevision).toBe(
			String(BigInt(guardedHead.replicaRevision) + 1n),
		);
		expect(repairedHead?.lockEpoch).toBe(
			String(BigInt(guardedHead.lockEpoch) + 1n),
		);
		// The explicit repair has no Session. Only actual unlock may fetch fresh authority.
		page.on("response", (response) => {
			if (
				new URL(response.url()).pathname === "/api/v1/sync/bootstrap" &&
				response.status() === 200
			)
				bootstrapResponses++;
		});
		blockImageGrant = false;
		await page.reload();
		await expect(
			page.getByRole("button", {
				name: uiText("auth_signin_button_unlock_vault"),
				exact: true,
			}),
		).toBeVisible({ timeout: 30_000 });
		expect((await snapshot(page)).operations).toEqual(original.operations);
		expect(bootstrapResponses).toBe(0);
		await page.locator("#password").fill(user.password);
		await page
			.getByRole("button", {
				name: uiText("auth_signin_button_unlock_vault"),
				exact: true,
			})
			.click();
		await waitForAppReady(page);
		await expect
			.poll(() => bootstrapResponses, { timeout: 30_000 })
			.toBeGreaterThan(0);
		await page
			.getByRole("link", { name: "Vaults", exact: true })
			.first()
			.click();
		await expect(vaultNavLink(page, accepted.vaultId)).toBeVisible({
			timeout: 60_000,
		});
		await expect
			.poll(async () => (await snapshot(page)).operations.length, {
				timeout: 30_000,
			})
			.toBe(0);
		const hydrated = await snapshot(page);
		// Re-Bootstrap replaces the derived generation prefix, while the Vault identity and
		// authoritative contents survive in the selected Account's freshly published projection.
		const originalAuthority = JSON.parse(originalVault.payloadJson);
		expect(
			hydrated.vaults
				.filter((row) => row.accountId === accepted.accountId)
				.map((row) => JSON.parse(row.payloadJson)),
		).toContainEqual(originalAuthority);
		await expect(vaultNavLink(page, originalAuthority.id)).toBeVisible();
		expect(
			hydrated.receipts.map((row) => JSON.parse(row.payloadJson)),
		).toContainEqual(
			expect.objectContaining({
				operationId: accepted.operationId,
				target: { type: "vault", vaultId: accepted.vaultId },
				result: { type: "vaultApplied", vaultId: accepted.vaultId },
			}),
		);
	} finally {
		await context.close();
	}
});
