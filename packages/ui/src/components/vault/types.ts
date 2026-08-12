import type { DecryptedItem } from "@bittery/shared/types";

export type { CustomField } from "@bittery/shared/types";

export interface VaultOption {
	id: string;
	name: string;
	type: "personal" | "team";
	icon?: string | null;
	imageUrl?: string | null;
	accountId?: string;
	accountEmail?: string;
	accountName?: string;
	accountTeamName?: string;
	accountTeamAvatarUrl?: string | null;
}

/** Data attached to draggable vault items via dnd-kit. */
export interface DragItemData {
	type: "vault-item";
	item: DecryptedItem;
	sourceVaultId: string;
}

/** Data attached to droppable vault drop targets via dnd-kit. */
export interface DropVaultData {
	type: "vault";
	vaultId: string;
	role: string;
}

export interface MoveItemDialogProps {
	open: boolean;
	onOpenChange: (open: boolean) => void;
	item: DecryptedItem;
	currentVaultId: string;
}

export interface DeleteVaultDialogProps {
	open: boolean;
	onOpenChange: (open: boolean) => void;
	vault: { id: string; name: string } | null;
	onConfirm: (vaultId: string) => Promise<void>;
}
