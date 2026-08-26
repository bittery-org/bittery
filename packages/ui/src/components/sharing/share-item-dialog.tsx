import { useI18n } from "@bittery/i18n/react";
import type { DecryptedItem } from "@bittery/shared/types";
import {
	IconCopy,
	IconLink,
	IconLoaderCircle,
	IconShare,
	IconTriangleAlert,
	IconX,
} from "@bittery/ui/icons";
import { useEffect, useRef, useState } from "react";
import {
	AlertDialog,
	AlertDialogAction,
	AlertDialogCancel,
	AlertDialogContent,
	AlertDialogDescription,
	AlertDialogFooter,
	AlertDialogHeader,
	AlertDialogTitle,
} from "../alert-dialog";
import { Badge } from "../badge";
import { Button } from "../button";
import { Checkbox } from "../checkbox";
import { copyWithToast } from "../clipboard";
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogFooter,
	DialogHeader,
	DialogTitle,
	DialogTrigger,
} from "../dialog";
import { Input } from "../input";
import { Label } from "../label";
import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from "../select";
import { toast } from "../sonner";

export const SHARE_EXPIRATION_OPTIONS = [
	"1hour",
	"1day",
	"7days",
	"14days",
	"30days",
] as const;

export type ShareExpirationOption = (typeof SHARE_EXPIRATION_OPTIONS)[number];
export type ShareAccessMode = "anyone" | "email-restricted";

export interface CreateShareRequest {
	item: DecryptedItem;
	accessMode: ShareAccessMode;
	expiresIn: ShareExpirationOption;
	isOneTimeUse: boolean;
	allowedEmails?: string[];
}

export interface ShareItemDialogProps {
	accountId: string;
	item: DecryptedItem;
	onCreateShare: (request: CreateShareRequest) => Promise<DeliveredShareResult>;
	onAcknowledgeShareResult?: (result: DeliveredShareResult) => Promise<void>;
	resumableResult?: DeliveredShareResult | null;
	open?: boolean;
	onOpenChange?: (open: boolean) => void;
}

export interface DeliveredShareResult {
	accountId: string;
	itemId: string;
	operationId: string;
	shareUrl: string;
}

export type ShareAckSchedule = (
	run: () => void,
	delayMs: number,
) => () => void;

export function retryShareResultAcknowledgement(
	acknowledge: () => Promise<void>,
	onAcknowledged: () => void,
	schedule: ShareAckSchedule = (run, delayMs) => {
		const handle = setTimeout(run, delayMs);
		return () => clearTimeout(handle);
	},
): () => void {
	let cancelled = false;
	let cancelRetry: () => void = () => undefined;
	let attempt = 0;
	const run = async () => {
		try {
			await acknowledge();
			if (!cancelled) onAcknowledged();
		} catch {
			if (!cancelled) {
				attempt += 1;
				cancelRetry = schedule(
					() => void run(),
					Math.min(1_000 * 2 ** Math.min(attempt - 1, 8), 300_000),
				);
			}
		}
	};
	void run();
	return () => {
		cancelled = true;
		cancelRetry();
	};
}

export function ShareItemDialog({
	accountId,
	item,
	onCreateShare,
	onAcknowledgeShareResult,
	resumableResult,
	open: controlledOpen,
	onOpenChange: controlledOnOpenChange,
}: ShareItemDialogProps) {
	const { m } = useI18n();
	const [internalOpen, setInternalOpen] = useState(false);
	const isControlled = controlledOpen !== undefined;
	const open = isControlled ? controlledOpen : internalOpen;
	const setOpen = isControlled
		? (v: boolean) => controlledOnOpenChange?.(v)
		: setInternalOpen;

	const [showConfirmation, setShowConfirmation] = useState(false);
	const [generatedResult, setGeneratedResult] =
		useState<DeliveredShareResult | null>(null);
	const deliveryScope = useRef({ accountId, itemId: item.id, open });
	deliveryScope.current = { accountId, itemId: item.id, open };
	const acknowledgedOperation = useRef<string | null>(null);
	const resultMatchesScope =
		generatedResult?.accountId === accountId &&
		generatedResult.itemId === item.id;
	const generatedLink =
		open && resultMatchesScope ? generatedResult.shareUrl : null;
	const [hasCopiedLink, setHasCopiedLink] = useState(false);
	const [showCloseWithoutCopy, setShowCloseWithoutCopy] = useState(false);

	const [accessMode, setAccessMode] = useState<ShareAccessMode>("anyone");
	const [expiresIn, setExpiresIn] = useState<ShareExpirationOption>("7days");
	const [isOneTimeUse, setIsOneTimeUse] = useState(false);
	const [allowedEmails, setAllowedEmails] = useState<string[]>([]);
	const [emailInput, setEmailInput] = useState("");

	const [isCreating, setIsCreating] = useState(false);

	useEffect(() => {
		if (
			open &&
			generatedResult === null &&
			resumableResult?.accountId === accountId &&
			resumableResult.itemId === item.id
		) {
			setGeneratedResult(resumableResult);
		}
	}, [accountId, generatedResult, item.id, open, resumableResult]);

	useEffect(() => {
		if (
			!open ||
			!generatedResult ||
			!resultMatchesScope ||
			!onAcknowledgeShareResult ||
			acknowledgedOperation.current === generatedResult.operationId
		) {
			return;
		}
		return retryShareResultAcknowledgement(
			() => onAcknowledgeShareResult(generatedResult),
			() => {
				acknowledgedOperation.current = generatedResult.operationId;
			},
		);
	}, [generatedResult, onAcknowledgeShareResult, open, resultMatchesScope]);

	const expirationLabels: Record<ShareExpirationOption, string> = {
		"1hour": m.sharing_item_dialog_expiration_1hour(),
		"1day": m.sharing_item_dialog_expiration_1day(),
		"7days": m.sharing_item_dialog_expiration_7days(),
		"14days": m.sharing_item_dialog_expiration_14days(),
		"30days": m.sharing_item_dialog_expiration_30days(),
	};

	const handleCreateShare = async () => {
		setIsCreating(true);
		try {
			const result = await onCreateShare({
				item,
				accessMode,
				expiresIn,
				isOneTimeUse,
				allowedEmails:
					accessMode === "email-restricted" ? allowedEmails : undefined,
			});

			const currentScope = deliveryScope.current;
			if (
				currentScope.open &&
				result.accountId === currentScope.accountId &&
				result.itemId === currentScope.itemId
			) {
				setGeneratedResult(result);
			}
			toast.success(m.sharing_item_dialog_toast_create_success());
		} catch (error) {
			const errorMessage =
				error instanceof Error
					? error.message
					: m.sharing_item_dialog_toast_create_error();
			toast.error(errorMessage);
		} finally {
			setIsCreating(false);
		}
	};

	const handleAddEmail = () => {
		const email = emailInput.trim().toLowerCase();
		if (!email) return;

		const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
		if (!emailRegex.test(email)) {
			toast.error(m.sharing_item_dialog_toast_invalid_email());
			return;
		}

		if (allowedEmails.includes(email)) {
			toast.error(m.sharing_item_dialog_toast_email_already_added());
			return;
		}

		setAllowedEmails([...allowedEmails, email]);
		setEmailInput("");
	};

	const handleRemoveEmail = (email: string) => {
		setAllowedEmails(allowedEmails.filter((e) => e !== email));
	};

	const handleCopyLink = async () => {
		const copied = await copyWithToast(
			generatedLink,
			m.sharing_common_link_label(),
			{
				autoClearMs: 0,
				showAutoClearMessage: false,
			},
		);
		if (copied) {
			setHasCopiedLink(true);
		}
	};

	const handleCreateLink = () => {
		setShowConfirmation(true);
	};

	const handleConfirmCreate = () => {
		setShowConfirmation(false);
		handleCreateShare();
	};

	const handleClose = () => {
		setOpen(false);
		setShowCloseWithoutCopy(false);
		setTimeout(() => {
			setGeneratedResult(null);
			setHasCopiedLink(false);
			setAccessMode("anyone");
			setExpiresIn("7days");
			setIsOneTimeUse(false);
			setAllowedEmails([]);
			setEmailInput("");
		}, 200);
	};

	// Once Runtime has observed delivery, closing an uncopied result makes this host copy
	// unavailable; retain the explicit warning before clearing the rendered value.
	const isLinkAtRisk = generatedLink !== null && !hasCopiedLink;

	const handleRequestClose = () => {
		if (isLinkAtRisk) {
			setShowCloseWithoutCopy(true);
			return;
		}
		handleClose();
	};

	return (
		<>
			<Dialog
				open={open}
				onOpenChange={(isOpen) =>
						isOpen ? setOpen(true) : handleRequestClose()
					}
			>
				{!isControlled && (
					<DialogTrigger asChild>
						<Button size="sm" variant="outline">
							<IconShare className="mr-2 h-4 w-4" />
							{m.sharing_item_dialog_trigger()}
						</Button>
					</DialogTrigger>
				)}
				<DialogContent className="sm:max-w-md" data-testid="share-item-dialog">
					<DialogHeader>
						<DialogTitle>{m.sharing_item_dialog_title()}</DialogTitle>
						<DialogDescription>
							{m.sharing_item_dialog_description({ itemTitle: item.title })}
						</DialogDescription>
					</DialogHeader>

					{generatedLink ? (
						<div className="space-y-4">
							<div className="rounded-lg border bg-muted/50 p-4">
								<div className="flex items-center gap-2 text-green-600">
									<IconLink className="h-4 w-4" />
									<span className="font-medium text-sm">
										{m.sharing_item_dialog_generated_title()}
									</span>
								</div>
								<p className="mt-2 text-muted-foreground text-xs">
									{accessMode === "email-restricted"
										? m.sharing_item_dialog_generated_description_email_restricted()
										: m.sharing_item_dialog_generated_description_anyone()}
								</p>
							</div>

							<div className="flex items-start gap-2 rounded-lg border border-warning/30 bg-warning/10 p-3">
								<IconTriangleAlert
									aria-hidden
									className="mt-px size-4 shrink-0 text-warning"
								/>
								<p className="text-xs">
									{m.sharing_item_dialog_generated_copy_once_warning()}
								</p>
							</div>

							<div className="flex gap-2">
								<Input
									value={generatedLink}
									readOnly
									className="flex-1 font-mono text-xs"
									data-testid="share-link-value"
								/>
								<Button
									onClick={handleCopyLink}
									title={m.sharing_item_dialog_action_copy_link()}
								>
									<IconCopy className="h-4 w-4" />
								</Button>
							</div>

							<DialogFooter>
								<Button onClick={handleRequestClose}>
									{m.sharing_item_dialog_action_done()}
								</Button>
							</DialogFooter>
						</div>
					) : (
						<div className="space-y-4">
							<div className="space-y-2">
								<Label>{m.sharing_item_dialog_field_access_mode()}</Label>
								<Select
									value={accessMode}
									onValueChange={(value: ShareAccessMode) =>
										setAccessMode(value)
									}
								>
									<SelectTrigger>
										<SelectValue />
									</SelectTrigger>
									<SelectContent>
										<SelectItem
											value="anyone"
											description={m.sharing_item_dialog_access_mode_anyone_hint()}
										>
											{m.sharing_item_dialog_access_mode_anyone()}
										</SelectItem>
										<SelectItem
											value="email-restricted"
											description={m.sharing_item_dialog_access_mode_email_restricted_hint()}
										>
											{m.sharing_item_dialog_access_mode_email_restricted()}
										</SelectItem>
									</SelectContent>
								</Select>
							</div>

							{accessMode === "email-restricted" && (
								<div className="space-y-2">
									<Label>
										{m.sharing_item_dialog_field_allowed_emails()}
									</Label>
									<div className="flex gap-2">
										<Input
											type="email"
											placeholder={m.sharing_item_dialog_placeholder_email()}
											value={emailInput}
											onChange={(e) => setEmailInput(e.target.value)}
											onKeyDown={(e) => e.key === "Enter" && handleAddEmail()}
										/>
										<Button
											type="button"
											onClick={handleAddEmail}
											variant="secondary"
										>
											{m.sharing_item_dialog_action_add_email()}
										</Button>
									</div>
									{allowedEmails.length > 0 && (
										<div className="flex flex-wrap gap-2 pt-2">
											{allowedEmails.map((email) => (
												<Badge
													key={email}
													variant="secondary"
													className="flex items-center gap-1"
												>
													{email}
													<button
														type="button"
														onClick={() => handleRemoveEmail(email)}
														className="hover:text-destructive"
													>
														<IconX className="h-3 w-3" />
													</button>
												</Badge>
											))}
										</div>
									)}
								</div>
							)}

							<div className="space-y-2">
								<Label>{m.sharing_item_dialog_field_expires_in()}</Label>
								<Select
									value={expiresIn}
									onValueChange={(value: ShareExpirationOption) =>
										setExpiresIn(value)
									}
								>
									<SelectTrigger>
										<SelectValue />
									</SelectTrigger>
									<SelectContent>
										{SHARE_EXPIRATION_OPTIONS.map((value) => (
											<SelectItem key={value} value={value}>
												{expirationLabels[value]}
											</SelectItem>
										))}
									</SelectContent>
								</Select>
							</div>

							<div className="flex items-center space-x-2">
								<Checkbox
									id="one-time"
									checked={isOneTimeUse}
									onCheckedChange={(checked) =>
										setIsOneTimeUse(checked === true)
									}
								/>
								<Label htmlFor="one-time" className="cursor-pointer">
									{m.sharing_item_dialog_field_one_time_use()}
								</Label>
							</div>

							<DialogFooter>
								<Button variant="outline" onClick={handleClose}>
									{m.sharing_item_dialog_action_cancel()}
								</Button>
								<Button
									onClick={handleCreateLink}
									data-testid="share-create-button"
									disabled={
										isCreating ||
										(accessMode === "email-restricted" &&
											allowedEmails.length === 0)
									}
								>
									{isCreating ? (
										<>
											<IconLoaderCircle className="h-4 w-4 animate-spin" />
											{m.sharing_item_dialog_action_creating()}
										</>
									) : (
										<>
											<IconLink className="h-4 w-4" />
											{m.sharing_item_dialog_action_create_link()}
										</>
									)}
								</Button>
							</DialogFooter>
						</div>
					)}
				</DialogContent>
			</Dialog>

			<AlertDialog open={showConfirmation} onOpenChange={setShowConfirmation}>
				<AlertDialogContent>
					<AlertDialogHeader>
						<AlertDialogTitle className="flex items-center gap-2">
							<IconTriangleAlert
								aria-hidden
								className="size-5 text-warning"
							/>
							{m.sharing_item_dialog_confirm_title()}
						</AlertDialogTitle>
						<AlertDialogDescription asChild>
							<div>
								{m.sharing_item_dialog_confirm_description({
								itemTitle: item.title,
								})}
								<br />
								<br />
								<strong>
									{m.sharing_item_dialog_confirm_security_title()}
								</strong>
								<ul className="mt-2 list-inside list-disc">
									<li>{m.sharing_item_dialog_confirm_security_item_data()}</li>
									<li>
										{m.sharing_item_dialog_confirm_security_item_access()}
									</li>
									<li>
										{m.sharing_item_dialog_confirm_security_item_recommendation()}
									</li>
								</ul>
							</div>
						</AlertDialogDescription>
					</AlertDialogHeader>
					<AlertDialogFooter>
						<AlertDialogCancel>
							{m.sharing_item_dialog_action_cancel()}
						</AlertDialogCancel>
						<AlertDialogAction onClick={handleConfirmCreate}>
							{m.sharing_item_dialog_confirm_action_confirm()}
						</AlertDialogAction>
					</AlertDialogFooter>
				</AlertDialogContent>
			</AlertDialog>

			<AlertDialog
				open={showCloseWithoutCopy}
				onOpenChange={setShowCloseWithoutCopy}
			>
				<AlertDialogContent>
					<AlertDialogHeader>
						<AlertDialogTitle className="flex items-center gap-2">
							<IconTriangleAlert
								aria-hidden
								className="size-5 text-warning"
							/>
							{m.sharing_item_dialog_close_without_copy_title()}
						</AlertDialogTitle>
						<AlertDialogDescription>
							{m.sharing_item_dialog_close_without_copy_description()}
						</AlertDialogDescription>
					</AlertDialogHeader>
					<AlertDialogFooter>
						<AlertDialogCancel>
							{m.sharing_item_dialog_action_cancel()}
						</AlertDialogCancel>
						<AlertDialogAction
							onClick={handleClose}
							variant="destructive"
						>
							{m.sharing_item_dialog_action_close_anyway()}
						</AlertDialogAction>
					</AlertDialogFooter>
				</AlertDialogContent>
			</AlertDialog>
		</>
	);
}
