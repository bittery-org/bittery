import { describe, expect, test } from "bun:test";
import { createApiClient } from "@bittery/api-contract";
import {
	createWebRotationPlanClient,
	type WebRotationIntent,
} from "./vault-key-rotation-adapter";

const cases: Array<{
	intent: WebRotationIntent;
	suffix: string;
	path: string;
	rejection: string;
}> = [
	{
		intent: {
			kind: "vault-member-removal",
			vaultId: "vault-1",
			userId: "target",
		},
		suffix: "vault_member_removal_rotation_plans",
		path: "/vaults/vault-1/members/target/removal-rotation-plans",
		rejection: "vault_access_denied",
	},
	{
		intent: { kind: "team-leave", teamId: "team-1" },
		suffix: "team_leave_rotation_plans",
		path: "/teams/team-1/leave-rotation-plans",
		rejection: "team_owner_leave_forbidden",
	},
	{
		intent: { kind: "team-member-removal", teamId: "team-1", userId: "target" },
		suffix: "team_member_removal_rotation_plans",
		path: "/teams/team-1/members/target/removal-rotation-plans",
		rejection: "team_management_denied",
	},
];
const plan = {
	id: "plan-1",
	vaultId: "vault-1",
	initiatorUserId: "actor",
	expectedKeyVersion: 2,
	state: "preparing",
	idleExpiresAt: "2026-09-07T12:00:00Z",
	absoluteExpiresAt: "2026-09-08T12:00:00Z",
};
const acceptedPlans = [
	{
		planId: plan.id,
		vaultId: plan.vaultId,
		expectedKeyVersion: plan.expectedKeyVersion,
	},
];
const local = { refresh: async () => {}, markUnavailable: async () => {} };

function adapter(fetch: (request: Request) => Promise<Response>) {
	return createWebRotationPlanClient(
		createApiClient({
			serverUrl: "https://api.example.test",
			supportedApiMajors: [1],
			getAccessToken: () => "session",
			getClientMetadata: () => ({
				id: "client",
				platform: "web",
				version: "0.5.1",
			}),
			fetch: async (request) => fetch(request),
		}),
		local,
	);
}

for (const scenario of cases)
	describe(scenario.intent.kind, () => {
		for (const stage of ["create", "finalize"] as const) {
			const kind = `${stage}_${scenario.suffix}`;
			const run = (client: ReturnType<typeof adapter>) =>
				stage === "create"
					? client.start(scenario.intent, new AbortController().signal)
					: client.finalize(
							{ intent: scenario.intent, plans: acceptedPlans },
							new AbortController().signal,
						);
			const applied =
				stage === "create"
					? { status: "applied", plans: [plan] }
					: {
							status: "applied",
							rotations: [
								{
									planId: plan.id,
									vaultId: plan.vaultId,
									keyVersion: 3,
									rotationId: "rotation-1",
								},
							],
							...(scenario.intent.kind === "vault-member-removal"
								? {}
								: { personalTeamId: "personal-1" }),
						};
			test(`${stage} consumes retained applied outcomes and preserves exact retry identity/body`, async () => {
				const requests: Array<{ id: string | null; body: string }> = [];
				const client = adapter(async (request) => {
					expect(new URL(request.url).pathname).toBe(
						`/api/v1${scenario.path}${stage === "finalize" ? "/finalize" : ""}`,
					);
					requests.push({
						id: request.headers.get("Idempotency-Key"),
						body: await request.text(),
					});
					if (requests.length === 1)
						throw new TypeError("response lost after commit");
					return Response.json({
						kind,
						operationId: request.headers.get("Idempotency-Key"),
						result: applied,
					});
				});
				expect(await run(client)).toEqual(
					stage === "create" ? acceptedPlans : { rotationId: "rotation-1" },
				);
				expect(requests).toHaveLength(2);
				expect(requests[0]?.id).toMatch(/^[0-9a-f-]{36}$/);
				expect(requests[0]).toEqual(requests[1]);
				expect(requests[0]?.body).toBe(
					stage === "create" ? "" : JSON.stringify({ planIds: [plan.id] }),
				);
			});

			test(`${stage} surfaces terminal retained rejection without another attempt`, async () => {
				let attempts = 0;
				const result =
					stage === "create"
						? { status: "rejected", code: scenario.rejection }
						: {
								status: "rejected",
								code: "rotation_plan_stale",
								details: { planId: plan.id, reason: "member_set" },
							};
				const client = adapter(async (request) => {
					attempts++;
					return Response.json({
						kind,
						operationId: request.headers.get("Idempotency-Key"),
						result,
					});
				});
				await expect(run(client)).rejects.toMatchObject({
					name: "RotationOperationRejectedError",
					result,
				});
				expect(attempts).toBe(1);
			});

			for (const mismatch of ["kind", "operationId"])
				test(`${stage} refuses another ${mismatch}`, async () => {
					let attempts = 0;
					const client = adapter(async (request) => {
						attempts++;
						return Response.json({
							kind,
							operationId: request.headers.get("Idempotency-Key"),
							result: applied,
							[mismatch]:
								mismatch === "kind" ? "create_vault" : "other-operation",
						});
					});
					await expect(run(client)).rejects.toThrow(
						"another Operation identity",
					);
					expect(attempts).toBe(1);
				});
		}
		if (scenario.intent.kind !== "vault-member-removal")
			test("zero-Vault departure retains the personal Team result", async () => {
				const client = adapter(async (request) =>
					Response.json({
						kind: `finalize_${scenario.suffix}`,
						operationId: request.headers.get("Idempotency-Key"),
						result: {
							status: "applied",
							rotations: [],
							personalTeamId: "personal-1",
						},
					}),
				);
				expect(
					await client.finalize(
						{ intent: scenario.intent, plans: [] },
						new AbortController().signal,
					),
				).toEqual({ rotationId: "personal-1" });
			});
	});
