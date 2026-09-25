/** Opaque selection identity; only its registry can capture or validate it. */
declare const selectionScope: unique symbol;
export interface WebVaultCapabilityScope {
	readonly [selectionScope]: true;
}
type Capture = {
	owner: object;
	accountId: string;
	accountEpoch: number;
	vaultId?: string;
	vaultEpoch: number;
};
type VaultEpoch = { epoch: number; retired: boolean };

/** Platform capability epochs only. Core supplies retirement and re-admission decisions. */
export class WebVaultCapabilityScopes {
	readonly #captures = new WeakMap<WebVaultCapabilityScope, Capture>();
	readonly #accounts = new Map<string, number>();
	readonly #vaults = new Map<string, Map<string, VaultEpoch>>();
	readonly #reserve: (additional: number) => void;
	#owner = {};
	constructor(options: { reserve(additional: number): void }) {
		this.#reserve = options.reserve;
	}
	get size(): number {
		return [...this.#vaults.values()].reduce(
			(sum, values) => sum + values.size,
			0,
		);
	}
	/** Account epochs occupy the registry's existing Account slot, retained until reset. */
	hasAccount(accountId: string): boolean {
		return this.#accounts.has(accountId);
	}
	capture(
		accountId: string,
		vaultId?: string,
		additionalIdentities = 0,
	): WebVaultCapabilityScope {
		if (
			!validId(accountId) ||
			(vaultId !== undefined && !validId(vaultId)) ||
			(vaultId !== undefined &&
				this.#vaults.get(accountId)?.get(vaultId)?.retired)
		)
			throw new Error("Capability selection is retired or invalid");
		const vaults = this.#vaults.get(accountId);
		const newVault = vaultId !== undefined && !vaults?.has(vaultId);
		this.#reserve(additionalIdentities + (newVault ? 1 : 0));
		if (newVault && vaultId !== undefined) {
			const retained = vaults ?? new Map<string, VaultEpoch>();
			retained.set(vaultId, { epoch: 0, retired: false });
			this.#vaults.set(accountId, retained);
		}
		if (!this.#accounts.has(accountId)) this.#accounts.set(accountId, 0);
		const scope = Object.freeze({}) as WebVaultCapabilityScope;
		this.#captures.set(scope, {
			owner: this.#owner,
			accountId,
			accountEpoch: this.#accounts.get(accountId) ?? 0,
			vaultId,
			vaultEpoch:
				vaultId === undefined
					? 0
					: (this.#vaults.get(accountId)?.get(vaultId)?.epoch ?? 0),
		});
		return scope;
	}
	matches(
		scope: WebVaultCapabilityScope,
		accountId: string,
		vaultId?: string,
	): boolean {
		const captured = this.#captures.get(scope);
		const vault =
			vaultId === undefined
				? undefined
				: this.#vaults.get(accountId)?.get(vaultId);
		return (
			captured !== undefined &&
			captured.owner === this.#owner &&
			captured.accountId === accountId &&
			captured.vaultId === vaultId &&
			captured.accountEpoch === (this.#accounts.get(accountId) ?? 0) &&
			captured.vaultEpoch === (vault?.epoch ?? 0) &&
			!vault?.retired
		);
	}
	retire(accountId: string, vaultIds: string[]): void {
		const ids = validateTargets(accountId, vaultIds);
		const current = this.#vaults.get(accountId);
		this.#reserve(ids.filter((id) => !current?.has(id)).length);
		for (const id of ids) {
			const value = current?.get(id);
			if (value && !value.retired && value.epoch === Number.MAX_SAFE_INTEGER)
				throw new Error("Vault capability generation exhausted");
		}
		if (ids.length === 0) return;
		const values = current ?? new Map<string, VaultEpoch>();
		this.#vaults.set(accountId, values);
		for (const id of ids) {
			const value = values.get(id);
			if (!value?.retired)
				values.set(id, { epoch: (value?.epoch ?? 0) + 1, retired: true });
		}
	}
	isRetired(accountId: string, vaultId: string): boolean {
		return this.#vaults.get(accountId)?.get(vaultId)?.retired === true;
	}
	complete(accountId: string, vaultIds: string[]): void {
		for (const id of validateTargets(accountId, vaultIds)) {
			const value = this.#vaults.get(accountId)?.get(id);
			if (value) value.retired = false;
		}
	}
	invalidateAccount(accountId: string): void {
		if (!validId(accountId))
			throw new Error("Capability Account identity is invalid");
		if (!this.#accounts.has(accountId)) return;
		const epoch = this.#accounts.get(accountId) ?? 0;
		if (epoch === Number.MAX_SAFE_INTEGER)
			throw new Error("Account capability generation exhausted");
		this.#accounts.set(accountId, epoch + 1);
	}
	forgetAccount(accountId: string): void {
		this.invalidateAccount(accountId);
		this.#vaults.delete(accountId);
	}
	reset(): void {
		this.#owner = {};
		this.#accounts.clear();
		this.#vaults.clear();
	}
}
function validId(value: string): boolean {
	return typeof value === "string" && /^[A-Za-z0-9._~-]{1,128}$/.test(value);
}
function validateTargets(accountId: string, vaultIds: string[]): string[] {
	if (!validId(accountId) || vaultIds.some((id) => !validId(id)))
		throw new Error("Vault capability identities are invalid");
	return [...new Set(vaultIds)];
}
