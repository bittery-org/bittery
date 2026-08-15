/**
 * M1-C6 — item detail. Read-only: `ItemDetail` (`@bittery/ui`) renders the category-specific
 * fields and its own copy affordances (`handleCopy`, wired through `../../../lib/clipboard-bridge`
 * at boot). No edit, delete, passkey removal, tags, sharing or attachments — those are all
 * optional props on `ItemDetail` and are left unset so it renders without their affordances.
 */

import { useItem, useVaultInfo } from "@bittery/core/hooks";
import { detectCardBrand } from "@bittery/shared/credit-card";
import { getItemServerUrl } from "@bittery/shared/favicon";
import { ItemDetail, Skeleton } from "@bittery/ui";
import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { MobileScreen } from "@/components/mobile-screen";
import { Favicon } from "@/components/vault/favicon";
import { useI18n } from "@/providers/i18n-provider";

export const Route = createFileRoute("/vault/$id/$itemId/")({
	component: ItemDetailScreen,
});

function ItemDetailSkeleton() {
	return (
		<div className="space-y-4 px-4 py-4">
			<div className="flex items-center gap-4">
				<Skeleton className="size-12 rounded-lg" />
				<div className="flex-1 space-y-1.5">
					<Skeleton className="h-4 w-40" />
					<Skeleton className="h-3 w-24" />
				</div>
			</div>
			<Skeleton className="h-32 w-full rounded-lg" />
		</div>
	);
}

function ItemDetailScreen() {
	const { m } = useI18n();
	const navigate = useNavigate();
	const { id, itemId } = Route.useParams();
	const { vaultInfo } = useVaultInfo(id);
	const { rawItem, decryptedData, isLoading } = useItem(itemId);

	const canRender = !isLoading && rawItem && decryptedData;

	return (
		<MobileScreen
			title={
				decryptedData?.title ??
				vaultInfo?.vaultName ??
				m.mob_vault_items_fallback_title()
			}
			backLabel={m.mob_common_go_back()}
			onBack={() => navigate({ to: "/vault/$id", params: { id } })}
		>
			<div className="px-4 py-4">
				{!canRender ? (
					isLoading ? (
						<ItemDetailSkeleton />
					) : (
						<div className="flex flex-col items-center justify-center gap-1 p-8 text-center">
							<h2 className="font-semibold text-lg">
								{m.mob_detail_not_found()}
							</h2>
						</div>
					)
				) : (
					<ItemDetail
						category={rawItem.category}
						data={decryptedData}
						icon={
							<Favicon
								url={
									rawItem.category === "login" ? decryptedData.url : undefined
								}
								title={decryptedData.title}
								serverUrl={getItemServerUrl(rawItem)}
								category={rawItem.category}
								cardBrand={
									rawItem.category === "credit-card" &&
									"cardNumber" in decryptedData &&
									decryptedData.cardNumber
										? detectCardBrand(decryptedData.cardNumber)
										: undefined
								}
								size="lg"
							/>
						}
					/>
				)}
			</div>
		</MobileScreen>
	);
}
