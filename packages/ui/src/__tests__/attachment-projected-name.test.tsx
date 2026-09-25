import { afterEach, expect, mock, test } from "bun:test";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
	act,
	cleanup,
	fireEvent,
	render,
	screen,
} from "@testing-library/react";
import { useState } from "react";
import type {
	AttachmentItem,
	ItemAttachmentsProps,
} from "../components/vault/item-detail/item-attachments";

mock.module("@bittery/i18n/react", () => ({
	useI18n: () => ({
		m: new Proxy({}, { get: (_target, key) => () => String(key) }),
	}),
}));
const { ItemAttachments } = await import(
	"../components/vault/item-detail/item-attachments"
);

const attachment: AttachmentItem = {
	id: "attachment-1",
	accountId: "account-1",
	itemId: "item-1",
	vaultId: "vault-1",
	name: "old.txt",
	fileSize: 10,
	uploadedBy: "user-1",
	createdAt: "2026-09-01T00:00:00Z",
};
const props: Omit<ItemAttachmentsProps, "attachments"> = {
	isLoading: false,
	attachmentMaxFileSizeBytes: null,
	canEdit: true,
	onDecryptMeta: async (item) => ({ name: item.name ?? "legacy.txt" }),
	onUpload: async () => undefined,
	onDownload: async () => ({
		bytes: new Uint8Array(),
		fileName: "download.txt",
	}),
	onRename: async () => undefined,
	onDelete: async () => undefined,
	getUploadErrorCode: () => "unknown",
};
afterEach(cleanup);

test("a renamed projected Attachment keeps its current name when the pane remounts", async () => {
	const queryClient = new QueryClient({
		defaultOptions: { queries: { staleTime: 60_000 } },
	});
	function Host() {
		const [name, setName] = useState("old.txt");
		const [open, setOpen] = useState(true);
		return (
			<QueryClientProvider client={queryClient}>
				<button type="button" onClick={() => setOpen(!open)}>
					toggle pane
				</button>
				{open && (
					<ItemAttachments
						{...props}
						attachments={[{ ...attachment, name }]}
						onRename={async (_id, next) => {
							setName(next);
						}}
					/>
				)}
			</QueryClientProvider>
		);
	}
	render(<Host />);
	await screen.findByTitle("old.txt");
	fireEvent.click(
		screen.getByTitle(
			"vaults_detail_items_attachments_action_rename_attachment",
		),
	);
	fireEvent.change(screen.getByRole("textbox"), {
		target: { value: "new.txt" },
	});
	await act(async () => {
		fireEvent.keyDown(screen.getByRole("textbox"), { key: "Enter" });
	});
	await screen.findByTitle("new.txt");
	fireEvent.click(screen.getByText("toggle pane"));
	fireEvent.click(screen.getByText("toggle pane"));
	expect(screen.queryByTitle("new.txt")).not.toBeNull();
	expect(screen.queryByTitle("old.txt")).toBeNull();
	queryClient.clear();
});

test("retiring a projected Attachment leaves no decrypted name in the query cache", async () => {
	const queryClient = new QueryClient({
		defaultOptions: { queries: { staleTime: 60_000 } },
	});
	const decrypt = mock(async () => ({ name: "obsolete fallback.txt" }));
	const view = (attachments: AttachmentItem[]) => (
		<QueryClientProvider client={queryClient}>
			<ItemAttachments
				{...props}
				attachments={attachments}
				onDecryptMeta={decrypt}
			/>
		</QueryClientProvider>
	);
	const mounted = render(view([attachment]));
	expect(screen.queryByTitle("old.txt")).not.toBeNull();
	// Lock retires the Items projection; Quick Unlock publishes fresh authority later.
	mounted.rerender(view([]));
	expect(screen.queryByTitle("old.txt")).toBeNull();
	expect(queryClient.getQueriesData({ queryKey: ["attachment"] })).toEqual([]);
	mounted.rerender(view([{ ...attachment, name: "after-unlock.txt" }]));
	expect(screen.queryByTitle("after-unlock.txt")).not.toBeNull();
	expect(screen.queryByTitle("old.txt")).toBeNull();
	expect(decrypt).not.toHaveBeenCalled();
	queryClient.clear();
});

test("hosts without projected names retain metadata decryption and rename presentation", async () => {
	const queryClient = new QueryClient();
	const rename = mock(async () => undefined);
	render(
		<QueryClientProvider client={queryClient}>
			<ItemAttachments
				{...props}
				attachments={[{ ...attachment, name: undefined }]}
				onRename={rename}
			/>
		</QueryClientProvider>,
	);
	await screen.findByTitle("legacy.txt");
	fireEvent.click(
		screen.getByTitle(
			"vaults_detail_items_attachments_action_rename_attachment",
		),
	);
	fireEvent.change(screen.getByRole("textbox"), {
		target: { value: "legacy-renamed.txt" },
	});
	await act(async () => {
		fireEvent.keyDown(screen.getByRole("textbox"), { key: "Enter" });
	});
	expect(rename).toHaveBeenCalledWith("attachment-1", "legacy-renamed.txt");
	expect(screen.queryByTitle("legacy-renamed.txt")).not.toBeNull();
	queryClient.clear();
});

test("Attachment selection captures before the picker and retains that upload through confirmation and rerender", async () => {
	const events: string[] = [];
	const queryClient = new QueryClient();
	const view = (generation: string) => (
		<QueryClientProvider client={queryClient}>
			<ItemAttachments
				{...props}
				attachments={[]}
				onPrepareUpload={() => {
					events.push(`capture-${generation}`);
					return async (file) => {
						events.push(`upload-${generation}-${file.name}`);
					};
				}}
				onUpload={async () => {
					events.push("unscoped-upload");
				}}
			/>
		</QueryClientProvider>
	);
	const mounted = render(view("old"));
	const picker =
		mounted.container.querySelector<HTMLInputElement>('input[type="file"]');
	if (!picker) throw new Error("Attachment picker missing");
	picker.click = () => {
		events.push("picker");
	};
	fireEvent.click(
		screen.getByText("vaults_detail_items_attachments_action_attach_file"),
	);
	expect(events).toEqual(["capture-old", "picker"]);
	mounted.rerender(view("replacement"));
	const file = new File(["private"], "selected.txt", { type: "text/plain" });
	fireEvent.change(picker, { target: { files: [file] } });
	fireEvent.change(screen.getByRole("textbox"), {
		target: { value: "display.txt" },
	});
	await act(async () => {
		fireEvent.click(
			screen.getByText("vaults_detail_items_attachments_action_upload"),
		);
	});
	expect(events).toEqual(["capture-old", "picker", "upload-old-selected.txt"]);
	fireEvent.click(
		screen.getByText("vaults_detail_items_attachments_action_attach_file"),
	);
	expect(events.slice(-2)).toEqual(["capture-replacement", "picker"]);
	queryClient.clear();
});
