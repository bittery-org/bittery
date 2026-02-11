import { maskCardNumber } from "@bittery/shared/credit-card";
import type { DecryptedItem } from "@bittery/shared/types";
import { cn } from "@bittery/ui";
import {
	IconCircleKeyOutlineDuo18,
	IconMobileOutlineDuo18,
} from "@bittery/ui/icons";
import { useDraggable } from "@dnd-kit/core";
import { useNavigate } from "@tanstack/react-router";
import type { DragItemData } from "../../providers/dnd-provider";
import { Favicon } from "./favicon";

interface ItemListRowProps {
	item: DecryptedItem;
	isSelected: boolean;
	linkTo: string;
	linkParams: Record<string, string>;
	vaultId: string;
}

export function ItemListRow({
	item,
	isSelected,
	linkTo,
	linkParams,
	vaultId,
}: ItemListRowProps) {
	const navigate = useNavigate();
	const maskedCardNumber = item.cardNumber
		? maskCardNumber(item.cardNumber)
		: undefined;
	const hasPasskeys =
		item.category === "login" && (item.passkeys?.length ?? 0) > 0;

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
								<IconMobileOutlineDuo18
									className={cn(
										"size-3 shrink-0",
										isSelected
											? "text-primary-foreground"
											: "text-muted-foreground",
									)}
								/>
							</span>
						)}
						{hasPasskeys && (
							<span title="Has passkeys">
								<IconCircleKeyOutlineDuo18
									className={cn(
										"size-3 shrink-0",
										isSelected
											? "text-primary-foreground"
											: "text-muted-foreground",
									)}
								/>
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
			</div>
		</div>
	);
}
