import { maskCardNumber } from "@bittery/shared/credit-card";
import type { DecryptedItem } from "@bittery/shared/types";
import { Link } from "@tanstack/react-router";
import { Smartphone, Star } from "lucide-react";
import { Favicon } from "./favicon";
import { VaultAvatar } from "./vault-avatar";

interface VaultInfo {
	name: string;
	icon: string | null;
	imageUrl: string | null;
}

interface ItemListRowProps {
	item: DecryptedItem & { vault?: VaultInfo };
	isSelected: boolean;
	onToggleFavorite: (e: React.MouseEvent) => void;
	linkTo: string;
	linkParams: Record<string, string>;
	showVaultBadge?: boolean;
}

export function ItemListRow({
	item,
	isSelected,
	onToggleFavorite,
	linkTo,
	linkParams,
	showVaultBadge = false,
}: ItemListRowProps) {
	const maskedCardNumber = item.cardNumber
		? maskCardNumber(item.cardNumber)
		: undefined;

	return (
		<Link
			to={linkTo}
			params={linkParams}
			className={`mb-1 w-full rounded-md px-3 py-2.5 text-left transition-colors ${
				isSelected ? "bg-muted/60" : "hover:bg-muted/30"
			}`}
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
				</div>
				<button
					type="button"
					onClick={onToggleFavorite}
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
		</Link>
	);
}
