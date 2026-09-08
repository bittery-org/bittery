import { expect, test } from "bun:test";
import { createRuntimeClient } from "@bittery/client-runtime/client";
import { RuntimeProvider } from "@bittery/client-runtime/react";
import { createFakeRuntimeTransport } from "@bittery/client-runtime/testing";
import type { DecryptedItemWithContext } from "@bittery/shared/types";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { useCreateShare } from "./use-create-share";

test("a retained Share callback refuses admission after unmount", async () => {
	const transport = createFakeRuntimeTransport();
	let requests = 0;
	const runtime = createRuntimeClient({
		transport: {
			...transport,
			request: async () => {
				requests += 1;
				throw new Error("Unexpected detached request");
			},
		},
	});
	const release = runtime.session().subscribe(() => {});
	await transport.settled();
	transport.publish({
		type: "runtimeStatus",
		value: {
			accountId: null,
			closed: false,
			revision: "1",
			accounts: [
				{
					accountId: "account",
					access: "unlocked",
					failure: null,
					replicaRevision: "1",
					displayIdentity: { email: "a@example.test" },
				},
			],
		},
	});
	runtime.selectAccount("account");
	let start: ReturnType<typeof useCreateShare>["mutateAsync"] | undefined;
	function Host() {
		start = useCreateShare().mutateAsync;
		return null;
	}
	const root = createRoot(document.createElement("div"));
	await act(async () =>
		root.render(
			<RuntimeProvider client={runtime}>
				<Host />
			</RuntimeProvider>,
		),
	);
	await act(async () => root.unmount());
	try {
		if (!start) throw new Error("Host did not mount");
		const outcome = await start({
			item: { id: "item", accountId: "account" } as DecryptedItemWithContext,
			accessMode: "anyone",
			expiresIn: "7days",
			isOneTimeUse: false,
		}).catch((error: Error) => error.name);
		expect(requests).toBe(0);
		expect(outcome).toBe("AbortError");
	} finally {
		release();
		await runtime.close();
	}
});
