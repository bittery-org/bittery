/**
 * Create a share link for an item, then hand it straight to Android's share chooser.
 *
 * A port of `apps/mobile/src/components/share/share-item-sheet.tsx` onto the WebView kit.
 * `@bittery/ui`'s `ShareItemDialog` is not reused for the same reason `MoveItemSheet` does not
 * reuse `MoveItemDialog`: it is a desktop form (a `Select` for expiry, a checkbox row, a
 * `DialogFooter`) and — more importantly — it is copy-link-only. On a phone the useful verb is
 * "send this to someone", which is `ACTION_SEND` via `lib/share.ts`, not a clipboard write.
 *
 * Both of desktop's access modes are here: a link anyone can open, or one gated on a list of
 * verified email addresses. The list is a required field in that mode — a share restricted to
 * nobody is a link that cannot be opened at all — so Create stays disabled until it has one.
 *
 * The one rule that shapes everything here: **the decryption key lives only in the URL**. The
 * server never sees it, so a link that is created and then lost is gone. That is why closing
 * with an unshared, uncopied link asks for confirmation, and why the copy path deliberately
 * skips the 30s clipboard auto-clear that every other copy in this app uses — a share link has
 * to survive long enough to be pasted somewhere.
 */

import { useCreateShare } from "@bittery/core/hooks";
import {
	SHARE_EXPIRATION_OPTIONS,
	type ShareAccessMode,
	type ShareExpirationOption,
} from "@bittery/core/services/share-service";
import type { DecryptedItem } from "@bittery/shared/types";
import { toast } from "@bittery/ui";
import {
	IconCheck,
	IconCopy,
	IconLink,
	IconMail,
	IconPlus,
	IconShare,
	IconTriangleAlert,
	IconX,
} from "@bittery/ui/icons";
import { useState } from "react";
import {
	BrandButton,
	ChipRail,
	iconClass,
	ListCard,
	ListRow,
	MobileSheet,
	Pressable,
	SectionLabel,
	SHEET_EXIT_MS,
	Switch,
	TextField,
} from "@/components/ui";
import { shareText } from "@/lib/share";
import { useI18n } from "@/providers/i18n-provider";

interface ShareItemSheetProps {
	open: boolean;
	onOpenChange: (open: boolean) => void;
	item: DecryptedItem;
}

export function ShareItemSheet({
	open,
	onOpenChange,
	item,
}: ShareItemSheetProps) {
	const { m } = useI18n();
	const [accessMode, setAccessMode] = useState<ShareAccessMode>("anyone");
	const [allowedEmails, setAllowedEmails] = useState<string[]>([]);
	const [emailDraft, setEmailDraft] = useState("");
	const [expiresIn, setExpiresIn] = useState<ShareExpirationOption>("7days");
	const [isOneTimeUse, setIsOneTimeUse] = useState(false);
	const [shareUrl, setShareUrl] = useState<string | null>(null);
	const [hasSharedLink, setHasSharedLink] = useState(false);
	const [hasCopiedLink, setHasCopiedLink] = useState(false);
	const [isConfirmingClose, setIsConfirmingClose] = useState(false);

	const createShare = useCreateShare();

	const expirationLabels: Record<ShareExpirationOption, string> = {
		"1hour": m.mob_share_expiry_1hour(),
		"1day": m.mob_share_expiry_1day(),
		"7days": m.mob_share_expiry_7days(),
		"14days": m.mob_share_expiry_14days(),
		"30days": m.mob_share_expiry_30days(),
	};

	const closeAndReset = () => {
		setIsConfirmingClose(false);
		onOpenChange(false);
		// Reset after the exit animation so the sheet does not visibly snap back to its
		// pre-link state on the way out.
		setTimeout(() => {
			setShareUrl(null);
			setHasSharedLink(false);
			setHasCopiedLink(false);
			setExpiresIn("7days");
			setIsOneTimeUse(false);
			setAccessMode("anyone");
			setAllowedEmails([]);
			setEmailDraft("");
		}, SHEET_EXIT_MS);
	};

	const openNativeShare = async (url: string) => {
		try {
			await shareText({ text: url, title: m.mob_share_title() });
			// `ACTION_SEND` is fire-and-forget — Android reports no "the user picked X and it
			// completed" signal — so showing the chooser is the strongest fact available, and
			// it is enough to count the link as no longer at risk.
			setHasSharedLink(true);
		} catch (error) {
			// A chooser that never opened is recoverable: the link-ready card stays on screen
			// with Copy next to it, so the key is never silently lost.
			toast.error(
				error instanceof Error
					? error.message
					: m.mob_attachments_sharing_not_available(),
			);
		}
	};

	/** Mirrors `ShareItemDialog`: one address at a time, validated and de-duplicated on add. */
	const addEmail = () => {
		const email = emailDraft.trim().toLowerCase();
		if (!email) return;
		if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
			toast.error(m.sharing_item_dialog_toast_invalid_email());
			return;
		}
		if (allowedEmails.includes(email)) {
			toast.error(m.sharing_item_dialog_toast_email_already_added());
			return;
		}
		setAllowedEmails([...allowedEmails, email]);
		setEmailDraft("");
	};

	const removeEmail = (email: string) => {
		setAllowedEmails(allowedEmails.filter((entry) => entry !== email));
	};

	const isMissingRecipients =
		accessMode === "email-restricted" && allowedEmails.length === 0;

	const handleCreateAndShare = async () => {
		let createdUrl: string;
		try {
			const result = await createShare.mutateAsync({
				item,
				accessMode,
				expiresIn,
				isOneTimeUse,
				allowedEmails:
					accessMode === "email-restricted" ? allowedEmails : undefined,
			});
			createdUrl = result.shareUrl;
		} catch (error) {
			toast.error(
				error instanceof Error ? error.message : m.mob_share_toast_failed(),
			);
			return;
		}

		setShareUrl(createdUrl);
		setHasSharedLink(false);
		setHasCopiedLink(false);
		await openNativeShare(createdUrl);
	};

	const handleCopyLink = async () => {
		if (!shareUrl) return;
		// Deliberately not `handleCopy` from `@bittery/ui`: that one clears the clipboard after
		// 30 seconds, which is right for a password and wrong for a link the user is about to
		// paste into a chat app.
		await navigator.clipboard.writeText(shareUrl);
		setHasCopiedLink(true);
		toast.success(m.mob_share_toast_link_copied());
	};

	/** The key exists only in this URL, so an unshared and uncopied link dies with the sheet. */
	const isLinkAtRisk = shareUrl !== null && !hasSharedLink && !hasCopiedLink;

	const handleOpenChange = (nextOpen: boolean) => {
		if (nextOpen) {
			onOpenChange(true);
			return;
		}
		if (createShare.isPending) return;
		if (isLinkAtRisk) {
			setIsConfirmingClose(true);
			return;
		}
		closeAndReset();
	};

	// The confirm step swaps this sheet's *contents*, and never the sheet itself. Returning a
	// second `<MobileSheet>` from an early return would unmount an open Radix dialog and mount
	// another in the same commit, which loses the scroll lock and can leave `pointer-events:
	// none` stuck on the body.
	return (
		<MobileSheet
			open={open}
			onOpenChange={
				isConfirmingClose
					? (next) => {
							// Dismissing the confirm is "keep the link", not "throw it away".
							if (!next) setIsConfirmingClose(false);
						}
					: handleOpenChange
			}
			title={
				isConfirmingClose
					? m.mob_share_close_confirm_title()
					: m.mob_share_title()
			}
			description={
				isConfirmingClose
					? m.mob_share_close_confirm_description()
					: m.mob_share_description({ title: item.title ?? "" })
			}
		>
			{isConfirmingClose ? (
				<div className="flex flex-col gap-2 px-4 pt-1 pb-6">
					<Pressable
						onClick={() => setIsConfirmingClose(false)}
						surface="sheet"
						className="flex h-12 w-full items-center justify-center rounded-xl bg-surface-tertiary font-medium text-base text-foreground"
					>
						{m.mob_share_close_confirm_cancel()}
					</Pressable>
					<Pressable
						onClick={closeAndReset}
						scale
						haptic={false}
						className="flex h-12 w-full items-center justify-center rounded-xl bg-danger font-semibold text-base text-white"
					>
						{m.mob_share_close_confirm_confirm()}
					</Pressable>
				</div>
			) : (
				<div className="flex flex-col gap-5 px-4 pt-1 pb-6">
					{shareUrl ? (
						<div className="rounded-2xl border border-success/25 bg-success-soft p-4">
							<div className="flex items-center gap-2">
								<IconLink className={`${iconClass.chip} text-success`} />
								<span className="font-medium text-sm text-success">
									{m.mob_share_link_ready_label()}
								</span>
							</div>
							<p className="mt-2 text-muted-foreground text-xs">
								{accessMode === "email-restricted"
									? m.sharing_item_dialog_generated_description_email_restricted()
									: m.sharing_item_dialog_generated_description_anyone()}
							</p>
							{/* `.selectable` opts this one string back into text selection, so the link
						    can still be long-pressed if the chooser and Copy both fail. */}
							<p className="selectable mt-2 break-all font-mono text-muted-foreground text-xs">
								{shareUrl}
							</p>
							<div className="mt-3 flex gap-2">
								<Pressable
									onClick={() => void handleCopyLink()}
									surface="sheet"
									className="flex h-11 flex-1 items-center justify-center gap-2 rounded-xl bg-surface font-medium text-foreground text-sm"
								>
									{hasCopiedLink ? (
										<IconCheck className={`${iconClass.chip} text-success`} />
									) : (
										<IconCopy className={iconClass.chip} />
									)}
									{m.mob_share_copy_link()}
								</Pressable>
								<Pressable
									onClick={() => void openNativeShare(shareUrl)}
									surface="sheet"
									className="flex h-11 flex-1 items-center justify-center gap-2 rounded-xl bg-surface font-medium text-foreground text-sm"
								>
									<IconShare className={iconClass.chip} />
									{m.mob_share_share_again()}
								</Pressable>
							</div>
						</div>
					) : null}

					{/* Two rows rather than a `Segmented`: both labels are a phrase, and a phrase
					    truncates to nothing in a half-width segment. Rows also carry desktop's
					    per-option hint, which is where the actual difference is explained. */}
					<section>
						<SectionLabel>
							{m.sharing_item_dialog_field_access_mode()}
						</SectionLabel>
						<ListCard>
							<ListRow
								title={m.sharing_item_dialog_access_mode_anyone()}
								subtitle={m.sharing_item_dialog_access_mode_anyone_hint()}
								isSelected={accessMode === "anyone"}
								onPress={() => setAccessMode("anyone")}
								trailing={
									accessMode === "anyone" ? (
										<IconCheck className={`${iconClass.row} text-primary`} />
									) : undefined
								}
							/>
							<ListRow
								title={m.sharing_item_dialog_access_mode_email_restricted()}
								subtitle={m.sharing_item_dialog_access_mode_email_restricted_hint()}
								isSelected={accessMode === "email-restricted"}
								onPress={() => setAccessMode("email-restricted")}
								trailing={
									accessMode === "email-restricted" ? (
										<IconCheck className={`${iconClass.row} text-primary`} />
									) : undefined
								}
							/>
						</ListCard>
					</section>

					{accessMode === "email-restricted" ? (
						<section>
							<SectionLabel>
								{m.sharing_item_dialog_field_allowed_emails()}
							</SectionLabel>
							{/* A form, so the keyboard's Go key adds the address — on a phone that is
							    the only comfortable way to enter three of them in a row. */}
							<form
								onSubmit={(event) => {
									event.preventDefault();
									addEmail();
								}}
								className="flex items-end gap-2"
							>
								<TextField
									className="min-w-0 flex-1"
									icon={IconMail}
									type="email"
									inputMode="email"
									autoCapitalize="none"
									autoCorrect="off"
									enterKeyHint="done"
									value={emailDraft}
									onChange={(event) => setEmailDraft(event.target.value)}
									placeholder={m.sharing_item_dialog_placeholder_email()}
									aria-label={m.sharing_item_dialog_field_allowed_emails()}
								/>
								<Pressable
									onClick={addEmail}
									disabled={emailDraft.trim().length === 0}
									surface="sheet"
									aria-label={m.sharing_item_dialog_action_add_email()}
									className="flex h-12 shrink-0 items-center gap-1.5 rounded-xl bg-surface-tertiary px-3.5 font-medium text-foreground text-sm"
								>
									<IconPlus className={iconClass.chip} />
									{m.sharing_item_dialog_action_add_email()}
								</Pressable>
							</form>

							{allowedEmails.length > 0 ? (
								<div className="mt-3 flex flex-wrap gap-2">
									{allowedEmails.map((email) => (
										<Pressable
											key={email}
											onClick={() => removeEmail(email)}
											surface="sheet"
											aria-label={m.mob_share_a11y_remove_email({ email })}
											className="flex h-9 max-w-full items-center gap-2 rounded-full border border-border bg-surface px-3"
										>
											<span className="min-w-0 truncate font-medium text-foreground text-sm">
												{email}
											</span>
											<IconX className="size-3.5 shrink-0 text-muted-foreground" />
										</Pressable>
									))}
								</div>
							) : (
								<p className="mt-2 px-1 text-muted-foreground text-xs">
									{m.mob_share_emails_required()}
								</p>
							)}
						</section>
					) : null}

					<section>
						<SectionLabel>{m.mob_share_expires_label()}</SectionLabel>
						<ChipRail
							ariaLabel={m.mob_share_expires_label()}
							value={expiresIn}
							onChange={setExpiresIn}
							chips={SHARE_EXPIRATION_OPTIONS.map((option) => ({
								key: option,
								label: expirationLabels[option],
							}))}
						/>
					</section>

					<ListCard>
						<ListRow
							title={m.mob_share_one_time_use()}
							subtitle={m.mob_share_one_time_use_description()}
							trailing={
								<Switch
									isSelected={isOneTimeUse}
									onSelectedChange={setIsOneTimeUse}
									ariaLabel={m.mob_share_one_time_use()}
								/>
							}
						/>
					</ListCard>

					<div className="flex items-start gap-2.5 rounded-2xl bg-warning-soft p-3.5 text-warning text-xs">
						<IconTriangleAlert
							className={`mt-0.5 shrink-0 ${iconClass.chip}`}
						/>
						<div className="min-w-0 flex-1">
							<p>{m.mob_share_security_notice()}</p>
							<p className="mt-1.5">{m.mob_share_copy_once_notice()}</p>
						</div>
					</div>

					<div className="flex flex-col gap-2">
						<BrandButton
							label={
								createShare.isPending
									? m.mob_share_creating()
									: m.mob_share_create_button()
							}
							onClick={() => void handleCreateAndShare()}
							isLoading={createShare.isPending}
							disabled={isMissingRecipients}
							leading={<IconShare className={iconClass.chip} />}
						/>
						<Pressable
							onClick={() => handleOpenChange(false)}
							disabled={createShare.isPending}
							surface="sheet"
							className="flex h-11 w-full items-center justify-center rounded-xl bg-surface-tertiary font-medium text-base text-foreground"
						>
							{m.mob_share_cancel()}
						</Pressable>
					</div>
				</div>
			)}
		</MobileSheet>
	);
}
