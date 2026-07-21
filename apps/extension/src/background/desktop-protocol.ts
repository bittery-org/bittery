// Kept at 1: the `theme` field and `theme_changed` event are additive and
// tolerated by older peers, so no version bump (a bump hard-breaks mixed
// extension/desktop versions during staggered rollouts).
export const DESKTOP_PROTOCOL_VERSION = 1;

export type DesktopTheme = "light" | "dark" | "system";

export type DesktopRequest =
	| { type: "PING" }
	| { type: "GET_DESKTOP_STATUS" }
	| { type: "GET_DESKTOP_ACCOUNTS" }
	| { type: "GET_DESKTOP_AUTH_TOKEN"; accountId: string }
	| { type: "GET_DESKTOP_VAULT_KEYS"; accountId: string }
	| { type: "GET_DESKTOP_ITEMS_SNAPSHOT"; accountIds?: string[] }
	| { type: "SUBSCRIBE_DESKTOP_EVENTS" }
	| { type: "UNSUBSCRIBE_DESKTOP_EVENTS" }
	| { type: "CHECK_BIOMETRIC_AVAILABLE" }
	| {
			type: "BIOMETRIC_UNLOCK_REQUEST";
			challenge: string;
			extension_id: string;
			accountId?: string;
	  }
	| {
			type: "BIOMETRIC_UNLOCK_ALL_REQUEST";
			challenge: string;
			extension_id: string;
	  }
	| { type: "TRIGGER_DESKTOP_UNLOCK" }
	// Intent fields are additive (protocol v1): older desktop hosts ignore
	// them and simply open the app without acting on the intent.
	| {
			type: "OPEN_DESKTOP_APP";
			intent?: "create_item" | "view_item";
			url?: string;
			itemId?: string;
			vaultId?: string;
	  };

export type DesktopEventPayload =
	| { event: "lock"; payload: { reason: string; timestamp: number } }
	| { event: "unlock"; payload: { accounts: string[]; timestamp: number } }
	| { event: "desktop_close"; payload: { timestamp: number } }
	| {
			event: "active_account_changed";
			payload: { accountId: string; timestamp: number };
	  }
	| {
			event: "theme_changed";
			payload: { theme: DesktopTheme; timestamp: number };
	  };

export type DesktopResponse =
	| {
			type: "PROTOCOL_MISMATCH";
			expectedVersion: number;
			receivedVersion?: number;
	  }
	| { type: "PONG"; version: string }
	| {
			type: "DESKTOP_STATUS";
			available: boolean;
			locked: boolean;
			unlockedAccounts: string[];
			timestamp: number;
			autolockTimeoutMs: number;
			theme?: DesktopTheme | null;
	  }
	| {
			type: "DESKTOP_ACCOUNTS";
			accounts: Array<{
				accountId: string;
				email: string;
				userId: string;
				name: string;
				secretKeyHint: string;
				teamName?: string;
				teamAvatarUrl?: string | null;
				lastActiveAt?: number;
				biometricEnabled?: boolean;
				addedAt?: number;
			}>;
			activeAccount?: string | null;
			unlockedAccounts: string[];
	  }
	| {
			type: "DESKTOP_AUTH_TOKEN";
			accountId: string;
			email: string;
			authToken: string;
			expiresAt?: number;
			userId?: string;
	  }
	| {
			type: "DESKTOP_VAULT_KEYS";
			accountId: string;
			email: string;
			vaultKeys: string;
	  }
	| {
			type: "DESKTOP_ITEMS_SNAPSHOT";
			items: Array<Record<string, unknown>>;
			generatedAt: number;
	  }
	| ({ type: "DESKTOP_EVENT" } & DesktopEventPayload)
	| { type: "DESKTOP_EVENT_SUBSCRIPTION"; subscribed: boolean }
	| {
			type: "BIOMETRIC_STATUS";
			available: boolean;
			enabled: boolean;
			appRunning?: boolean;
			app_running?: boolean;
	  }
	| {
			type: "BIOMETRIC_UNLOCK_SUCCESS";
			accountId: string;
			email: string;
			encrypted_session: string;
			device_key: string;
			signature: string;
			auth_token?: string;
			vault_keys?: string;
	  }
	| { type: "BIOMETRIC_UNLOCK_FAILED"; error: string }
	| {
			type: "BIOMETRIC_UNLOCK_ALL_SUCCESS";
			device_key: string;
			signature: string;
			accounts: Array<{
				accountId: string;
				email: string;
				encrypted_session: string;
				auth_token?: string;
				vault_keys?: string;
			}>;
			unlocked: string[];
			failed: string[];
	  }
	| { type: "BIOMETRIC_UNLOCK_ALL_FAILED"; error: string }
	| { type: "OPEN_DESKTOP_APP_RESULT"; success: boolean; error?: string }
	| { type: "TRIGGER_DESKTOP_UNLOCK_RESULT"; success: boolean; error?: string }
	| { type: "ERROR"; message: string };

export type DesktopEnvelope<T> = T & {
	protocolVersion: number;
	requestId?: string;
};

export class DesktopProtocolMismatchError extends Error {
	readonly expectedVersion: number;
	readonly receivedVersion: number | undefined;

	constructor(expectedVersion: number, receivedVersion: number | undefined) {
		super(
			`Desktop protocol mismatch (expected ${expectedVersion}, received ${receivedVersion ?? "legacy"})`,
		);
		this.name = "DesktopProtocolMismatchError";
		this.expectedVersion = expectedVersion;
		this.receivedVersion = receivedVersion;
	}
}
