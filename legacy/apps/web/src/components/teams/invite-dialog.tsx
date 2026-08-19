import { useCoreContext, usePlatformCrypto } from "@bittery/core/hooks";
import {
	formatDate,
	formatCurrency as formatLocalizedCurrency,
} from "@bittery/i18n/format/browser";
import { useApiClient } from "@bittery/shared/api";
import { apiQueries } from "@bittery/shared/api-query";
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
	IconCopy as Copy,
	IconBanknote as Receipt,
	IconUsers as UserPlus,
} from "@bittery/ui/icons";
import { useMutation, useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { useI18n } from "@/providers/i18n-provider";
import { useQueryInvalidator } from "../../providers/sync-provider";

interface InviteDialogProps {
	teamId: string;
}

type TeamMessageCatalog = ReturnType<typeof useI18n>["m"];

function formatCurrencyFromCents(
	amountCents: number | bigint | string,
	currency: string,
): string {
	return formatLocalizedCurrency(
		Number(amountCents) / 100,
		currency.toUpperCase(),
		{
			minimumFractionDigits: 2,
			maximumFractionDigits: 2,
		},
	);
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

function getSeatCountLabel(
	count: number | bigint | string,
	m: TeamMessageCatalog,
): string {
	const normalizedCount = Number(count);
	return normalizedCount === 1
		? m.team_invite_dialog_seat_count_single({ count: normalizedCount })
		: m.team_invite_dialog_seat_count_plural({ count: normalizedCount });
}

export function InviteDialog({ teamId }: InviteDialogProps) {
	const [open, setOpen] = useState(false);
	const [email, setEmail] = useState("");
	const [role, setRole] = useState<"admin" | "member">("member");
	const [inviteLink, setInviteLink] = useState<string | null>(null);
	const api = useApiClient();
	const crypto = usePlatformCrypto();
	const { vaultCrypto } = useCoreContext();
	const invalidator = useQueryInvalidator();
	const { m } = useI18n();

	// Query team vaults for key provisioning
	const teamVaultsQuery = useQuery({
		...apiQueries.teams.vaults(api, teamId),
		enabled: open, // Only fetch when dialog is open
	});
	const billingStatusQuery = useQuery({
		...apiQueries.billing.status(api),
		enabled: open,
	});
	const shouldFetchSeatPreview =
		open &&
		billingStatusQuery.data?.enabled &&
		billingStatusQuery.data.plan === "team" &&
		billingStatusQuery.data.isActive;

	const seatPreviewQuery = useQuery({
		queryKey: ["api", "v1", "billing", "team-seats", "addition-preview"],
		queryFn: async () => (await api.billing.seatAdditionPreview()).data,
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
			const result = (
				await api.teams.invitations.send(input.teamId, {
					email: input.email,
					role: input.role,
					pendingVaultKeys: null,
				})
			).data;

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
							const vaultKey = await vaultCrypto.unwrapStoredVaultKey({
								encryptedVaultKey: vault.encryptedVaultKey,
								vaultId: vault.id,
							});

							// Sealed to the invitee's public key without the key material
							// leaving the backend; the ref is still ours to retire.
							try {
								pendingVaultKeys.push({
									vaultId: vault.id,
									encryptedVaultKey: await crypto.encryptVaultKeyForMember(
										vaultKey,
										result.existingUserPublicKey,
									),
								});
							} finally {
								await crypto.destroyKey(vaultKey);
							}
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
					await api.teams.invitations.cancel(input.teamId, result.invitationId);
					return (
						await api.teams.invitations.send(input.teamId, {
							email: input.email,
							role: input.role,
							pendingVaultKeys,
						})
					).data;
				}
			}

			return result;
		},
		onSuccess: async (data) => {
			const url = `${window.location.origin}/invite/${data.token}`;
			setInviteLink(url);
			toast.success(m.team_invite_dialog_toast_created());
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
				<Button size="sm" className="h-8 px-2 sm:px-3">
					<UserPlus className="mr-1.5 h-3.5 w-3.5" />
					<span className="text-xs">{m.team_invite_dialog_trigger()}</span>
				</Button>
			</DialogTrigger>
			<DialogContent
				className="max-h-[85vh] overflow-y-auto"
				data-testid="invite-dialog"
			>
				{(() => {
					const seatDelta = seatPreview
						? Number(seatPreview.nextQuantity) -
							Number(seatPreview.currentQuantity)
						: 0;
					return (
						<form onSubmit={handleSubmit}>
							<DialogHeader>
								<DialogTitle>{m.team_invite_dialog_title()}</DialogTitle>
								<DialogDescription>
									{m.team_invite_dialog_description()}
								</DialogDescription>
							</DialogHeader>
							<div className="grid gap-4 py-4">
								<div className="grid gap-2">
									<Label htmlFor="email">
										{m.team_invite_dialog_field_email()}
									</Label>
									<Input
										id="email"
										type="email"
										value={email}
										onChange={(e) => setEmail(e.target.value)}
										placeholder={m.team_invite_dialog_placeholder_email()}
										autoFocus
									/>
								</div>
								<div className="grid gap-2">
									<Label htmlFor="role">
										{m.team_invite_dialog_field_role()}
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
												{m.team_role_member()}
											</SelectItem>
											<SelectItem value="admin">
												{m.team_role_admin()}
											</SelectItem>
										</SelectContent>
									</Select>
									<p className="text-muted-foreground text-xs">
										{m.team_invite_dialog_hint_role()}
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
													{m.team_invite_dialog_billing_impact_title()}
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
													{m.team_invite_dialog_billing_impact_estimated_invoice()}
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
														{m.team_invite_dialog_billing_impact_view_breakdown()}
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
															{m.team_invite_dialog_invoice_preview_title()}
														</p>
														<p className="mt-0.5 text-muted-foreground text-xs">
															{seatDelta === 1
																? m.team_invite_dialog_invoice_preview_adding_seats_single(
																		{
																			count: seatDelta,
																			currentQuantity: Number(
																				seatPreview.currentQuantity,
																			),
																			nextQuantity: Number(
																				seatPreview.nextQuantity,
																			),
																		},
																	)
																: m.team_invite_dialog_invoice_preview_adding_seats_plural(
																		{
																			count: seatDelta,
																			currentQuantity: Number(
																				seatPreview.currentQuantity,
																			),
																			nextQuantity: Number(
																				seatPreview.nextQuantity,
																			),
																		},
																	)}
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
																			? m.team_invite_dialog_invoice_preview_line_seats_change(
																					{
																						currentQuantity: Number(
																							seatPreview.currentQuantity,
																						),
																						nextQuantity: Number(
																							seatPreview.nextQuantity,
																						),
																					},
																				)
																			: line.quantity != null
																				? m.team_invite_dialog_invoice_preview_line_quantity(
																						{ quantity: Number(line.quantity) },
																					)
																				: ""}
																		{(line.isProration ||
																			line.quantity != null) &&
																		line.unitAmountCents != null &&
																		line.quantity != null &&
																		Number(line.quantity) > 0
																			? " · "
																			: ""}
																		{line.unitAmountCents != null &&
																		line.quantity != null &&
																		Number(line.quantity) > 0
																			? m.team_invite_dialog_invoice_preview_line_each(
																					{
																						amount: formatCurrencyFromCents(
																							line.unitAmountCents,
																							line.currency,
																						),
																					},
																				)
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
															{m.team_invite_dialog_invoice_preview_total()}
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
											{m.team_invite_dialog_invite_link_title()}
										</p>
										<p
											className="break-all text-muted-foreground text-xs"
											data-testid="invite-link-value"
										>
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
													m.team_invite_dialog_invite_link_copy_label(),
													{
														showAutoClearMessage: false,
													},
												)
											}
										>
											<Copy className="mr-2 h-4 w-4" />
											{m.team_invite_dialog_invite_link_copy_button()}
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
									{m.team_common_action_cancel()}
								</Button>
								<Button
									type="submit"
									disabled={inviteMutation.isPending}
									data-testid="invite-submit-button"
								>
									{inviteMutation.isPending
										? m.team_invite_dialog_button_sending()
										: m.team_invite_dialog_button_create_invitation()}
								</Button>
							</DialogFooter>
						</form>
					);
				})()}
			</DialogContent>
		</Dialog>
	);
}
