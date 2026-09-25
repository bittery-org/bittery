import {
	useRuntimeClient,
	useRuntimeSession,
} from "@bittery/client-runtime/react";
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
	IconCircleCheck as Check,
	IconLoaderCircle as Loader2,
	IconSearch as Search,
	IconUsers as UserPlus,
} from "@bittery/ui/icons";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useMemo, useRef, useState } from "react";
import { useI18n } from "@/providers/i18n-provider";
import { useRecipientKeyVerification } from "@/providers/recipient-key-verification-provider";
import { useQueryInvalidator } from "../../providers/transitional-sync-provider";

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

	const runtime = useRuntimeClient();
	const queryClient = useQueryClient();
	const session = useRuntimeSession();
	const accountId = session.state === "unlocked" ? session.accountId : null;
	const active = useRef<AbortController | null>(null);
	const verification = useRecipientKeyVerification();
	const invalidator = useQueryInvalidator();
	const { m } = useI18n();

	const availableQuery = useQuery({
		queryKey: ["runtime", "availableVaultMembers", accountId, vaultId],
		queryFn: ({ signal }) => {
			if (!accountId) throw new Error("No unlocked Account");
			return runtime.listAvailableVaultMembers(
				{ accountId, vaultId },
				{ signal },
			);
		},
		enabled: open && accountId !== null,
	});
	useEffect(() => {
		if (!accountId) active.current?.abort();
		return () => active.current?.abort();
	}, [accountId]);

	const filteredMembers = useMemo(() => {
		const members = availableQuery.data ?? [];
		if (!search.trim()) return members;
		const q = search.toLowerCase();
		return members.filter(
			(m) =>
				m.name.toLowerCase().includes(q) || m.email.toLowerCase().includes(q),
		);
	}, [availableQuery.data, search]);

	const handleAddMember = async (member: {
		userId: string;
		publicKey: string;
		email: string;
	}) => {
		const controller = new AbortController();
		active.current = controller;
		setAddingUserId(member.userId);

		try {
			await verification.run(async (gesture) => {
				await gesture.approvedKey({
					recipientUserId: member.userId,
					publicKey: member.publicKey,
					label: member.email,
				});
				const role = selectedRoles[member.userId] ?? "member";
				await gesture.checkActive();
				const result = await runtime.addVaultMember(
					{
						accountId: gesture.accountId,
						vaultId,
						userId: member.userId,
						role,
					},
					{ signal: gesture.signal },
				);
				if (result.type === "vaultMemberAddUncertain") {
					toast.error(m.vaults_add_member_dialog_toast_add_uncertain());
					await queryClient.invalidateQueries({
						queryKey: ["runtime", "vaultMembers", gesture.accountId, vaultId],
					});
					await invalidator.invalidateVaultMembers(vaultId);
					await availableQuery.refetch();
					return;
				}
				setAddedUserIds((prev) => new Set([...prev, member.userId]));
				toast.success(m.vaults_add_member_dialog_toast_member_added());
				await queryClient.invalidateQueries({
					queryKey: ["runtime", "vaultMembers", gesture.accountId, vaultId],
				});
				await invalidator.invalidateVaultMembers(vaultId);
				await availableQuery.refetch();
			}, controller.signal);
		} catch {
			if (!controller.signal.aborted)
				toast.error(m.vaults_add_member_dialog_toast_add_failed());
		} finally {
			if (active.current === controller) active.current = null;
			setAddingUserId(null);
		}
	};

	const handleOpenChange = (newOpen: boolean) => {
		setOpen(newOpen);
		if (!newOpen) {
			active.current?.abort();
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
			? m.vaults_add_member_dialog_footer_available_single({
					filteredCount: filteredMembers.length,
					totalCount: availableCount,
				})
			: m.vaults_add_member_dialog_footer_available_plural({
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
					{!isMobile ? m.vaults_add_member_dialog_trigger() : null}
				</Button>
			</DialogTrigger>
			<DialogContent className="flex max-h-[70vh] flex-col gap-0 p-0 sm:max-w-md">
				<DialogHeader className="border-b px-5 pt-5 pb-4">
					<DialogTitle>{m.vaults_add_member_dialog_title()}</DialogTitle>
					<DialogDescription>
						{m.vaults_add_member_dialog_description()}
					</DialogDescription>
				</DialogHeader>

				{/* Search */}
				<div className="border-b px-4 py-3">
					<div className="relative">
						<Search className="absolute top-1/2 left-3 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
						<Input
							placeholder={m.vaults_add_member_dialog_search_placeholder()}
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
									? m.vaults_add_member_dialog_empty_all_members_added()
									: m.vaults_add_member_dialog_empty_no_search_matches()}
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
															{m.vaults_common_role_admin()}
														</SelectItem>
														<SelectItem value="member">
															{m.vaults_common_role_member()}
														</SelectItem>
														<SelectItem value="read-only">
															{m.vaults_common_role_read_only()}
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
													{m.vaults_add_member_dialog_badge_added()}
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
														m.vaults_add_member_dialog_action_add()
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
