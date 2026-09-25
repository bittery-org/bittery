import type { WebVaultCapabilityScope } from "../web-vault-capability-scopes";
import {
	activateWebVaultImageSourceRegistry,
	type VaultImageSourceAnswer,
	type VaultImageSourceGrant,
	WebVaultImageSourceRegistry,
	type WebVaultImageSourceRegistryOptions,
} from "../web-vault-image-source";

export interface VaultImageSourceRegistryOwner {
	readonly grants: {
		captureScope(accountId: string, vaultId?: string): WebVaultCapabilityScope;
		grant(source: VaultImageSourceGrant): string;
		discard(capabilityId: string): Promise<void>;
	};
	prepare(runtimeIncarnation: string): Promise<void>;
	invoke(
		controlRequestJson: string,
		runtimeIncarnation: string,
	): Promise<VaultImageSourceAnswer>;
	beginClose(): void;
	drainClose(): Promise<void>;
}

/** Keeps the bounded registry private while replacing failed Runtime incarnations exactly once. */
export function createVaultImageSourceRegistryOwner(
	options: WebVaultImageSourceRegistryOptions = {},
): VaultImageSourceRegistryOwner {
	let registry = new WebVaultImageSourceRegistry(options);
	let attemptedPreparation = false;
	let closing = false;
	let tail = Promise.resolve();
	const prepare = (runtimeIncarnation: string) => {
		const task = tail.then(async () => {
			if (closing) throw new Error("Vault-image source registry is closing");
			if (attemptedPreparation) {
				await registry.drainClose();
				registry = new WebVaultImageSourceRegistry(options);
				if (closing) {
					registry.beginClose();
					await registry.drainClose();
					throw new Error("Vault-image source registry is closing");
				}
			}
			attemptedPreparation = true;
			await activateWebVaultImageSourceRegistry(registry, runtimeIncarnation);
		});
		tail = task.then(
			() => undefined,
			() => undefined,
		);
		return task;
	};
	const grants = {
		captureScope: (accountId: string, vaultId?: string) =>
			registry.captureScope(accountId, vaultId),
		grant: (source: VaultImageSourceGrant) => registry.grant(source),
		discard: (capabilityId: string) => registry.discard(capabilityId),
	};
	return {
		grants,
		prepare,
		invoke: (controlRequestJson, runtimeIncarnation) =>
			registry.invoke(controlRequestJson, runtimeIncarnation),
		beginClose: () => {
			closing = true;
			registry.beginClose();
		},
		drainClose: async () => {
			closing = true;
			registry.beginClose();
			await tail;
			registry.beginClose();
			await registry.drainClose();
		},
	};
}
