export type DesktopRequest =
	| { type: "PING" }
	| { type: "GET_DESKTOP_STATUS" }
	| { type: "GET_DESKTOP_ACCOUNTS" }
	| { type: "GET_DESKTOP_AUTH_TOKEN"; email: string }
	| { type: "GET_DESKTOP_VAULT_KEYS"; email: string }
	| { type: "GET_DESKTOP_ITEMS_SNAPSHOT"; emails?: string[] }
	| { type: "SUBSCRIBE_DESKTOP_EVENTS" }
	| { type: "UNSUBSCRIBE_DESKTOP_EVENTS" }
	| { type: "CHECK_BIOMETRIC_AVAILABLE" }
	| {
			type: "BIOMETRIC_UNLOCK_REQUEST";
			challenge: string;
			extension_id: string;
			email?: string;
	  }
	| {
			type: "BIOMETRIC_UNLOCK_ALL_REQUEST";
			challenge: string;
			extension_id: string;
	  }
	| { type: "TRIGGER_DESKTOP_UNLOCK" }
	| { type: "OPEN_DESKTOP_APP" };

export type DesktopEventPayload =
	| { event: "lock"; payload: { reason: string; timestamp: number } }
	| { event: "unlock"; payload: { accounts: string[]; timestamp: number } }
	| { event: "desktop_close"; payload: { timestamp: number } }
	| {
			event: "active_account_changed";
			payload: { email: string; timestamp: number };
	  };

export type DesktopResponse =
	| { type: "PONG"; version: string }
	| {
			type: "DESKTOP_STATUS";
			available: boolean;
			locked: boolean;
			unlockedAccounts: string[];
			timestamp: number;
			autolockTimeoutMs: number;
	  }
	| {
			type: "DESKTOP_ACCOUNTS";
			accounts: Array<{
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
			email: string;
			authToken: string;
			expiresAt?: number;
			userId?: string;
	  }
	| { type: "DESKTOP_VAULT_KEYS"; email: string; vaultKeys: string }
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
	requestId?: string;
};
