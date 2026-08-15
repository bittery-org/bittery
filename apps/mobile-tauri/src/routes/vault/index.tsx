/**
 * M1-C6 — vault list. The landing screen after unlock: the active account's email plus a
 * reachable Lock button (the M1 "lock" acceptance criterion), then every vault the account has,
 * each showing its item count. Tapping a vault pushes `/vault/$id`.
 */

import { useAllVaultKeys, useItemCounts, useItems } from "@bittery/core/hooks";
import { Button, Skeleton, VaultAvatar } from "@bittery/ui";
import { IconChevronRight, IconLock } from "@bittery/ui/icons";
import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useAccount } from "@/contexts/account-context";
import { useI18n } from "@/providers/i18n-provider";

export const Route = createFileRoute("/vault/")({
	component: VaultListScreen,
});

function VaultListSkeleton() {
	return (
		<div className="flex flex-col gap-1 p-2">
			{[0, 1, 2].map((row) => (
				<div key={row} className="flex min-h-14 items-center gap-3 px-3 py-2">
					<Skeleton className="size-10 rounded-lg" />
					<div className="flex-1 space-y-1.5">
						<Skeleton className="h-3.5 w-32" />
						<Skeleton className="h-3 w-16" />
					</div>
				</div>
			))}
		</div>
	);
}

function VaultListScreen() {
	const { m } = useI18n();
	const navigate = useNavigate();
	const { activeAccount, lockAllAccounts } = useAccount();
	const { vaultKeys, isLoading: isLoadingVaults } = useAllVaultKeys();
	// One item subscription feeds every vault's count — same shape as desktop's sidebar
	// (apps/desktop/src/routes/vault/route.tsx).
	const { items, isLoading: isLoadingItems } = useItems();
	const itemCounts = useItemCounts(isLoadingItems ? undefined : items);

	const handleLock = async () => {
		await lockAllAccounts();
		navigate({ to: "/unlock" });
	};

	return (
		<div
			className="flex w-full flex-col overflow-hidden"
			style={{
				height: "calc(100dvh - var(--safe-top) - var(--safe-bottom))",
			}}
		>
			<header className="sticky top-0 z-10 flex min-h-14 shrink-0 items-center justify-between gap-3 border-b bg-background px-4 py-2">
				<p className="min-w-0 truncate font-semibold text-base">
					{activeAccount?.email ?? m.mob_settings_account_fallback()}
				</p>
				<Button
					type="button"
					variant="outline"
					size="sm"
					className="h-11 shrink-0 gap-1.5 px-3"
					onClick={() => void handleLock()}
				>
					<IconLock className="size-4" />
					{m.mob_settings_lock_vault()}
				</Button>
			</header>

			<div
				className="flex-1 overflow-y-auto"
				style={{ overscrollBehavior: "contain" }}
			>
				{isLoadingVaults ? (
					<VaultListSkeleton />
				) : vaultKeys.length === 0 ? (
					<div className="flex h-full flex-col items-center justify-center gap-1 p-8 text-center">
						<h2 className="font-semibold text-lg">
							{m.mob_vaults_empty_title()}
						</h2>
						<p className="text-muted-foreground text-sm">
							{m.mob_vaults_empty_description()}
						</p>
					</div>
				) : (
					<div className="flex flex-col gap-1 p-2">
						{vaultKeys.map((vault) => {
							const count = itemCounts?.byVault[vault.vaultId] ?? 0;
							return (
								<button
									key={vault.vaultId}
									type="button"
									onClick={() =>
										navigate({
											to: "/vault/$id",
											params: { id: vault.vaultId },
										})
									}
									className="flex min-h-14 w-full items-center gap-3 rounded-lg px-3 py-2 text-left active:bg-foreground/5"
								>
									<VaultAvatar
										name={vault.vaultName}
										icon={vault.vaultIcon}
										imageUrl={vault.vaultImageUrl}
										size="md"
									/>
									<div className="min-w-0 flex-1">
										<p className="truncate font-medium text-sm">
											{vault.vaultName}
										</p>
										<p className="truncate text-muted-foreground text-xs">
											{count === 1
												? m.mob_item_count_singular({ count: String(count) })
												: m.mob_item_count_plural({ count: String(count) })}
										</p>
									</div>
									<IconChevronRight className="size-4 shrink-0 text-muted-foreground" />
								</button>
							);
						})}
					</div>
				)}
			</div>
		</div>
	);
}
