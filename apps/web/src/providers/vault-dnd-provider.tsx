import { useMoveItem } from "@bittery/core/hooks";
import type { DecryptedItem, DecryptedItemData } from "@bittery/shared/types";
import {
	type DragItemData,
	type DropVaultData,
	ItemDragPreview,
	toast,
} from "@bittery/ui";
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
import { getServerUrl } from "@/lib/auth-server";
import { useI18n } from "@/providers/i18n-provider";

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
			setSourceAccountId(data.accountId);
		}
	}

	function handleDragEnd(event: DragEndEvent) {
		const { over } = event;

		const draggedItem = activeItem;
		const draggedSourceVaultId = sourceVaultId;
		const draggedSourceAccountId = sourceAccountId;
		setActiveItem(null);
		setSourceVaultId(null);
		setSourceAccountId(null);

		if (
			!over ||
			!draggedItem ||
			!draggedSourceVaultId ||
			!draggedSourceAccountId
		) {
			return;
		}

		const dropData = over.data.current as DropVaultData | undefined;

		if (dropData?.type !== "vault") {
			return;
		}

		const targetVaultId = dropData.vaultId;

		if (targetVaultId === draggedSourceVaultId) {
			return;
		}

		if (dropData.role === "read-only") {
			return;
		}

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

		moveItem.mutate(
			{
				itemId: draggedItem.id,
				sourceVaultId: draggedSourceVaultId,
				targetVaultId,
				category: draggedItem.category,
				decryptedData,
				accountId: draggedSourceAccountId,
				targetAccountId: dropData.accountId,
			},
			{
				onSuccess: () => {
					toast.success(m.vaults_dnd_move_success());
					navigate({
						to: "/vaults/$vaultId",
						params: { vaultId: targetVaultId },
					});
				},
				onError: (error) => {
					console.error("[VaultDnd] move failed:", error);
					toast.error(
						error instanceof Error && error.message
							? error.message
							: m.vaults_dnd_move_error(),
					);
				},
			},
		);
	}

	function handleDragCancel() {
		setActiveItem(null);
		setSourceVaultId(null);
		setSourceAccountId(null);
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
							defaultServerUrl={getServerUrl()}
						/>
					)}
				</DragOverlay>
			</DndContext>
		</VaultDndContext.Provider>
	);
}
