import { expect, test } from "bun:test";
import { RuntimeRequestError } from "@bittery/client-runtime/client";
import type { VerifiedRecipientGesture } from "@/lib/recipient-key-verification";
import {
	inspectRuntimeTeamLeave,
	runRuntimeTeamLeave,
} from "./use-runtime-team-leave";

test("an applied Team leave returns its retained refresh duty after the Server revokes the old session", async () => {
	let sessionRevoked = false;
	let approvals = 0;
	const selection = {
		startOperationId: "start-operation",
		candidates: [{ userId: "remaining-owner", publicKey: "approved-key" }],
	};
	const client = {
		prepareRotation: async () => ({ type: "rotationPrepared", selection }),
		completeRotation: async () => {
			sessionRevoked = true;
			return {
				type: "rotationRefreshRequired",
				finalizeOperationId: "finalize-operation",
				outcome: { type: "applied", personalTeamId: "personal-team" },
			};
		},
		inspectRotation: async () => {
			throw new Error("No poll is needed for a terminal refresh duty");
		},
	} as unknown as Parameters<typeof runRuntimeTeamLeave>[0];
	const verification: Parameters<typeof runRuntimeTeamLeave>[1] = {
		async run<T>(task: (gesture: VerifiedRecipientGesture) => Promise<T>) {
			const result = await task({
				accountId: "same-account",
				signal: new AbortController().signal,
				async checkActive() {
					if (sessionRevoked)
						throw new RuntimeRequestError(
							"AUTHENTICATION_REQUIRED",
							"Old session was revoked",
						);
				},
				async approvedKey(recipient) {
					approvals++;
					return recipient.publicKey;
				},
			});
			if (sessionRevoked)
				throw new RuntimeRequestError(
					"AUTHENTICATION_REQUIRED",
					"Old session was revoked",
				);
			return result;
		},
	};

	expect(await runRuntimeTeamLeave(client, verification, "team-id")).toEqual({
		accountId: "same-account",
		startOperationId: "start-operation",
		result: {
			type: "rotationRefreshRequired",
			finalizeOperationId: "finalize-operation",
			outcome: { type: "applied", personalTeamId: "personal-team" },
		},
	});
	expect(approvals).toBe(1);
});

test("dialog caller loss aborts a held private completion before finalize admission", async () => {
	const owner = new AbortController();
	let entered!: () => void;
	const held = new Promise<void>((resolve) => {
		entered = resolve;
	});
	let release!: () => void;
	const released = new Promise<void>((resolve) => {
		release = resolve;
	});
	let completionSignal: AbortSignal | undefined;
	const client = {
		prepareRotation: async () => ({
			type: "rotationPrepared",
			selection: { startOperationId: "original-start", candidates: [] },
		}),
		completeRotation: async (
			_request: unknown,
			options?: { signal?: AbortSignal },
		) => {
			completionSignal = options?.signal;
			entered();
			await released;
			if (options?.signal?.aborted)
				throw new RuntimeRequestError("CANCELLED", "caller closed");
			return { type: "rotationCompleted", personalTeamId: "personal-team" };
		},
		inspectRotation: async () => {
			throw new Error("Unexpected inspection");
		},
	} as unknown as Parameters<typeof runRuntimeTeamLeave>[0];
	const verification: Parameters<typeof runRuntimeTeamLeave>[1] = {
		async run<T>(task: (gesture: VerifiedRecipientGesture) => Promise<T>) {
			return task({
				accountId: "same-account",
				signal: new AbortController().signal,
				checkActive: async () => {},
				approvedKey: async (recipient) => recipient.publicKey,
			});
		},
	};
	const attempt = runRuntimeTeamLeave(
		client,
		verification,
		"team-id",
		owner.signal,
	);
	await held;
	owner.abort();
	expect(completionSignal?.aborted).toBe(true);
	release();
	await expect(attempt).rejects.toMatchObject({ code: "CANCELLED" });
});

test("same Account renewal inspects the original start Operation after a lost finalize reply", async () => {
	let renewed = false;
	let starts = 0;
	let completions = 0;
	const client = {
		prepareRotation: async () => {
			starts++;
			return {
				type: "rotationPrepared",
				selection: {
					startOperationId: "original-start",
					candidates: [],
				},
			};
		},
		completeRotation: async () => {
			completions++;
			throw new RuntimeRequestError(
				"AUTHENTICATION_REQUIRED",
				"old Session revoked",
			);
		},
		inspectRotation: async ({
			accountId,
			startOperationId,
		}: {
			accountId: string;
			startOperationId: string;
		}) => {
			expect(accountId).toBe("same-account");
			expect(startOperationId).toBe("original-start");
			if (!renewed)
				throw new RuntimeRequestError(
					"AUTHENTICATION_REQUIRED",
					"renew required",
				);
			return { type: "rotationCompleted", personalTeamId: "personal-team" };
		},
	} as unknown as Parameters<typeof runRuntimeTeamLeave>[0];
	const verification: Parameters<typeof runRuntimeTeamLeave>[1] = {
		async run<T>(task: (gesture: VerifiedRecipientGesture) => Promise<T>) {
			return task({
				accountId: "same-account",
				signal: new AbortController().signal,
				checkActive: async () => {},
				approvedKey: async (recipient) => recipient.publicKey,
			});
		},
	};
	const pending = await runRuntimeTeamLeave(client, verification, "old-team");
	expect(pending).toEqual({
		accountId: "same-account",
		startOperationId: "original-start",
		result: { type: "inspectionRequired" },
	});
	renewed = true;
	const completed = await inspectRuntimeTeamLeave(
		client,
		verification,
		pending.accountId,
		pending.startOperationId,
	);
	expect(completed.result).toEqual({
		type: "rotationCompleted",
		personalTeamId: "personal-team",
	});
	expect(starts).toBe(1);
	expect(completions).toBe(1);
});
