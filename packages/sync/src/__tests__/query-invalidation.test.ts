import { describe, expect, test } from "bun:test";
import { apiQueryKeys } from "@bittery/shared/api-query";
import type { QueryClient } from "@tanstack/react-query";
import { createQueryInvalidator } from "../query-invalidation";

function makeQueryClient() {
	const invalidated: Array<readonly unknown[]> = [];
	const queryClient = {
		invalidateQueries: async ({
			queryKey,
		}: {
			queryKey: readonly unknown[];
		}) => {
			invalidated.push(queryKey);
		},
	} as unknown as QueryClient;
	return { queryClient, invalidated };
}

describe("query invalidation", () => {
	test("uses canonical REST keys for team queries", async () => {
		const { queryClient, invalidated } = makeQueryClient();
		const invalidator = createQueryInvalidator({ queryClient });

		await invalidator.invalidateTeam();
		await invalidator.invalidateTeamInvitations();

		expect(invalidated).toEqual([
			apiQueryKeys.teams.all,
			apiQueryKeys.teams.all,
			apiQueryKeys.teams.pendingInvitations,
		]);
	});

	test("uses the affected item's canonical share-link key", async () => {
		const { queryClient, invalidated } = makeQueryClient();
		const invalidator = createQueryInvalidator({ queryClient });

		await invalidator.invalidateShare("item-123");

		expect(invalidated).toEqual([apiQueryKeys.shares.list("item-123")]);
	});
});
