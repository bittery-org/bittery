import {
	getDecryptedVaultKey,
	type VaultKeyCryptoProvider,
} from "@bittery/shared";
import { useTRPC, useTRPCClient } from "@bittery/shared/trpc";
import {
	Avatar,
	AvatarFallback,
	Badge,
	Button,
	cn,
	Dialog,
	DialogContent,
	DialogDescription,
	DialogHeader,
	DialogTitle,
	DialogTrigger,
	Input,
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
	toast,
	useSidebar,
} from "@bittery/ui";
import {
	IconCircleCheck2OutlineDuo18 as Check,
	IconLoader2OutlineDuo18 as Loader2,
	IconMagnifier3OutlineDuo18 as Search,
	IconUsers6OutlineDuo18 as UserPlus,
} from "@bittery/ui/icons";
import { useMutation, useQuery } from "@tanstack/react-query";
import { useMemo, useState } from "react";
import { storage } from "@/lib/storage";
import {
	arrayBufferToBase64,
	decrypt,
	rsaDecrypt,
	rsaEncrypt,
} from "@/lib/wasm-crypto";
import { useI18n } from "@/providers/i18n-provider";
import { useQueryInvalidator } from "../../providers/sync-provider";

interface AddMemberDialogProps {
	vaultId: string;
}

export function AddMemberDialog({ vaultId }: AddMemberDialogProps) {
	const { isMobile } = useSidebar();
	const [open, setOpen] = useState(false);
	const [search, setSearch] = useState("");
	const [addingUserId, setAddingUserId] = useState<string | null>(null);
	const [addedUserIds, setAddedUserIds] = useState<Set<string>>(new Set());
	const [selectedRoles, setSelectedRoles] = useState<
		Record<string, "admin" | "member" | "read-only">
	>({});

	const trpc = useTRPC();
	const trpcClient = useTRPCClient();
	const invalidator = useQueryInvalidator();
	const { m } = useI18n();

	// Fetch available team members (not already in vault)
	const availableQuery = useQuery({
		...trpc.vault.members.availableTeamMembers.queryOptions({ vaultId }),
		enabled: open,
	});

	const filteredMembers = useMemo(() => {
		const members = availableQuery.data ?? [];
		if (!search.trim()) return members;
		const q = search.toLowerCase();
		return members.filter(
			(m) =>
				m.name.toLowerCase().includes(q) || m.email.toLowerCase().includes(q),
		);
	}, [availableQuery.data, search]);

	const addMemberMutation = useMutation({
		mutationFn: async (input: {
			vaultId: string;
			userId: string;
			role: "admin" | "member" | "read-only";
			encryptedVaultKey: string;
		}) => trpcClient.vault.members.add.mutate(input),
		onSuccess: async (_data, variables) => {
			setAddedUserIds((prev) => new Set([...prev, variables.userId]));
			setAddingUserId(null);
			toast.success(m["vaults.add_member_dialog.toast.member_added"]());
			await invalidator.invalidateVaultMembers(vaultId);
			availableQuery.refetch();
		},
		onError: () => {
			setAddingUserId(null);
			toast.error(m["vaults.add_member_dialog.toast.add_failed"]());
		},
	});

	const handleAddMember = async (member: {
		userId: string;
		publicKey: string;
	}) => {
		setAddingUserId(member.userId);

		try {
			const vaultKey = await getDecryptedVaultKey({
				vaultId,
				storage,
				crypto: {
					decrypt,
					rsaDecrypt,
				} as VaultKeyCryptoProvider,
			});
			if (!vaultKey) {
				toast.error(m["vaults.add_member_dialog.toast.decrypt_key_failed"]());
				setAddingUserId(null);
				return;
			}

			const vaultKeyBase64 = arrayBufferToBase64(vaultKey);
			const encryptedVaultKey = await rsaEncrypt(
				vaultKeyBase64,
				member.publicKey,
			);

			const role = selectedRoles[member.userId] ?? "member";
			addMemberMutation.mutate({
				vaultId,
				userId: member.userId,
				role,
				encryptedVaultKey,
			});
		} catch (error) {
			toast.error(m["vaults.add_member_dialog.toast.encrypt_key_failed"]());
			console.error(error);
			setAddingUserId(null);
		}
	};

	const handleOpenChange = (newOpen: boolean) => {
		setOpen(newOpen);
		if (!newOpen) {
			setSearch("");
			setAddingUserId(null);
			setAddedUserIds(new Set());
			setSelectedRoles({});
		}
	};

	const getInitials = (name: string) =>
		name
			.split(" ")
			.map((n) => n[0])
			.join("")
			.toUpperCase()
			.slice(0, 2);

	const availableCount = availableQuery.data?.length ?? 0;
	const availableMemberSummary =
		availableCount === 1
			? m["vaults.add_member_dialog.footer.available.single"]({
					filteredCount: filteredMembers.length,
					totalCount: availableCount,
				})
			: m["vaults.add_member_dialog.footer.available.plural"]({
					filteredCount: filteredMembers.length,
					totalCount: availableCount,
				});

	return (
		<Dialog open={open} onOpenChange={handleOpenChange}>
			<DialogTrigger asChild>
				<Button
					size="sm"
					variant="outline"
					className="h-8 px-2 text-xs lg:px-3"
				>
					<UserPlus
						className={cn("h-3.5 w-3.5", !isMobile ? "mr-1.5" : undefined)}
					/>
					{!isMobile ? m["vaults.add_member_dialog.trigger"]() : null}
				</Button>
			</DialogTrigger>
			<DialogContent className="flex max-h-[70vh] flex-col gap-0 p-0 sm:max-w-md">
				<DialogHeader className="border-b px-5 pt-5 pb-4">
					<DialogTitle>{m["vaults.add_member_dialog.title"]()}</DialogTitle>
					<DialogDescription>
						{m["vaults.add_member_dialog.description"]()}
					</DialogDescription>
				</DialogHeader>

				{/* Search */}
				<div className="border-b px-4 py-3">
					<div className="relative">
						<Search className="absolute top-1/2 left-3 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
						<Input
							placeholder={m["vaults.add_member_dialog.search_placeholder"]()}
							value={search}
							onChange={(e) => setSearch(e.target.value)}
							className="h-9 pl-9 text-sm"
						/>
					</div>
				</div>

				{/* Members List */}
				<div className="min-h-0 flex-1 overflow-y-auto">
					{availableQuery.isLoading ? (
						<div className="flex flex-col gap-3 p-4">
							{Array.from({ length: 3 }).map((_, i) => (
								<div key={`skeleton-${i}`} className="flex items-center gap-3">
									<div className="h-9 w-9 animate-pulse rounded-full bg-muted" />
									<div className="flex-1 space-y-1.5">
										<div className="h-3.5 w-28 animate-pulse rounded bg-muted" />
										<div className="h-3 w-40 animate-pulse rounded bg-muted" />
									</div>
								</div>
							))}
						</div>
					) : filteredMembers.length === 0 ? (
						<div className="flex flex-col items-center gap-2 px-4 py-10 text-center">
							<UserPlus className="h-8 w-8 text-muted-foreground/50" />
							<p className="text-muted-foreground text-sm">
								{availableCount === 0
									? m["vaults.add_member_dialog.empty.all_members_added"]()
									: m["vaults.add_member_dialog.empty.no_search_matches"]()}
							</p>
						</div>
					) : (
						<div className="divide-y">
							{filteredMembers.map((member) => {
								const isAdding = addingUserId === member.userId;
								const isAdded = addedUserIds.has(member.userId);
								const selectedRole = selectedRoles[member.userId] ?? "member";

								return (
									<div
										key={member.userId}
										className={cn(
											"flex items-center gap-3 px-4 py-3 transition-colors",
											isAdded ? "bg-primary/5" : "hover:bg-muted/50",
										)}
									>
										<Avatar className="h-9 w-9 shrink-0">
											<AvatarFallback className="font-medium text-xs">
												{getInitials(member.name)}
											</AvatarFallback>
										</Avatar>
										<div className="min-w-0 flex-1">
											<div className="truncate font-medium text-sm leading-tight">
												{member.name}
											</div>
											<div className="truncate text-muted-foreground text-xs">
												{member.email}
											</div>
										</div>
										<div className="flex shrink-0 items-center gap-2">
											{!isAdded && (
												<Select
													value={selectedRole}
													onValueChange={(
														value: "admin" | "member" | "read-only",
													) =>
														setSelectedRoles((prev) => ({
															...prev,
															[member.userId]: value,
														}))
													}
													disabled={isAdding}
												>
													<SelectTrigger className="h-7 w-26 text-xs">
														<SelectValue />
													</SelectTrigger>
													<SelectContent>
														<SelectItem value="admin">
															{m["vaults.common.role.admin"]()}
														</SelectItem>
														<SelectItem value="member">
															{m["vaults.common.role.member"]()}
														</SelectItem>
														<SelectItem value="read-only">
															{m["vaults.common.role.read_only"]()}
														</SelectItem>
													</SelectContent>
												</Select>
											)}
											{isAdded ? (
												<Badge
													variant="secondary"
													className="gap-1 px-2 py-0.5 text-xs"
												>
													<Check className="h-3 w-3" />
													{m["vaults.add_member_dialog.badge.added"]()}
												</Badge>
											) : (
												<Button
													size="sm"
													variant="outline"
													className="h-7 px-2.5 text-xs"
													onClick={() => handleAddMember(member)}
													disabled={isAdding || addingUserId !== null}
												>
													{isAdding ? (
														<Loader2 className="h-3.5 w-3.5 animate-spin" />
													) : (
														m["vaults.add_member_dialog.action.add"]()
													)}
												</Button>
											)}
										</div>
									</div>
								);
							})}
						</div>
					)}
				</div>

				{/* Footer */}
				{availableCount > 0 && !availableQuery.isLoading && (
					<div className="border-t px-4 py-3">
						<p className="text-muted-foreground text-xs">
							{availableMemberSummary}
						</p>
					</div>
				)}
			</DialogContent>
		</Dialog>
	);
}
