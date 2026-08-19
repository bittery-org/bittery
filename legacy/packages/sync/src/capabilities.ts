import type { ItemSyncCommand } from "@bittery/types";

export interface IQueryInvalidator {
	invalidateItem(itemId: string, vaultId: string): Promise<void>;
	invalidateVaultList(vaultId: string): Promise<void>;
	invalidateVaultKeys(): Promise<void>;
	invalidateDeletedItems(vaultId: string): Promise<void>;
	invalidateTeam(): Promise<void>;
	invalidateTeamInvitations(): Promise<void>;
	invalidateShare(itemId: string): Promise<void>;
	invalidateVaultMembers(vaultId: string): Promise<void>;
}

export interface IPendingMutationQueue {
	enqueue(
		mutation: ItemSyncCommand,
		applyOptimistic?: () => Promise<void>,
	): Promise<void>;
	getPendingCount?(): number;
	hasPendingForItem?(itemId: string): boolean;
	getCommands?(accountId?: string): ItemSyncCommand[];
}

export interface ISyncContext {
	clientId: string;
	isConnected: boolean;
	isOnline: boolean;
	invalidator: IQueryInvalidator;
	outboundQueue: IPendingMutationQueue;
}
