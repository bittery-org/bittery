/**
 * The drift guard for the one restatement of the Tauri command surface.
 *
 * `@bittery/storage`'s Tauri adapter declares the three `keychain_*` signatures
 * itself, because a package cannot import an app and the generated types live in
 * this app. ADR 0012 permits that restatement only with a compile-time guard,
 * and this is it: the desktop app is the single place where the package's
 * declaration and the generated argument types are both in scope.
 *
 * The two assignments below check both directions, so neither side can add,
 * drop, rename or retype an argument without failing `pnpm -F desktop
 * check-types`. Widening one side would still pass a one-way check.
 *
 * Nothing here runs — `storage.ts` builds the real port from
 * `createTauriPlatformPort`, whose default loader is the same `invoke`.
 */

import type { TauriInvoke } from "@bittery/storage/adapters/tauri";
import type {
	KeychainDeleteArgs,
	KeychainGetArgs,
	KeychainSetArgs,
} from "@/generated/tauri-commands";

/** The same three commands, spelled from the generated argument types. */
interface GeneratedKeychainInvoke {
	(cmd: "keychain_set", args: KeychainSetArgs): Promise<void>;
	(cmd: "keychain_get", args: KeychainGetArgs): Promise<string | null>;
	(cmd: "keychain_delete", args: KeychainDeleteArgs): Promise<boolean>;
}

declare const generated: GeneratedKeychainInvoke;
declare const restated: TauriInvoke;

const _generatedSatisfiesRestated: TauriInvoke = generated;
const _restatedSatisfiesGenerated: GeneratedKeychainInvoke = restated;

void _generatedSatisfiesRestated;
void _restatedSatisfiesGenerated;
