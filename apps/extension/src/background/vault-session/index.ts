/**
 * The production vault-session singleton.
 *
 * Imported by the MV3 service worker, so module scope only builds objects —
 * no DOM, no React, no eager I/O (same convention as `background/lifecycle.ts`).
 *
 * `sync` and the revocation fallback email arrive through setters rather than
 * imports: `sync-manager` dispatches into this module, so importing it back
 * would close a cycle at module-eval time in the worker.
 */

import { createChromeSessionAdapter } from "./adapters/chrome-session-adapter";
import { createDesktopAdapter } from "./adapters/desktop-adapter";
import { createLifecycleAdapter } from "./adapters/lifecycle-adapter";
import { createSettingsAdapter } from "./adapters/settings-adapter";
import { createVaultSessionMachine } from "./machine";
import type { SyncPort, VaultSessionPorts } from "./ports";

let syncPort: SyncPort = { disconnect: () => {} };
let sessionFallbackEmail: string | null = null;

/** `sync-manager` registers its own disconnect once, at initialization. */
export function setSyncPort(port: SyncPort): void {
	syncPort = port;
}

/**
 * The SSE `session_revoked` payload names a session, never an account, so the
 * connection's own email is the only fallback when the id resolves to nothing.
 */
export function setSessionFallbackEmail(email: string | null): void {
	sessionFallbackEmail = email;
}

export const vaultSessionPorts: VaultSessionPorts = {
	chrome: createChromeSessionAdapter(),
	desktop: createDesktopAdapter(),
	lifecycle: createLifecycleAdapter({
		resolveFallbackEmail: () => sessionFallbackEmail,
	}),
	sync: {
		disconnect: (reason, suppressReconnect) =>
			syncPort.disconnect(reason, suppressReconnect),
	},
	settings: createSettingsAdapter(),
	clock: { now: () => Date.now() },
};

export const vaultSession = createVaultSessionMachine(vaultSessionPorts);

export type {
	VaultSessionMachine,
	VaultSessionMachineOptions,
} from "./machine";
export { createVaultSessionMachine } from "./machine";
export type {
	ChromeSessionPort,
	Clock,
	DesktopPort,
	InvalidatedSession,
	SessionInvalidationTarget,
	SettingsPort,
	SyncPort,
	VaultLifecyclePort,
	VaultSessionPorts,
} from "./ports";
export { createInitialState, projectSnapshot, reduce } from "./transitions";
export type {
	DesktopSnapshot,
	LockReason,
	RefusalCode,
	VaultOwner,
	VaultSessionBroadcast,
	VaultSessionEffect,
	VaultSessionEvent,
	VaultSessionSnapshot,
	VaultSessionState,
} from "./types";
