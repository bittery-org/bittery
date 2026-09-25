import { mkdir, readFile, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { BrowserContext, Page, Request } from "@playwright/test";
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
import { inviteMember, openTeamPage, signUpFromInvite } from "../fixtures/team";
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

async function persistRecovery(
	name: string,
	user: TestUser,
	account?: FixtureAccount,
) {
	if (!privateDirectory) throw new Error("BITTERY_107_PRIVATE_DIR is required");
	await mkdir(privateDirectory, { recursive: true, mode: 0o700 });
	const path = join(privateDirectory, `${name}-${user.email}.json`);
	await writeFile(path, JSON.stringify({ user, account }), { mode: 0o600 });
	return path;
}

async function waitForOwnedBilling(email: string, teamId: string) {
	if (!privateDirectory) throw new Error("BITTERY_107_PRIVATE_DIR is required");
	await writeFile(
		join(privateDirectory, "billing-request-add-member-v23-eighteenth.json"),
		JSON.stringify({ email, teamId, fixtureDatabase }),
		{ mode: 0o600 },
	);
	await expect
		.poll(
			async () => {
				try {
					const ready = JSON.parse(
						await readFile(
							join(
								privateDirectory,
								"billing-ready-add-member-v23-eighteenth.json",
							),
							"utf8",
						),
					) as { email?: string; teamId?: string };
					return ready.email === email && ready.teamId === teamId;
				} catch {
					return false;
				}
			},
			{ timeout: 180_000 },
		)
		.toBe(true);
}

async function currentIdentity(page: Page, accountId: string) {
	return page.evaluate(async (accountId) => {
		const path = "/src/lib/crypto.ts";
		const { runtimeClient } = (await import(
			path
		)) as typeof import("../../src/lib/crypto");
		const result = await runtimeClient.readTeamPage({ accountId });
		return { userId: result.user.id, teamId: result.team?.id ?? null };
	}, accountId);
}

async function ownFingerprint(page: Page): Promise<string> {
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
	if (!value) throw new Error("Own key fingerprint was not displayed");
	await page.locator('a[href="/vaults"]').first().click();
	await waitForAppReady(page);
	return value;
}

async function deleteSharedVault(
	page: Page,
	accountId: string,
	vaultId: string,
) {
	const outcome = await page.evaluate(
		async ({ accountId, vaultId }) => {
			const path = "/src/lib/crypto.ts";
			const { runtime } = (await import(
				path
			)) as typeof import("../../src/lib/crypto");
			const answer = JSON.parse(
				await runtime.request(
					`owned-add-member-cleanup-${crypto.randomUUID()}`,
					JSON.stringify({ type: "deleteVault", accountId, vaultId }),
				),
			) as { type: string; value: { type?: string; code?: string } };
			return {
				envelope: answer.type,
				result: answer.value.type ?? answer.value.code,
			};
		},
		{ accountId, vaultId },
	);
	expect(outcome).toEqual({
		envelope: "succeeded",
		result: "vaultDeletionAccepted",
	});
}

test("Core Add Member gives an independently verified Team User readable Vault Items", async ({
	page,
	browser,
}) => {
	test.setTimeout(720_000);
	test.skip(
		!privateDirectory || !fixtureDatabase,
		"Dedicated owned #107 fixture is required",
	);
	if (!privateDirectory || !fixtureDatabase)
		throw new Error("Owned #107 fixture scope is required");
	let owner: TestUser | undefined;
	let recipient: TestUser | undefined;
	let ownerAccount: FixtureAccount | undefined;
	let recipientAccount: FixtureAccount | undefined;
	let ownerRecovery: string | undefined;
	let recipientRecovery: string | undefined;
	let vaultId: string | undefined;
	let ownerDeleted = false;
	let recipientDeleted = false;
	let recipientReadContext: BrowserContext | undefined;
	let recipientReadPage: Page | undefined;
	const recipientContext = await browser.newContext();
	const recipientPage = await recipientContext.newPage();
	try {
		owner = await signUp(page, generateTestUser(), { plan: "team" });
		ownerAccount = await captureFixtureAccount(page, owner.email);
		ownerRecovery = await persistRecovery(
			"add-member-owner-v23",
			owner,
			ownerAccount,
		);
		const ownerIdentity = await currentIdentity(page, ownerAccount.accountId);
		if (!ownerIdentity.teamId) throw new Error("Owner Team was not published");
		await waitForOwnedBilling(owner.email, ownerIdentity.teamId);

		await openTeamPage(page);
		recipient = generateTestUser();
		recipientRecovery = await persistRecovery(
			"add-member-recipient-v23",
			recipient,
		);
		const inviteUrl = await inviteMember(page, recipient.email);
		recipient = await signUpFromInvite(recipientPage, inviteUrl, recipient);
		recipientAccount = await captureFixtureAccount(
			recipientPage,
			recipient.email,
		);
		recipientRecovery = await persistRecovery(
			"add-member-recipient-v23",
			recipient,
			recipientAccount,
		);
		const fingerprint = await ownFingerprint(recipientPage);
		const recipientIdentity = await currentIdentity(
			recipientPage,
			recipientAccount.accountId,
		);
		expect(recipientIdentity.teamId).toBe(ownerIdentity.teamId);

		vaultId = await createVault(page, `Core Add Member ${nanoid(6)}`, {
			type: "team",
		});
		const itemTitle = `Recipient readable ${nanoid(6)}`;
		await createItem(page, "login", async (sheet) => {
			await sheet.locator("#title").fill(itemTitle);
			await sheet.locator("#username").fill("recipient-read-evidence");
			await sheet.locator("#password").fill(`secret-${nanoid(10)}`);
		});
		await openVault(page, vaultId);

		const putPath = `/api/v1/vaults/${vaultId}/members/${recipientIdentity.userId}`;
		const putBodies: Array<{ keys: string[]; role: unknown }> = [];
		const putStatuses: number[] = [];
		const observePut = (request: Request) => {
			if (
				request.method() !== "PUT" ||
				new URL(request.url()).pathname !== putPath
			)
				return;
			const body = request.postDataJSON() as Record<string, unknown>;
			putBodies.push({ keys: Object.keys(body).sort(), role: body.role });
			void request.response().then((response) => {
				if (response) putStatuses.push(response.status());
			});
		};
		page.on("request", observePut);
		try {
			await page.getByTestId("vault-menu-button").click();
			await page
				.getByRole("menuitem", {
					name: uiText("vaults_detail_tab_members"),
					exact: true,
				})
				.click();
			const membersDialog = page.getByRole("dialog", {
				name: uiText("vaults_nav_members_dialog_title"),
			});
			await membersDialog
				.getByRole("button", {
					name: uiText("vaults_add_member_dialog_trigger"),
				})
				.click();
			const addDialog = page.getByRole("dialog", {
				name: uiText("vaults_add_member_dialog_title"),
			});
			await expect(addDialog.getByText(recipient.email)).toBeVisible({
				timeout: VAULT_READY_TIMEOUT_MS,
			});
			await addDialog
				.getByText(recipient.email, { exact: true })
				.locator("xpath=../..")
				.getByRole("button", {
					name: uiText("vaults_add_member_dialog_action_add"),
					exact: true,
				})
				.click();
			const verification = page.getByRole("dialog", {
				name: uiText("recipient_key_verify_title"),
				exact: true,
			});
			await expect(verification).toBeVisible();
			await expect(verification).toContainText(recipient.email);
			await expect(verification).toContainText(recipientIdentity.userId);
			await verification
				.getByLabel(uiText("recipient_key_fingerprint_label"))
				.fill(`BVK1-${"0".repeat(64)}`);
			await verification
				.getByRole("button", {
					name: uiText("recipient_key_verify_action"),
				})
				.click();
			await expect(verification.getByRole("alert")).toHaveText(
				uiText("recipient_key_mismatch"),
			);
			expect(putBodies).toHaveLength(0);
			await verification
				.getByLabel(uiText("recipient_key_fingerprint_label"))
				.fill(fingerprint);
			await verification
				.getByRole("button", {
					name: uiText("recipient_key_verify_action"),
				})
				.click();
			await expect(verification).toBeHidden();
			await expect(
				toastWithText(
					page,
					uiText("vaults_add_member_dialog_toast_member_added"),
				),
			).toBeVisible({ timeout: VAULT_READY_TIMEOUT_MS });
			await expect.poll(() => putStatuses.length).toBe(1);
			expect(putStatuses).toEqual([200]);
			expect(putBodies).toEqual([
				{ keys: ["encryptedVaultKey", "role"], role: "member" },
			]);
			await page.keyboard.press("Escape");
			await page.keyboard.press("Escape");
		} finally {
			page.off("request", observePut);
		}

		recipientReadContext = await browser.newContext();
		recipientReadPage = await recipientReadContext.newPage();
		await signIn(recipientReadPage, recipient);
		recipientAccount = await captureFixtureAccount(
			recipientReadPage,
			recipient.email,
		);
		recipientRecovery = await persistRecovery(
			"add-member-recipient-v23",
			recipient,
			recipientAccount,
		);
		await openVault(recipientReadPage, vaultId);
		await openItem(recipientReadPage, itemTitle);
		await expect(
			recipientReadPage.getByRole("heading", { name: itemTitle }),
		).toBeVisible({ timeout: VAULT_READY_TIMEOUT_MS });
		console.log(
			JSON.stringify({
				kind: "runtime-vault-add-member-recipient-read",
				fixtureDatabase,
				vaultId,
				userId: recipientIdentity.userId,
				putCount: putBodies.length,
				putStatus: putStatuses[0],
			}),
		);
	} finally {
		if (recipientAccount) {
			recipientDeleted = await deleteFixtureUser(
				recipientReadPage ?? recipientPage,
				recipientAccount,
			).catch(() => false);
		}
		if (vaultId && ownerAccount) {
			await deleteSharedVault(page, ownerAccount.accountId, vaultId).catch(
				() => undefined,
			);
		}
		if (ownerAccount && (!recipientAccount || recipientDeleted)) {
			ownerDeleted = await deleteFixtureUser(page, ownerAccount).catch(
				() => false,
			);
		}
		await recipientReadContext?.close();
		await recipientContext.close();
		if (ownerDeleted && ownerRecovery) await unlink(ownerRecovery);
		if (recipientDeleted && recipientRecovery) await unlink(recipientRecovery);
		console.log(
			JSON.stringify({
				kind: "runtime-vault-add-member-cleanup",
				ownerDeleted,
				recipientDeleted,
			}),
		);
	}
	expect(recipientDeleted).toBe(true);
	expect(ownerDeleted).toBe(true);
});
