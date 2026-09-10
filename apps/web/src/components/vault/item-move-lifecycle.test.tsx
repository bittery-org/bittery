import { expect, mock, test } from "bun:test";
import { createRuntimeClient } from "@bittery/client-runtime/client";
import type { ItemsProjection } from "@bittery/client-runtime/protocol";
import { RuntimeProvider } from "@bittery/client-runtime/react";
import { createFakeRuntimeTransport } from "@bittery/client-runtime/testing";
import { act, type ReactNode } from "react";
import { createRoot } from "react-dom/client";

const navigate = mock((_options: unknown) => {});
const success = mock(() => {});
const errors = mock(() => {});
const messages = new Proxy({}, { get: (_, key) => () => String(key) });
mock.module("@/providers/i18n-provider", () => ({
	useI18n: () => ({ m: messages }),
}));
mock.module("@tanstack/react-router", () => ({ useNavigate: () => navigate }));
mock.module("@/components/vault/favicon", () => ({ Favicon: () => null }));
mock.module("@/hooks/use-runtime-item-attachments", () => ({
	useRuntimeItemAttachments: () => ({ attachments: [], isLoading: false }),
	getRuntimeAttachmentUploadErrorCode: () => "unknown",
}));
const passthrough = ({ children }: { children?: ReactNode }) => <>{children}</>;
const button = ({
	children,
	onClick,
	disabled,
	"data-testid": testId,
}: {
	children?: ReactNode;
	onClick?: () => void;
	disabled?: boolean;
	"data-testid"?: string;
}) => (
	<button
		type="button"
		onClick={onClick}
		disabled={disabled}
		data-testid={testId}
	>
		{children}
	</button>
);
mock.module("@bittery/ui", () => ({
	Button: button,
	cn: () => "",
	toast: { success, error: errors },
	DropdownMenu: passthrough,
	DropdownMenuContent: passthrough,
	DropdownMenuItem: button,
	DropdownMenuSeparator: () => null,
	DropdownMenuTrigger: passthrough,
	ItemAttachments: () => null,
	ItemDetail: () => null,
	PasswordHistoryDialog: () => null,
	ShareHistoryDialog: () => null,
	ShareItemDialog: () => null,
	Command: passthrough,
	CommandInput: () => null,
	CommandList: passthrough,
	CommandItem: ({
		children,
		onSelect,
		disabled,
		value,
	}: {
		children?: ReactNode;
		onSelect: () => void;
		disabled: boolean;
		value: string;
	}) => (
		<button
			type="button"
			disabled={disabled}
			onClick={onSelect}
			data-target={value}
		>
			{children}
		</button>
	),
	Dialog: ({ children, open }: { children?: ReactNode; open: boolean }) =>
		open ? <div data-testid="move-dialog">{children}</div> : null,
	DialogContent: passthrough,
	DialogFooter: passthrough,
	DialogHeader: passthrough,
	DialogTitle: passthrough,
	VaultAvatar: () => null,
}));
const { ItemDetailPane } = await import("./item-detail-pane");
const { useRuntimeItems } = await import("@/hooks/use-runtime-items");

for (const departure of ["projection", "lock", "account", "unmount"] as const)
	test(`Move presentation handles ${departure} before the acceptance response`, async () => {
		navigate.mockClear();
		success.mockClear();
		errors.mockClear();
		const transport = createFakeRuntimeTransport();
		const runtime = createRuntimeClient({ transport });
		const release = runtime.session().subscribe(() => {});
		const releaseItems = runtime.items("account").subscribe(() => {});
		await transport.settled();
		const publishSession = (
			access: "unlocked" | "locked" = "unlocked",
			accountId = "account",
		) => {
			transport.publish({
				type: "runtimeStatus",
				value: {
					accountId: null,
					closed: false,
					revision: "1",
					accounts: [
						{
							accountId,
							access,
							failure: null,
							replicaRevision: "1",
							displayIdentity: { email: "a@example.test" },
						},
					],
				},
			});
			runtime.selectAccount(accountId);
		};
		publishSession();
		const projection = (vaultId: string): ItemsProjection => ({
			accountId: "account",
			replicaRevision: "1",
			vaults: ["source", "target"].map((vaultId) => ({
				vaultId,
				name: vaultId,
				vaultType: "personal",
				role: "owner",
			})),
			items: [
				{
					accountId: "account",
					itemId: "item",
					vaultId,
					data: { category: "login", data: { title: "Moving" } },
					favorite: false,
					status: "authoritative",
					createdAt: "2026-01-01",
					updatedAt: "2026-01-01",
				},
			],
		});
		transport.publish({ type: "items", value: projection("source") });
		function Host() {
			const { items } = useRuntimeItems();
			return (
				<ItemDetailPane
					selectedItem={items.find((item) => item.vaultId === "source") ?? null}
					selectedItemId="item"
					availableTags={[]}
					canWriteItems
					onClose={() => {}}
					onEdit={() => {}}
					onDelete={() => {}}
				/>
			);
		}
		const container = document.createElement("div");
		document.body.append(container);
		const root = createRoot(container);
		let mounted = true;
		const click = async (selector: string) => {
			const element = container.querySelector<HTMLButtonElement>(selector);
			if (!element) throw new Error(`Missing ${selector}`);
			await act(async () => element.click());
		};
		try {
			await act(async () =>
				root.render(
					<RuntimeProvider client={runtime}>
						<Host />
					</RuntimeProvider>,
				),
			);
			await click('[data-testid="item-move-button"]');
			await click('[data-target="target"]');
			const confirm = Array.from(container.querySelectorAll("button")).find(
				(button) =>
					button.textContent === "vaults_detail_items_move_dialog_action_move",
			);
			if (!confirm) throw new Error("Missing Move confirmation");
			await act(async () => confirm.click());
			await transport.settled();
			expect(
				transport.calls.filter((call) => call.type === "request"),
			).toHaveLength(1);
			await act(async () => {
				transport.publish({ type: "items", value: projection("target") });
			});
			expect(container.querySelector('[data-testid="move-dialog"]')).toBeNull();
			await act(async () => {
				if (departure === "lock") {
					publishSession("locked");
					publishSession();
				}
				if (departure === "account") {
					publishSession("unlocked", "other");
					publishSession();
				}
				if (departure === "unmount") {
					root.unmount();
					mounted = false;
				}
				transport.answer({
					type: "succeeded",
					value: {
						type: "accepted",
						operationId: "operation",
						itemId: "item",
						replicaRevision: "2",
					},
				});
				await transport.settled();
			});
			expect(success.mock.calls.length).toBe(
				departure === "projection" ? 1 : 0,
			);
			expect(navigate.mock.calls.length).toBe(
				departure === "projection" ? 1 : 0,
			);
			expect(errors.mock.calls).toEqual([]);
			if (departure === "projection")
				expect(navigate.mock.calls[0]).toEqual([
					{
						to: "/vaults/$vaultId",
						params: { vaultId: "target" },
						search: { itemId: "item" },
					},
				]);
		} finally {
			if (mounted) await act(async () => root.unmount());
			container.remove();
			release();
			releaseItems();
			await runtime.close();
		}
	});
