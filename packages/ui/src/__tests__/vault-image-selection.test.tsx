import { afterEach, expect, mock, test } from "bun:test";
import { cleanup, fireEvent, render } from "@testing-library/react";

mock.module("@bittery/i18n/react", () => ({
	useI18n: () => ({
		m: new Proxy({}, { get: (_target, key) => () => String(key) }),
	}),
}));
const { CreateVaultDialog } = await import(
	"../components/vault/create-vault-dialog"
);
afterEach(cleanup);

test("image picker keeps its pre-dialog capability scope through a host rerender", () => {
	const selected: string[] = [];
	const prepare = (generation: string) => (accountId: string) => {
		selected.push(`capture:${accountId}:${generation}`);
		return (file: File) => {
			selected.push(`file:${generation}:${file.name}`);
		};
	};
	const props = {
		open: true,
		onOpenChange: () => {},
		onSubmit: async () => {},
		accounts: [{ accountId: "account", email: "a@example.test" }],
		defaultAccountId: "account",
	};
	const view = render(
		<CreateVaultDialog {...props} prepareImageSelection={prepare("old")} />,
	);
	const input = document.querySelector<HTMLInputElement>('input[type="file"]');
	if (!input) throw new Error("Image picker missing");
	input.click = () => {
		selected.push("picker");
	};
	const trigger = input.parentElement?.querySelector(".cursor-pointer");
	if (!trigger) throw new Error("Image picker trigger missing");
	fireEvent.click(trigger);
	expect(selected).toEqual(["capture:account:old", "picker"]);
	view.rerender(
		<CreateVaultDialog {...props} prepareImageSelection={prepare("new")} />,
	);
	const file = new File([new Uint8Array([1])], "image.png", {
		type: "image/png",
	});
	fireEvent.change(input, { target: { files: [file] } });
	expect(selected).toEqual([
		"capture:account:old",
		"picker",
		"file:old:image.png",
	]);
});
