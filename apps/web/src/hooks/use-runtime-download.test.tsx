import { expect, mock, test } from "bun:test";
import { createRuntimeClient } from "@bittery/client-runtime/client";
import { RuntimeProvider } from "@bittery/client-runtime/react";
import { createFakeRuntimeTransport } from "@bittery/client-runtime/testing";
import type { AtomicAttachmentDownloadSink } from "@bittery/client-runtime/web";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, useState } from "react";
import { createRoot } from "react-dom/client";

let sink: AtomicAttachmentDownloadSink | undefined;
let releasedUploads = 0;
let releasedDownloads = 0;
const currentSink = () => sink;
mock.module("@/lib/crypto", () => ({
	attachmentDownloadSinks: {
		captureScope: () => ({}),
		release: async () => {
			releasedDownloads++;
		},
		grant(input: { sink: AtomicAttachmentDownloadSink }) {
			sink = input.sink;
			return "download-grant";
		},
	},
	attachmentUploadSources: {
		captureScope: () => ({}),
		grant: () => "upload-grant",
		release: async () => {
			releasedUploads++;
		},
	},
}));
mock.module("@bittery/shared/api", () => ({ useApiClient: () => ({}) }));
mock.module("@bittery/shared/api-query", () => ({
	apiQueries: {
		billing: {
			entitlements: () => ({
				queryKey: ["entitlements"],
				queryFn: async () => ({ limits: { attachmentMaxFileSizeBytes: 1024 } }),
			}),
		},
	},
}));
const { useRuntimeItemAttachments } = await import(
	"./use-runtime-item-attachments"
);

for (const departure of [
	"none",
	"lock",
	"account",
	"item",
	"unmount",
	"upload",
	"after-unmount",
] as const)
	test(`foreground Download never caches plaintext or publishes after ${departure}`, async () => {
		sink = undefined;
		releasedUploads = 0;
		releasedDownloads = 0;
		const transport = createFakeRuntimeTransport();
		const runtime = createRuntimeClient({ transport });
		const release = runtime.session().subscribe(() => {});
		await transport.settled();
		const publish = (
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
							unlockCapabilities: {
								password: false,
								desktop: false,
								signIn: false,
							},
							displayIdentity: {
								email: "a@example.test",
								name: "Test Account",
								teamName: null,
								teamAvatarUrl: null,
								serverUrl: "https://vault.example.test",
								secretKeyHint: "A3-A••••",
							},
						},
					],
				},
			});
			runtime.selectAccount(accountId);
		};
		publish();
		const query = new QueryClient();
		let upload:
			| ReturnType<typeof useRuntimeItemAttachments>["upload"]
			| undefined;
		let download:
			| ReturnType<typeof useRuntimeItemAttachments>["download"]
			| undefined;
		let changeItem = () => {};
		function Host() {
			const [itemId, setItemId] = useState("item");
			changeItem = () => setItemId("other-item");
			const attachments = useRuntimeItemAttachments({
				id: itemId,
				vaultId: "vault",
				accountId: "account",
			});
			download = attachments.download;
			upload = attachments.upload;
			return null;
		}
		const root = createRoot(document.createElement("div"));
		let mounted = true;
		try {
			await act(async () =>
				root.render(
					<QueryClientProvider client={query}>
						<RuntimeProvider client={runtime}>
							<Host />
						</RuntimeProvider>
					</QueryClientProvider>,
				),
			);
			if (departure === "after-unmount") {
				await act(async () => root.unmount());
				mounted = false;
			}
			const downloading =
				departure === "upload"
					? upload?.mutateAsync(new File(["private file bytes"], "private.txt"))
					: download?.mutateAsync({
							id: "attachment",
							accountId: "account",
							itemId: "item",
							vaultId: "vault",
							name: "private.txt",
							fileSize: 3,
							uploadedBy: "user",
							createdAt: "2026-01-01",
						});
			const outcome = downloading?.catch((error: Error) => error.name);
			await act(async () => {
				await transport.settled();
			});
			if (departure !== "upload") {
				await currentSink()?.write(new Uint8Array([1, 2, 3]));
				await currentSink()?.commit();
			}
			await act(async () => {
				if (departure === "item") changeItem();
				if (departure === "unmount") {
					root.unmount();
					mounted = false;
				}
				if (departure === "lock") {
					publish("locked");
					publish();
				}
				if (departure === "account") {
					publish("unlocked", "other-account");
					publish();
				}
			});
			if (departure === "after-unmount") {
				expect(sink).toBeUndefined();
				expect(
					transport.calls.filter((call) => call.type === "request"),
				).toEqual([]);
			}
			let value: unknown;
			await act(async () => {
				transport.answer({
					type: "succeeded",
					value:
						departure === "upload"
							? {
									type: "attachmentUploaded",
									attachmentId: "attachment",
									replicaRevision: "2",
								}
							: {
									type: "attachmentDownloaded",
									accountId: "account",
									attachmentId: "attachment",
								},
				});
				value = await outcome;
			});
			if (departure === "upload")
				expect(value).toEqual({
					attachmentId: "attachment",
					replicaRevision: "2",
				});
			else if (departure === "none")
				expect(value).toEqual({
					bytes: new Uint8Array([1, 2, 3]),
					fileName: "private.txt",
				});
			else expect(value).toBe("AbortError");
			expect(releasedUploads).toBe(departure === "upload" ? 1 : 0);
			expect(releasedDownloads).toBe(
				departure !== "upload" && departure !== "after-unmount" ? 1 : 0,
			);
			expect(
				query
					.getMutationCache()
					.getAll()
					.map((mutation) => mutation.state.data)
					.filter(Boolean),
			).toEqual([]);
			expect(
				query
					.getMutationCache()
					.getAll()
					.map((mutation) => mutation.state.variables),
			).toEqual([]);
		} finally {
			if (mounted) await act(async () => root.unmount());
			query.clear();
			release();
			await runtime.close();
		}
	});
