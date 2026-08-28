import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import type { RuntimeSessionSnapshot } from "@bittery/client-runtime/client";
import { activeRuntimeAccountDisplayIdentity } from "./settings-runtime-identity";

const settingsSource = readFileSync(
	new URL("../routes/_app/settings/index.tsx", import.meta.url),
	"utf8",
);
const dangerZoneSource = settingsSource.slice(
	settingsSource.indexOf("{/* Danger Zone */}"),
	settingsSource.indexOf("<VaultExportDialog"),
);

describe("Settings deletion Runtime identity wiring", () => {
	test("selects only the active Account's validated display identity", () => {
		const session: RuntimeSessionSnapshot = {
			state: "unlocked",
			accountId: "account-2",
			accounts: [
				{
					accountId: "account-1",
					access: "unlocked",
					displayIdentity: { email: "wrong@example.test" },
					failure: null,
					replicaRevision: "1",
				},
				{
					accountId: "account-2",
					access: "unlocked",
					displayIdentity: { email: "person@example.test" },
					failure: null,
					replicaRevision: "1",
				},
			],
			waitingReason: null,
			code: null,
		};

		expect(activeRuntimeAccountDisplayIdentity(session)).toEqual({
			email: "person@example.test",
		});
	});

	test("does not fabricate an identity for recovery or a stale Account", () => {
		const recoverySession: RuntimeSessionSnapshot = {
			state: "signedOut",
			accountId: "account-recovery",
			accounts: [
				{
					accountId: "account-recovery",
					access: "signedOut",
					failure: "INVARIANT_VIOLATION",
					replicaRevision: "0",
				},
			],
			waitingReason: null,
			code: "INVARIANT_VIOLATION",
		};
		const staleSession = {
			...recoverySession,
			state: "missing",
			accountId: "account-stale",
		} satisfies RuntimeSessionSnapshot;

		expect(activeRuntimeAccountDisplayIdentity(recoverySession)).toBeNull();
		expect(activeRuntimeAccountDisplayIdentity(staleSession)).toBeNull();
	});

	test("uses the active Runtime Account identity instead of auth.me", () => {
		expect(settingsSource).toContain("useRuntimeSession()");
		expect(dangerZoneSource).toContain(
			"<DeleteAccountDialog userEmail={deletionIdentity.email}",
		);
		expect(dangerZoneSource).not.toContain("userQuery.data");
	});
});
