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
	DialogDescription,
	DialogFooter,
	DialogHeader,
	DialogTitle,
	DialogTrigger,
	Input,
	Label,
	Popover,
	PopoverContent,
	PopoverTrigger,
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
import {
	formatDate,
	formatCurrency as formatLocalizedCurrency,
} from "@/lib/i18n-format";
import { storage } from "@/lib/storage";
import { decrypt, rsaDecrypt, rsaEncrypt } from "@/lib/wasm-crypto";
import { useI18n } from "@/providers/i18n-provider";
import { useQueryInvalidator } from "../../providers/sync-provider";

interface InviteDialogProps {
	teamId: string;
}

type TeamMessageCatalog = ReturnType<typeof useI18n>["m"];

function formatCurrencyFromCents(
	amountCents: number,
	currency: string,
): string {
	return formatLocalizedCurrency(amountCents / 100, currency.toUpperCase(), {
		minimumFractionDigits: 2,
		maximumFractionDigits: 2,
	});
}

function formatPeriodRange(start: Date | string, end: Date | string): string {
	const startPart = formatDate(start, {
		month: "short",
		day: "numeric",
	});
	const endPart = formatDate(end, {
		month: "short",
		day: "numeric",
		year: "numeric",
	});
	return `${startPart} - ${endPart}`;
}

function getSeatCountLabel(count: number, m: TeamMessageCatalog): string {
	return count === 1
		? m["team.invite_dialog.seat_count.single"]({ count })
		: m["team.invite_dialog.seat_count.plural"]({ count });
}

export function InviteDialog({ teamId }: InviteDialogProps) {
	const [open, setOpen] = useState(false);
	const [email, setEmail] = useState("");
	const [role, setRole] = useState<"admin" | "member">("member");
	const [inviteLink, setInviteLink] = useState<string | null>(null);
	const trpc = useTRPC();
	const trpcClient = useTRPCClient();
	const invalidator = useQueryInvalidator();
	const { m } = useI18n();

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
			toast.success(m["team.invite_dialog.toast.created"]());
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
					{m["team.invite_dialog.trigger"]()}
				</Button>
			</DialogTrigger>
			<DialogContent className="max-h-[85vh] overflow-y-auto">
				<form onSubmit={handleSubmit}>
					<DialogHeader>
						<DialogTitle>{m["team.invite_dialog.title"]()}</DialogTitle>
						<DialogDescription>
							{m["team.invite_dialog.description"]()}
						</DialogDescription>
					</DialogHeader>
					<div className="grid gap-4 py-4">
						<div className="grid gap-2">
							<Label htmlFor="email">
								{m["team.invite_dialog.field.email"]()}
							</Label>
							<Input
								id="email"
								type="email"
								value={email}
								onChange={(e) => setEmail(e.target.value)}
								placeholder={m["team.invite_dialog.placeholder.email"]()}
								autoFocus
							/>
						</div>
						<div className="grid gap-2">
							<Label htmlFor="role">
								{m["team.invite_dialog.field.role"]()}
							</Label>
							<Select
								value={role}
								onValueChange={(v: "admin" | "member") => setRole(v)}
							>
								<SelectTrigger>
									<SelectValue />
								</SelectTrigger>
								<SelectContent>
									<SelectItem value="member">
										{m["team.role.member"]()}
									</SelectItem>
									<SelectItem value="admin">
										{m["team.role.admin"]()}
									</SelectItem>
								</SelectContent>
							</Select>
							<p className="text-muted-foreground text-xs">
								{m["team.invite_dialog.hint.role"]()}
							</p>
						</div>
						{hasSeatPreview && seatPreview && (
							<div className="rounded-lg border bg-muted/30 p-4">
								<div className="mb-3 flex items-center gap-2.5">
									<div className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md bg-primary/10">
										<Receipt className="h-4 w-4 text-primary" />
									</div>
									<div className="flex min-w-0 flex-1 items-center justify-between">
										<p className="font-medium text-sm">
											{m["team.invite_dialog.billing_impact.title"]()}
										</p>
										<Badge
											variant="secondary"
											className="font-normal text-[11px] tabular-nums"
										>
											{seatPreview.currentQuantity} &rarr;{" "}
											{getSeatCountLabel(seatPreview.nextQuantity, m)}
										</Badge>
									</div>
								</div>
								<Separator className="mb-3" />
								<div className="flex items-end justify-between gap-3">
									<div className="space-y-0.5">
										<p className="text-muted-foreground text-xs">
											{m[
												"team.invite_dialog.billing_impact.estimated_invoice"
											]()}
										</p>
										<p className="font-semibold text-lg tabular-nums leading-tight tracking-tight">
											{formatCurrencyFromCents(
												seatPreview.estimatedNextPaymentCents,
												seatPreview.currency,
											)}
										</p>
									</div>
									<Popover>
										<PopoverTrigger asChild>
											<Button
												type="button"
												variant="outline"
												size="sm"
												className="h-7 text-xs"
											>
												{m[
													"team.invite_dialog.billing_impact.view_breakdown"
												]()}
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
												<p className="font-medium text-sm">
													{m["team.invite_dialog.invoice_preview.title"]()}
												</p>
												<p className="mt-0.5 text-muted-foreground text-xs">
													{seatPreview.nextQuantity -
														seatPreview.currentQuantity ===
													1
														? m[
																"team.invite_dialog.invoice_preview.adding_seats.single"
															]({
																count:
																	seatPreview.nextQuantity -
																	seatPreview.currentQuantity,
																currentQuantity: seatPreview.currentQuantity,
																nextQuantity: seatPreview.nextQuantity,
															})
														: m[
																"team.invite_dialog.invoice_preview.adding_seats.plural"
															]({
																count:
																	seatPreview.nextQuantity -
																	seatPreview.currentQuantity,
																currentQuantity: seatPreview.currentQuantity,
																nextQuantity: seatPreview.nextQuantity,
															})}
												</p>
											</div>
											<div className="divide-y">
												{seatPreview.lines.map((line) => (
													<div
														key={line.id}
														className="flex items-start gap-3 px-4 py-3"
													>
														<div className="min-w-0 flex-1 space-y-0.5">
															<p className="truncate text-sm">
																{line.description}
															</p>
															<p className="text-muted-foreground text-xs">
																{formatPeriodRange(
																	line.periodStart,
																	line.periodEnd,
																)}
															</p>
															<p className="text-muted-foreground text-xs">
																{line.isProration
																	? m[
																			"team.invite_dialog.invoice_preview.line.seats_change"
																		]({
																			currentQuantity:
																				seatPreview.currentQuantity,
																			nextQuantity: seatPreview.nextQuantity,
																		})
																	: line.quantity !== null
																		? m[
																				"team.invite_dialog.invoice_preview.line.quantity"
																			]({ quantity: line.quantity })
																		: ""}
																{(line.isProration || line.quantity !== null) &&
																line.unitAmountCents !== null &&
																line.quantity !== null &&
																line.quantity > 0
																	? " · "
																	: ""}
																{line.unitAmountCents !== null &&
																line.quantity !== null &&
																line.quantity > 0
																	? m[
																			"team.invite_dialog.invoice_preview.line.each"
																		]({
																			amount: formatCurrencyFromCents(
																				line.unitAmountCents,
																				line.currency,
																			),
																		})
																	: ""}
															</p>
														</div>
														<p className="shrink-0 font-medium text-sm tabular-nums">
															{formatCurrencyFromCents(
																line.amountCents,
																line.currency,
															)}
														</p>
													</div>
												))}
											</div>
											<div className="flex items-center justify-between border-t bg-muted/40 px-4 py-3">
												<p className="font-medium text-sm">
													{m["team.invite_dialog.invoice_preview.total"]()}
												</p>
												<p className="font-semibold text-sm tabular-nums">
													{formatCurrencyFromCents(
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
								<p className="mb-2 font-medium text-sm">
									{m["team.invite_dialog.invite_link.title"]()}
								</p>
								<p className="break-all text-muted-foreground text-xs">
									{inviteLink}
								</p>
								<Button
									type="button"
									variant="outline"
									size="sm"
									className="mt-3"
									onClick={() =>
										copyWithToast(
											inviteLink,
											m["team.invite_dialog.invite_link.copy_label"](),
											{
												showAutoClearMessage: false,
											},
										)
									}
								>
									<Copy className="mr-2 h-4 w-4" />
									{m["team.invite_dialog.invite_link.copy_button"]()}
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
							{m["team.common.action.cancel"]()}
						</Button>
						<Button type="submit" disabled={inviteMutation.isPending}>
							{inviteMutation.isPending
								? m["team.invite_dialog.button.sending"]()
								: m["team.invite_dialog.button.create_invitation"]()}
						</Button>
					</DialogFooter>
				</form>
			</DialogContent>
		</Dialog>
	);
}
