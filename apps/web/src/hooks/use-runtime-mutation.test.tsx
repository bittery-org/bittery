import { expect, mock, test } from "bun:test";
import { createRuntimeClient } from "@bittery/client-runtime/client";
import { RuntimeProvider } from "@bittery/client-runtime/react";
import { createFakeRuntimeTransport } from "@bittery/client-runtime/testing";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { useUpdateItem } from "./use-runtime-item-mutations";

mock.module("@/providers/i18n-provider", () => ({
	useI18n: () => ({
		m: {
			vaults_detail_items_create_sheet_toast_no_vault_selected: () =>
				"Select an Account",
		},
	}),
}));
const { useAcceptItem } = await import("./use-accept-item");

for (const kind of ["update", "create"] as const)
	for (const departure of [
		"none",
		"lock",
		"account",
		"unmount",
		"after-unmount",
		...(kind === "create" ? ["no-account" as const] : []),
	] as const)
		test(`Item ${kind} leaves no plaintext cache or late success after ${departure}`, async () => {
			const transport = createFakeRuntimeTransport();
			const callerSignals: Array<AbortSignal | undefined> = [];
			const runtime = createRuntimeClient({
				transport: {
					...transport,
					request: (id, json, options) => {
						callerSignals.push(options?.signal);
						return transport.request(id, json, options);
					},
				},
			});
			const release = runtime.session().subscribe(() => {});
			const releaseItems = runtime.items("account").subscribe(() => {});
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
								displayIdentity: { email: "a@example.test" },
							},
						],
					},
				});
				runtime.selectAccount(accountId);
			};
			publish();
			transport.publish({
				type: "items",
				value: {
					accountId: "account",
					replicaRevision: "1",
					vaults: [],
					items: [
						{
							accountId: "account",
							itemId: "item",
							vaultId: "vault",
							data: {
								category: "login",
								data: { title: "Private", password: "old" },
							},
							favorite: false,
							status: "authoritative",
							createdAt: "2026-01-01",
							updatedAt: "2026-01-01",
						},
					],
				},
			});
			const query = new QueryClient();
			let start = (): Promise<unknown> =>
				Promise.reject(new Error("Not mounted"));
			function Host() {
				const update = useUpdateItem();
				const create = useAcceptItem();
				start = () =>
					kind === "update"
						? update.mutateAsync({
								accountId: "account",
								itemId: "item",
								vaultId: "vault",
								data: { password: "new private password" },
							})
						: create.accept({
								accountId: departure === "no-account" ? null : "account",
								vaultId: "vault",
								category: "login",
								data: { title: "Private", password: "new private password" },
							});
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
				let updating: Promise<unknown> | undefined;
				if (departure === "after-unmount") {
					await act(async () => root.unmount());
					mounted = false;
				}
				let successes = 0;
				await act(async () => {
					updating = start().then(
						() => {
							successes += 1;
						},
						(error: Error) => error.name,
					);
				});
				await act(async () => {
					await transport.settled();
					if (departure === "lock") {
						publish("locked");
						publish();
					}
					if (departure === "account") {
						publish("unlocked", "other");
						publish();
					}
					if (departure === "unmount") {
						root.unmount();
						mounted = false;
					}
					if (departure === "after-unmount" || departure === "no-account")
						expect(callerSignals).toEqual([]);
					else expect(callerSignals[0]?.aborted).toBe(departure !== "none");
					transport.answer({
						type: "succeeded",
						value: {
							type: "accepted",
							operationId: "operation",
							itemId: "item",
							replicaRevision: "2",
						},
					});
					const outcome = await updating;
					if (departure !== "none")
						expect(outcome).toBe(
							departure === "no-account" ? "Error" : "AbortError",
						);
				});
				expect(
					query
						.getMutationCache()
						.getAll()
						.map((mutation) => mutation.state.variables),
				).toEqual([]);
				expect(successes).toBe(departure === "none" ? 1 : 0);
				expect(
					transport.calls
						.filter((call) => call.type === "request")
						.map((call) => JSON.parse(call.requestJson).type),
				).toEqual(
					departure === "after-unmount" || departure === "no-account"
						? []
						: [kind === "create" ? "createItem" : "updateItem"],
				);
			} finally {
				if (mounted) await act(async () => root.unmount());
				query.clear();
				release();
				releaseItems();
				await runtime.close();
			}
		});
