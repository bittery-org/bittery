import { useMoveItem } from "@bittery/core/hooks";
import type { DecryptedItem, DecryptedItemData } from "@bittery/shared/types";
import { toast } from "@bittery/ui";
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
import { ItemDragPreview } from "../components/vault/item-drag-preview";

/**
 * Data attached to draggable items
 */
export interface DragItemData {
	type: "vault-item";
	item: DecryptedItem;
	sourceVaultId: string;
}

/**
 * Data attached to droppable vault targets
 */
export interface DropVaultData {
	type: "vault";
	vaultId: string;
	role: string;
}

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
	const [activeItem, setActiveItem] = useState<DecryptedItem | null>(null);
	const [sourceVaultId, setSourceVaultId] = useState<string | null>(null);
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
		const data = event.active.data.current as DragItemData | undefined;
		if (data?.type === "vault-item") {
			setActiveItem(data.item);
			setSourceVaultId(data.sourceVaultId);
		}
	}

	function handleDragEnd(event: DragEndEvent) {
		const { over } = event;

		// Reset state
		const draggedItem = activeItem;
		const draggedSourceVaultId = sourceVaultId;
		setActiveItem(null);
		setSourceVaultId(null);

		// If no valid drop target, do nothing
		if (!over || !draggedItem || !draggedSourceVaultId) {
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

		// Extract decrypted data from the item (everything except metadata)
		const decryptedData: DecryptedItemData = {
			title: draggedItem.title,
			url: draggedItem.url,
			urls: draggedItem.urls,
			username: draggedItem.username,
			password: draggedItem.password,
			notes: draggedItem.notes,
			note: draggedItem.note,
			customFields: draggedItem.customFields,
			tags: draggedItem.tags,
			cardholderName: draggedItem.cardholderName,
			cardNumber: draggedItem.cardNumber,
			cvv: draggedItem.cvv,
			expiryDate: draggedItem.expiryDate,
			billingAddress: draggedItem.billingAddress,
			firstName: draggedItem.firstName,
			middleName: draggedItem.middleName,
			lastName: draggedItem.lastName,
			email: draggedItem.email,
			addresses: draggedItem.addresses,
			phoneNumbers: draggedItem.phoneNumbers,
			ssn: draggedItem.ssn,
			passportNumber: draggedItem.passportNumber,
			driversLicense: draggedItem.driversLicense,
			dateOfBirth: draggedItem.dateOfBirth,
			totpSecret: draggedItem.totpSecret,
			totpIssuer: draggedItem.totpIssuer,
			totpAccountName: draggedItem.totpAccountName,
			totpAlgorithm: draggedItem.totpAlgorithm,
			totpDigits: draggedItem.totpDigits,
			totpPeriod: draggedItem.totpPeriod,
			linkedItemId: draggedItem.linkedItemId,
		};

		// Perform the move with toast and navigation callbacks
		moveItem.mutate(
			{
				itemId: draggedItem.id,
				sourceVaultId: draggedSourceVaultId,
				targetVaultId,
				category: draggedItem.category,
				decryptedData,
			},
			{
				onSuccess: (result) => {
					if (result.crossAccount) {
						toast.success("Item transferred to other account successfully");
						// For cross-account transfers, use the new item ID
						navigate({
							to: "/vault/$id/$itemId",
							params: {
								id: targetVaultId,
								itemId: result.newItemId || draggedItem.id,
							},
						});
					} else {
						toast.success("Item moved successfully");
						// Navigate to the item in the target vault
						navigate({
							to: "/vault/$id/$itemId",
							params: { id: targetVaultId, itemId: draggedItem.id },
						});
					}
				},
				onError: (error) => {
					const errorMessage =
						error instanceof Error ? error.message : "Failed to move item";
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
					{activeItem && <ItemDragPreview item={activeItem} />}
				</DragOverlay>
			</DndContext>
		</VaultDndContext.Provider>
	);
}
