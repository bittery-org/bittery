import type {
	RuntimeClient,
	RuntimeRotationCompletion,
	RuntimeRotationInspection,
} from "@bittery/client-runtime/client";
import { useRuntimeClient } from "@bittery/client-runtime/react";
import type { VerifiedRecipientGesture } from "@/lib/recipient-key-verification";
import { useRecipientKeyVerification } from "@/providers/recipient-key-verification-provider";

type TeamLeaveClient = Pick<
	RuntimeClient,
	"prepareRotation" | "inspectRotation" | "completeRotation"
>;
type Verification = {
	run<T>(
		task: (gesture: VerifiedRecipientGesture) => Promise<T>,
		ownerSignal?: AbortSignal,
	): Promise<T>;
};

export interface TeamLeaveProgress {
	accountId: string;
	startOperationId: string;
	result: RuntimeRotationInspection | { type: "inspectionRequired" };
}

/** The caller owns cancellation; Core owns the retained Operation and retry duty. */
export function useRuntimeTeamLeave() {
	const client = useRuntimeClient();
	const verification = useRecipientKeyVerification();
	return {
		start: (teamId: string, signal: AbortSignal) =>
			runRuntimeTeamLeave(client, verification, teamId, signal),
		inspect: (
			accountId: string,
			startOperationId: string,
			signal: AbortSignal,
		) =>
			inspectRuntimeTeamLeave(
				client,
				verification,
				accountId,
				startOperationId,
				signal,
			),
	};
}

export async function runRuntimeTeamLeave(
	client: TeamLeaveClient,
	verification: Verification,
	teamId: string,
	ownerSignal?: AbortSignal,
): Promise<TeamLeaveProgress> {
	const { accountId, result } = await verification.run(async (gesture) => {
		const accountId = gesture.accountId;
		const result = await client.prepareRotation(
			{ accountId, intent: { type: "teamLeave", teamId } },
			{ signal: gesture.signal },
		);
		return { accountId, result };
	}, ownerSignal);
	if (result.type !== "rotationPrepared") {
		return {
			accountId,
			startOperationId:
				result.type === "rotationStartPending" ? result.startOperationId : "",
			result,
		};
	}
	return completePrepared(client, verification, accountId, result, ownerSignal);
}

export async function inspectRuntimeTeamLeave(
	client: TeamLeaveClient,
	verification: Verification,
	accountId: string,
	startOperationId: string,
	ownerSignal?: AbortSignal,
): Promise<TeamLeaveProgress> {
	const result = await client.inspectRotation(
		{ accountId, startOperationId },
		{ signal: ownerSignal },
	);
	if (result.type === "rotationPrepared") {
		return completePrepared(
			client,
			verification,
			accountId,
			result,
			ownerSignal,
		);
	}
	return { accountId, startOperationId, result };
}

async function completePrepared(
	client: TeamLeaveClient,
	verification: Verification,
	accountId: string,
	prepared: Extract<RuntimeRotationInspection, { type: "rotationPrepared" }>,
	ownerSignal?: AbortSignal,
): Promise<TeamLeaveProgress> {
	const selection = prepared.selection;
	await verification.run(async (gesture) => {
		if (gesture.accountId !== accountId)
			throw new TeamLeaveFailure("accountChanged");
		for (const candidate of selection.candidates) {
			const approved = await gesture.approvedKey({
				recipientUserId: candidate.userId,
				publicKey: candidate.publicKey,
			});
			if (approved !== candidate.publicKey)
				throw new TeamLeaveFailure("keyChanged");
		}
		await gesture.checkActive();
	}, ownerSignal);
	// Applied finalize revokes the old Session. The gesture's internal signal has ended;
	// the dialog-owned signal remains live through private completion admission.
	let result: RuntimeRotationCompletion;
	try {
		result = await client.completeRotation(
			{ accountId, selection },
			{ signal: ownerSignal },
		);
	} catch (error) {
		if (ownerSignal?.aborted) throw error;
		try {
			const inspected = await client.inspectRotation(
				{ accountId, startOperationId: selection.startOperationId },
				{ signal: ownerSignal },
			);
			return {
				accountId,
				startOperationId: selection.startOperationId,
				result: inspected,
			};
		} catch {
			return {
				accountId,
				startOperationId: selection.startOperationId,
				result: { type: "inspectionRequired" },
			};
		}
	}
	return { accountId, startOperationId: selection.startOperationId, result };
}

export type TeamLeaveFailureCode = "accountChanged" | "keyChanged";
export class TeamLeaveFailure extends Error {
	constructor(readonly code: TeamLeaveFailureCode) {
		super(code);
	}
}
