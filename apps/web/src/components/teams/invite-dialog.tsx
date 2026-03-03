import {
	decryptStoredVaultKey,
	type VaultKeyCryptoProvider,
} from "@bittery/shared";
import { useTRPC, useTRPCClient } from "@bittery/shared/trpc";
import {
	Badge,
	Button,
	copyWithToast,
	Dialog,
	DialogContent,
	Popover,
	PopoverContent,
	PopoverTrigger,
	DialogDescription,
	DialogFooter,
	DialogHeader,
	DialogTitle,
	DialogTrigger,
	Input,
	Label,
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
	Separator,
	toast,
} from "@bittery/ui";
import {
	IconCopyOutlineDuo18 as Copy,
	IconMoneyDollarOutlineDuo18 as Receipt,
	IconUsers6OutlineDuo18 as UserPlus,
} from "@bittery/ui/icons";
import { useMutation, useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { storage } from "@/lib/storage";
import { decrypt, rsaDecrypt, rsaEncrypt } from "@/lib/wasm-crypto";
import { useQueryInvalidator } from "../../providers/sync-provider";

interface InviteDialogProps {
	teamId: string;
}

function formatCurrency(amountCents: number, currency: string): string {
	return new Intl.NumberFormat(undefined, {
		style: "currency",
		currency: currency.toUpperCase(),
		minimumFractionDigits: 2,
		maximumFractionDigits: 2,
	}).format(amountCents / 100);
}

function formatPeriodRange(start: Date | string, end: Date | string): string {
	const startDate = new Date(start);
	const endDate = new Date(end);
	const startPart = startDate.toLocaleDateString(undefined, {
		month: "short",
		day: "numeric",
	});
	const endPart = endDate.toLocaleDateString(undefined, {
		month: "short",
		day: "numeric",
		year: "numeric",
	});
	return `${startPart} - ${endPart}`;
}

export function InviteDialog({ teamId }: InviteDialogProps) {
	const [open, setOpen] = useState(false);
	const [email, setEmail] = useState("");
	const [role, setRole] = useState<"admin" | "member">("member");
	const [inviteLink, setInviteLink] = useState<string | null>(null);
	const trpc = useTRPC();
	const trpcClient = useTRPCClient();
	const invalidator = useQueryInvalidator();

	// Query team vaults for key provisioning
	const teamVaultsQuery = useQuery({
		...trpc.team.vaults.queryOptions({ teamId }),
		enabled: open, // Only fetch when dialog is open
	});
	const billingStatusQuery = useQuery({
		...trpc.billing.status.queryOptions(),
		enabled: open,
	});
	const shouldFetchSeatPreview =
		open &&
		billingStatusQuery.data?.enabled &&
		billingStatusQuery.data.plan === "team" &&
		billingStatusQuery.data.isActive;

	const seatPreviewQuery = useQuery({
		...trpc.billing.previewAdditionalTeamSeat.queryOptions(),
		enabled: shouldFetchSeatPreview,
	});
	const seatPreview = seatPreviewQuery.data;
	const hasSeatPreview = !!(seatPreview && seatPreview.lines.length > 0);

	const inviteMutation = useMutation({
		mutationFn: async (input: {
			teamId: string;
			email: string;
			role: "admin" | "member";
		}) => {
			// First, send the invitation to get user's public key (if they exist)
			const result = await trpcClient.team.invitations.send.mutate(input);

			// If the user already exists and has a public key, we need to provision vault keys
			if (result.existingUserPublicKey && teamVaultsQuery.data) {
				const pendingVaultKeys: Array<{
					vaultId: string;
					encryptedVaultKey: string;
				}> = [];

				// For each team vault, decrypt the key and re-encrypt with invitee's public key
				for (const vault of teamVaultsQuery.data) {
					if (vault.encryptedVaultKey) {
						try {
							// Decrypt vault key with our MUK
							const vaultKey = await decryptStoredVaultKey({
								encryptedVaultKey: vault.encryptedVaultKey,
								storage,
								crypto: {
									decrypt,
									rsaDecrypt,
								} as VaultKeyCryptoProvider,
							});

							// Convert vault key to base64 string for RSA encryption
							const vaultKeyBase64 = btoa(
								String.fromCharCode(...new Uint8Array(vaultKey)),
							);

							// Encrypt with invitee's RSA public key
							const encryptedForInvitee = await rsaEncrypt(
								vaultKeyBase64,
								result.existingUserPublicKey,
							);

							pendingVaultKeys.push({
								vaultId: vault.id,
								encryptedVaultKey: encryptedForInvitee,
							});
						} catch (err) {
							console.error(
								`Failed to provision vault key for vault ${vault.id}:`,
								err,
							);
						}
					}
				}

				// If we have vault keys to provision, update the invitation
				if (pendingVaultKeys.length > 0) {
					// Cancel the existing invitation and create a new one with vault keys
					await trpcClient.team.invitations.cancel.mutate({
						invitationId: result.invitationId,
					});
					return trpcClient.team.invitations.send.mutate({
						...input,
						pendingVaultKeys,
					});
				}
			}

			return result;
		},
		onSuccess: async (data) => {
			const url = `${window.location.origin}/invite/${data.token}`;
			setInviteLink(url);
			toast.success("Invitation created. Copy the invite link to share.");
			await invalidator.invalidateTeam();
		},
		onError: (error: Error) => {
			toast.error(error.message);
		},
	});

	const handleSubmit = (e: React.FormEvent) => {
		e.preventDefault();
		if (!email.trim()) return;
		inviteMutation.mutate({ teamId, email: email.trim(), role });
	};

	const handleOpenChange = (nextOpen: boolean) => {
		setOpen(nextOpen);
		if (!nextOpen) {
			setEmail("");
			setRole("member");
			setInviteLink(null);
		}
	};

	return (
		<Dialog open={open} onOpenChange={handleOpenChange}>
			<DialogTrigger asChild>
				<Button>
					<UserPlus className="mr-2 h-4 w-4" />
					Invite Member
				</Button>
			</DialogTrigger>
			<DialogContent className="max-h-[85vh] overflow-y-auto">
				<form onSubmit={handleSubmit}>
					<DialogHeader>
						<DialogTitle>Invite Member</DialogTitle>
						<DialogDescription>
							Send an invitation to join this team.
						</DialogDescription>
					</DialogHeader>
					<div className="grid gap-4 py-4">
						<div className="grid gap-2">
							<Label htmlFor="email">Email Address</Label>
							<Input
								id="email"
								type="email"
								value={email}
								onChange={(e) => setEmail(e.target.value)}
								placeholder="colleague@example.com"
								autoFocus
							/>
						</div>
						<div className="grid gap-2">
							<Label htmlFor="role">Role</Label>
							<Select
								value={role}
								onValueChange={(v: "admin" | "member") => setRole(v)}
							>
								<SelectTrigger>
									<SelectValue />
								</SelectTrigger>
								<SelectContent>
									<SelectItem value="member">Member</SelectItem>
									<SelectItem value="admin">Admin</SelectItem>
								</SelectContent>
							</Select>
							<p className="text-muted-foreground text-xs">
								Admins can invite members and manage team settings.
							</p>
						</div>
						{hasSeatPreview && seatPreview && (
							<div className="rounded-lg border bg-muted/30 p-4">
								<div className="mb-3 flex items-center gap-2.5">
									<div className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md bg-primary/10">
										<Receipt className="h-4 w-4 text-primary" />
									</div>
									<div className="flex min-w-0 flex-1 items-center justify-between">
										<p className="font-medium text-sm">Billing impact</p>
										<Badge variant="secondary" className="font-normal text-[11px] tabular-nums">
											{seatPreview.currentQuantity} &rarr; {seatPreview.nextQuantity} seats
										</Badge>
									</div>
								</div>
								<Separator className="mb-3" />
								<div className="flex items-end justify-between gap-3">
									<div className="space-y-0.5">
										<p className="text-muted-foreground text-xs">Estimated next invoice</p>
										<p className="text-lg font-semibold leading-tight tracking-tight tabular-nums">
											{formatCurrency(
												seatPreview.estimatedNextPaymentCents,
												seatPreview.currency,
											)}
										</p>
									</div>
									<Popover>
										<PopoverTrigger asChild>
											<Button type="button" variant="outline" size="sm" className="h-7 text-xs">
												View breakdown
											</Button>
										</PopoverTrigger>
										<PopoverContent
											align="end"
											side="bottom"
											sideOffset={8}
											className="max-h-[70vh] w-[min(26rem,calc(100vw-2rem))] overflow-y-auto overscroll-contain p-0"
											onWheel={(event) => event.stopPropagation()}
										>
											<div className="border-b px-4 py-3">
												<p className="font-medium text-sm">Invoice preview</p>
												<p className="mt-0.5 text-muted-foreground text-xs">
													Adding 1 seat ({seatPreview.currentQuantity} &rarr;{" "}
													{seatPreview.nextQuantity})
												</p>
											</div>
											<div className="divide-y">
												{seatPreview.lines.map((line) => (
													<div key={line.id} className="flex items-start gap-3 px-4 py-3">
														<div className="min-w-0 flex-1 space-y-0.5">
															<p className="truncate text-sm">{line.description}</p>
															<p className="text-muted-foreground text-xs">
																{formatPeriodRange(line.periodStart, line.periodEnd)}
															</p>
															<p className="text-muted-foreground text-xs">
																{line.isProration
																	? `Seats ${seatPreview.currentQuantity} → ${seatPreview.nextQuantity}`
																	: line.quantity !== null
																		? `Quantity ${line.quantity}`
																		: ""}
																{line.unitAmountCents !== null &&
																	line.quantity !== null &&
																	line.quantity > 0
																	? ` · ${formatCurrency(line.unitAmountCents, line.currency)} each`
																	: ""}
															</p>
														</div>
														<p className="shrink-0 font-medium text-sm tabular-nums">
															{formatCurrency(line.amountCents, line.currency)}
														</p>
													</div>
												))}
											</div>
											<div className="flex items-center justify-between border-t bg-muted/40 px-4 py-3">
												<p className="font-medium text-sm">Total</p>
												<p className="font-semibold text-sm tabular-nums">
													{formatCurrency(
														seatPreview.totalLineItemsCents,
														seatPreview.currency,
													)}
												</p>
											</div>
										</PopoverContent>
									</Popover>
								</div>
							</div>
						)}
						{inviteLink && (
							<div className="rounded-md border bg-muted/40 p-3">
								<p className="mb-2 font-medium text-sm">Invite Link</p>
								<p className="break-all text-muted-foreground text-xs">
									{inviteLink}
								</p>
								<Button
									type="button"
									variant="outline"
									size="sm"
									className="mt-3"
									onClick={() =>
										copyWithToast(inviteLink, "Invite link", {
											showAutoClearMessage: false,
										})
									}
								>
									<Copy className="mr-2 h-4 w-4" />
									Copy link
								</Button>
							</div>
						)}
					</div>
					<DialogFooter>
						<Button
							type="button"
							variant="outline"
							onClick={() => setOpen(false)}
						>
							Cancel
						</Button>
						<Button type="submit" disabled={inviteMutation.isPending}>
							{inviteMutation.isPending ? "Sending..." : "Create Invitation"}
						</Button>
					</DialogFooter>
				</form>
			</DialogContent>
		</Dialog>
	);
}
