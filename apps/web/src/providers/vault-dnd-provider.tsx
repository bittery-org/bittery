import { useRuntimeSession } from "@bittery/client-runtime/react";
import type { DecryptedItem } from "@bittery/shared/types";
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
import { createContext, type ReactNode, useContext } from "react";
import { useAccountPresentationState } from "@/hooks/use-account-presentation-state";
import { useMoveItem } from "@/hooks/use-runtime-item-mutations";
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
	const session = useRuntimeSession();
	const [drag, setDrag, readDrag] = useAccountPresentationState<{
		item: DecryptedItem;
		sourceVaultId: string;
		accountId: string;
	}>(session.state === "unlocked" ? session.accountId : null);
	const activeItem = drag?.item ?? null;
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
			setDrag({
				item: data.item,
				sourceVaultId: data.sourceVaultId,
				accountId: data.accountId,
			});
		}
	}

	function handleDragEnd(event: DragEndEvent) {
		const { over } = event;

		const current = readDrag();
		const draggedItem = current?.item;
		const draggedSourceVaultId = current?.sourceVaultId;
		const draggedSourceAccountId = current?.accountId;
		setDrag(null);

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

		moveItem.mutate(
			{
				itemId: draggedItem.id,
				targetVaultId,
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
		setDrag(null);
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
