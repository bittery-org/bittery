import { expect, test } from "bun:test";
import { createRuntimeClient } from "@bittery/client-runtime/client";
import { RuntimeProvider } from "@bittery/client-runtime/react";
import { createFakeRuntimeTransport } from "@bittery/client-runtime/testing";
import { act, useState } from "react";
import { createRoot } from "react-dom/client";
import { useRuntimeShareHistory } from "./use-runtime-share-history";

const link = {
	id: "link",
	status: "active" as const,
	accessMode: "anyone" as const,
	isOneTimeUse: false,
	accessCount: 0,
	maxAccessCount: null,
	allowedEmails: [],
	expiresAt: "2099-01-01",
	createdAt: "2026-01-01",
	lastAccessedAt: null,
};
async function fixture() {
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
						displayIdentity: { email: "a@example.test" },
					},
				],
			},
		});
		runtime.selectAccount(accountId);
	};
	publish();
	let view: ReturnType<typeof useRuntimeShareHistory> | undefined;
	let close = () => {};
	function Host() {
		const [open, setOpen] = useState(true);
		close = () => setOpen(false);
		view = useRuntimeShareHistory("account", "item", open);
		return null;
	}
	const root = createRoot(document.createElement("div"));
	await act(async () => {
		root.render(
			<RuntimeProvider client={runtime}>
				<Host />
			</RuntimeProvider>,
		);
	});
	return {
		transport,
		runtime,
		publish,
		close: () => close(),
		view: () => {
			if (!view) throw new Error("Hook not mounted");
			return view;
		},
		answerLinks: async (status: "active" | "revoked" = "active") => {
			await act(async () => {
				transport.answer({
					type: "succeeded",
					value: {
						type: "itemShareLinks",
						accountId: "account",
						itemId: "item",
						links: [{ ...link, status }],
						baseShareUrl: "https://example.test/share",
					},
				});
				await transport.settled();
			});
		},
		cleanup: async () => {
			await act(async () => root.unmount());
			release();
			await runtime.close();
		},
	};
}

test("Share history, access logs and revocation use only Account-addressed Runtime requests", async () => {
	const f = await fixture();
	try {
		await f.answerLinks();
		expect(f.view().links).toEqual([link]);
		const logging = f.view().loadAccessLogs("link");
		await f.transport.settled();
		f.transport.answer({
			type: "succeeded",
			value: {
				type: "shareAccessLogs",
				accountId: "account",
				linkId: "link",
				logs: [],
			},
		});
		expect(await logging).toEqual([]);
		let revoking: Promise<void> | undefined;
		await act(async () => {
			revoking = f.view().revoke("link");
			await f.transport.settled();
			f.transport.answer({
				type: "succeeded",
				value: {
					type: "shareLinkRevoked",
					accountId: "account",
					linkId: "link",
				},
			});
			await f.transport.settled();
		});
		await f.answerLinks("revoked");
		await revoking;
		expect(f.view().links[0]?.status).toBe("revoked");
		expect(
			f.transport.calls
				.filter((call) => call.type === "request")
				.map((call) => JSON.parse(call.requestJson)),
		).toEqual([
			{ type: "listItemShareLinks", accountId: "account", itemId: "item" },
			{ type: "listShareAccessLogs", accountId: "account", linkId: "link" },
			{ type: "revokeShareLink", accountId: "account", linkId: "link" },
			{ type: "listItemShareLinks", accountId: "account", itemId: "item" },
		]);
	} finally {
		await f.cleanup();
	}
});

for (const departure of ["lock", "account", "close"] as const)
	test(`late Share history never publishes after ${departure}`, async () => {
		const f = await fixture();
		try {
			await act(async () => {
				if (departure === "lock") {
					f.publish("locked");
					f.publish();
				}
				if (departure === "account") {
					f.publish("unlocked", "other");
					f.publish();
				}
				if (departure === "close") f.close();
			});
			await f.answerLinks();
			expect(f.view().links).toEqual([]);
			expect(f.view().isLoading).toBe(false);
			await expect(f.view().loadAccessLogs("link")).rejects.toThrow("detached");
		} finally {
			await f.cleanup();
		}
	});

test("Share history shows failure explicitly and retries through Runtime", async () => {
	const f = await fixture();
	try {
		await act(async () => {
			f.transport.answer({
				type: "failed",
				value: { code: "AUTHENTICATION_REQUIRED", message: "not exposed" },
			});
			await f.transport.settled();
		});
		expect(f.view().failed).toBe(true);
		expect(f.view().isLoading).toBe(false);
		await act(async () => {
			f.view().retry();
			await f.transport.settled();
		});
		await f.answerLinks();
		expect(f.view().failed).toBe(false);
		expect(f.view().links).toEqual([link]);
	} finally {
		await f.cleanup();
	}
});
