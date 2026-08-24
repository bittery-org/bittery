/**
 * What the Web can still reach in the transitional TypeScript stack.
 *
 * The Runtime owns the Web's Items and Vaults after ticket 22, but the transitional stack
 * stays compiled: Desktop and the Extension have not cut over, and the remaining Item write
 * kinds move in ticket 28. "Deleted" is therefore not the property to check. The property is
 * reachability: can any module the Web bundle reaches still ask a transitional owner for
 * something the Runtime now owns?
 *
 * This audit answers that over the whole entry graph, per imported symbol, and refuses to be
 * silently outgrown: a transitional symbol the table does not classify fails the audit, so a
 * new consumer cannot slip in the way `useItems` did.
 *
 * Ticket 28 tightens it by moving `item-write` into {@link FORBIDDEN_KINDS} and deleting the
 * holdouts it retires. Nothing else about this file has to change.
 */

import {
	buildWebImportGraph,
	type ExternalImport,
	type WebImportGraph,
} from "./web-import-graph";

/**
 * What a transitional symbol owns.
 *
 * The four forbidden kinds are the ones the Runtime replaced on Web. The rest are named,
 * not forgiven: they say which transitional stack a symbol belongs to and which ticket owes
 * its removal.
 */
export type TransitionalKind =
	/** Reads the transitional Item repository. The Runtime's Items projection replaced it. */
	| "item-read"
	/** Reads transitional Vault metadata. The Runtime's Vault projections replaced it. */
	| "vault-read"
	/** Creates an Item through the transitional repository. `CreateLoginItem` replaced it. */
	| "item-create"
	/** Runs or assembles the transitional Sync loop. The Runtime owns Web Sync ownership. */
	| "sync-loop"
	/** Update, delete, favorite, move, share. Ticket 28. */
	| "item-write"
	/** Vault create, update, delete, type conversion. Still transitional; no ticket yet. */
	| "vault-write"
	/** Transitional Account, Session and lifecycle machinery. Sign-in itself is the Runtime's. */
	| "account"
	/** Builds a transitional store, port or repository. Deleted when every host has cut over. */
	| "store"
	/** The `PlatformProvider` seam the remaining transitional consumers are wired through. */
	| "platform"
	/** A team, billing or attachment surface the Runtime does not model at all yet. */
	| "product"
	/** Pure derivation over data it is handed. Reaches no owner. */
	| "derivation";

/** The kinds no Web path may reach after ticket 22. */
export const FORBIDDEN_KINDS: ReadonlySet<TransitionalKind> = new Set([
	"item-read",
	"vault-read",
	"item-create",
	"sync-loop",
]);

/** A Web file that may still reach a forbidden symbol, and the reason it may. */
export interface Holdout {
	/** Path relative to `apps/web`. */
	readonly file: string;
	/** The ticket that removes it. */
	readonly ticket: number;
	readonly why: string;
}

export interface TransitionalEntry {
	readonly module: string;
	readonly symbol: string;
	readonly kind: TransitionalKind;
	readonly holdouts?: readonly Holdout[];
}

/** Module prefixes the audit classifies. Everything else on Web is not transitional. */
export const TRANSITIONAL_MODULE_PREFIXES = [
	"@bittery/core/hooks",
	"@bittery/core/services/",
	"@bittery/storage",
	"@bittery/sync",
] as const;

export function isTransitionalModule(module: string): boolean {
	return TRANSITIONAL_MODULE_PREFIXES.some((prefix) =>
		module.startsWith(prefix),
	);
}

const HOOKS = "@bittery/core/hooks";

/**
 * Every transitional symbol the Web may import, and what it owns.
 *
 * A symbol may stay listed after its last consumer goes: the classification is the
 * vocabulary, and keeping `useItems` here means re-adding it fails loudly instead of
 * needing the table extended first. Holdouts are the opposite — they are debt, so a stale
 * one fails the audit.
 */
export const TRANSITIONAL_SURFACE: readonly TransitionalEntry[] = [
	// --- Items and Vaults: the Runtime owns these on Web -----------------------------
	{ module: HOOKS, symbol: "useItems", kind: "item-read" },
	{ module: HOOKS, symbol: "useItem", kind: "item-read" },
	{ module: HOOKS, symbol: "useVaultItems", kind: "item-read" },
	{ module: HOOKS, symbol: "useVaultSearch", kind: "item-read" },
	{ module: HOOKS, symbol: "useCreateItem", kind: "item-create" },
	{ module: HOOKS, symbol: "useVaultInfo", kind: "vault-read" },
	{ module: HOOKS, symbol: "useCrossVaultTags", kind: "vault-read" },
	{ module: HOOKS, symbol: "useVaultRepositoryState", kind: "vault-read" },
	{
		module: HOOKS,
		symbol: "useAllVaultKeys",
		kind: "vault-read",
		holdouts: [
			{
				file: "src/hooks/use-vault-import.ts",
				ticket: 28,
				why: "bulk import writes Items through the transitional repository, and reads this only to pick the Vault it writes into",
			},
		],
	},
	{
		module: HOOKS,
		symbol: "useMoveTargetVaults",
		kind: "vault-read",
		holdouts: [
			{
				file: "src/components/vault/move-item-dialog.tsx",
				ticket: 28,
				why: "the move dialog offers the targets of a move the Runtime cannot perform yet",
			},
		],
	},
	{
		module: HOOKS,
		symbol: "useDeletedItems",
		kind: "item-read",
		holdouts: [
			{
				file: "src/routes/_app/vaults/trash.tsx",
				ticket: 28,
				why: "Trash lists what transitional delete produced; the Runtime has no deleted-Item projection until delete moves",
			},
		],
	},
	{
		module: HOOKS,
		symbol: "useItemAttachments",
		kind: "item-read",
		holdouts: [
			{
				file: "src/components/vault/item-detail-pane.tsx",
				ticket: 28,
				why: "the first Runtime slice models no Attachments, so the detail pane still reads them transitionally",
			},
		],
	},

	// --- Item writes: ticket 28 ------------------------------------------------------
	{ module: HOOKS, symbol: "useUpdateItem", kind: "item-write" },
	{ module: HOOKS, symbol: "useDeleteItem", kind: "item-write" },
	{ module: HOOKS, symbol: "useRestoreItem", kind: "item-write" },
	{ module: HOOKS, symbol: "usePermanentDeleteItem", kind: "item-write" },
	{ module: HOOKS, symbol: "useToggleFavorite", kind: "item-write" },
	{ module: HOOKS, symbol: "useMoveItem", kind: "item-write" },
	{ module: HOOKS, symbol: "useCreateShare", kind: "item-write" },

	// --- Vault writes: still transitional, no ticket yet -----------------------------
	{ module: HOOKS, symbol: "useCreateVault", kind: "vault-write" },
	{ module: HOOKS, symbol: "useUpdateVault", kind: "vault-write" },
	{ module: HOOKS, symbol: "useDeleteVault", kind: "vault-write" },
	{ module: HOOKS, symbol: "useConvertVaultType", kind: "vault-write" },

	// --- Pure derivations: they read whatever the caller hands them ------------------
	{ module: HOOKS, symbol: "useAvailableTags", kind: "derivation" },
	{ module: HOOKS, symbol: "useItemCounts", kind: "derivation" },
	{ module: HOOKS, symbol: "useItemListFilters", kind: "derivation" },
	{
		module: `${HOOKS}/use-password-security`,
		symbol: "usePasswordSecurity",
		kind: "derivation",
	},

	// --- The seam the remaining transitional consumers are wired through -------------
	{ module: HOOKS, symbol: "PlatformProvider", kind: "platform" },
	{ module: HOOKS, symbol: "useCoreContext", kind: "platform" },
	{ module: HOOKS, symbol: "usePlatformCrypto", kind: "platform" },
	{ module: HOOKS, symbol: "useQueryInvalidator", kind: "platform" },
	{
		module: `${HOOKS}/services/autolock-web`,
		symbol: "createWebAutolockService",
		kind: "platform",
	},
	{ module: "@bittery/sync", symbol: "useSyncCapability", kind: "platform" },
	{
		module: "@bittery/sync",
		symbol: "createQueryInvalidator",
		kind: "platform",
	},
	{
		module: "@bittery/sync",
		symbol: "getOrCreateClientId",
		kind: "derivation",
	},

	// --- The transitional Sync loop: Web owns none of it after ticket 22 -------------
	{ module: "@bittery/sync", symbol: "useSync", kind: "sync-loop" },
	{
		module: "@bittery/core/services/account-sync",
		symbol: "createAccountSync",
		kind: "sync-loop",
	},
	{
		module: "@bittery/core/services/account-sync-lifecycle",
		symbol: "AccountSyncLifecycle",
		kind: "sync-loop",
	},

	// --- Transitional Account, Session and lifecycle machinery -----------------------
	{ module: HOOKS, symbol: "useAccountSwitcher", kind: "account" },
	{ module: HOOKS, symbol: "useSessionState", kind: "account" },
	{
		module: "@bittery/core/services/account-lifecycle",
		symbol: "NO_CREDENTIAL_MIRROR",
		kind: "account",
	},
	{
		module: "@bittery/core/services/account-lifecycle",
		symbol: "requireCompleteLifecycleOutcome",
		kind: "account",
	},
	{
		module: "@bittery/core/services/account-lifecycle",
		symbol: "lockInvalidSession",
		kind: "account",
	},
	{
		module: "@bittery/core/services/account-lifecycle",
		symbol: "signOutAccount",
		kind: "account",
	},
	{
		module: "@bittery/core/services/account-lifecycle",
		symbol: "removeAccount",
		kind: "account",
	},
	{
		module: "@bittery/core/services/account-lifecycle",
		symbol: "deleteAccountEverywhere",
		kind: "account",
	},
	{
		module: "@bittery/core/services/account-resolver",
		symbol: "getClientForAccount",
		kind: "account",
	},
	{
		module: "@bittery/core/services/auth-service",
		symbol: "storeLoginSessionOwned",
		kind: "account",
	},
	{
		module: "@bittery/core/services/vault-crypto",
		symbol: "createAccountKeys",
		kind: "account",
	},
	{
		module: "@bittery/core/services/vault-crypto",
		symbol: "changeAccountEmail",
		kind: "account",
	},
	{
		module: "@bittery/core/services/vault-crypto",
		symbol: "changeAccountPassword",
		kind: "account",
	},
	{
		module: "@bittery/core/services/vault-crypto",
		symbol: "prepareRecoveryKey",
		kind: "account",
	},
	{
		module: "@bittery/core/services/vault-crypto",
		symbol: "recoverAccount",
		kind: "account",
	},
	{
		module: "@bittery/core/services/vault-crypto",
		symbol: "regenerateAccountSecretKey",
		kind: "account",
	},
	{
		module: "@bittery/core/services/vault-crypto",
		symbol: "InvalidAccountPasswordError",
		kind: "account",
	},
	{
		module: "@bittery/core/services/vault-crypto",
		symbol: "InvalidRecoveryKeyError",
		kind: "account",
	},
	{
		module: "@bittery/core/services/vault-crypto",
		symbol: "LocalKeyAdoptionError",
		kind: "account",
	},

	// --- Building the transitional stores themselves ---------------------------------
	{
		module: "@bittery/core/services/client-runtime",
		symbol: "ClientRuntime",
		kind: "store",
	},
	{
		module: "@bittery/core/services/vault-runtime",
		symbol: "createVaultRuntime",
		kind: "store",
	},
	{
		module: "@bittery/core/services/vault-key-rotation",
		symbol: "createVaultKeyRotationCeremony",
		kind: "store",
	},
	{ module: "@bittery/storage", symbol: "createAccountStore", kind: "store" },
	{ module: "@bittery/storage", symbol: "createItemCache", kind: "store" },
	{
		module: "@bittery/storage",
		symbol: "DEFAULT_AUTO_LOCK_TIMEOUT_MS",
		kind: "store",
	},
	{
		module: "@bittery/storage/account-id",
		symbol: "generateAccountId",
		kind: "store",
	},
	{
		module: "@bittery/storage/adapters/web",
		symbol: "createWebPlatformPort",
		kind: "store",
	},
	{
		module: "@bittery/storage/adapters/web",
		symbol: "createWebRecordPort",
		kind: "store",
	},

	// --- Product surfaces the Runtime does not model at all yet ----------------------
	{ module: HOOKS, symbol: "useTeamAvatar", kind: "product" },
	{ module: HOOKS, symbol: "TeamAvatarError", kind: "product" },
	{ module: HOOKS, symbol: "getAttachmentUploadErrorCode", kind: "product" },
	{
		module: "@bittery/core/services/attachment-crypto",
		symbol: "decryptAttachmentParts",
		kind: "product",
	},
	{
		module: "@bittery/core/services/attachment-crypto",
		symbol: "parseAttachmentBlobEnvelope",
		kind: "product",
	},
	{
		module: "@bittery/core/services/attachment-crypto",
		symbol: "unwrapAttachmentKey",
		kind: "product",
	},
	{
		module: "@bittery/core/services/share-service",
		symbol: "readShareKeyFromUrl",
		kind: "product",
	},
];

export interface Violation {
	readonly module: string;
	readonly symbol: string;
	readonly kind: TransitionalKind;
	readonly file: string;
}

export interface AuditResult {
	/** Reached transitional imports the table does not classify. */
	readonly unclassified: readonly ExternalImport[];
	/** Reached forbidden symbols with no holdout covering the importer. */
	readonly violations: readonly Violation[];
	/** Recorded holdouts nothing imports any more. Debt that has been paid must go. */
	readonly staleHoldouts: readonly (Holdout & {
		readonly module: string;
		readonly symbol: string;
	})[];
	/** Every reached transitional import, classified. Useful when a test fails. */
	readonly reached: readonly Violation[];
}

/** Audit one Web import graph against {@link TRANSITIONAL_SURFACE}. */
export function auditTransitionalReachability(
	graph: WebImportGraph = buildWebImportGraph(),
): AuditResult {
	const byKey = new Map(
		TRANSITIONAL_SURFACE.map((entry) => [
			`${entry.module} ${entry.symbol}`,
			entry,
		]),
	);
	const unclassified: ExternalImport[] = [];
	const violations: Violation[] = [];
	const reached: Violation[] = [];
	const usedHoldouts = new Set<string>();

	for (const imported of graph.imports) {
		if (!isTransitionalModule(imported.module)) continue;
		const entry = byKey.get(`${imported.module} ${imported.symbol}`);
		if (entry === undefined) {
			unclassified.push(imported);
			continue;
		}
		reached.push({ ...imported, kind: entry.kind });
		if (!FORBIDDEN_KINDS.has(entry.kind)) continue;
		const holdout = entry.holdouts?.find(
			(candidate) => candidate.file === imported.file,
		);
		if (holdout === undefined) {
			violations.push({ ...imported, kind: entry.kind });
			continue;
		}
		usedHoldouts.add(`${entry.module} ${entry.symbol} ${holdout.file}`);
	}

	const staleHoldouts = TRANSITIONAL_SURFACE.flatMap((entry) =>
		(entry.holdouts ?? [])
			.filter(
				(holdout) =>
					!usedHoldouts.has(`${entry.module} ${entry.symbol} ${holdout.file}`),
			)
			.map((holdout) => ({
				...holdout,
				module: entry.module,
				symbol: entry.symbol,
			})),
	);

	return { unclassified, violations, staleHoldouts, reached };
}

/** A failure message a reader can act on without re-running the walker by hand. */
export function describeAudit(result: AuditResult): string {
	const lines: string[] = [];
	for (const item of result.violations) {
		lines.push(
			`${item.file} reaches ${item.kind} owner ${item.symbol} from ${item.module}`,
		);
	}
	for (const item of result.unclassified) {
		lines.push(
			`${item.file} imports unclassified transitional symbol ${item.symbol} from ${item.module}`,
		);
	}
	for (const item of result.staleHoldouts) {
		lines.push(
			`holdout for ${item.symbol} in ${item.file} (ticket ${item.ticket}) is stale`,
		);
	}
	return lines.join("\n");
}
