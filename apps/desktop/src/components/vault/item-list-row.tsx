import { maskCardNumber } from "@bittery/shared/credit-card";
import type { DecryptedItem } from "@bittery/shared/types";
import { cn } from "@bittery/ui";
import {
	IconMobileOutlineDuo18,
	IconStarOutlineDuo18,
} from "@bittery/ui/icons";
import { useDraggable } from "@dnd-kit/core";
import { useNavigate } from "@tanstack/react-router";
import type { DragItemData } from "../../providers/dnd-provider";
import { Favicon } from "./favicon";

interface ItemListRowProps {
	item: DecryptedItem;
	isSelected: boolean;
	onToggleFavorite: (e: React.MouseEvent) => void;
	linkTo: string;
	linkParams: Record<string, string>;
	vaultId: string;
}

export function ItemListRow({
	item,
	isSelected,
	onToggleFavorite,
	linkTo,
	linkParams,
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
			className={cn(
				"mb-1 w-full cursor-pointer rounded-md px-3 py-2.5 text-left transition-colors",
				isSelected
					? "bg-primary text-primary-foreground"
					: "hover:bg-primary/10",
				isDragging && "opacity-50",
			)}
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
								<IconMobileOutlineDuo18 className="size-3 shrink-0 text-primary-foreground" />
							</span>
						)}
					</div>
					{item.username && (
						<div
							className={cn(
								"mt-0.5 truncate text-xs",
								isSelected
									? "text-primary-foreground"
									: "text-muted-foreground",
							)}
						>
							{item.username}
						</div>
					)}
					{maskedCardNumber && (
						<div
							className={cn(
								"mt-0.5 truncate text-xs",
								isSelected
									? "text-primary-foreground"
									: "text-muted-foreground",
							)}
						>
							{maskedCardNumber}
						</div>
					)}
				</div>
				<button
					type="button"
					onClick={(e) => {
						e.stopPropagation();
						onToggleFavorite(e);
					}}
					className={cn(
						"shrink-0",
						item.favorite
							? "text-yellow-400 hover:text-yellow-500"
							: isSelected
								? "text-primary-foreground/60 hover:text-yellow-400"
								: "text-muted-foreground hover:text-yellow-500",
					)}
				>
					<IconStarOutlineDuo18
						className="size-4"
						fill={item.favorite ? "currentColor" : "none"}
					/>
				</button>
			</div>
		</div>
	);
}
