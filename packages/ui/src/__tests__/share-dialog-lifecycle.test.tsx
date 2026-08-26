import { afterEach, describe, expect, mock, test } from "bun:test";
import type { DecryptedItem } from "@bittery/shared/types";
import {
	act,
	cleanup,
	fireEvent,
	render,
	screen,
} from "@testing-library/react";
import { useState } from "react";
import type { DeliveredShareResult } from "../components/sharing/share-item-dialog";

mock.module("@bittery/i18n/react", () => ({
	useI18n: () => ({
		m: new Proxy(
			{},
			{
				get: (_target, key) => () => String(key),
			},
		),
	}),
}));

const { ShareItemDialog } = await import(
	"../components/sharing/share-item-dialog"
);

const item = {
	id: "item-a",
	title: "Item A",
	category: "login",
} as DecryptedItem;

function deferred<T>() {
	let resolve!: (value: T) => void;
	const promise = new Promise<T>((next) => {
		resolve = next;
	});
	return { promise, resolve };
}

afterEach(cleanup);

describe("Share dialog delivery lifecycle", () => {
	test("closing before resolution leaves the durable result unacknowledged", async () => {
		const creation = deferred<{
			accountId: string;
			itemId: string;
			operationId: string;
			shareUrl: string;
		}>();
		const acknowledge = mock(async () => undefined);
		function Host() {
			const [open, setOpen] = useState(true);
			return (
				<ShareItemDialog
					accountId="account-a"
					item={item}
					onCreateShare={() => creation.promise}
					onAcknowledgeShareResult={acknowledge}
					open={open}
					onOpenChange={setOpen}
				/>
			);
		}
		render(<Host />);
		fireEvent.click(screen.getByTestId("share-create-button"));
		fireEvent.click(
			screen.getByRole("button", {
				name: "sharing_item_dialog_confirm_action_confirm",
			}),
		);
		fireEvent.click(
			screen.getByRole("button", {
				name: "sharing_item_dialog_action_cancel",
			}),
		);

		await act(async () => {
			creation.resolve({
				accountId: "account-a",
				itemId: "item-a",
				operationId: "operation-a",
				shareUrl: "https://share.test/a#secret-a",
			});
			await creation.promise;
		});

		expect(screen.queryByTestId("share-link-value")).toBeNull();
		expect(acknowledge).not.toHaveBeenCalled();
	});

	test("an open result is rendered before acknowledgement", async () => {
		let renderedAtAcknowledgement: string | null = null;
		let acknowledgedIdentity: { accountId: string; itemId: string } | null =
			null;
		const getAcknowledgedIdentity = () => acknowledgedIdentity;
		const acknowledge = mock(async (result: DeliveredShareResult) => {
			acknowledgedIdentity = {
				accountId: result.accountId,
				itemId: result.itemId,
			};
			renderedAtAcknowledgement = screen
				.getByTestId("share-link-value")
				.getAttribute("value");
		});
		render(
			<ShareItemDialog
				accountId="account-a"
				item={item}
				onCreateShare={async () => ({
					accountId: "account-a",
					itemId: "item-a",
					operationId: "operation-a",
					shareUrl: "https://share.test/a#secret-a",
				})}
				onAcknowledgeShareResult={acknowledge}
				open
				onOpenChange={() => undefined}
			/>,
		);
		fireEvent.click(screen.getByTestId("share-create-button"));
		await act(async () => {
			fireEvent.click(
				screen.getByRole("button", {
					name: "sharing_item_dialog_confirm_action_confirm",
				}),
			);
		});

		expect(String(renderedAtAcknowledgement)).toBe(
			"https://share.test/a#secret-a",
		);
		expect(getAcknowledgedIdentity()).toEqual({
			accountId: "account-a",
			itemId: "item-a",
		});
	});

	test("a result for Account and Item A never renders or acknowledges under B", async () => {
		const creation = deferred<{
			accountId: string;
			itemId: string;
			operationId: string;
			shareUrl: string;
		}>();
		const acknowledgements: Array<{ accountId: string; operationId: string }> =
			[];
		function Host() {
			const [scope, setScope] = useState({
				accountId: "account-a",
				item: item,
			});
			return (
				<>
					<button
						type="button"
						onClick={() =>
							setScope({
								accountId: "account-b",
								item: { ...item, id: "item-b", title: "Item B" },
							})
						}
					>
						select-b
					</button>
					<ShareItemDialog
						accountId={scope.accountId}
						item={scope.item}
						onCreateShare={() => creation.promise}
						onAcknowledgeShareResult={(result) => {
							acknowledgements.push({
								accountId: scope.accountId,
								operationId: result.operationId,
							});
							return Promise.resolve();
						}}
						open
						onOpenChange={() => undefined}
					/>
				</>
			);
		}
		render(<Host />);
		fireEvent.click(screen.getByTestId("share-create-button"));
		fireEvent.click(
			screen.getByRole("button", {
				name: "sharing_item_dialog_confirm_action_confirm",
			}),
		);
		fireEvent.click(
			screen.getByRole("button", { name: "select-b", hidden: true }),
		);
		await act(async () => {
			creation.resolve({
				accountId: "account-a",
				itemId: "item-a",
				operationId: "operation-a",
				shareUrl: "https://share.test/a#secret-a",
			});
			await creation.promise;
		});

		expect(
			screen.queryByDisplayValue("https://share.test/a#secret-a"),
		).toBeNull();
		expect(acknowledgements).toEqual([]);
	});

	test("a keyed A result survives B and resumes with A identity", async () => {
		const creation = deferred<DeliveredShareResult>();
		const resultA = {
			accountId: "account-a",
			itemId: "item-a",
			operationId: "operation-a",
			shareUrl: "https://share.test/a#secret-a",
		};
		const acknowledgements: Array<{
			accountId: string;
			itemId: string;
			renderedValue: string | null;
		}> = [];

		function Host() {
			const [scope, setScope] = useState({
				accountId: "account-a",
				item,
				resumableResult: null as DeliveredShareResult | null,
			});
			return (
				<>
					<button
						type="button"
						onClick={() =>
							setScope({
								accountId: "account-b",
								item: { ...item, id: "item-b", title: "Item B" },
								resumableResult: null,
							})
						}
					>
						select-b
					</button>
					<button
						type="button"
						onClick={() =>
							setScope({
								accountId: "account-a",
								item,
								resumableResult: resultA,
							})
						}
					>
						resume-a
					</button>
					<ShareItemDialog
						key={`${scope.accountId}:${scope.item.id}`}
						accountId={scope.accountId}
						item={scope.item}
						onCreateShare={() => creation.promise}
						onAcknowledgeShareResult={(result) => {
							acknowledgements.push({
								accountId: result.accountId,
								itemId: result.itemId,
								renderedValue: screen
									.getByTestId("share-link-value")
									.getAttribute("value"),
							});
							return Promise.resolve();
						}}
						resumableResult={scope.resumableResult}
						open
						onOpenChange={() => undefined}
					/>
				</>
			);
		}

		render(<Host />);
		fireEvent.click(screen.getByTestId("share-create-button"));
		fireEvent.click(
			screen.getByRole("button", {
				name: "sharing_item_dialog_confirm_action_confirm",
			}),
		);
		fireEvent.click(
			screen.getByRole("button", { name: "select-b", hidden: true }),
		);
		await act(async () => {
			creation.resolve(resultA);
			await creation.promise;
		});

		expect(
			screen.queryByDisplayValue("https://share.test/a#secret-a"),
		).toBeNull();
		expect(acknowledgements).toEqual([]);

		fireEvent.click(
			screen.getByRole("button", { name: "resume-a", hidden: true }),
		);
		await screen.findByDisplayValue("https://share.test/a#secret-a");
		expect(acknowledgements).toEqual([
			{
				accountId: "account-a",
				itemId: "item-a",
				renderedValue: "https://share.test/a#secret-a",
			},
		]);
	});
});
