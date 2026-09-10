import { describe, expect, test } from "bun:test";
import type { ItemProjection } from "@bittery/client-runtime/protocol";
import { mergeRuntimeItemDraft } from "./use-runtime-item-mutations";

const ITEM: ItemProjection = {
	accountId: "account-1",
	itemId: "item-1",
	vaultId: "vault-1",
	data: {
		category: "login",
		data: { title: "Bank", username: "old-user", password: "old-password" },
	},
	favorite: false,
	status: "authoritative",
	createdAt: "2026-08-30T00:00:00Z",
	updatedAt: "2026-08-30T00:00:00Z",
};

describe("Web Runtime Item mutation adapters", () => {
	test("a title or tag edit preserves imported optional fields across all categories", () => {
		const optional = {
			notes: "extra",
			tags: ["imported"],
			customFields: [
				{ id: "custom", label: "Extra", value: "kept", type: "text" as const },
			],
		};
		const drafts: ItemProjection["data"][] = [
			{
				category: "login",
				data: {
					...optional,
					title: "Login",
					username: "alice",
					urls: ["https://example.test"],
					passwordHistory: [{ password: "old", changedAt: "2026-01-01" }],
				},
			},
			{
				category: "secure-note",
				data: { ...optional, title: "Note", note: "body" },
			},
			{
				category: "credit-card",
				data: {
					...optional,
					title: "Card",
					cardNumber: "4111111111111111",
					cardholderName: "Alice",
				},
			},
			{
				category: "identity",
				data: {
					...optional,
					title: "Identity",
					firstName: "Alice",
					passportNumber: "passport",
				},
			},
			{
				category: "authenticator",
				data: {
					...optional,
					title: "OTP",
					totpSecret: "JBSWY3DPEHPK3PXP",
					totpAlgorithm: "SHA256",
					totpDigits: 8,
					totpPeriod: 60,
				},
			},
		];
		for (const draft of drafts) {
			const item = { ...ITEM, data: draft };
			expect<unknown>(mergeRuntimeItemDraft(item, { title: "Edited" })).toEqual(
				{ ...draft, data: { ...draft.data, title: "Edited" } },
			);
			expect<unknown>(mergeRuntimeItemDraft(item, { tags: [] })).toEqual({
				...draft,
				data: { ...draft.data, tags: [] },
			});
		}
	});
	test("merges a partial edit with Runtime authority before sealing the draft", () => {
		expect(mergeRuntimeItemDraft(ITEM, { password: "new-password" })).toEqual({
			category: "login",
			data: {
				title: "Bank",
				username: "old-user",
				password: "new-password",
			},
		});
	});
});
