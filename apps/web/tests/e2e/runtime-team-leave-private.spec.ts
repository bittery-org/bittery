import { mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { BrowserContext, Page, Route } from "@playwright/test";
import { nanoid } from "nanoid";
import {
	expect,
	generateTestUser,
	signIn,
	signUp,
	type TestUser,
	test,
	waitForAppReady,
} from "../fixtures/auth";
import { uiText } from "../fixtures/messages";
import {
	captureFixtureAccount,
	deleteFixtureUser,
} from "../fixtures/runtime-account-cleanup";
import {
	inviteMember,
	openTeamPage,
	openTeamTab,
	signUpFromInvite,
} from "../fixtures/team";
import {
	createItem,
	createVault,
	openItem,
	openVault,
	toastWithText,
	VAULT_READY_TIMEOUT_MS,
} from "../fixtures/vault";

const privateDirectory = process.env.BITTERY_107_PRIVATE_DIR;
const fixtureDatabase = process.env.BITTERY_107_DATABASE;
type FixtureAccount = Awaited<ReturnType<typeof captureFixtureAccount>>;

async function recovery(
	name: string,
	user: TestUser,
	account?: FixtureAccount,
) {
	if (!privateDirectory)
		throw new Error("Private fixture directory is required");
	await mkdir(privateDirectory, { recursive: true, mode: 0o700 });
	const path = join(privateDirectory, `${name}-${user.email}.json`);
	await writeFile(path, JSON.stringify({ user, account }), { mode: 0o600 });
	return path;
}

async function awaitBilling(email: string, teamId: string) {
	if (!privateDirectory || !fixtureDatabase)
		throw new Error("Owned fixture is required");
	const request = { email, teamId, fixtureDatabase };
	const marker = join(
		privateDirectory,
		"billing-request-private-rotation-v32-twentythird.json",
	);
	const temporary = `${marker}.tmp`;
	await writeFile(temporary, JSON.stringify(request), { mode: 0o600 });
	await rename(temporary, marker);
	await expect
		.poll(
			async () => {
				try {
					const ready = JSON.parse(
						await readFile(
							join(
								privateDirectory,
								"billing-ready-private-rotation-v32-twentythird.json",
							),
							"utf8",
						),
					);
					return (
						ready.email === request.email &&
						ready.teamId === request.teamId &&
						ready.fixtureDatabase === request.fixtureDatabase &&
						Object.keys(ready).sort().join(",") ===
							"email,fixtureDatabase,teamId"
					);
				} catch {
					return false;
				}
			},
			{ timeout: 600_000 },
		)
		.toBe(true);
}

async function identity(page: Page, accountId: string) {
	return page.evaluate(async (accountId) => {
		const path = "/src/lib/crypto.ts";
		const { runtimeClient } = (await import(
			path
		)) as typeof import("../../src/lib/crypto");
		const team = await runtimeClient.readTeamPage({ accountId });
		return {
			userId: team.user.id,
			teamId: team.team?.id ?? null,
			teamName: team.team?.name ?? null,
			teamRole: team.team?.userRole ?? null,
		};
	}, accountId);
}

async function fingerprint(page: Page) {
	const settings = page.locator('a[href="/settings"]').first();
	if (!(await settings.isVisible()))
		await page.getByTestId("user-menu").click();
	await settings.click();
	await page
		.getByRole("tab", { name: uiText("settings_tab_security"), exact: true })
		.click();
	await page
		.getByRole("button", { name: uiText("recipient_key_show") })
		.click();
	const code = page.getByTestId("own-key-fingerprint");
	await expect(code).toHaveText(/^BVK1-[A-F0-9]{64}$/);
	const value = await code.textContent();
	if (!value) throw new Error("Independent fingerprint is missing");
	await page.locator('a[href="/vaults"]').first().click();
	await waitForAppReady(page);
	return value;
}

async function approve(page: Page, expected: string) {
	const dialog = page.getByRole("dialog", {
		name: uiText("recipient_key_verify_title"),
		exact: true,
	});
	await expect(dialog).toBeVisible();
	await dialog
		.getByLabel(uiText("recipient_key_fingerprint_label"))
		.fill(expected);
	await dialog
		.getByRole("button", { name: uiText("recipient_key_verify_action") })
		.click();
	await expect(dialog).toBeHidden();
}

async function unlockStoredAccount(page: Page, user: TestUser) {
	const unlock = page.getByRole("button", {
		name: "Unlock Vault",
		exact: true,
	});
	await expect(unlock).toBeVisible({ timeout: VAULT_READY_TIMEOUT_MS });
	await page.locator("#password").fill(user.password);
	await unlock.click();
	await waitForAppReady(page);
}

async function grantMember(
	page: Page,
	email: string,
	expectedFingerprint: string,
) {
	await page.getByTestId("vault-menu-button").click();
	await page
		.getByRole("menuitem", {
			name: uiText("vaults_detail_tab_members"),
			exact: true,
		})
		.click();
	const members = page.getByRole("dialog", {
		name: uiText("vaults_nav_members_dialog_title"),
	});
	await members
		.getByRole("button", { name: uiText("vaults_add_member_dialog_trigger") })
		.click();
	const add = page.getByRole("dialog", {
		name: uiText("vaults_add_member_dialog_title"),
	});
	await expect(add.getByText(email, { exact: true })).toBeVisible({
		timeout: VAULT_READY_TIMEOUT_MS,
	});
	await add
		.getByText(email, { exact: true })
		.locator("xpath=../..")
		.getByRole("button", {
			name: uiText("vaults_add_member_dialog_action_add"),
			exact: true,
		})
		.click();
	await approve(page, expectedFingerprint);
	await expect(
		toastWithText(page, uiText("vaults_add_member_dialog_toast_member_added")),
	).toBeVisible({ timeout: VAULT_READY_TIMEOUT_MS });
	await page.keyboard.press("Escape");
	await page.keyboard.press("Escape");
}

async function deleteVault(page: Page, accountId: string, vaultId: string) {
	return page.evaluate(
		async ({ accountId, vaultId }) => {
			const path = "/src/lib/crypto.ts";
			const { runtime } = (await import(
				path
			)) as typeof import("../../src/lib/crypto");
			return JSON.parse(
				await runtime.request(
					`rotation-private-cleanup-${crypto.randomUUID()}`,
					JSON.stringify({ type: "deleteVault", accountId, vaultId }),
				),
			);
		},
		{ accountId, vaultId },
	);
}

test("real private Team leave rotates a populated Vault and keeps the remaining owner readable", async ({
	page,
	browser,
}) => {
	test.setTimeout(900_000);
	test.skip(
		!privateDirectory || !fixtureDatabase,
		"Owned #107 private fixture is required",
	);
	if (!privateDirectory || !fixtureDatabase)
		throw new Error("Owned #107 private fixture is required");
	const memberContext = await browser.newContext();
	const memberPage = await memberContext.newPage();
	let ownerReadContext: BrowserContext | undefined;
	let ownerReadPage: Page | undefined;
	let ownerReadAccount: FixtureAccount | undefined;
	let owner: TestUser | undefined;
	let member: TestUser | undefined;
	let ownerAccount: FixtureAccount | undefined;
	let memberAccount: FixtureAccount | undefined;
	let ownerRecovery: string | undefined;
	let memberRecovery: string | undefined;
	let vaultId: string | undefined;
	let remainingOwnerRead = false;
	let vaultDeleted = false;
	let ownerDeleted = false;
	let memberDeleted = false;
	const network: Array<{
		kind: string;
		status: number;
		count?: number;
		version?: boolean;
		operationId?: string;
	}> = [];
	let finalizing = false;
	const observer = async (route: Route) => {
		const request = route.request();
		const url = new URL(request.url());
		const path = url.pathname;
		const kind = path.includes("/leave-rotation-plans/finalize")
			? "finalize"
			: path.includes("/leave-rotation-plans")
				? "start"
				: path.includes("/preparation/")
					? "preparation"
					: path.includes("/staged/")
						? "stage"
						: path === "/api/v1/sync/bootstrap" &&
								url.searchParams.get("phase") === "vaults"
							? "vaultPage"
							: path === "/api/v1/sync/changes"
								? "catchUp"
								: null;
		if (!kind) {
			await route.continue();
			return;
		}
		const response = await route.fetch();
		if (kind === "finalize") {
			const body = await response.json().catch(() => null);
			network.push({
				kind,
				status: response.status(),
				count: body?.result?.rotations?.length,
			});
			finalizing = body?.result?.status === "applied";
		} else if (kind === "stage") {
			network.push({
				kind: `stage:${path.split("/").at(-1)}`,
				status: response.status(),
			});
		} else if (kind === "vaultPage") {
			const body = await response.json().catch(() => null);
			network.push({
				kind: finalizing ? "freshVaultPage" : kind,
				status: response.status(),
				version:
					request.headers().accept ===
						"application/vnd.bittery.sync-vault-key-version+json" &&
					body?.vaultKeyVersionIncluded === true,
			});
		} else {
			network.push({
				kind: kind === "catchUp" && finalizing ? "freshCatchUp" : kind,
				status: response.status(),
				operationId:
					kind === "start" ? request.headers()["idempotency-key"] : undefined,
			});
		}
		await route.fulfill({ response });
	};
	try {
		owner = await signUp(page, generateTestUser(), { plan: "team" });
		ownerAccount = await captureFixtureAccount(page, owner.email);
		ownerRecovery = await recovery("private-owner-v32", owner, ownerAccount);
		const ownerIdentity = await identity(page, ownerAccount.accountId);
		if (!ownerIdentity.teamId) throw new Error("Owner Team is missing");
		expect(ownerIdentity.teamName).toBe(owner.organizationName);
		expect(ownerIdentity.teamRole).toBe("owner");
		await awaitBilling(owner.email, ownerIdentity.teamId);
		const ownerFingerprint = await fingerprint(page);
		await openTeamPage(page);
		member = generateTestUser();
		memberRecovery = await recovery("private-member-v32", member);
		const invitation = await inviteMember(page, member.email);
		member = await signUpFromInvite(memberPage, invitation, member);
		memberAccount = await captureFixtureAccount(memberPage, member.email);
		memberRecovery = await recovery(
			"private-member-v32",
			member,
			memberAccount,
		);
		const memberIdentity = await identity(memberPage, memberAccount.accountId);
		expect(memberIdentity.teamId).toBe(ownerIdentity.teamId);
		const memberFingerprint = await fingerprint(memberPage);

		vaultId = await createVault(page, `Private leave ${nanoid(6)}`, {
			type: "team",
		});
		const title = `Remaining owner readable ${nanoid(6)}`;
		await createItem(page, "login", async (sheet) => {
			await sheet.locator("#title").fill(title);
			await sheet.locator("#username").fill("remaining-owner-read");
			await sheet.locator("#password").fill(`secret-${nanoid(10)}`);
		});
		await openVault(page, vaultId);
		await grantMember(page, member.email, memberFingerprint);
		await memberPage.reload();
		await unlockStoredAccount(memberPage, member);
		memberAccount = await captureFixtureAccount(memberPage, member.email);
		memberRecovery = await recovery(
			"private-member-v32",
			member,
			memberAccount,
		);
		await openVault(memberPage, vaultId);
		await openItem(memberPage, title);
		await expect(memberPage.getByRole("heading", { name: title })).toBeVisible({
			timeout: VAULT_READY_TIMEOUT_MS,
		});

		await memberPage.route("**/api/v1/**", observer);
		await openTeamPage(memberPage);
		await openTeamTab(memberPage, "team_page_tab_settings");
		await memberPage
			.getByRole("button", { name: uiText("team_leave_dialog_trigger") })
			.click();
		await memberPage
			.getByRole("alertdialog")
			.getByRole("button", { name: uiText("team_leave_dialog_action_confirm") })
			.click();
		await approve(memberPage, ownerFingerprint);
		await expect(
			toastWithText(memberPage, uiText("team_leave_dialog_toast_left")),
		).toBeVisible({ timeout: VAULT_READY_TIMEOUT_MS });
		const startOperationId = network.find(
			(entry) => entry.kind === "start" && entry.status === 200,
		)?.operationId;
		if (!startOperationId)
			throw new Error("Retained start Operation is missing");
		const memberAccountId = memberAccount.accountId;
		const renewed = await memberPage.evaluate(
			async ({ accountId, masterPassword }) => {
				const path = "/src/lib/crypto.ts";
				const { runtimeClient } = (await import(
					path
				)) as typeof import("../../src/lib/crypto");
				await runtimeClient.lock(accountId);
				return runtimeClient.quickUnlock({ accountId, masterPassword });
			},
			{
				accountId: memberAccountId,
				masterPassword: member.password,
			},
		);
		expect(renewed.accountId).toBe(memberAccountId);
		expect(renewed.userId).toBe(memberIdentity.userId);
		await expect
			.poll(
				async () =>
					memberPage.evaluate(
						async ({ accountId, startOperationId }) => {
							const path = "/src/lib/crypto.ts";
							const { runtimeClient } = (await import(
								path
							)) as typeof import("../../src/lib/crypto");
							const result = await runtimeClient.inspectRotation({
								accountId,
								startOperationId,
							});
							return result.type;
						},
						{ accountId: memberAccountId, startOperationId },
					),
				{ timeout: VAULT_READY_TIMEOUT_MS },
			)
			.toBe("rotationCompleted");
		await memberPage.unroute("**/api/v1/**", observer);
		expect(
			network.some((entry) => entry.kind === "start" && entry.status === 200),
		).toBe(true);
		expect(
			network.some(
				(entry) => entry.kind === "preparation" && entry.status === 200,
			),
		).toBe(true);
		expect(
			network.some(
				(entry) => entry.kind === "stage:member" && entry.status === 200,
			),
		).toBe(true);
		expect(
			network.some(
				(entry) => entry.kind === "stage:item" && entry.status === 200,
			),
		).toBe(true);
		expect(
			network.some(
				(entry) =>
					entry.kind === "finalize" &&
					entry.status === 200 &&
					entry.count === 1,
			),
		).toBe(true);
		expect(
			network.some(
				(entry) =>
					entry.kind === "freshVaultPage" &&
					entry.status === 200 &&
					entry.version,
			),
		).toBe(true);
		expect(
			network.some(
				(entry) => entry.kind === "freshCatchUp" && entry.status === 200,
			),
		).toBe(true);

		ownerReadContext = await browser.newContext();
		ownerReadPage = await ownerReadContext.newPage();
		await signIn(ownerReadPage, owner);
		ownerReadAccount = await captureFixtureAccount(ownerReadPage, owner.email);
		await openVault(ownerReadPage, vaultId);
		await openItem(ownerReadPage, title);
		await expect(
			ownerReadPage.getByRole("heading", { name: title }),
		).toBeVisible({
			timeout: VAULT_READY_TIMEOUT_MS,
		});
		remainingOwnerRead = true;
		console.log(
			JSON.stringify({
				kind: "private-rotation-accepted",
				stages: network.filter((entry) => entry.kind.startsWith("stage:"))
					.length,
				freshVersionPages: network.filter(
					(entry) => entry.kind === "freshVaultPage" && entry.version,
				).length,
				remainingOwnerRead: true,
			}),
		);
	} finally {
		await memberPage.unroute("**/api/v1/**", observer).catch(() => undefined);
		if (remainingOwnerRead && memberAccount && member) {
			try {
				if (
					await memberPage
						.getByRole("button", { name: "Unlock Vault", exact: true })
						.isVisible()
				)
					await unlockStoredAccount(memberPage, member);
				else if (await memberPage.locator("#app-scroll-area").isVisible())
					await waitForAppReady(memberPage);
				else await signIn(memberPage, member);
				memberAccount = await captureFixtureAccount(memberPage, member.email);
				memberRecovery = await recovery(
					"private-member-v32",
					member,
					memberAccount,
				);
			} catch {
				// Keep the prior scoped Account for the cleanup attempt.
			}
		}
		if (remainingOwnerRead && memberAccount)
			memberDeleted = await deleteFixtureUser(memberPage, memberAccount).catch(
				() => false,
			);
		if (remainingOwnerRead && vaultId) {
			const cleanupPage =
				ownerReadPage && ownerReadAccount ? ownerReadPage : page;
			const cleanupAccount = ownerReadAccount ?? ownerAccount;
			if (cleanupAccount)
				vaultDeleted = !!(await deleteVault(
					cleanupPage,
					cleanupAccount.accountId,
					vaultId,
				).catch(() => undefined));
		}
		if (remainingOwnerRead && ownerAccount)
			ownerDeleted = await deleteFixtureUser(
				ownerReadPage && ownerReadAccount ? ownerReadPage : page,
				ownerReadAccount ?? ownerAccount,
			).catch(() => false);
		await ownerReadContext?.close();
		await memberContext.close();
		if (ownerDeleted && ownerRecovery) await unlink(ownerRecovery);
		if (memberDeleted && memberRecovery) await unlink(memberRecovery);
		console.log(
			JSON.stringify({
				kind: "private-rotation-cleanup",
				remainingOwnerRead,
				vaultDeleted,
				ownerDeleted,
				memberDeleted,
			}),
		);
	}
	expect(remainingOwnerRead).toBe(true);
	expect(vaultDeleted).toBe(true);
	expect(ownerDeleted).toBe(true);
	expect(memberDeleted).toBe(true);
});
