import type { Page } from "@playwright/test";

export async function captureFixtureAccount(page: Page, email: string) {
	return page.evaluate(async (email) => {
		const cryptoPath = "/src/lib/crypto.ts";
		const serverPath = "/src/lib/auth-server.ts";
		const { runtimeClient } = (await import(
			cryptoPath
		)) as typeof import("../../src/lib/crypto");
		const { getServerUrl } = (await import(
			serverPath
		)) as typeof import("../../src/lib/auth-server");
		const session = runtimeClient.session().getSnapshot();
		const account = session.accounts.find(
			(account) => account.accountId === session.accountId,
		);
		if (
			!account?.displayIdentity ||
			account.displayIdentity.email !== email ||
			account.displayIdentity.serverUrl !== getServerUrl()
		)
			throw new Error("Fresh fixture Account identity was not published");
		return {
			accountId: account.accountId,
			serverUrl: account.displayIdentity.serverUrl,
			email,
		};
	}, email);
}

export async function deleteFixtureUser(
	page: Page,
	account: Awaited<ReturnType<typeof captureFixtureAccount>>,
) {
	const requestId = crypto.randomUUID();
	const response = page.waitForResponse(
		(response) => {
			const request = response.request();
			const url = new URL(response.url());
			return (
				request.method() === "DELETE" &&
				url.origin === new URL(account.serverUrl).origin &&
				url.pathname === "/api/v1/users/me" &&
				request.headers()["idempotency-key"] === requestId
			);
		},
		{ timeout: 30_000 },
	);
	const deletion = page.evaluate(
		async ({ account, requestId }) => {
			const path = "/src/lib/crypto.ts";
			const { runtimeClient } = (await import(
				path
			)) as typeof import("../../src/lib/crypto");
			const current = runtimeClient
				.session()
				.getSnapshot()
				.accounts.find((entry) => entry.accountId === account.accountId);
			if (
				current?.displayIdentity?.email !== account.email ||
				current.displayIdentity.serverUrl !== account.serverUrl
			)
				return false;
			try {
				const result = await runtimeClient.deleteServerAccount({
					accountId: account.accountId,
					confirmEmail: account.email,
					requestId,
				});
				return (
					result.outcome === "deleted" &&
					result.accountId === account.accountId &&
					result.requestId === requestId
				);
			} catch {
				return false;
			}
		},
		{ account, requestId },
	);
	const [http, result] = await Promise.allSettled([response, deletion]);
	return (
		http.status === "fulfilled" &&
		http.value.status() === 200 &&
		result.status === "fulfilled" &&
		result.value
	);
}
