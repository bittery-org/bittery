import {
	buildShareUrl,
	type ShareAccessMode,
	type ShareExpirationOption,
	useCreateShare,
} from "@bittery/hooks";
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
	Input,
	Label,
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
	toast,
} from "@bittery/ui";
import { AlertTriangle, Copy, Link, Loader2, X } from "lucide-react";
import { useState } from "react";

interface ShareItemDialogProps {
	open: boolean;
	onOpenChange: (open: boolean) => void;
	item: DecryptedItem;
}

const EXPIRATION_LABELS: Record<ShareExpirationOption, string> = {
	"1hour": "1 hour",
	"1day": "1 day",
	"7days": "7 days",
	"14days": "14 days",
	"30days": "30 days",
};

export function ShareItemDialog({
	open,
	onOpenChange,
	item,
}: ShareItemDialogProps) {
	const [showConfirmation, setShowConfirmation] = useState(false);
	const [generatedLink, setGeneratedLink] = useState<string | null>(null);

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

			// Build the share URL using the server-provided base URL
			const shareUrl = buildShareUrl(result);

			setGeneratedLink(shareUrl);
			toast.success("Share link created successfully!");
		} catch (error) {
			const errorMessage =
				error instanceof Error ? error.message : "Failed to create share link";
			toast.error(errorMessage);
		}
	};

	const handleAddEmail = () => {
		const email = emailInput.trim().toLowerCase();
		if (!email) return;

		// Basic email validation
		const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
		if (!emailRegex.test(email)) {
			toast.error("Please enter a valid email address");
			return;
		}

		if (allowedEmails.includes(email)) {
			toast.error("Email already added");
			return;
		}

		setAllowedEmails([...allowedEmails, email]);
		setEmailInput("");
	};

	const handleRemoveEmail = (email: string) => {
		setAllowedEmails(allowedEmails.filter((e) => e !== email));
	};

	const handleCopyLink = () => {
		copyWithToast(generatedLink, "Link", {
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
		onOpenChange(false);
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
				onOpenChange={(isOpen) => (isOpen ? onOpenChange(true) : handleClose())}
			>
				<DialogContent className="sm:max-w-md">
					<DialogHeader>
						<DialogTitle>Share Item</DialogTitle>
						<DialogDescription>
							Create a secure link to share "{item.title}" with others.
						</DialogDescription>
					</DialogHeader>

					{generatedLink ? (
						// Show generated link
						<div className="space-y-4">
							<div className="rounded-lg border bg-muted/50 p-4">
								<div className="flex items-center gap-2 text-green-600">
									<Link className="h-4 w-4" />
									<span className="font-medium text-sm">Link created!</span>
								</div>
								<p className="mt-2 text-muted-foreground text-xs">
									This link will expire based on your settings. Anyone with this
									link{" "}
									{accessMode === "email-restricted"
										? "and a verified email "
										: ""}
									can view this item.
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
								<Button onClick={handleClose}>Done</Button>
							</DialogFooter>
						</div>
					) : (
						// Show configuration form
						<div className="space-y-4">
							{/* Access Mode */}
							<div className="space-y-2">
								<Label>Who can access</Label>
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
												<div>Anyone with the link</div>
												<div className="text-muted-foreground text-xs">
													No email verification required
												</div>
											</div>
										</SelectItem>
										<SelectItem value="email-restricted">
											<div>
												<div>Specific email addresses</div>
												<div className="text-muted-foreground text-xs">
													Recipients must verify their email
												</div>
											</div>
										</SelectItem>
									</SelectContent>
								</Select>
							</div>

							{/* Email Addresses (for restricted mode) */}
							{accessMode === "email-restricted" && (
								<div className="space-y-2">
									<Label>Allowed email addresses</Label>
									<div className="flex gap-2">
										<Input
											type="email"
											placeholder="email@example.com"
											value={emailInput}
											onChange={(e) => setEmailInput(e.target.value)}
											onKeyDown={(e) => e.key === "Enter" && handleAddEmail()}
										/>
										<Button
											type="button"
											onClick={handleAddEmail}
											variant="secondary"
										>
											Add
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
								<Label>Link expires in</Label>
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
										{Object.entries(EXPIRATION_LABELS).map(([value, label]) => (
											<SelectItem key={value} value={value}>
												{label}
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
									One-time use (link becomes invalid after first access)
								</Label>
							</div>

							<DialogFooter>
								<Button variant="outline" onClick={handleClose}>
									Cancel
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
											Creating...
										</>
									) : (
										<>
											<Link className="mr-2 h-4 w-4" />
											Create Link
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
							Share Sensitive Item?
						</AlertDialogTitle>
						<AlertDialogDescription>
							You are about to share "{item.title}". This will create a link
							that allows others to view this item's contents.
							<br />
							<br />
							<strong>Security reminders:</strong>
							<ul className="mt-2 list-inside list-disc">
								<li>The link will contain encrypted data</li>
								<li>
									Anyone with the link can access the item until it expires
								</li>
								<li>
									Consider using email-restricted access for sensitive items
								</li>
							</ul>
						</AlertDialogDescription>
					</AlertDialogHeader>
					<AlertDialogFooter>
						<AlertDialogCancel>Cancel</AlertDialogCancel>
						<AlertDialogAction onClick={handleConfirmCreate}>
							Yes, Create Link
						</AlertDialogAction>
					</AlertDialogFooter>
				</AlertDialogContent>
			</AlertDialog>
		</>
	);
}
