import { afterEach, expect, mock, test } from "bun:test";
import {
	act,
	cleanup,
	fireEvent,
	render,
	screen,
} from "@testing-library/react";
import type { CreditCardFormData } from "../components/vault/item-categories/credit-card-form";

mock.module("@bittery/i18n/react", () => ({
	useI18n: () => ({
		m: new Proxy({}, { get: (_target, key) => () => String(key) }),
	}),
}));
const { default: ItemDetail } = await import("../components/vault/item-detail");
afterEach(cleanup);

test("an imported Card with no expiry date renders its available fields", () => {
	render(
		<ItemDetail
			category="credit-card"
			data={{
				title: "Sparse imported card",
				cardNumber: "4111111111111111",
				billingAddress: "Imported billing address",
			}}
		/>,
	);
	expect(screen.getByText("Sparse imported card")).toBeTruthy();
	expect(screen.getByText("Imported billing address")).toBeTruthy();
});

test("an imported Card with no optional card fields renders without inventing values", () => {
	render(
		<ItemDetail category="credit-card" data={{ title: "Title-only card" }} />,
	);
	expect(screen.getByText("Title-only card")).toBeTruthy();
	expect(screen.queryByText("Invalid Date")).toBeNull();
});

const { CreditCardForm } = await import(
	"../components/vault/item-categories/credit-card-form"
);

const { EditItemSheet } = await import("../components/vault/edit-item-sheet");

test("a sparse imported Card can save a title edit without requiring absent optional fields", async () => {
	const onSubmit = mock(async (_data: CreditCardFormData) => {});
	render(
		<EditItemSheet
			open
			onOpenChange={() => {}}
			item={{
				category: "credit-card",
				vaultId: "vault",
				title: "Imported card",
				cardNumber: "4111111111111111",
				billingAddress: "Imported billing address",
			}}
			onUpdateItem={onSubmit}
		/>,
	);
	fireEvent.change(document.querySelector("#title") as HTMLInputElement, {
		target: { value: "Edited imported card" },
	});
	const form = document.querySelector("form");
	if (!form) throw new Error("Card form is missing");
	expect(form.checkValidity()).toBe(true);
	await act(async () => form.requestSubmit());
	const saved = onSubmit.mock.calls[0]?.[0];
	expect(saved).toBeDefined();
	expect(JSON.parse(JSON.stringify(saved))).toEqual({
		title: "Edited imported card",
		cardNumber: "4111111111111111",
		billingAddress: "Imported billing address",
	});
	expect(onSubmit).toHaveBeenCalledWith(
		expect.objectContaining({
			title: "Edited imported card",
			cardNumber: "4111111111111111",
			billingAddress: "Imported billing address",
		}),
	);
});

test("new Card creation still requires its original four card fields", async () => {
	const onSubmit = mock(async () => {});
	const { container } = render(
		<CreditCardForm
			initialData={{ title: "New card" }}
			selectedVaultId="vault"
			onSubmit={onSubmit}
			onCancel={() => {}}
		/>,
	);
	const form = container.querySelector("form");
	if (!form) throw new Error("Card form is missing");
	for (const field of ["cardholderName", "cardNumber", "expiryDate", "cvv"]) {
		expect((form.querySelector(`#${field}`) as HTMLInputElement).required).toBe(
			true,
		);
	}
	expect(form.checkValidity()).toBe(false);
	await act(async () => form.requestSubmit());
	expect(onSubmit).not.toHaveBeenCalled();
});
