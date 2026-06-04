/**
 * API helpers for E2E testing
 *
 * Provides utilities for creating test data via the API.
 * This is useful for setting up test scenarios without going through the UI.
 */

import type { Page } from "@playwright/test";
import { waitForNetworkIdleExceptSSE } from "./network-helpers";

/**
 * Get authentication token from page storage
 */
export async function getAuthToken(page: Page): Promise<string | null> {
	return await page.evaluate(() => {
		return sessionStorage.getItem("auth-token");
	});
}

/**
 * Seed test data via API calls
 * Note: This requires authentication first
 */
export async function seedTestVaultItem(
	page: Page,
	vaultId: string,
	itemData: {
		title: string;
		url?: string;
		username?: string;
		password?: string;
		notes?: string;
	},
	category:
		| "login"
		| "secure-note"
		| "credit-card"
		| "identity"
		| "totp" = "login",
): Promise<string | null> {
	// This would need to be called through the RPC client
	// For E2E tests, we'll create items through the UI flow if possible
	// or use direct API calls with the auth token

	const result = await page.evaluate(
		async ({ vaultId: _vaultId, itemData: _itemData, category: _category }) => {
			// Access an exposed RPC client from the window if available
			const rpcClient = (window as any).__RPC_CLIENT__;
			if (!rpcClient) {
				console.error("RPC client not available");
				return null;
			}

			try {
				// In a real implementation, this would call the API
				// For now, return null to indicate we should use UI-based creation
				return null;
			} catch (error) {
				console.error("Failed to seed test item:", error);
				return null;
			}
		},
		{ vaultId, itemData, category },
	);

	return result;
}

/**
 * Interface for vault data from API
 */
export interface VaultInfo {
	id: string;
	name: string;
	type: "personal" | "team";
	itemCount: number;
	memberCount: number;
}

/**
 * Get user's vaults from the page context
 */
export async function getUserVaults(page: Page): Promise<VaultInfo[]> {
	// Navigate to vaults page and extract vault data
	const currentUrl = page.url();

	if (!currentUrl.includes("/vaults")) {
		await page.goto("/vaults");
		await waitForNetworkIdleExceptSSE(page);
	}

	// Wait for vaults to load
	await page.waitForTimeout(2000);

	// Extract vault information from the page
	const vaults = await page.evaluate(() => {
		const vaultCards = document.querySelectorAll('[data-testid="vault-card"]');
		const vaultList: VaultInfo[] = [];

		vaultCards.forEach((card) => {
			const nameEl = card.querySelector('[data-testid="vault-name"]');
			const typeEl = card.querySelector('[data-testid="vault-type"]');
			const hrefEl = card.closest("a");

			if (nameEl && hrefEl) {
				const href = hrefEl.getAttribute("href") || "";
				const idMatch = href.match(/\/vaults\/([^/]+)/);

				vaultList.push({
					id: idMatch ? idMatch[1] : "",
					name: nameEl.textContent || "",
					type: typeEl?.textContent?.includes("team") ? "team" : "personal",
					itemCount: 0,
					memberCount: 1,
				});
			}
		});

		return vaultList;
	});

	return vaults;
}

/**
 * Wait for API response with specific pattern
 */
export async function waitForApiResponse(
	page: Page,
	urlPattern: string | RegExp,
	timeout = 10000,
): Promise<any> {
	const response = await page.waitForResponse(
		(resp) => {
			const url = resp.url();
			if (typeof urlPattern === "string") {
				return url.includes(urlPattern);
			}
			return urlPattern.test(url);
		},
		{ timeout },
	);

	try {
		return await response.json();
	} catch {
		return null;
	}
}

/**
 * Mock an API endpoint for testing
 */
export async function mockApiEndpoint(
	page: Page,
	urlPattern: string,
	response: object,
	statusCode = 200,
): Promise<void> {
	await page.route(urlPattern, async (route) => {
		await route.fulfill({
			status: statusCode,
			contentType: "application/json",
			body: JSON.stringify(response),
		});
	});
}

/**
 * Clear API mocks
 */
export async function clearApiMocks(
	page: Page,
	urlPattern: string,
): Promise<void> {
	await page.unroute(urlPattern);
}

/**
 * Store and retrieve test session data
 */
export interface TestSessionData {
	userId: string;
	email: string;
	secretKey: string;
	vaultIds: string[];
	itemIds: string[];
}

const testSessions = new Map<string, TestSessionData>();

export function storeTestSession(email: string, data: TestSessionData): void {
	testSessions.set(email, data);
}

export function getTestSession(email: string): TestSessionData | undefined {
	return testSessions.get(email);
}

export function clearTestSession(email: string): void {
	testSessions.delete(email);
}

export function clearAllTestSessions(): void {
	testSessions.clear();
}
