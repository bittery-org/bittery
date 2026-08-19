/**
 * Background Event Contract
 *
 * One entry per `message.type` the background *pushes* at the popup and the
 * extension's other UI contexts. This is the other half of the runtime
 * protocol: `router/contract.ts` types the request direction (UI → background,
 * every message answered), this file types the notification direction
 * (background → UI, nothing answered).
 *
 * Because there is no response, an event is a payload and nothing else — so the
 * map is keyed on the discriminant and valued with the payload directly, rather
 * than with a `{ payload, response }` pair. `undefined` means the event carries
 * no payload at all.
 *
 * Events are flat on the wire (`{ type: "VAULT_LOCKED", reason: "timeout" }`,
 * not `{ type, payload }`) because that is what they have always been, and the
 * popup, the content scripts and the desktop bridge ship on independent
 * schedules: renaming a key or moving a field is a breaking change, adding one
 * is not.
 *
 * Types only — no runtime values; the key set and the emitter live in
 * `./index.ts`.
 */

import type { ConnectionStatus, SyncCommandSummary } from "@bittery/sync";
import type { ItemSyncAcknowledgement, ItemSyncCommand } from "@bittery/types";
import type { DesktopEventOf } from "../desktop-protocol";
import type { VaultSessionBroadcast } from "../vault-session/types";

/**
 * The payload of one vault-session broadcast. The reducer's own union is the
 * definition — this contract only decides which of its members reach the UI and
 * under which key, never what they contain.
 */
type SessionBroadcast<K extends VaultSessionBroadcast["type"]> = Omit<
	Extract<VaultSessionBroadcast, { type: K }>,
	"type"
>;

/**
 * `undefined` = the event has no payload. Anything else is spread flat onto the
 * `type` discriminant, so optional fields are spelled optional in the payload
 * itself rather than by admitting `undefined` here.
 */
export interface BackgroundEventContract {
	// -- Vault session (emitted by the reducer, via the chrome adapter) --
	VAULT_LOCKED: SessionBroadcast<"VAULT_LOCKED">;
	DESKTOP_LOCKED: SessionBroadcast<"DESKTOP_LOCKED">;
	DESKTOP_UNLOCKED: SessionBroadcast<"DESKTOP_UNLOCKED">;
	SESSION_REVOKED: SessionBroadcast<"SESSION_REVOKED">;

	// -- Desktop app (forwarded desktop IPC events, minus their timestamps) --
	THEME_CHANGED: Pick<DesktopEventOf<"theme_changed">, "theme">;
	ACTIVE_ACCOUNT_CHANGED: Pick<
		DesktopEventOf<"active_account_changed">,
		"accountId"
	>;

	// -- Sync --
	SYNC_STATUS_CHANGED: { status: ConnectionStatus };
	SYNC_FULL_REFRESH_REQUIRED: undefined;
	SYNC_COMMAND_STATUS_CHANGED: { summary: SyncCommandSummary };
	SYNC_ITEM_COMMAND_ACKNOWLEDGED: {
		command: ItemSyncCommand;
		acknowledgement: ItemSyncAcknowledgement;
	};
}

/* -------------------------------------------------------------------------- */
/* Derived shapes                                                             */
/* -------------------------------------------------------------------------- */

export type BackgroundEventKey = keyof BackgroundEventContract;

export type BackgroundEventPayload<K extends BackgroundEventKey> =
	BackgroundEventContract[K];

/** A payload-less event is the bare discriminant; everything else merges flat. */
type EventFor<K extends BackgroundEventKey> =
	undefined extends BackgroundEventPayload<K>
		? { type: K }
		: { type: K } & BackgroundEventPayload<K>;

/**
 * The discriminated union of every push the background may emit and every push
 * the UI may narrow. Both ends are checked against it, so an event that no
 * receiver knows about and a receiver case that no sender can produce are the
 * same compile error.
 */
export type BackgroundEvent = {
	[K in BackgroundEventKey]: EventFor<K>;
}[BackgroundEventKey];

/** One member of the union, for handlers that take a single event. */
export type BackgroundEventOf<K extends BackgroundEventKey> = Extract<
	BackgroundEvent,
	{ type: K }
>;
