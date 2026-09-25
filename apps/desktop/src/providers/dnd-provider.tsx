import { useMoveItem } from "@bittery/core/hooks";
import type { DecryptedItem } from "@bittery/shared/types";
import { type DropVaultData, ItemDragPreview, toast } from "@bittery/ui";
import {
	DndContext,
	type DragEndEvent,
	DragOverlay,
	type DragStartEvent,
	PointerSensor,
	useSensor,
	useSensors,
} from "@dnd-kit/core";
import { useNavigate } from "@tanstack/react-router";
import { createContext, type ReactNode, useContext, useState } from "react";
import { readCurrentAuthServerUrl } from "../lib/auth-server";
import {
	type DesktopPrivateDragItemData,
	privateMoveData,
} from "../lib/legacy-item-move";
import { useI18n } from "../providers/i18n-provider";

interface DndContextValue {
	activeItem: DecryptedItem | null;
	isDragging: boolean;
}

const VaultDndContext = createContext<DndContextValue>({
	activeItem: null,
	isDragging: false,
});

export function useVaultDnd() {
	return useContext(VaultDndContext);
}

interface VaultDndProviderProps {
	children: ReactNode;
}

export function VaultDndProvider({ children }: VaultDndProviderProps) {
	const { m } = useI18n();
	const [activeItem, setActiveItem] = useState<DecryptedItem | null>(null);
	const [sourceVaultId, setSourceVaultId] = useState<string | null>(null);
	const [sourceAccountId, setSourceAccountId] = useState<string | null>(null);
	const moveItem = useMoveItem();
	const navigate = useNavigate();

	// Configure pointer sensor with activation distance to prevent accidental drags
	const sensors = useSensors(
		useSensor(PointerSensor, {
			activationConstraint: {
				distance: 8,
			},
		}),
	);

	function handleDragStart(event: DragStartEvent) {
		const data = event.active.data.current as
			| DesktopPrivateDragItemData
			| undefined;
		if (data?.type === "vault-item") {
			setActiveItem(data.item);
			setSourceVaultId(data.sourceVaultId);
			setSourceAccountId(data.accountId);
		}
	}

	function handleDragEnd(event: DragEndEvent) {
		const { over } = event;

		// Reset state
		const draggedItem = activeItem;
		const draggedSourceVaultId = sourceVaultId;
		const draggedSourceAccountId = sourceAccountId;
		setActiveItem(null);
		setSourceVaultId(null);
		setSourceAccountId(null);

		// If no valid drop target, do nothing
		if (
			!over ||
			!draggedItem ||
			!draggedSourceVaultId ||
			!draggedSourceAccountId
		) {
			return;
		}

		const dropData = over.data.current as DropVaultData | undefined;

		// Validate drop target
		if (dropData?.type !== "vault") {
			return;
		}

		const targetVaultId = dropData.vaultId;

		// Don't do anything if dropping on the same vault
		if (targetVaultId === draggedSourceVaultId) {
			return;
		}

		// Don't allow dropping on read-only vaults
		if (dropData.role === "read-only") {
			return;
		}

		// Perform the move with toast and navigation callbacks
		moveItem.mutate(
			{
				itemId: draggedItem.id,
				sourceVaultId: draggedSourceVaultId,
				targetVaultId,
				category: draggedItem.category,
				decryptedData: privateMoveData(draggedItem),
				accountId: draggedSourceAccountId,
				targetAccountId: dropData.accountId,
			},
			{
				onSuccess: (result) => {
					if (result.crossAccount) {
						toast.info(
							m.vaults_detail_items_move_dialog_toast_cross_account_pending(),
						);
					} else {
						toast.success(m.vaults_dnd_move_success());
						navigate({
							to: "/vault/$id/$itemId",
							params: { id: targetVaultId, itemId: draggedItem.id },
						});
					}
				},
				onError: (error) => {
					const errorMessage =
						error instanceof Error ? error.message : m.vaults_dnd_move_error();
					toast.error(errorMessage);
				},
			},
		);
	}

	function handleDragCancel() {
		setActiveItem(null);
		setSourceVaultId(null);
	}

	return (
		<VaultDndContext.Provider value={{ activeItem, isDragging: !!activeItem }}>
			<DndContext
				sensors={sensors}
				onDragStart={handleDragStart}
				onDragEnd={handleDragEnd}
				onDragCancel={handleDragCancel}
			>
				{children}
				<DragOverlay>
					{activeItem && (
						<ItemDragPreview
							item={activeItem}
							defaultServerUrl={readCurrentAuthServerUrl()}
						/>
					)}
				</DragOverlay>
			</DndContext>
		</VaultDndContext.Provider>
	);
}
