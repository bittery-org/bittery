import { describe, expect, test } from "bun:test";
import { RuntimeRequestError } from "@bittery/client-runtime/client";
import {
	type AccountDeletionMarker,
	type DeleteAccountEverywhereDeps,
	decodeAccountDeletionMarker,
	deleteAccountEverywhere,
	gateLocalTeardown,
	gateRuntimeAuthentication,
} from "./account-deletion";

const target = {
	runtimeAccountId: "runtime-account-1",
	transitionalAccountId: "web-account-1",
};

function fixture(overrides: Partial<DeleteAccountEverywhereDeps> = {}) {
	let marker: AccountDeletionMarker | null = null;
	const calls: string[] = [];
	const deps: DeleteAccountEverywhereDeps = {
		resolveTarget: async () => target,
		readMarker: () => marker,
		writeMarker(value) {
			marker = value;
			calls.push(`write:${value?.phase ?? "clear"}`);
		},
		createRequestId: () => "018f47a2-6f40-47da-8d53-a55e557dc723",
		normalizeAccountEmail: async (value) =>
			value.trim().toLowerCase().normalize("NFKC"),
		async deleteServerAccount(input) {
			calls.push(`server:${JSON.stringify(input)}`);
			return { ...input, outcome: "deleted" };
		},
		async removeLocalAccount(resolved) {
			calls.push(`local:${JSON.stringify(resolved)}`);
			return { status: "removed" };
		},
		...overrides,
	};
	return {
		deps,
		calls,
		marker: () => marker,
		seed: (value: AccountDeletionMarker) => (marker = value),
	};
}

describe("durable Server Account deletion", () => {
	test("persists prepared and dispatchedUnknown before granting Runtime transport authority", async () => {
		const f = fixture();
		const result = await deleteAccountEverywhere(
			" Person@Example.Test ",
			f.deps,
		);

		expect(result).toEqual({ status: "deleted" });
		expect(f.calls).toEqual([
			"write:prepared",
			"write:dispatchedUnknown",
			'server:{"accountId":"runtime-account-1","confirmEmail":"person@example.test","requestId":"018f47a2-6f40-47da-8d53-a55e557dc723"}',
			"write:serverDeleted",
			'local:{"runtimeAccountId":"runtime-account-1","transitionalAccountId":"web-account-1"}',
			"write:clear",
		]);
	});

	test("a marker write failure never contacts the Runtime", async () => {
		const f = fixture({
			writeMarker: () => {
				throw new Error("quota");
			},
		});
		const result = await deleteAccountEverywhere("person@example.test", f.deps);
		expect(result.status).toBe("incomplete");
		expect(f.calls).toEqual([]);
	});

	test("reload replays dispatchedUnknown exactly and serverDeleted skips the Server", async () => {
		const unknown = fixture();
		unknown.seed({
			version: 1,
			...target,
			confirmEmail: "person@example.test",
			requestId: "018f47a2-6f40-47da-8d53-a55e557dc723",
			phase: "dispatchedUnknown",
		});
		await deleteAccountEverywhere("ignored@example.test", unknown.deps);
		expect(unknown.calls[0]).toContain(
			'server:{"accountId":"runtime-account-1","confirmEmail":"person@example.test"',
		);

		const closed = fixture();
		closed.seed({
			version: 1,
			...target,
			confirmEmail: "person@example.test",
			requestId: "018f47a2-6f40-47da-8d53-a55e557dc723",
			phase: "serverDeleted",
		});
		await deleteAccountEverywhere("ignored@example.test", closed.deps);
		expect(closed.calls.some((call) => call.startsWith("server:"))).toBe(false);
	});

	test("account mismatch isolates another Account's retry material", async () => {
		const f = fixture();
		f.seed({
			version: 1,
			runtimeAccountId: "other",
			transitionalAccountId: "other-web",
			confirmEmail: "other@example.test",
			requestId: "11111111-1111-4111-8111-111111111111",
			phase: "dispatchedUnknown",
		});
		const result = await deleteAccountEverywhere("person@example.test", f.deps);
		expect(result).toMatchObject({
			status: "incomplete",
			reason: "accountMismatch",
		});
		expect(f.calls).toEqual([]);
	});

	test("closed refusal and final 401 clear consumed retry material without local loss", async () => {
		for (const answer of ["confirmationEmailMismatch", "blocked"] as const) {
			const f = fixture({
				deleteServerAccount: async (input) => ({ ...input, outcome: answer }),
			});
			const result = await deleteAccountEverywhere(
				"person@example.test",
				f.deps,
			);
			expect(result).toMatchObject({ status: "incomplete", reason: answer });
			expect(f.marker()).toBeNull();
			expect(f.calls.some((call) => call.startsWith("local:"))).toBe(false);
		}
		const f = fixture({
			deleteServerAccount: async () => {
				throw new RuntimeRequestError("AUTHENTICATION_REQUIRED", "closed 401");
			},
		});
		const result = await deleteAccountEverywhere("person@example.test", f.deps);
		expect(result).toMatchObject({
			status: "incomplete",
			reason: "AUTHENTICATION_REQUIRED",
		});
		expect(f.marker()).toBeNull();
	});

	test("ambiguous transport retains dispatchedUnknown and local cleanup cannot start", async () => {
		const f = fixture({
			deleteServerAccount: async () => {
				throw new RuntimeRequestError(
					"AUTHENTICATION_UNAVAILABLE",
					"lost response",
				);
			},
		});
		const result = await deleteAccountEverywhere("person@example.test", f.deps);
		expect(result).toMatchObject({
			status: "incomplete",
			reason: "AUTHENTICATION_UNAVAILABLE",
		});
		expect(f.marker()?.phase).toBe("dispatchedUnknown");
		expect(f.calls.some((call) => call.startsWith("local:"))).toBe(false);
	});

	test("marker clears only after the local Runtime and transitional owners complete", async () => {
		const f = fixture({
			removeLocalAccount: async () => ({
				status: "incomplete",
				target,
				attempts: 1,
				areas: ["replica"],
				code: null,
				canClearBrowserDataOnly: false,
			}),
		});
		const result = await deleteAccountEverywhere("person@example.test", f.deps);
		expect(result.status).toBe("incomplete");
		expect(f.marker()?.phase).toBe("serverDeleted");
	});
});

describe("deletion marker teardown gate", () => {
	test("prepared cancels, serverDeleted continues, and dispatchedUnknown preserves retry authority", () => {
		for (const [phase, expected] of [
			["prepared", "allowed"],
			["serverDeleted", "allowed"],
			["dispatchedUnknown", "recoveryRequired"],
		] as const) {
			const f = fixture();
			f.seed({
				version: 1,
				...target,
				confirmEmail: "person@example.test",
				requestId: "018f47a2-6f40-47da-8d53-a55e557dc723",
				phase,
			});
			expect(gateLocalTeardown(target, f.deps)).toBe(expected);
			expect(f.marker()?.phase ?? null).toBe(
				phase === "prepared" ? null : phase,
			);
		}
	});

	test("bootstrap may cancel prepared but must recover every post-dispatch phase first", () => {
		for (const [phase, expected] of [
			["prepared", "allowed"],
			["serverDeleted", "recoveryRequired"],
			["dispatchedUnknown", "recoveryRequired"],
		] as const) {
			const f = fixture();
			f.seed({
				version: 1,
				...target,
				confirmEmail: "person@example.test",
				requestId: "018f47a2-6f40-47da-8d53-a55e557dc723",
				phase,
			});
			expect(gateRuntimeAuthentication(f.deps)).toBe(expected);
		}
	});
});

test("the versioned marker codec rejects unknown fields and non-canonical request ids", () => {
	const marker = {
		version: 1,
		...target,
		confirmEmail: "person@example.test",
		requestId: "018f47a2-6f40-47da-8d53-a55e557dc723",
		phase: "prepared",
	} as const;
	expect(decodeAccountDeletionMarker(marker)).toEqual(marker);
	expect(() =>
		decodeAccountDeletionMarker({ ...marker, token: "secret" }),
	).toThrow();
	expect(() =>
		decodeAccountDeletionMarker({
			...marker,
			requestId: marker.requestId.toUpperCase(),
		}),
	).toThrow();
});
