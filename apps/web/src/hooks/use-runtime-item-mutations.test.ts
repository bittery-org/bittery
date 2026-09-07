import { describe, expect, test } from "bun:test";
import type { LoginItemProjection } from "@bittery/client-runtime/protocol";
import { mergeLoginItemDraft, runtimeMoveTargets } from "./use-runtime-item-mutations";

const ITEM: LoginItemProjection = {
	accountId: "account-1",
	itemId: "item-1",
	vaultId: "vault-1",
	title: "Bank",
	username: "old-user",
	password: "old-password",
	favorite: false,
	status: "authoritative",
	createdAt: "2026-08-30T00:00:00Z",
	updatedAt: "2026-08-30T00:00:00Z",
};

describe("Web Runtime Item mutation adapters", () => {
	test("merges a partial edit with Runtime authority before sealing the draft", () => {
		expect(mergeLoginItemDraft(ITEM, { password: "new-password" })).toEqual({
			title: "Bank",
			username: "old-user",
			password: "new-password",
		});
	});

	test("maps only this Account's Runtime Vault projections into move targets", () => {
		expect(
			runtimeMoveTargets("account-1", [
				{
					id: "vault-1",
					name: "Personal",
					type: "personal",
					role: "owner",
				},
			]),
		).toEqual([
			{
				vaultId: "vault-1",
				vaultName: "Personal",
				vaultType: "personal",
				vaultIcon: null,
				vaultImageUrl: null,
				role: "owner",
				accountId: "account-1",
			},
		]);
	});
});
