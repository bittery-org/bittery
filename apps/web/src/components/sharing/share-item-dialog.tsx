import {
	type ShareAccessMode,
	type ShareExpirationOption,
	useCreateShare,
} from "@bittery/core/hooks";
import type { DecryptedItem } from "@bittery/shared/types";
import {
	AlertDialog,
	AlertDialogAction,
	AlertDialogCancel,
	AlertDialogContent,
	AlertDialogDescription,
	AlertDialogFooter,
	AlertDialogHeader,
	AlertDialogTitle,
	Badge,
	Button,
	Checkbox,
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
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
	toast,
} from "@bittery/ui";
import {
	IconTriangleWarningOutlineDuo18 as AlertTriangle,
	IconCopyOutlineDuo18 as Copy,
	IconLinkOutlineDuo18 as Link,
	IconLoader2OutlineDuo18 as Loader2,
	IconShareLeft2OutlineDuo18 as Share2,
	IconXmarkOutlineDuo18 as X,
} from "@bittery/ui/icons";
import { useState } from "react";
import { useI18n } from "@/providers/i18n-provider";

interface ShareItemDialogProps {
	item: DecryptedItem;
}

const EXPIRATION_OPTIONS: ShareExpirationOption[] = [
	"1hour",
	"1day",
	"7days",
	"14days",
	"30days",
];

export function ShareItemDialog({ item }: ShareItemDialogProps) {
	const [open, setOpen] = useState(false);
	const [showConfirmation, setShowConfirmation] = useState(false);
	const [generatedLink, setGeneratedLink] = useState<string | null>(null);
	const { m } = useI18n();

	// Form state
	const [accessMode, setAccessMode] = useState<ShareAccessMode>("anyone");
	const [expiresIn, setExpiresIn] = useState<ShareExpirationOption>("7days");
	const [isOneTimeUse, setIsOneTimeUse] = useState(false);
	const [allowedEmails, setAllowedEmails] = useState<string[]>([]);
	const [emailInput, setEmailInput] = useState("");

	// Use shared hook for share creation
	const createShare = useCreateShare();

	const handleCreateShare = async () => {
		try {
			const result = await createShare.mutateAsync({
				item,
				accessMode,
				expiresIn,
				isOneTimeUse,
				allowedEmails:
					accessMode === "email-restricted" ? allowedEmails : undefined,
			});

			// Build the share URL with web app origin
			const baseUrl = window.location.origin;
			const shareUrl = `${baseUrl}/share/${result.token}#${result.shareKeyBase64}`;

			setGeneratedLink(shareUrl);
			toast.success(m["sharing.item_dialog.toast.create_success"]());
		} catch {
			toast.error(m["sharing.item_dialog.toast.create_error"]());
		}
	};

	const handleAddEmail = () => {
		const email = emailInput.trim().toLowerCase();
		if (!email) return;

		// Basic email validation
		const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
		if (!emailRegex.test(email)) {
			toast.error(m["sharing.item_dialog.toast.invalid_email"]());
			return;
		}

		if (allowedEmails.includes(email)) {
			toast.error(m["sharing.item_dialog.toast.email_already_added"]());
			return;
		}

		setAllowedEmails([...allowedEmails, email]);
		setEmailInput("");
	};

	const handleRemoveEmail = (email: string) => {
		setAllowedEmails(allowedEmails.filter((e) => e !== email));
	};

	const handleCopyLink = () => {
		copyWithToast(generatedLink, m["sharing.common.link_label"](), {
			autoClearMs: 0,
			showAutoClearMessage: false,
		});
	};

	const handleCreateLink = () => {
		// Show confirmation for sensitive items
		setShowConfirmation(true);
	};

	const handleConfirmCreate = () => {
		setShowConfirmation(false);
		handleCreateShare();
	};

	const handleClose = () => {
		setOpen(false);
		// Reset state after dialog closes
		setTimeout(() => {
			setGeneratedLink(null);
			setAccessMode("anyone");
			setExpiresIn("7days");
			setIsOneTimeUse(false);
			setAllowedEmails([]);
			setEmailInput("");
		}, 200);
	};

	return (
		<>
			<Dialog
				open={open}
				onOpenChange={(isOpen) => (isOpen ? setOpen(true) : handleClose())}
			>
				<DialogTrigger asChild>
					<Button size="sm" variant="outline">
						<Share2 className="mr-2 h-4 w-4" />
						{m["sharing.item_dialog.trigger"]()}
					</Button>
				</DialogTrigger>
				<DialogContent className="sm:max-w-md">
					<DialogHeader>
						<DialogTitle>{m["sharing.item_dialog.title"]()}</DialogTitle>
						<DialogDescription>
							{m["sharing.item_dialog.description"]({ itemTitle: item.title })}
						</DialogDescription>
					</DialogHeader>

					{generatedLink ? (
						// Show generated link
						<div className="space-y-4">
							<div className="rounded-lg border bg-muted/50 p-4">
								<div className="flex items-center gap-2 text-green-600">
									<Link className="h-4 w-4" />
									<span className="font-medium text-sm">
										{m["sharing.item_dialog.generated.title"]()}
									</span>
								</div>
								<p className="mt-2 text-muted-foreground text-xs">
									{accessMode === "email-restricted"
										? m[
												"sharing.item_dialog.generated.description.email_restricted"
											]()
										: m["sharing.item_dialog.generated.description.anyone"]()}
								</p>
							</div>

							<div className="flex gap-2">
								<Input
									value={generatedLink}
									readOnly
									className="flex-1 font-mono text-xs"
								/>
								<Button onClick={handleCopyLink}>
									<Copy className="h-4 w-4" />
								</Button>
							</div>

							<DialogFooter>
								<Button onClick={handleClose}>
									{m["sharing.item_dialog.action.done"]()}
								</Button>
							</DialogFooter>
						</div>
					) : (
						// Show configuration form
						<div className="space-y-4">
							{/* Access Mode */}
							<div className="space-y-2">
								<Label>{m["sharing.item_dialog.field.access_mode"]()}</Label>
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
										<SelectItem value="anyone">
											<div>
												<div>
													{m["sharing.item_dialog.access_mode.anyone"]()}
												</div>
												<div className="text-muted-foreground text-xs">
													{m["sharing.item_dialog.access_mode.anyone_hint"]()}
												</div>
											</div>
										</SelectItem>
										<SelectItem value="email-restricted">
											<div>
												<div>
													{m[
														"sharing.item_dialog.access_mode.email_restricted"
													]()}
												</div>
												<div className="text-muted-foreground text-xs">
													{m[
														"sharing.item_dialog.access_mode.email_restricted_hint"
													]()}
												</div>
											</div>
										</SelectItem>
									</SelectContent>
								</Select>
							</div>

							{/* Email Addresses (for restricted mode) */}
							{accessMode === "email-restricted" && (
								<div className="space-y-2">
									<Label>
										{m["sharing.item_dialog.field.allowed_emails"]()}
									</Label>
									<div className="flex gap-2">
										<Input
											type="email"
											placeholder={m["sharing.item_dialog.placeholder.email"]()}
											value={emailInput}
											onChange={(e) => setEmailInput(e.target.value)}
											onKeyDown={(e) => e.key === "Enter" && handleAddEmail()}
										/>
										<Button
											type="button"
											onClick={handleAddEmail}
											variant="secondary"
										>
											{m["sharing.item_dialog.action.add_email"]()}
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
														<X className="h-3 w-3" />
													</button>
												</Badge>
											))}
										</div>
									)}
								</div>
							)}

							{/* Expiration */}
							<div className="space-y-2">
								<Label>{m["sharing.item_dialog.field.expires_in"]()}</Label>
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
										{EXPIRATION_OPTIONS.map((value) => (
											<SelectItem key={value} value={value}>
												{m[`sharing.item_dialog.expiration.${value}`]()}
											</SelectItem>
										))}
									</SelectContent>
								</Select>
							</div>

							{/* One-time use */}
							<div className="flex items-center space-x-2">
								<Checkbox
									id="one-time"
									checked={isOneTimeUse}
									onCheckedChange={(checked) =>
										setIsOneTimeUse(checked === true)
									}
								/>
								<Label htmlFor="one-time" className="cursor-pointer">
									{m["sharing.item_dialog.field.one_time_use"]()}
								</Label>
							</div>

							<DialogFooter>
								<Button variant="outline" onClick={handleClose}>
									{m["sharing.item_dialog.action.cancel"]()}
								</Button>
								<Button
									onClick={handleCreateLink}
									disabled={
										createShare.isPending ||
										(accessMode === "email-restricted" &&
											allowedEmails.length === 0)
									}
								>
									{createShare.isPending ? (
										<>
											<Loader2 className="mr-2 h-4 w-4 animate-spin" />
											{m["sharing.item_dialog.action.creating"]()}
										</>
									) : (
										<>
											<Link className="mr-2 h-4 w-4" />
											{m["sharing.item_dialog.action.create_link"]()}
										</>
									)}
								</Button>
							</DialogFooter>
						</div>
					)}
				</DialogContent>
			</Dialog>

			{/* Confirmation Dialog */}
			<AlertDialog open={showConfirmation} onOpenChange={setShowConfirmation}>
				<AlertDialogContent>
					<AlertDialogHeader>
						<AlertDialogTitle className="flex items-center gap-2">
							<AlertTriangle className="h-5 w-5 text-amber-500" />
							{m["sharing.item_dialog.confirm.title"]()}
						</AlertDialogTitle>
						<AlertDialogDescription>
							{m["sharing.item_dialog.confirm.description"]({
								itemTitle: item.title,
							})}
							<br />
							<br />
							<strong>
								{m["sharing.item_dialog.confirm.security_title"]()}
							</strong>
							<ul className="mt-2 list-inside list-disc">
								<li>{m["sharing.item_dialog.confirm.security_item_data"]()}</li>
								<li>
									{m["sharing.item_dialog.confirm.security_item_access"]()}
								</li>
								<li>
									{m[
										"sharing.item_dialog.confirm.security_item_recommendation"
									]()}
								</li>
							</ul>
						</AlertDialogDescription>
					</AlertDialogHeader>
					<AlertDialogFooter>
						<AlertDialogCancel>
							{m["sharing.item_dialog.action.cancel"]()}
						</AlertDialogCancel>
						<AlertDialogAction onClick={handleConfirmCreate}>
							{m["sharing.item_dialog.confirm.action_confirm"]()}
						</AlertDialogAction>
					</AlertDialogFooter>
				</AlertDialogContent>
			</AlertDialog>
		</>
	);
}
