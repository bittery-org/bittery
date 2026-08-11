import { describe, expect, test } from "bun:test";
import { apiQueryKeys } from "@bittery/shared/api-query";
import type { QueryClient } from "@tanstack/react-query";
import {
	createQueryInvalidator,
	getQueryKeysForEvent,
} from "../query-invalidation";

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

	test("uses canonical REST keys for travel mode and item invalidation", async () => {
		const { queryClient, invalidated } = makeQueryClient();
		const invalidator = createQueryInvalidator({ queryClient });

		expect(
			getQueryKeysForEvent({
				id: "event-1",
				type: "travel_mode_updated",
				entityId: "user-1",
				entityType: "user",
				vaultId: null,
				version: 1,
				clientId: null,
				userId: "user-1",
				timestamp: Date.now(),
			}),
		).toContainEqual(apiQueryKeys.travelMode);

		await invalidator.invalidateItem("item-123", "vault-123");

		expect(invalidated).toEqual([
			apiQueryKeys.items.inVault("vault-123"),
			apiQueryKeys.items.get("item-123"),
			apiQueryKeys.items.all,
		]);
	});
});
