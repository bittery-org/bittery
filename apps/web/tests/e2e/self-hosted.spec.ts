import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { BrowserContext, Page } from "@playwright/test";
import {
	expect,
	generateTestUser,
	signUpSelfHosted,
	type TestUser,
	test,
} from "../fixtures/auth";
import { runE2eSql } from "../fixtures/e2e-database";
import { readOutbox } from "../fixtures/mail-outbox";
import { uiText } from "../fixtures/messages";
import { inviteMember, memberRow, openTeamPage } from "../fixtures/team";
import { gotoRoute, VAULT_READY_TIMEOUT_MS } from "../fixtures/vault";

/**
 * Registration on a self-hosted server: the bootstrap admin, the wall that
 * closes behind them, and the invite link that is the only way past it.
 *
 * This file is the whole `self-hosted` Playwright project. It runs against the
 * API on :3020 with `BITTERY_MODE=self-hosted`, which changes two things every
 * test here depends on: `requires_signup_email_verification()` is false, so no
 * code is ever emailed and none may be waited for, and `has_any_registered_user`
 * makes registration a one-shot resource - the *first* account to exist is the
 * administrator and public signup is closed from then on.
 *
 * That resource is global to the run rather than to a test, so the file is
 * serial and `beforeAll` empties the database. See `resetSelfHostedServer()`.
 *
 * TWO signups, which is the floor: the administrator, and one account that
 * signed up through an invitation. Neither can stand in for the other - the
 * first is by definition the only account that bootstraps, and `send_invitation`
 * refuses any address whose user already has a `team_id`.
 */

test.describe.configure({ mode: "serial" });

/** Mirrors the `self-hosted` project's `webServer` in `playwright.config.ts`. */
const SELF_HOSTED_DATABASE = "bittery_e2e_selfhosted";
const SELF_HOSTED_SIGNUP_URL = "http://localhost:3020/api/v1/auth/signups";

/** The refusal `has_any_registered_user` raises in `services/auth.rs`. */
const PUBLIC_SIGNUP_REFUSED =
	"Public registration is disabled. Ask an admin for an invite link.";

/** A signup is ~40s of PBKDF2, SRP and RSA keygen before any assertion runs. */
const SIGNUP_BUDGET_MS = 240000;

/** What one step of the signup flow gets, key generation included. */
const SIGNUP_FLOW_TIMEOUT_MS = 120000;

/** No key derivation at all: a page load, a wall, and one API call. */
const TEST_BUDGET_MS = 120000;

/**
 * Empty the self-hosted database.
 *
 * `migrate --fresh` runs once, when Playwright boots the API server, but the
 * bootstrap admin is decided by `SELECT id FROM "user" LIMIT 1` - so a rerun of
 * the first test would face a server that is already bootstrapped and get the
 * invite-only wall instead of a signup form. CI runs with `retries: 2`, and
 * serial mode retries this file as one group, so this hook runs again with it
 * and hands every attempt the fresh server the first test is about.
 *
 * Truncating rather than dropping keeps `_sqlx_migrations` intact, so the
 * already-running server never re-migrates; `rate_limit_state` going with it is
 * deliberate, since a retried run otherwise spends the same budget twice.
 */
function resetSelfHostedServer(): void {
	runE2eSql(
		`DO $$
		DECLARE tables text;
		BEGIN
			SELECT string_agg(format('%I.%I', schemaname, tablename), ', ')
			INTO tables
			FROM pg_tables
			WHERE schemaname = 'public' AND tablename <> '_sqlx_migrations';
			IF tables IS NOT NULL THEN
				EXECUTE 'TRUNCATE TABLE ' || tables || ' RESTART IDENTITY CASCADE';
			END IF;
		END $$;`,
		SELF_HOSTED_DATABASE,
	);
}

/**
 * The single KDF profile the verifier-producing API accepts
 * (`ValidatedKdfProfile::try_from` in `services/auth.rs`).
 *
 * Read off disk the way `../fixtures/messages` reads the message catalogue:
 * `@bittery/shared/kdf-policy` reaches the same file through a JSON *module*,
 * which Playwright's loader rejects for want of an import attribute.
 */
function currentKdfProfile() {
	const policy = JSON.parse(
		readFileSync(
			path.resolve(
				path.dirname(fileURLToPath(import.meta.url)),
				"../../../../packages/crypto/kdf-policy.json",
			),
			"utf8",
		),
	) as { schemaVersion: number; algorithm: string; defaultIterations: number };
	return {
		schemaVersion: policy.schemaVersion,
		algorithm: policy.algorithm,
		iterations: policy.defaultIterations,
	};
}

/**
 * A structurally valid `auth.signup` body carrying no real key material.
 *
 * `validate_signup_input` checks only the id shapes, the hex encoding of the
 * SRP pair and the KDF profile, so this is enough to reach the registration
 * guard - which is the point: the guard has to turn the request away before
 * anything looks at the credentials.
 */
function syntheticSignupPayload(user: TestUser) {
	return {
		userId: null,
		vaultId: null,
		email: user.email,
		signupVerificationToken: "",
		name: user.name,
		plan: "free",
		organizationName: null,
		secretKeyHint: "A3-E2EEE",
		srpSalt: "ab".repeat(16),
		srpVerifier: "cd".repeat(128),
		publicKey: "e2e-public-key",
		encryptedPrivateKey: "{}",
		encryptedMasterKey: "{}",
		recoveryKeyHint: "R1-E2EEE",
		encryptedVaultKey: "{}",
		kdfParams: currentKdfProfile(),
	};
}

/** Every signup code this run's server has emailed, which must stay empty. */
async function emailedSignupCodes() {
	return (await readOutbox()).filter((entry) => entry.purpose === "signup");
}

let adminContext: BrowserContext;
let adminPage: Page;
let admin: TestUser;
let invitee: TestUser;

test.beforeAll(async ({ browser }) => {
	test.setTimeout(SIGNUP_BUDGET_MS);
	resetSelfHostedServer();
	// Fresh addresses per attempt, so a retry can never collide with the rows a
	// previous attempt wrote before it failed.
	admin = generateTestUser();
	invitee = generateTestUser();
	// One context for the administrator across the whole file: the invitation in
	// the last test is sent from the session the first test opens, which is a
	// full SRP sign-in saved.
	adminContext = await browser.newContext();
	adminPage = await adminContext.newPage();
});

test.afterAll(async () => {
	await adminContext?.close();
});

test("the first account on a fresh server self-registers as the administrator", async () => {
	test.setTimeout(SIGNUP_BUDGET_MS);

	await signUpSelfHosted(adminPage, admin, {
		timeoutMs: SIGNUP_FLOW_TIMEOUT_MS,
	});
	await expect(adminPage).toHaveURL(/\/home$/);

	// Self-hosted signup skips email verification outright, so nothing was sent -
	// not merely "nothing was waited for".
	expect(await emailedSignupCodes()).toEqual([]);

	await openTeamPage(adminPage);
	const adminRow = memberRow(adminPage, admin.email);
	await expect(adminRow).toBeVisible({ timeout: VAULT_READY_TIMEOUT_MS });
	// The member list spells the owner role differently in self-hosted mode, and
	// this label is the product naming this account the server's administrator.
	await expect(adminRow).toContainText(
		uiText("team_members_role_owner_self_hosted"),
	);

	// `/admin` is gated on the `teamManagement` entitlement and an owner-or-admin
	// role (`beforeLoad` in `src/routes/_app/admin/index.tsx`); reaching it is the
	// administrator's authority, not just their label.
	await gotoRoute(
		adminPage,
		"/admin",
		adminPage.getByRole("tab", { name: uiText("admin_console_tab_people") }),
	);
	// The console defaults its tab through the query string.
	await expect(adminPage).toHaveURL(/\/admin(?:\?|$)/);
});

test("a second public signup is refused once the server has an administrator", async ({
	page,
	request,
}) => {
	test.setTimeout(TEST_BUDGET_MS);

	// Not the dead-invitation screen, which carries the near-identical
	// "Invitation Required"; `uiText` is what keeps the two apart.
	await gotoRoute(
		page,
		"/signup",
		page.getByRole("heading", {
			name: uiText("auth_signup_self_hosted_invite_only_title"),
		}),
	);
	await expect(
		page.getByText(uiText("auth_signup_self_hosted_invite_only_description")),
	).toBeVisible();
	await expect(page.getByTestId("signup-form")).toHaveCount(0);

	// The wall is only the client's half. `has_any_registered_user` is what
	// refuses the write, so call the endpoint the way the app's API facade would:
	// a second account is impossible even for a caller that never loaded the form.
	const response = await request.post(SELF_HOSTED_SIGNUP_URL, {
		data: syntheticSignupPayload(generateTestUser()),
	});
	expect(await response.text()).toContain(PUBLIC_SIGNUP_REFUSED);
});

test("an invited account signs up through its link and lands in the team", async ({
	browser,
}) => {
	test.setTimeout(SIGNUP_BUDGET_MS);

	await openTeamPage(adminPage);
	// The link is assembled in the browser and shown once - no invitation email
	// is ever sent, in either mode.
	const inviteUrl = await inviteMember(adminPage, invitee.email);
	expect(inviteUrl).toContain("/invite/");

	const inviteeContext = await browser.newContext();
	try {
		const inviteePage = await inviteeContext.newPage();
		await signUpSelfHosted(inviteePage, invitee, {
			inviteUrl,
			timeoutMs: SIGNUP_FLOW_TIMEOUT_MS,
		});

		// Landing on `/team` is the product stating that the invitation was
		// accepted as part of the signup rather than left pending.
		await expect(inviteePage).toHaveURL(/\/team$/);
		await expect(memberRow(inviteePage, admin.email)).toBeVisible({
			timeout: VAULT_READY_TIMEOUT_MS,
		});
		await expect(memberRow(inviteePage, invitee.email)).toContainText(
			uiText("team_role_member"),
		);
	} finally {
		await inviteeContext.close();
	}

	// And the administrator sees the same membership from their own session.
	await openTeamPage(adminPage);
	await expect(memberRow(adminPage, invitee.email)).toBeVisible({
		timeout: VAULT_READY_TIMEOUT_MS,
	});

	expect(await emailedSignupCodes()).toEqual([]);
});
