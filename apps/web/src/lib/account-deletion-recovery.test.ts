import { expect, test } from "bun:test";
import { RuntimeRequestError } from "@bittery/client-runtime/client";
import type {
	AccountDeletionMarker,
	DeleteAccountEverywhereDeps,
} from "./account-deletion";
import { recoverRetainedAccountDeletionAtStartup } from "./account-deletion-recovery";

const marker: AccountDeletionMarker = {
	version: 1,
	runtimeAccountId: "runtime-1",
	transitionalAccountId: "web-1",
	confirmEmail: "person@example.test",
	requestId: "018f47a2-6f40-47da-8d53-a55e557dc723",
	phase: "dispatchedUnknown",
};

function fixture(
	deleteServerAccount: DeleteAccountEverywhereDeps["deleteServerAccount"],
) {
	let retained: AccountDeletionMarker | null = marker;
	const deps: DeleteAccountEverywhereDeps = {
		resolveTarget: async () => marker,
		readMarker: () => retained,
		writeMarker: (next) => {
			retained = next;
		},
		createRequestId: () => marker.requestId,
		normalizeAccountEmail: async (value) => value,
		deleteServerAccount,
		removeLocalAccount: async () => ({ status: "removed" }),
	};
	return { deps, marker: () => retained };
}

test("startup continues after replayed closed refusals consume the marker", async () => {
	for (const outcome of ["confirmationEmailMismatch", "blocked"] as const) {
		const f = fixture(async () => ({
			accountId: marker.runtimeAccountId,
			requestId: marker.requestId,
			outcome,
		}));

		await expect(
			recoverRetainedAccountDeletionAtStartup(marker, f.deps),
		).resolves.toBeUndefined();
		expect(f.marker()).toBeNull();
	}
});

test("startup continues after an authoritative 401 and blocks on ambiguity", async () => {
	const closed = fixture(async () => {
		throw new RuntimeRequestError(
			"AUTHENTICATION_REQUIRED",
			"authoritative retry refusal",
		);
	});
	await expect(
		recoverRetainedAccountDeletionAtStartup(marker, closed.deps),
	).resolves.toBeUndefined();
	expect(closed.marker()).toBeNull();

	const unknown = fixture(async () => {
		throw new RuntimeRequestError(
			"AUTHENTICATION_UNAVAILABLE",
			"response lost",
		);
	});
	await expect(
		recoverRetainedAccountDeletionAtStartup(marker, unknown.deps),
	).rejects.toThrow("remains incomplete");
	expect(unknown.marker()?.phase).toBe("dispatchedUnknown");
});
