/**
 * M1-C6 — item list for one vault. Pushed from `/vault`; each row navigates to
 * `/vault/$id/$itemId`. No virtualisation: the spike measured ~51ms to decrypt 2 000 items, so a
 * plain list is fine for M1.
 */

import { useVaultInfo, useVaultItems } from "@bittery/core/hooks";
import { maskCardNumber } from "@bittery/shared/credit-card";
import { Skeleton, VaultItemListRow } from "@bittery/ui";
import { IconClock, IconPasskey } from "@bittery/ui/icons";
import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { MobileScreen } from "@/components/mobile-screen";
import { Favicon } from "@/components/vault/favicon";
import { useI18n } from "@/providers/i18n-provider";

export const Route = createFileRoute("/vault/$id/")({
	component: VaultItemListScreen,
});

function ItemListSkeleton() {
	return (
		<div className="flex flex-col gap-px p-1.5">
			{[0, 1, 2, 3].map((row) => (
				<div key={row} className="flex items-center gap-2.5 px-2.5 py-2">
					<Skeleton className="size-10 rounded-lg" />
					<div className="flex-1 space-y-1.5">
						<Skeleton className="h-3.5 w-40" />
						<Skeleton className="h-3 w-24" />
					</div>
				</div>
			))}
		</div>
	);
}

function VaultItemListScreen() {
	const { m } = useI18n();
	const navigate = useNavigate();
	const { id } = Route.useParams();
	const { vaultInfo } = useVaultInfo(id);
	const { items, isLoading } = useVaultItems(id);

	return (
		<MobileScreen
			title={vaultInfo?.vaultName ?? m.mob_vault_items_fallback_title()}
			backLabel={m.mob_common_go_back()}
			onBack={() => navigate({ to: "/vault" })}
		>
			{isLoading ? (
				<ItemListSkeleton />
			) : items.length === 0 ? (
				<div className="flex h-full flex-col items-center justify-center gap-1 p-8 text-center">
					<h2 className="font-semibold text-lg">
						{m.mob_vault_items_empty_no_items()}
					</h2>
					<p className="text-muted-foreground text-sm">
						{m.mob_vault_items_empty_description()}
					</p>
				</div>
			) : (
				<div className="flex flex-col gap-px p-1.5">
					{items.map((item) => {
						const maskedCardNumber = item.cardNumber
							? maskCardNumber(item.cardNumber)
							: undefined;
						const hasPasskeys =
							item.category === "login" && (item.passkeys?.length ?? 0) > 0;

						return (
							<VaultItemListRow
								key={item.id}
								itemTitle={item.title}
								ariaLabel={m.vaults_detail_items_list_item_action_select({
									title: item.title,
								})}
								leadingVisual={<Favicon item={item} size="sm" />}
								indicators={
									<>
										{item.category === "login" && item.totpSecret && (
											<IconClock className="size-3 shrink-0 text-muted-foreground" />
										)}
										{hasPasskeys && (
											<IconPasskey className="size-3 shrink-0 text-muted-foreground" />
										)}
									</>
								}
								secondaryText={item.username}
								tertiaryText={maskedCardNumber}
								// Mobile has no side-by-side selected pane — the row navigates instead.
								isSelected={false}
								onPrimaryAction={() =>
									navigate({
										to: "/vault/$id/$itemId",
										params: { id, itemId: item.id },
									})
								}
							/>
						);
					})}
				</div>
			)}
		</MobileScreen>
	);
}
