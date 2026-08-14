import type { AccountSessionManagerOptions } from "./account-session-manager";
import { AccountSessionManager } from "./account-session-manager";
import { AccountVaultRuntime } from "./account-vault-runtime";
import type { VaultRepository } from "./vault-repository";

export interface ClientRuntimeOptions extends AccountSessionManagerOptions {
	vaultRepository: VaultRepository;
}

/** Owns one client's account state and local Vault projection. */
export class ClientRuntime {
	readonly accounts: AccountSessionManager;
	readonly vaultRuntime: AccountVaultRuntime;
	private started = false;

	constructor(options: ClientRuntimeOptions) {
		this.accounts = new AccountSessionManager(options);
		this.vaultRuntime = new AccountVaultRuntime(
			this.accounts,
			options.vaultRepository,
		);
	}

	start(): void {
		if (this.started) return;
		this.started = true;
		this.vaultRuntime.start();
	}

	dispose(): void {
		if (!this.started) return;
		this.started = false;
		this.vaultRuntime.dispose();
	}
}
