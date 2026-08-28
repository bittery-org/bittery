import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import {
	createMemoryActiveAccountStorage,
	createRuntimeClient,
	LOADING_SESSION,
	type RuntimeSessionSnapshot,
} from "@bittery/client-runtime/client";
import { createFakeRuntimeTransport } from "@bittery/client-runtime/testing";
import {
	evaluateRuntimeSessionAccess,
	settledRuntimeSession,
} from "./runtime-session";

function session(
	partial: Partial<RuntimeSessionSnapshot>,
): RuntimeSessionSnapshot {
	return { ...LOADING_SESSION, ...partial } as RuntimeSessionSnapshot;
}

describe("the app route guard reads the Runtime, not a stored token", () => {
	test("lets an unlocked Account in", () => {
		expect(
			evaluateRuntimeSessionAccess(
				session({ state: "unlocked", accountId: "account-1" }),
			),
		).toBe(null);
	});

	test("sends a locked Account to the lock screen, not into an empty vault", () => {
		expect(
			evaluateRuntimeSessionAccess(
				session({ state: "locked", accountId: "account-1" }),
			),
		).toBe("/login");
	});

	test("sends every other state to the lock screen", () => {
		for (const state of [
			"loading",
			"unavailable",
			"missing",
			"signedOut",
		] as const) {
			expect(evaluateRuntimeSessionAccess(session({ state }))).toBe("/login");
		}
	});
});

describe("waiting for the Device to answer", () => {
	test("resolves on the first settled snapshot", async () => {
		const transport = createFakeRuntimeTransport();
		const client = createRuntimeClient({
			transport,
			activeAccount: createMemoryActiveAccountStorage("account-1"),
		});
		const store = client.session();
		const settling = settledRuntimeSession(store);
		await transport.settled();
		transport.publish({
			type: "runtimeStatus",
			value: {
				accountId: null,
				accounts: [
					{
						accountId: "account-1",
						access: "unlocked",
						failure: null,
						replicaRevision: "1",
					},
				],
				closed: false,
				revision: "1",
			},
		});

		expect(await settling).toMatchObject({
			state: "unlocked",
			accountId: "account-1",
		});
	});

	test("a broken transport settles as unavailable rather than hanging", async () => {
		const transport = createFakeRuntimeTransport();
		transport.failObservations({
			code: "RUNTIME_CLOSED",
			message: "worker gone at owner.ts:88",
		});
		const client = createRuntimeClient({ transport });
		const settled = await settledRuntimeSession(client.session());
		expect(settled).toMatchObject({
			state: "unavailable",
			code: "RUNTIME_CLOSED",
		});
		expect(evaluateRuntimeSessionAccess(settled)).toBe("/login");
	});
});

describe("the Runtime owns the session, and nothing mirrors it", () => {
	function source(relative: string): string {
		return readFileSync(new URL(relative, import.meta.url), "utf8");
	}

	test("the localStorage mirror is gone", () => {
		expect(existsSync(new URL("./runtime-auth.ts", import.meta.url))).toBe(
			false,
		);
	});

	test("Sign-in and Quick Unlock go through the typed client, and no sentinel", () => {
		const form = source("../components/sign-in-form.tsx");
		expect(form).toContain("runtimeClient.signIn");
		expect(form).toContain("runtimeClient.quickUnlock");
		// The Account the form offers, reconciled against the Runtime's catalog.
		expect(form).toContain(
			"runtimeClient.resolveAccount(quickUnlockAccountId)",
		);
		expect(form).not.toContain("getRuntimeAccountId");
		expect(form).not.toContain("runtime-session");
		expect(form).not.toContain("storeAuthToken");
		expect(form).not.toContain("performSRPLogin");
		expect(form).not.toContain("unlockAccountWithPassword");
	});

	test("no source writes the gate-bypass credential", () => {
		for (const relative of [
			"../components/sign-in-form.tsx",
			"../routes/_app.tsx",
			"../routes/index.tsx",
			"../router.tsx",
		]) {
			expect(source(relative)).not.toContain(
				'storeAuthToken("runtime-session")',
			);
		}
	});

	test("the app route guard reads the observed Runtime session", () => {
		const guard = source("../routes/_app.tsx");
		expect(guard).toContain("settledRuntimeSession(runtimeClient.session())");
		expect(guard).toContain("evaluateRuntimeSessionAccess");
		expect(guard).not.toContain("storage.isAuthenticated");
	});

	test("post-dispatch deletion recovery runs before route authentication can refresh", () => {
		const root = source("../routes/__root.tsx");
		const storageReady = root.indexOf("await initializeStorage()");
		const deletionRecovered = root.indexOf(
			"await recoverAccountDeletionAtStartup()",
		);
		expect(storageReady).toBeGreaterThan(-1);
		expect(deletionRecovered).toBeGreaterThan(storageReady);
	});

	// Web "Log out" removes the whole Account from the Device, so it routes through the
	// Runtime's irreversible teardown, asks first, and reports what survived. `signOut` is
	// the weaker request and no longer reachable from here.
	test("log out reaches the Runtime's teardown, confirms, and reports what survived", () => {
		const sidebar = source("../components/layout/sidebar.tsx");
		expect(sidebar).toContain("removeAccountFromDevice");
		expect(sidebar).toContain("runtimeClient.removeAccount");
		expect(sidebar).toContain("runtimeClient.selectAccount");
		// The host duties the Runtime teardown does not cover.
		expect(sidebar).toContain("clearActiveAccountData");
		expect(sidebar).toContain("forgetWebAccountId");
		// Confirmation before an irreversible destroy.
		expect(sidebar).toContain("AlertDialog");
		// The contract, not one expression. `/login` is reached in two forms — the router
		// call and the hard fallback for a router that throws — and both must sit inside the
		// `removed` branch. Any other route out of the driver would navigate away over data
		// the Runtime still holds, so both forms are counted, everywhere in the file.
		const routeToLogin =
			/navigate\(\{\s*to:\s*"\/login"|location\.assign\("\/login"\)/g;
		expect(sidebar.match(routeToLogin) ?? []).toHaveLength(2);
		const removedBranch = sidebar.slice(
			sidebar.indexOf('result.status === "removed"'),
			sidebar.indexOf('result.status === "browserDataCleared"'),
		);
		expect(removedBranch.match(routeToLogin) ?? []).toHaveLength(2);
		expect(sidebar).not.toContain("runtimeClient.signOut");
	});

	// "Use a different account" sits on the locked screen, before anybody proved they own
	// the Account, so it retires the Session instead of destroying it. What it must not do
	// is discard the outcome: a swallowed refusal reloaded the page over a Runtime that
	// still held live access, and the same offer came straight back.
	test("switching account retires the session and reports what did not finish", () => {
		const form = source("../components/sign-in-form.tsx");
		expect(form).toContain("retireAccountSession");
		expect(form).toContain("runtimeClient.signOut");
		expect(form).not.toContain(".catch(() => undefined)");
		// The unnamed sign-out, which forgets nothing when the pointer is already empty.
		expect(form).not.toContain("forgetActiveSession");
		// Reload only where the retirement finished. It is the success effect, and a
		// reload over a refusal shows the same offer again and calls that a switch. The
		// branch is sliced to its own `return;`, not to the end of the file: a proximity
		// match passes even when the reload has been moved out of the branch entirely.
		const reloads = form.match(/location\.reload\(\)/g) ?? [];
		expect(reloads).toHaveLength(1);
		const retiredStart = form.indexOf('result.status === "retired"');
		const retiredBranch = form.slice(
			retiredStart,
			form.indexOf("\n\t\t\treturn;", retiredStart),
		);
		expect(retiredBranch).toContain("location.reload()");
		// The escape is not a switch: it forgets this browser's sign-in and says the
		// Runtime kept the Account. It may not reach the Runtime at all.
		expect(form).toContain("forgetBrowserSessionOnly");
		expect(form).toContain("auth_signin_different_account_forgotten");
		// Never the destroying request from a screen that cannot prove who is pressing it.
		expect(form).not.toContain("removeAccountFromDevice");
		expect(form).not.toContain("runtimeClient.removeAccount");
	});

	// The escape drops the Secret Key and deliberately does not reload. That leaves it
	// owing the user the thing it exists for: a usable email field. `isQuickUnlock` is read
	// from a cached `useSessionState` query with a five-second `staleTime` and no
	// invalidation of its own, and nothing here remounts the screen, so without an explicit
	// refresh the user stares at the same disabled field the escape was pressed to unblock.
	test("the browser-only escape re-enables the sign-in it just unblocked", () => {
		const form = source("../components/sign-in-form.tsx");
		const forgottenStart = form.indexOf(
			'result.status === "browserSessionForgotten"',
		);
		expect(forgottenStart).toBeGreaterThan(-1);
		// Bounded to the branch's own `return;`. A refresh outside it either never runs or
		// runs over a retirement that failed, which is a different screen entirely.
		const forgottenBranch = form.slice(
			forgottenStart,
			form.indexOf("\n\t\t\treturn;", forgottenStart),
		);
		expect(forgottenBranch).toContain("queryClient.invalidateQueries");
		expect(forgottenBranch).toContain('queryKey: ["auth", "sessionState"]');
	});

	// A retry the copy has just called impossible is not a retry. An empty transitional
	// pointer is refused for the rest of this page load, so the button goes away instead of
	// standing there inviting the same failure — exactly as the delete dialog does.
	test("the sign-in screen withdraws a retry that cannot finish", () => {
		const form = source("../components/sign-in-form.tsx");
		expect(form).toContain("retryCannotFinish(heldReport)");
		expect(form).toMatch(
			/\{stranded \? null : \([\s\S]{0,400}?"use-different-account"/,
		);
	});

	// The Danger Zone keeps the one ordering the Runtime cannot express: the Server first.
	// Everything after it is the Runtime's, and every local failure has to reach the user —
	// the transitional orchestrator surfaced only the server step and dropped the rest.
	test("account deletion deletes on the Server first, then destroys through the Runtime", () => {
		const dialog = source("../components/settings/delete-account-dialog.tsx");
		const orchestration = source("./account-deletion.ts");
		expect(dialog).toContain("deleteAccountEverywhere");
		expect(dialog).toContain("runtimeClient.deleteServerAccount");
		expect(dialog).toContain("normalizeAccountEmail");
		expect(orchestration).toContain(
			"await deps.normalizeAccountEmail(confirmEmail)",
		);
		expect(orchestration).not.toContain(".toLowerCase(");
		expect(orchestration).not.toContain('.normalize("NFKC")');
		expect(dialog).toContain("runtimeClient.removeAccount");
		expect(dialog).toContain("clearActiveAccountData");
		expect(dialog).toContain("forgetWebAccountId");
		expect(dialog).not.toContain("@bittery/core/services/account-lifecycle");
		expect(dialog).not.toContain("apiClient.auth.deleteAccount");
		expect(dialog).not.toContain('failure.step === "delete_server_account"');
		// The success effects belong to the deleted arm alone. Navigating on anything
		// else claims a deletion that did not happen.
		const navigations = dialog.match(/navigate\(\{ to: "\/" \}\)/g) ?? [];
		expect(navigations).toHaveLength(1);
		// Bounded to the branch's own `return;`. Slicing to the end of the file swallows
		// the failure arm below it, so moving the navigation there would still pass.
		const deletedStart = dialog.indexOf('result.status === "deleted"');
		const deletedBranch = dialog.slice(
			deletedStart,
			dialog.indexOf("\n\t\t\treturn;", deletedStart),
		);
		expect(deletedBranch).toContain('navigate({ to: "/" })');
	});

	test("a repeated local deletion failure offers a truthful browser-only terminal action", () => {
		const dialog = source("../components/settings/delete-account-dialog.tsx");
		expect(dialog).toContain("report?.canClearBrowserDataOnly");
		expect(dialog).toContain("delete-account-clear-browser-data");
		expect(dialog).toContain('result.status === "browserDataCleared"');
		expect(dialog).toContain("const heldTarget = previous?.target");
		expect(dialog).toContain("runtimeAccountId: heldTarget.runtimeAccountId");

		// Bounded to the driver. An import or an unrelated handler mentioning the escape
		// does not prove the clear action dispatches to it instead of deleting again.
		const runDeletionStart = dialog.indexOf("const runDeletion = async (");
		const runDeletion = dialog.slice(
			runDeletionStart,
			dialog.indexOf("\n\tconst report =", runDeletionStart),
		);
		expect(runDeletion).toContain('action === "clearBrowserData"');
		expect(runDeletion).toContain(
			"await clearBrowserStoredDataOnly(previous, removalDeps)",
		);
		expect(runDeletion).toContain("await deleteAccountEverywhere(");

		const terminalStart = dialog.indexOf(
			'result.status === "browserDataCleared"',
		);
		const terminalBranch = dialog.slice(
			terminalStart,
			dialog.indexOf("\n\t\t\treturn;", terminalStart),
		);
		expect(terminalBranch).not.toContain("navigate");
		expect(terminalBranch).not.toContain("toast.success");
		expect(terminalBranch).not.toContain("incomplete_retry");
		expect(terminalBranch).not.toContain("needsConfirmation");
		expect(terminalBranch).toContain('phase: "browserDataCleared"');
		expect(dialog).toContain("cleared || stranded ? null");
		expect(dialog).toContain("!cleared &&");

		const english = JSON.parse(
			source("../../../../packages/i18n/messages/en.json"),
		) as Record<string, string>;
		const german = JSON.parse(
			source("../../../../packages/i18n/messages/de.json"),
		) as Record<string, string>;
		expect(english.settings_delete_account_dialog_clear_browser_data_hint).toBe(
			"The Server Account is already deleted. Removing the surviving Device data keeps failing. You can still clear what this browser stored, including your Secret Key. Runtime-owned Account data can remain on this Device.",
		);
		expect(
			english.settings_delete_account_dialog_browser_cleared_description,
		).toBe(
			"The Server Account is deleted. This browser's transitional Account data is gone, including your Secret Key. The Account was not removed from this Device; Runtime-owned data can remain.",
		);
		expect(german.settings_delete_account_dialog_clear_browser_data_hint).toBe(
			"Das Server-Konto ist bereits gelöscht. Das Entfernen der verbliebenen Gerätedaten schlägt weiterhin fehl. Du kannst trotzdem löschen, was dieser Browser gespeichert hat, einschließlich deines Secret Keys. Runtime-eigene Kontodaten können auf diesem Gerät verbleiben.",
		);
		expect(
			german.settings_delete_account_dialog_browser_cleared_description,
		).toBe(
			"Das Server-Konto ist gelöscht. Die Übergangsdaten dieses Browsers sind weg, einschließlich deines Secret Keys. Das Konto wurde nicht von diesem Gerät entfernt; Runtime-eigene Daten können verbleiben.",
		);
	});

	// A report that dies with the dialog takes `serverAccountDeleted` with it, and the next
	// attempt asks the Server for an Account it no longer has. That answer is an error, and
	// reading it as "the Server still holds it" strands this Device's copy forever.
	test("an incomplete deletion report outlives the dialog that showed it", () => {
		const dialog = source("../components/settings/delete-account-dialog.tsx");
		expect(dialog).toContain("useRef<AccountDeletionIncomplete | null>(null)");
		expect(dialog).toMatch(
			/lastIncompleteReport\.current = report;[\s\S]{0,120}?setDeletion\(\{ phase: "incomplete"/,
		);
		// The read, not only the write. A ref nothing reads back is a ref that carries
		// nothing: the reopened dialog would show a fresh confirmation and the next
		// attempt would ask the Server for an Account it no longer has.
		expect(dialog).toContain("result: lastIncompleteReport.current");
	});

	// A ref dies with the document, and this one is guaranteed a document swap: the Server
	// Account is gone, so the next authenticated request answers 401 and `router.tsx` sends
	// the browser to `/login`. The fact the retry cannot re-derive is written down.
	test("the deleted Server Account is remembered outside React memory", () => {
		const dialog = source("../components/settings/delete-account-dialog.tsx");
		expect(dialog).toContain("readAccountDeletionMarker");
		expect(dialog).toContain("writeAccountDeletionMarker");

		const store = source("./storage.ts");
		// Keyed by the account it is about, so it can never speak for another one.
		expect(store).toMatch(
			/writeAccountDeletionMarker\([\s\S]{0,300}?JSON\.stringify\(marker\)/,
		);
	});

	// The dialog can be dismissed on an incomplete report — "Not now", or Escape while
	// nothing is running. Closing it must not throw the report away: the next gesture would
	// re-resolve two names the stores no longer answer to, and the failed-attempt count that
	// offers the escape hatch would start again at zero on a Device that never converges.
	test("an incomplete report outlives the dialog that showed it", () => {
		const sidebar = source("../components/layout/sidebar.tsx");
		expect(sidebar).toContain("useRef<LogOutReport | null>(null)");
		expect(sidebar).toMatch(
			/const previous =[\s\S]{0,160}?lastIncompleteReport\.current/,
		);
		// The write, not only the read. Without it the ref stays `null`, a closed dialog
		// loses its report, and the next gesture re-resolves two names the stores no longer
		// answer to. The write belongs to the incomplete arm: the removed arm clears it.
		expect(sidebar).toMatch(
			/lastIncompleteReport\.current = result;[\s\S]{0,80}?setRemoval\(\{ phase: "incomplete"/,
		);
		expect(sidebar).toMatch(
			/lastIncompleteReport\.current = null;[\s\S]{0,80}?setRemoval\(CLOSED\)/,
		);
		// Both terminal outcomes drop the decrypted Items. The escape hatch deliberately
		// does not navigate, so without this the vault stays on screen after it.
		expect(sidebar.match(/queryClient\.clear\(\)/g) ?? []).toHaveLength(2);
	});

	// A wedged Device refuses account-scope `RemoveAccount` every time, and Web has no
	// Device-wipe screen. The escape hatch must stay reachable, and must stay a transitional
	// store clear: it may not call the Runtime or move the Runtime's own pointer.
	test("the browser-only escape clears the transitional store and nothing else", () => {
		const sidebar = source("../components/layout/sidebar.tsx");
		expect(sidebar).toContain("clearBrowserStoredDataOnly");

		const module = source("./account-removal.ts");
		// Bounded to the function. The file holds three gestures now, and two of them
		// legitimately move the pointer this one may not touch.
		const start = module.indexOf(
			"export async function clearBrowserStoredDataOnly",
		);
		const hatch = module.slice(start, module.indexOf("\n}\n", start));
		expect(hatch).toContain("clearTransitionalAccountData");
		expect(hatch).not.toContain("deps.removeAccount");
		expect(hatch).not.toContain("deps.selectAccount");
	});

	// The sign-in screen's sibling wedge: `SignOut` reaches `retire_account_access`, which
	// keeps `ensure_open()`, so a wedged Runtime refuses it every time. Without an escape
	// the screen is a dead end — the email field stays disabled while this browser holds a
	// Quick Unlock. The escape forgets this browser's sign-in and nothing else.
	test("the sign-in escape forgets this browser's session and nothing else", () => {
		const form = source("../components/sign-in-form.tsx");
		expect(form).toContain("use-different-account-escape");

		const module = source("./account-removal.ts");
		const start = module.indexOf(
			"export async function forgetBrowserSessionOnly",
		);
		const hatch = module.slice(start, module.indexOf("\n}\n", start));
		expect(hatch).toContain("forgetTransitionalSession");
		expect(hatch).not.toContain("deps.signOutRuntimeAccount");
		expect(hatch).not.toContain("deps.selectAccount");
		// Its outcome says what the Runtime kept, so no screen can read it as a switch.
		expect(hatch).toContain('status: "browserSessionForgotten"');
		expect(hatch).toContain('areas: ["runtimeSession"]');
	});

	test("the Worker gets a per-browser client id and the build's version", () => {
		const composition = source("./crypto.ts");
		expect(composition).toContain("getOrCreateClientId(window.localStorage)");
		expect(composition).toContain("import.meta.env.VITE_APP_VERSION");
		expect(composition).toContain("encodeRuntimeClientIdentity");
		expect(composition).not.toContain('"bittery-web"');

		const worker = source("./runtime.worker.ts");
		expect(worker).toContain("decodeRuntimeClientIdentity(self.name)");
		expect(worker).not.toContain('clientId: "bittery-web"');
		expect(worker).not.toContain('version: "0.5.2"');
	});

	test("one Device-wide observation is opened at the composition root", () => {
		const composition = source("./crypto.ts");
		expect(composition).toContain("runtimeClient.session().subscribe");
	});
});
