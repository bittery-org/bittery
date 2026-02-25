import { useAllVaultKeys, useItems } from "@bittery/core/hooks";
import { Badge, Skeleton } from "@bittery/ui";
import {
	IconKeyOutlineDuo18 as Key,
	IconLockOutlineDuo18 as Lock,
	IconUsers6OutlineDuo18 as Users,
	IconVault3OutlineDuo18 as Vault,
} from "@bittery/ui/icons";
import { createFileRoute, Link } from "@tanstack/react-router";
import { useMemo } from "react";

export const Route = createFileRoute("/_app/vaults/")({
	component: VaultsPage,
	head: () => ({
		meta: [{ title: "Vaults - Bittery" }],
	}),
});

function VaultsPage() {
	const { vaultKeys, isLoading } = useAllVaultKeys();
	const { items } = useItems();

	// Build per-vault item counts from local decrypted items
	const itemCountByVault = useMemo(() => {
		const map = new Map<string, number>();
		for (const item of items) {
			map.set(item.vaultId, (map.get(item.vaultId) || 0) + 1);
		}
		return map;
	}, [items]);

	const totalItems = items.length;
	const totalVaults = vaultKeys.length;

	return (
		<div className="mx-auto flex w-full max-w-6xl flex-col gap-6 pb-3">
			{/* Hero Banner */}
			<section className="relative overflow-hidden rounded-2xl border bg-card p-6 sm:p-7">
				<div className="pointer-events-none absolute inset-0 bg-gradient-to-br from-muted/60 via-transparent to-transparent" />
				<div className="pointer-events-none absolute -top-24 right-0 h-56 w-56 rounded-full bg-muted/50 blur-3xl" />

				<div className="relative flex flex-col gap-6 lg:flex-row lg:items-end lg:justify-between">
					<div className="space-y-4">
						<Badge variant="secondary" className="w-fit">
							<Vault className="mr-1 h-3.5 w-3.5" />
							Vaults
						</Badge>
						<div className="space-y-2">
							<h1 className="text-balance font-bold text-3xl tracking-tight md:text-4xl">
								Your Vaults
							</h1>
							<p className="max-w-2xl text-muted-foreground">
								Browse and manage your encrypted password vaults.
							</p>
						</div>
						{!isLoading && totalVaults > 0 && (
							<div className="flex flex-wrap items-center gap-2 text-muted-foreground text-xs">
								<div className="inline-flex items-center gap-1.5 rounded-md border bg-background/70 px-2.5 py-1">
									<Lock className="h-3.5 w-3.5" />
									{totalVaults} vault{totalVaults !== 1 ? "s" : ""}
								</div>
								<div className="inline-flex items-center gap-1.5 rounded-md border bg-background/70 px-2.5 py-1">
									<Key className="h-3.5 w-3.5" />
									{totalItems} item{totalItems !== 1 ? "s" : ""} total
								</div>
							</div>
						)}
					</div>
				</div>
			</section>

			{/* Vault Grid */}
			{isLoading ? (
				<div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
					{[1, 2, 3].map((i) => (
						<Skeleton key={i} className="h-36 rounded-xl" />
					))}
				</div>
			) : totalVaults === 0 ? (
				<div className="flex flex-col items-center gap-3 rounded-xl border border-dashed p-10 text-center">
					<div className="flex h-12 w-12 items-center justify-center rounded-full bg-muted">
						<Vault className="h-6 w-6 text-muted-foreground" />
					</div>
					<div>
						<h3 className="font-medium text-lg">No vaults yet</h3>
						<p className="mt-1 text-muted-foreground text-sm">
							Create a vault in the desktop app to get started.
						</p>
					</div>
				</div>
			) : (
				<div className="space-y-3">
					<div className="flex flex-col gap-1 sm:flex-row sm:items-end sm:justify-between">
						<h2 className="font-semibold text-lg tracking-tight">
							All Vaults
						</h2>
						<p className="text-muted-foreground text-sm">
							Click a vault to view items and manage access.
						</p>
					</div>
					<div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
						{vaultKeys.map((vault) => {
							const itemCount = itemCountByVault.get(vault.vaultId) || 0;
							return (
								<Link
									key={vault.vaultId}
									to="/vaults/$vaultId"
									params={{ vaultId: vault.vaultId }}
									className="group"
								>
									<div className="relative overflow-hidden rounded-xl border bg-card p-5 transition-all duration-200 hover:-translate-y-0.5 hover:shadow-md">
										<div className="absolute top-0 left-0 h-full w-1 rounded-l-xl bg-primary/80" />
										<div className="flex items-start justify-between">
											<div className="flex items-center gap-3">
												<div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-muted">
													{vault.vaultType === "team" ? (
														<Users className="h-5 w-5 text-muted-foreground" />
													) : (
														<Lock className="h-5 w-5 text-muted-foreground" />
													)}
												</div>
												<div className="min-w-0">
													<h3 className="truncate font-semibold leading-tight">
														{vault.vaultName}
													</h3>
													<p className="mt-0.5 text-muted-foreground text-xs capitalize">
														{vault.vaultType} vault
													</p>
												</div>
											</div>
											<Badge
												variant={
													vault.role === "owner" ? "default" : "secondary"
												}
												className="shrink-0"
											>
												{vault.role}
											</Badge>
										</div>
										<div className="mt-4 flex items-center gap-3 text-muted-foreground text-xs">
											<div className="flex items-center gap-1">
												<Key className="h-3.5 w-3.5" />
												{itemCount} item{itemCount !== 1 ? "s" : ""}
											</div>
										</div>
									</div>
								</Link>
							);
						})}
					</div>
				</div>
			)}
		</div>
	);
}
