import { RuntimeRequestError } from "@bittery/client-runtime/client";
import {
	useRuntimeClient,
	useRuntimeSession,
} from "@bittery/client-runtime/react";
import {
	formatDate,
	formatCurrency as formatLocalizedCurrency,
} from "@bittery/i18n/format/browser";
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
import { useEffect, useRef, useState } from "react";
import { useI18n } from "@/providers/i18n-provider";
import { useRecipientKeyVerification } from "@/providers/recipient-key-verification-provider";
import { useQueryInvalidator } from "../../providers/transitional-sync-provider";

interface InviteDialogProps {
	teamId: string;
}

type InvitationGestureResult =
	| { type: "created"; token: string }
	| { type: "createdUnprovisioned"; invitationId: string };

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
	const [unprovisionedInvitationId, setUnprovisionedInvitationId] = useState<
		string | null
	>(null);
	const runtime = useRuntimeClient();
	const session = useRuntimeSession();
	const verification = useRecipientKeyVerification();
	const invalidator = useQueryInvalidator();
	const { m } = useI18n();
	const active = useRef<{
		controller: AbortController;
		accountId?: string;
		continuationId?: string;
	} | null>(null);
	const accountId = session.state === "unlocked" ? session.accountId : null;
	const composerQuery = useQuery({
		queryKey: ["runtime", "invitationComposer", accountId, teamId],
		queryFn: ({ signal }) => {
			if (!accountId) throw new Error("No unlocked Account");
			return runtime.readInvitationComposer({ accountId, teamId }, { signal });
		},
		enabled: open && !!accountId,
	});
	const seatPreview = composerQuery.data?.seatPreview;
	const hasSeatPreview = !!(seatPreview && seatPreview.lines.length > 0);

	useEffect(() => {
		const flight = active.current;
		if (flight?.accountId && flight.accountId !== accountId) {
			flight.controller.abort();
			if (flight.continuationId)
				void runtime
					.releaseInvitationContinuation({
						accountId: flight.accountId,
						continuationId: flight.continuationId,
					})
					.catch(() => undefined);
		}
	}, [accountId, runtime]);
	useEffect(
		() => () => {
			const flight = active.current;
			flight?.controller.abort();
			if (flight?.accountId && flight.continuationId)
				void runtime
					.releaseInvitationContinuation({
						accountId: flight.accountId,
						continuationId: flight.continuationId,
					})
					.catch(() => undefined);
		},
		[runtime],
	);

	const inviteMutation = useMutation({
		mutationFn: async (input: {
			teamId: string;
			email: string;
			role: "admin" | "member";
		}): Promise<InvitationGestureResult> => {
			const flight = {
				controller: new AbortController(),
				accountId: "",
				continuationId: "",
			};
			active.current = flight;
			const progress: {
				createdPending: { invitationId: string } | null;
				provisioningStarted: boolean;
			} = { createdPending: null, provisioningStarted: false };
			try {
				return await verification.run(async (gesture) => {
					flight.accountId = gesture.accountId;
					const created = await runtime.createTeamInvitation(
						{
							accountId: gesture.accountId,
							teamId: input.teamId,
							email: input.email,
							role: input.role,
						},
						{ signal: gesture.signal },
					);
					if (created.type === "teamInvitationUncertain")
						throw new RuntimeRequestError(
							"RETRYABLE_TRANSPORT",
							m.recipient_key_invite_incomplete(),
						);
					progress.createdPending = { invitationId: created.invitationId };
					if (!created.candidate)
						return { type: "created", token: created.token };
					if (!created.continuationId)
						throw new RuntimeRequestError(
							"INVARIANT_VIOLATION",
							m.recipient_key_invite_incomplete(),
						);
					flight.continuationId = created.continuationId;
					await gesture.checkActive();
					await gesture.approvedKey({
						recipientUserId: created.candidate.recipientUserId,
						publicKey: created.candidate.publicKey,
						label: input.email,
					});
					await gesture.checkActive();
					progress.provisioningStarted = true;
					const provisioned = await runtime.provisionTeamInvitation(
						{
							accountId: gesture.accountId,
							continuationId: created.continuationId,
						},
						{ signal: gesture.signal },
					);
					if (provisioned.type === "teamInvitationProvisioningNotRequired")
						return { type: "created", token: created.token };
					if (provisioned.type === "teamInvitationUncertain")
						throw new RuntimeRequestError(
							"RETRYABLE_TRANSPORT",
							m.recipient_key_invite_incomplete(),
						);
					return { type: "created", token: provisioned.token };
				}, flight.controller.signal);
			} catch (error) {
				// The first Server send is confirmed, but the human verification
				// ended before Core could attempt any replacement. Keep that exact
				// pending Invitation distinct from a completed Vault provision.
				const currentSession = runtime.session().getSnapshot();
				if (
					progress.createdPending &&
					!progress.provisioningStarted &&
					!flight.controller.signal.aborted &&
					currentSession.state === "unlocked" &&
					currentSession.accountId === flight.accountId
				) {
					return {
						type: "createdUnprovisioned",
						invitationId: progress.createdPending.invitationId,
					};
				}
				throw error;
			} finally {
				if (flight.accountId && flight.continuationId)
					await runtime
						.releaseInvitationContinuation({
							accountId: flight.accountId,
							continuationId: flight.continuationId,
						})
						.catch(() => undefined);
				if (active.current === flight) active.current = null;
			}
		},
		onSuccess: async (data) => {
			if (data.type === "createdUnprovisioned") {
				setInviteLink(null);
				setUnprovisionedInvitationId(data.invitationId);
				toast.error(m.recipient_key_invite_incomplete());
				await invalidator.invalidateTeamInvitations();
				return;
			}
			setUnprovisionedInvitationId(null);
			const url = `${window.location.origin}/invite/${data.token}`;
			setInviteLink(url);
			toast.success(m.team_invite_dialog_toast_created());
			await invalidator.invalidateTeamInvitations();
		},
		onError: (error: Error) => {
			toast.error(
				error instanceof RuntimeRequestError
					? m.recipient_key_invite_incomplete()
					: error.message,
			);
			// A lost first-send reply can still have created a pending Invitation.
			void invalidator.invalidateTeamInvitations();
		},
	});

	const handleSubmit = (e: React.FormEvent) => {
		e.preventDefault();
		if (!email.trim()) return;
		setUnprovisionedInvitationId(null);
		inviteMutation.mutate({ teamId, email: email.trim(), role });
	};

	const handleOpenChange = (nextOpen: boolean) => {
		setOpen(nextOpen);
		if (!nextOpen) {
			const flight = active.current;
			flight?.controller.abort();
			if (flight?.accountId && flight.continuationId)
				void runtime
					.releaseInvitationContinuation({
						accountId: flight.accountId,
						continuationId: flight.continuationId,
					})
					.catch(() => undefined);
			setEmail("");
			setRole("member");
			setInviteLink(null);
			setUnprovisionedInvitationId(null);
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
								{unprovisionedInvitationId && (
									<div
										className="rounded-md border bg-muted/40 p-3 text-sm"
										data-testid="invite-unprovisioned"
										role="status"
									>
										<p>{m.recipient_key_invite_incomplete()}</p>
										<code className="mt-2 block text-xs">
											{unprovisionedInvitationId}
										</code>
									</div>
								)}
							</div>
							<DialogFooter>
								<Button
									type="button"
									variant="outline"
									onClick={() => handleOpenChange(false)}
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
