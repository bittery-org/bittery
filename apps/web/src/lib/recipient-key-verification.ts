import {
	type RuntimeClient,
	RuntimeRequestError,
} from "@bittery/client-runtime/client";

export type RecipientKey = Pick<
	Parameters<RuntimeClient["verifiedRecipientKey"]>[0],
	"recipientUserId" | "publicKey"
> & { label?: string };
type VerificationClient = Pick<
	RuntimeClient,
	| "session"
	| "recipientKeyScope"
	| "verifyRecipientKey"
	| "verifiedRecipientKey"
>;
export type RecipientPrompt = (
	recipient: RecipientKey,
	changed: boolean,
	verify: (fingerprint: string) => Promise<void>,
	signal: AbortSignal,
) => Promise<void>;
export interface VerifiedRecipientGesture {
	readonly accountId: string;
	readonly signal: AbortSignal;
	approvedKey(recipient: RecipientKey): Promise<string>;
	checkActive(): Promise<void>;
}

/** One captured Account generation for the entire gesture, including its final HTTP submission. */
export async function withVerifiedRecipientKeys<T>(
	client: VerificationClient,
	prompt: RecipientPrompt,
	task: (gesture: VerifiedRecipientGesture) => Promise<T>,
	ownerSignal?: AbortSignal,
): Promise<T> {
	const session = client.session();
	const initial = session.getSnapshot();
	if (initial.state !== "unlocked" || !initial.accountId) throw cancelled();
	const accountId = initial.accountId;
	const controller = new AbortController();
	const retireOwner = () => controller.abort();
	ownerSignal?.addEventListener("abort", retireOwner, { once: true });
	if (ownerSignal?.aborted) controller.abort();
	const options = { signal: controller.signal };
	const assertActive = () => {
		const current = session.getSnapshot();
		if (current.state !== "unlocked" || current.accountId !== accountId)
			controller.abort();
		if (controller.signal.aborted) throw cancelled();
	};
	const unsubscribe = session.subscribe(() => {
		const current = session.getSnapshot();
		if (current.state !== "unlocked" || current.accountId !== accountId)
			controller.abort();
	});
	try {
		assertActive();
		const { scope } = await client.recipientKeyScope({ accountId }, options);
		const checkActive = async () => {
			assertActive();
			const current = await client.recipientKeyScope({ accountId }, options);
			if (current.scope !== scope) controller.abort();
			assertActive();
		};
		await checkActive();
		const result = await task({
			accountId,
			signal: controller.signal,
			checkActive,
			async approvedKey(recipient) {
				// Copy the exact candidate before a prompt can suspend this call.
				const input = {
					accountId,
					scope,
					recipientUserId: recipient.recipientUserId,
					publicKey: recipient.publicKey,
				};
				await checkActive();
				try {
					const result = await client.verifiedRecipientKey(input, options);
					await checkActive();
					return result.publicKey;
				} catch (error) {
					if (
						!(error instanceof RuntimeRequestError) ||
						(error.code !== "RECIPIENT_KEY_UNVERIFIED" &&
							error.code !== "RECIPIENT_KEY_CHANGED")
					)
						throw error;
					await prompt(
						{ ...input, label: recipient.label },
						error.code === "RECIPIENT_KEY_CHANGED",
						async (expectedFingerprint) => {
							await checkActive();
							await client.verifyRecipientKey(
								{ ...input, expectedFingerprint },
								options,
							);
							await checkActive();
						},
						controller.signal,
					);
					await checkActive();
					const result = await client.verifiedRecipientKey(input, options);
					await checkActive();
					return result.publicKey;
				}
			},
		});
		await checkActive();
		return result;
	} finally {
		controller.abort();
		unsubscribe();
		ownerSignal?.removeEventListener("abort", retireOwner);
	}
}

function cancelled() {
	return new RuntimeRequestError(
		"CANCELLED",
		"Recipient verification gesture is no longer active",
	);
}
