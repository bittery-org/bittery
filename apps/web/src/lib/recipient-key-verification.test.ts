import { expect, test } from "bun:test";
import {
	RuntimeRequestError,
	type RuntimeSessionSnapshot,
} from "@bittery/client-runtime/client";
import {
	type RecipientPrompt,
	withVerifiedRecipientKeys,
} from "./recipient-key-verification";

function harness() {
	let snapshot: RuntimeSessionSnapshot = {
		state: "unlocked",
		accountId: "account-a",
		accounts: [],
		waitingReason: null,
		code: null,
	};
	const listeners = new Set<() => void>();
	const state = {
		scope: "generation-1/epoch-0",
		trusted: false,
		approved: "runtime-approved-key",
		writes: 0,
		reads: 0,
		storageFailure: false,
	};
	const client: Parameters<typeof withVerifiedRecipientKeys>[0] = {
		session: () => ({
			getSnapshot: () => snapshot,
			subscribe(listener) {
				listeners.add(listener);
				return () => {
					listeners.delete(listener);
				};
			},
		}),
		recipientKeyScope: async () => ({
			type: "recipientKeyScope",
			scope: state.scope,
		}),
		verifiedRecipientKey: async (input) => {
			state.reads++;
			expect(input.accountId).toBe("account-a");
			if (state.storageFailure)
				throw new RuntimeRequestError("STORAGE_UNAVAILABLE", "storage fault");
			if (!state.trusted)
				throw new RuntimeRequestError("RECIPIENT_KEY_UNVERIFIED", "unverified");
			return { type: "verifiedRecipientKey", publicKey: state.approved };
		},
		verifyRecipientKey: async (input) => {
			if (input.expectedFingerprint !== "independently-received")
				throw new RuntimeRequestError(
					"RECIPIENT_FINGERPRINT_MISMATCH",
					"mismatch",
				);
			state.writes++;
			state.trusted = true;
			return { type: "recipientKeyVerified" };
		},
	};
	return {
		client,
		state,
		listeners,
		change(next: Partial<RuntimeSessionSnapshot>) {
			snapshot = { ...snapshot, ...next };
			for (const listener of listeners) listener();
		},
	};
}
const recipient = {
	recipientUserId: "recipient",
	publicKey: "server-supplied-key",
};
const verify: RecipientPrompt = async (_recipient, _changed, confirm) =>
	confirm("independently-received");

test("first contact requires independent verification and returns the Runtime-approved key", async () => {
	const h = harness();
	const key = await withVerifiedRecipientKeys(h.client, verify, (gesture) =>
		gesture.approvedKey(recipient),
	);
	expect(key).toBe("runtime-approved-key");
	expect(key).not.toBe(recipient.publicKey);
	expect(h.state.writes).toBe(1);
	expect(h.state.reads).toBe(2);
	expect(h.listeners.size).toBe(0);
});

test("wrong fingerprint and a prompt that skips verification cannot reach wrapping or upload", async () => {
	for (const prompt of [
		async (_r, _changed, confirm) => confirm("wrong"),
		async () => {},
	] satisfies RecipientPrompt[]) {
		const h = harness();
		let sent = false;
		await expect(
			withVerifiedRecipientKeys(h.client, prompt, async (gesture) => {
				await gesture.approvedKey(recipient);
				sent = true;
			}),
		).rejects.toBeInstanceOf(RuntimeRequestError);
		expect(sent).toBe(false);
		expect(h.state.writes).toBe(0);
	}
});

test("cancelled verification and storage failure never fall back to the server key", async () => {
	const h = harness();
	let sent = false;
	const cancel: RecipientPrompt = async () => {
		throw new RuntimeRequestError("CANCELLED", "cancelled");
	};
	await expect(
		withVerifiedRecipientKeys(h.client, cancel, async (gesture) => {
			await gesture.approvedKey(recipient);
			sent = true;
		}),
	).rejects.toMatchObject({ code: "CANCELLED" });
	h.state.storageFailure = true;
	await expect(
		withVerifiedRecipientKeys(
			h.client,
			async () => {
				throw new Error("must not prompt on storage failure");
			},
			async (gesture) => {
				await gesture.approvedKey(recipient);
				sent = true;
			},
		),
	).rejects.toMatchObject({ code: "STORAGE_UNAVAILABLE" });
	expect(sent).toBe(false);
});

test("a coalesced lock/unlock or remove/re-add changes the Rust scope and prevents submission", async () => {
	const h = harness();
	let sent = false;
	await expect(
		withVerifiedRecipientKeys(h.client, verify, async (gesture) => {
			await gesture.approvedKey(recipient);
			h.state.scope = "generation-2/epoch-1";
			await gesture.checkActive();
			sent = true;
		}),
	).rejects.toMatchObject({ code: "CANCELLED" });
	expect(sent).toBe(false);
	expect(h.listeners.size).toBe(0);
});

test("switching Accounts cancels a suspended prompt, even if the user switches back", async () => {
	const h = harness();
	let sent = false;
	await expect(
		withVerifiedRecipientKeys(
			h.client,
			async (_recipient, _changed, confirm, signal) => {
				h.change({ accountId: "account-b" });
				h.change({ accountId: "account-a" });
				expect(signal.aborted).toBe(true);
				await confirm("independently-received");
			},
			async (gesture) => {
				await gesture.approvedKey(recipient);
				sent = true;
			},
		),
	).rejects.toMatchObject({ code: "CANCELLED" });
	expect(sent).toBe(false);
	expect(h.state.writes).toBe(0);
});

test("Invitation dialog owner release cancels a suspended fingerprint prompt", async () => {
	const h = harness();
	const owner = new AbortController();
	let promptEntered = () => {};
	const entered = new Promise<void>((resolve) => {
		promptEntered = resolve;
	});
	let submitted = false;
	const request = withVerifiedRecipientKeys(
		h.client,
		async (_candidate, _changed, _confirm, signal) => {
			promptEntered();
			await new Promise<void>((_resolve, reject) => {
				signal.addEventListener(
					"abort",
					() => reject(new RuntimeRequestError("CANCELLED", "Dialog closed")),
					{ once: true },
				);
			});
		},
		async (gesture) => {
			await gesture.approvedKey(recipient);
			submitted = true;
		},
		owner.signal,
	);
	await entered;
	owner.abort();
	await expect(request).rejects.toMatchObject({ code: "CANCELLED" });
	expect(submitted).toBe(false);
	expect(h.state.writes).toBe(0);
	expect(h.listeners.size).toBe(0);
});
