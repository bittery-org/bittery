import { expect, test } from "bun:test";
import { createRuntimeClient } from "@bittery/client-runtime/client";
import { RuntimeProvider } from "@bittery/client-runtime/react";
import { createFakeRuntimeTransport } from "@bittery/client-runtime/testing";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { useAccountPresentationState } from "./use-account-presentation-state";

for (const departure of ["lock", "account"] as const)
	test(`dialog and drag selections retire during transient ${departure}`, async () => {
		const transport = createFakeRuntimeTransport();
		const runtime = createRuntimeClient({ transport });
		const release = runtime.session().subscribe(() => {});
		await transport.settled();
		const publish = (
			access: "unlocked" | "locked" = "unlocked",
			accountId = "account-a",
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
		let read = (): { title: string } | null => null;
		function Host() {
			const [selected, set, current] = useAccountPresentationState<{
				title: string;
			}>("account-a");
			read = current;
			return (
				<button type="button" onClick={() => set({ title: "private-title" })}>
					{selected?.title ?? "empty"}
				</button>
			);
		}
		const container = document.createElement("div");
		document.body.append(container);
		const root = createRoot(container);
		try {
			await act(async () =>
				root.render(
					<RuntimeProvider client={runtime}>
						<Host />
					</RuntimeProvider>,
				),
			);
			await act(async () => container.querySelector("button")?.click());
			expect(container.textContent).toBe("private-title");
			await act(async () => {
				if (departure === "lock") publish("locked");
				else publish("unlocked", "account-b");
				publish();
				// A stale confirmation callback must already see retirement before React renders.
				expect(read()).toBeNull();
			});
			expect(container.textContent).toBe("empty");
			await act(async () => container.querySelector("button")?.click());
			expect(read()).toEqual({ title: "private-title" });
		} finally {
			await act(async () => root.unmount());
			container.remove();
			release();
			await runtime.close();
		}
	});
