import { maskCardNumber } from "@bittery/shared/credit-card";
import type { DecryptedItem } from "@bittery/shared/types";
import { useDraggable } from "@dnd-kit/core";
import { useNavigate } from "@tanstack/react-router";
import { Smartphone, Star } from "lucide-react";
import type { DragItemData } from "../../providers/dnd-provider";
import { Favicon } from "./favicon";
import { VaultAvatar } from "./vault-avatar";

interface VaultInfo {
	name: string;
	icon: string | null;
	imageUrl: string | null;
}

interface ItemListRowProps {
	item: DecryptedItem & {
		vault?: VaultInfo;
		account?: { email: string; userId: string; name: string };
	};
	isSelected: boolean;
	onToggleFavorite: (e: React.MouseEvent) => void;
	linkTo: string;
	linkParams: Record<string, string>;
	showVaultBadge?: boolean;
	showAccountBadge?: boolean;
	accountEmail?: string;
	vaultId: string;
}

export function ItemListRow({
	item,
	isSelected,
	onToggleFavorite,
	linkTo,
	linkParams,
	showVaultBadge = false,
	showAccountBadge = false,
	accountEmail,
	vaultId,
}: ItemListRowProps) {
	const navigate = useNavigate();
	const maskedCardNumber = item.cardNumber
		? maskCardNumber(item.cardNumber)
		: undefined;

	const dragData: DragItemData = {
		type: "vault-item",
		item,
		sourceVaultId: vaultId,
	};

	const { attributes, listeners, setNodeRef, isDragging } = useDraggable({
		id: `item-${item.id}`,
		data: dragData,
	});

	const handleClick = () => {
		// Only navigate if not dragging
		if (!isDragging) {
			navigate({ to: linkTo, params: linkParams });
		}
	};

	return (
		// biome-ignore lint/a11y/noStaticElementInteractions: its fine here
		<div
			ref={setNodeRef}
			{...listeners}
			{...attributes}
			onClick={handleClick}
			onKeyDown={(e) => {
				if (e.key === "Enter" || e.key === " ") {
					handleClick();
				}
			}}
			className={`mb-1 w-full cursor-pointer rounded-md px-3 py-2.5 text-left transition-colors ${
				isSelected ? "bg-muted/60" : "hover:bg-muted/30"
			} ${isDragging ? "opacity-50" : ""}`}
		>
			<div className="flex min-w-0 items-center gap-3">
				<Favicon
					url={item.url}
					title={item.title}
					category={item.category}
					size="sm"
				/>
				<div className="min-w-0 flex-1">
					<div className="flex items-center gap-1.5">
						<span className="truncate font-medium text-sm">{item.title}</span>
						{item.category === "login" && item.totpSecret && (
							<span title="Has 2FA">
								<Smartphone className="size-3 shrink-0 text-primary" />
							</span>
						)}
					</div>
					{item.username && (
						<div className="mt-0.5 truncate text-muted-foreground text-xs">
							{item.username}
						</div>
					)}
					{maskedCardNumber && (
						<div className="mt-0.5 truncate text-muted-foreground text-xs">
							{maskedCardNumber}
						</div>
					)}
					{showVaultBadge && item.vault && (
						<div className="mt-0.5 flex items-center gap-1 text-muted-foreground/70 text-xs">
							<VaultAvatar
								name={item.vault.name}
								icon={item.vault.icon}
								imageUrl={item.vault.imageUrl}
								size="xs"
							/>
							<span className="truncate">{item.vault.name}</span>
						</div>
					)}
					{showAccountBadge && (accountEmail || item.account) && (
						<div className="mt-0.5 flex items-center gap-1 text-muted-foreground/70 text-xs">
							<span className="truncate">
								{accountEmail || item.account?.email}
							</span>
						</div>
					)}
				</div>
				<button
					type="button"
					onClick={(e) => {
						e.stopPropagation();
						onToggleFavorite(e);
					}}
					className={`shrink-0 ${
						item.favorite
							? "text-yellow-500 hover:text-yellow-600"
							: "text-muted-foreground hover:text-yellow-500"
					}`}
				>
					<Star
						className="size-4"
						fill={item.favorite ? "currentColor" : "none"}
					/>
				</button>
			</div>
		</div>
	);
}
