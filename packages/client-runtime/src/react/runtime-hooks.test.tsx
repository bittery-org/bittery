import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, render, screen } from "@testing-library/react";
import type { ReactNode } from "react";
import { StrictMode } from "react";
import {
	createRuntimeClient,
	type RuntimeAccepted,
	type RuntimeClient,
} from "../client";
import { createFakeRuntimeTransport } from "../testing";
import {
	RuntimeProvider,
	useCreateItem,
	useRuntimeItems,
	useRuntimeQuickUnlock,
	useRuntimeSession,
	useRuntimeStatus,
} from "./index";

function itemsProjection(accountId: string, title: string) {
	return {
		type: "items" as const,
		value: {
			accountId,
			replicaRevision: "1",
			vaults: [],
			items: [
				{
					itemId: "item-1",
					accountId,
					vaultId: "vault-1",
					data: { category: "login" as const, data: { title } },
					status: "authoritative" as const,
					favorite: false,
					createdAt: "2026-08-23T00:00:00Z",
					updatedAt: "2026-08-23T00:00:00Z",
				},
			],
		},
	};
}

function ItemTitles({ label }: { label: string }) {
	const snapshot = useRuntimeItems("account-1");
	const titles =
		snapshot.state === "ready"
			? snapshot.value.items.map((item) => item.data.data.title).join(",")
			: snapshot.state;
	return <p data-testid={label}>{titles}</p>;
}

function host(client: RuntimeClient, children: ReactNode) {
	return (
		<StrictMode>
			<QueryClientProvider client={new QueryClient()}>
				<RuntimeProvider client={client}>{children}</RuntimeProvider>
			</QueryClientProvider>
		</StrictMode>
	);
}

async function flush(transport: { settled(): Promise<void> }) {
	await act(async () => {
		await transport.settled();
	});
}

describe("sibling consumers of one Account", () => {
	test("open one observation, both receive, and the survivor keeps receiving", async () => {
		const transport = createFakeRuntimeTransport();
		const client = createRuntimeClient({ transport });
		const view = render(
			host(
				client,
				<>
					<ItemTitles label="layout" />
					<ItemTitles label="page" />
				</>,
			),
		);
		await flush(transport);

		expect(transport.openObservations()).toHaveLength(1);
		expect(
			transport.calls.filter((call) => call.type === "observe"),
		).toHaveLength(1);

		await act(async () => {
			transport.publish(itemsProjection("account-1", "first"));
		});
		expect(screen.getByTestId("layout").textContent).toBe("first");
		expect(screen.getByTestId("page").textContent).toBe("first");

		view.rerender(host(client, <ItemTitles label="layout" />));
		await flush(transport);

		await act(async () => {
			transport.publish(itemsProjection("account-1", "second"));
		});
		expect(screen.getByTestId("layout").textContent).toBe("second");
		expect(transport.openObservations()).toHaveLength(1);
		expect(
			transport.calls.filter((call) => call.type === "unobserve"),
		).toHaveLength(0);

		view.unmount();
	});

	test("a rapid remount posts no observe/unobserve pair", async () => {
		const transport = createFakeRuntimeTransport();
		const client = createRuntimeClient({ transport });

		const first = render(host(client, <ItemTitles label="layout" />));
		await flush(transport);
		first.unmount();
		const second = render(host(client, <ItemTitles label="layout" />));
		await flush(transport);

		expect(transport.calls.map((call) => call.type)).toEqual(["observe"]);
		second.unmount();
	});

	test("renders the retained snapshot on a remount inside the grace window", async () => {
		const transport = createFakeRuntimeTransport();
		const client = createRuntimeClient({ transport });

		const first = render(host(client, <ItemTitles label="layout" />));
		await flush(transport);
		await act(async () => {
			transport.publish(itemsProjection("account-1", "first"));
		});
		first.unmount();

		const second = render(host(client, <ItemTitles label="layout" />));
		await flush(transport);
		expect(screen.getByTestId("layout").textContent).toBe("first");
		second.unmount();
	});
});

describe("Device session", () => {
	function SessionState() {
		const session = useRuntimeSession();
		return (
			<p data-testid="session">{`${session.state}:${session.accountId ?? "-"}`}</p>
		);
	}

	test("renders a lock, not an empty vault, for a restored Account", async () => {
		const transport = createFakeRuntimeTransport();
		const client = createRuntimeClient({ transport });
		const view = render(host(client, <SessionState />));
		await flush(transport);

		expect(screen.getByTestId("session").textContent).toBe("loading:-");
		expect(transport.openObservations()[0]?.request).toEqual({
			type: "runtimeStatus",
			accountId: null,
		});

		await act(async () => {
			transport.publish({
				type: "runtimeStatus",
				value: {
					accountId: null,
					accounts: [
						{
							accountId: "account-1",
							access: "locked",
							failure: null,
							replicaRevision: "3",
						},
					],
					closed: false,
					revision: "2",
				},
			});
		});
		expect(screen.getByTestId("session").textContent).toBe("locked:account-1");
		view.unmount();
	});
});

describe("React entrypoint", () => {
	test("has no useEffect and exactly one useSyncExternalStore", () => {
		const joined = readdirSync(new URL(".", import.meta.url))
			.filter((name) => !name.includes(".test."))
			.map((name) => readFileSync(new URL(name, import.meta.url), "utf8"))
			.join("\n")
			// Prose may name what the code must not do.
			.replaceAll(/\/\*[\s\S]*?\*\/|\/\/[^\n]*/g, "");
		expect(joined).not.toMatch(/\buseEffect\b/);
		expect(joined.match(/\buseSyncExternalStore\(/g)).toHaveLength(1);
	});

	test("requires a provider", () => {
		function Bare() {
			useRuntimeStatus();
			return null;
		}
		expect(() => render(<Bare />)).toThrow(/RuntimeProvider/);
	});

	test("drives a request through TanStack Query", async () => {
		const transport = createFakeRuntimeTransport();
		const client = createRuntimeClient({ transport });
		let unlock: ReturnType<typeof useRuntimeQuickUnlock> | undefined;

		function Unlocker() {
			unlock = useRuntimeQuickUnlock();
			return (
				<p data-testid="unlock">{unlock.isPending ? "pending" : "idle"}</p>
			);
		}

		render(host(client, <Unlocker />));
		expect(screen.getByTestId("unlock").textContent).toBe("idle");

		let signedIn: unknown;
		await act(async () => {
			const running = unlock
				?.mutateAsync({ accountId: "account-1", masterPassword: "password" })
				.then((value) => {
					signedIn = value;
				});
			await transport.settled();
			transport.answer({
				type: "succeeded",
				value: { type: "signedIn", accountId: "account-1", userId: "user-1" },
			});
			await running;
		});

		expect(signedIn).toEqual({ accountId: "account-1", userId: "user-1" });
	});
});

describe("creating a Login Item from React", () => {
	test("hands the create to the Runtime and answers with what it accepted", async () => {
		const transport = createFakeRuntimeTransport();
		const client = createRuntimeClient({ transport });
		let accepting: Promise<RuntimeAccepted> | undefined;

		function CreateButton() {
			const create = useCreateItem();
			return (
				<button
					type="button"
					data-testid="create"
					onClick={() => {
						accepting = create.mutateAsync({
							accountId: "account-1",
							vaultId: "vault-1",
							draft: { category: "login", data: { title: "Bank" } },
						});
					}}
				>
					create
				</button>
			);
		}

		const view = render(host(client, <CreateButton />));
		await flush(transport);

		await act(async () => {
			screen.getByTestId("create").click();
			await transport.settled();
		});

		// One Runtime request, and it is the create. Nothing else was written anywhere.
		const requests = transport.calls.filter((call) => call.type === "request");
		expect(requests).toHaveLength(1);
		expect(JSON.parse(requests[0]?.requestJson ?? "{}")).toEqual({
			type: "createItem",
			accountId: "account-1",
			vaultId: "vault-1",
			draft: { category: "login", data: { title: "Bank" } },
		});

		await act(async () => {
			transport.answer({
				type: "succeeded",
				value: {
					type: "accepted",
					operationId: "operation-1",
					itemId: "item-1",
					replicaRevision: "7",
				},
			});
			await transport.settled();
		});
		expect(await accepting).toEqual({
			operationId: "operation-1",
			itemId: "item-1",
			replicaRevision: "7",
		});

		view.unmount();
	});
});
