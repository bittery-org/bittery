import { writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import type { BrowserContext, Page } from "@playwright/test";
import { generateTestUser, readSecretKey, signIn, type TestUser } from "./auth";
import type { RecipientIdentity } from "./native-member-device";
import { registerFromInvite } from "./team";
import { createVault } from "./vault";

interface FixtureAccount {
	accountId: string;
	serverUrl: string;
	email: string;
}

/** Assigned before prepare: every partially created User retains the same scoped cleanup owner. */
export function nativeReadOnlyVault(
	page: Page,
	directory: string,
	recipient: TestUser,
	captureAccount: (page: Page, email: string) => Promise<FixtureAccount>,
	deleteUser: (page: Page, account: FixtureAccount) => Promise<boolean>,
) {
	const browser = page.context().browser();
	if (!browser) throw new Error("Read-only fixture requires a Browser context");
	const browserModule = `/@fs${resolve(import.meta.dirname, "native-member-device.ts")}`;
	const credentials = join(directory, "read-only-vault-owner.json");
	const appOrigin = new URL(page.url()).origin;
	let owner = generateTestUser();
	let context: BrowserContext | undefined;
	let ownerPage: Page | undefined;
	let account: FixtureAccount | undefined;
	let identity: RecipientIdentity | undefined;
	let signupStarted = false;
	let credentialCapture: Promise<void> | undefined;
	const save = (phase: string) =>
		writeFile(
			credentials,
			JSON.stringify({ phase, owner, account, recipient: identity }),
			{ mode: 0o600 },
		);
	const signInOwner = async () => {
		await context?.close();
		context = await browser.newContext({ baseURL: appOrigin });
		ownerPage = await context.newPage();
		await signIn(ownerPage, owner);
		account = await captureAccount(ownerPage, owner.email);
		await save("account-captured");
	};
	return {
		async prepare() {
			identity = await page.evaluate(async (email) => {
				const path = "/src/lib/crypto.ts";
				const { runtimeClient } = (await import(
					path
				)) as typeof import("../../src/lib/crypto");
				const session = runtimeClient.session().getSnapshot();
				const account = session.accounts.find(
					(entry) => entry.accountId === session.accountId,
				);
				if (account?.displayIdentity?.email !== email)
					throw new Error("Read-only recipient identity is not current");
				return {
					...(await runtimeClient.ownKeyFingerprint({
						accountId: account.accountId,
					})),
					email,
				};
			}, recipient.email);
			await save("before-invitation");
			const invitation = await page.evaluate(
				async ({ browserModule, recipient, email }) => {
					const device = (await import(
						browserModule
					)) as typeof import("./native-member-device");
					return device.inviteVaultOwner(recipient, email);
				},
				{ browserModule, recipient, email: owner.email },
			);
			if (!invitation.ok)
				throw new Error(
					`Read-only invitation failed at ${invitation.phase}; HTTP status=${invitation.status ?? "unavailable"}`,
				);
			context = await browser.newContext();
			ownerPage = await context.newPage();
			const member = ownerPage;
			// Capture credentials as soon as signup commits, including if later app readiness
			// fails. The protected file is retained whenever scoped User cleanup is unproved.
			member.on("response", (response) => {
				if (
					response.request().method() === "POST" &&
					new URL(response.url()).pathname === "/api/v1/auth/signups" &&
					response.status() === 201 &&
					!credentialCapture
				) {
					credentialCapture = (async () => {
						owner.secretKey = await readSecretKey(member);
						await save("signup-committed");
					})();
					void credentialCapture.catch(() => undefined);
				}
			});
			signupStarted = true;
			owner = await registerFromInvite(
				member,
				new URL(`/invite/${encodeURIComponent(invitation.token)}`, page.url())
					.href,
				owner,
			);
			await credentialCapture;
			await save("signup-ready");
			await signInOwner();
			const runtimeOwner = ownerPage;
			if (!runtimeOwner || !account)
				throw new Error("Invited Runtime Account was not installed");
			const vaultId = await createVault(
				runtimeOwner,
				"Native read-only Travel choice",
				{
					type: "team",
				},
			);
			const granted = await runtimeOwner.evaluate(
				async ({
					browserModule,
					owner,
					ownerAccountId,
					vaultId,
					recipient,
				}) => {
					const device = (await import(
						browserModule
					)) as typeof import("./native-member-device");
					return device.grantReadOnlyVault(
						owner,
						ownerAccountId,
						vaultId,
						recipient,
					);
				},
				{
					browserModule,
					owner,
					ownerAccountId: account.accountId,
					vaultId,
					recipient: identity,
				},
			);
			if (!granted.ok)
				throw new Error(
					`Read-only grant failed at ${granted.phase}; HTTP status=${granted.status ?? "unavailable"}`,
				);
			await save("read-only-grant-confirmed");
			return vaultId;
		},
		async close() {
			let deleted = !signupStarted;
			try {
				if (signupStarted && ownerPage) {
					await credentialCapture?.catch(() => undefined);
					if (!owner.secretKey)
						owner.secretKey = await readSecretKey(ownerPage);
					await save("cleanup-started");
					if (!account) await signInOwner();
					if (!ownerPage || !account)
						throw new Error("Invited Runtime cleanup Account is unavailable");
					deleted = await deleteUser(ownerPage, account);
					await save(
						deleted ? "user-deletion-proved" : "user-deletion-unproved",
					);
				}
			} catch {
				deleted = false;
			} finally {
				try {
					await context?.close();
				} catch {
					deleted = false;
				}
			}
			return deleted;
		},
	};
}
