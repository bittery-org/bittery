import { encrypt, generateEncryptionKey } from "@bittery/crypto/encryption";
import { arrayBufferToBase64 } from "@bittery/crypto/key-derivation";
import { getDecryptedVaultKey } from "@bittery/crypto/session-storage";
import { useTRPCClient } from "@bittery/shared/trpc";
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
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { AlertTriangle, Copy, Link, Loader2, Share2, X } from "lucide-react";
import { useState } from "react";

interface ShareItemDialogProps {
	item: DecryptedItem;
}

type ExpirationOption = "1hour" | "1day" | "7days" | "14days" | "30days";
type AccessMode = "anyone" | "email-restricted";

const EXPIRATION_LABELS: Record<ExpirationOption, string> = {
	"1hour": "1 hour",
	"1day": "1 day",
	"7days": "7 days",
	"14days": "14 days",
	"30days": "30 days",
};

export function ShareItemDialog({ item }: ShareItemDialogProps) {
	const [open, setOpen] = useState(false);
	const [showConfirmation, setShowConfirmation] = useState(false);
	const [generatedLink, setGeneratedLink] = useState<string | null>(null);

	// Form state
	const [accessMode, setAccessMode] = useState<AccessMode>("anyone");
	const [expiresIn, setExpiresIn] = useState<ExpirationOption>("7days");
	const [isOneTimeUse, setIsOneTimeUse] = useState(false);
	const [allowedEmails, setAllowedEmails] = useState<string[]>([]);
	const [emailInput, setEmailInput] = useState("");

	const trpcClient = useTRPCClient();
	const queryClient = useQueryClient();

	const createShareMutation = useMutation({
		mutationFn: async () => {
			// Get the vault key to decrypt item data
			const vaultKey = await getDecryptedVaultKey(item.vaultId);
			if (!vaultKey) {
				throw new Error("Could not decrypt vault key. Please log in again.");
			}

			// Generate a new share-specific encryption key
			const shareKey = generateEncryptionKey();

			// Prepare item data for sharing (sanitized, no metadata)
			const itemDataToShare = {
				title: item.title,
				category: item.category,
				url: item.url,
				urls: item.urls,
				username: item.username,
				password: item.password,
				notes: item.notes,
				note: item.note,
				customFields: item.customFields,
				// Credit card fields
				cardholderName: item.cardholderName,
				cardNumber: item.cardNumber,
				cvv: item.cvv,
				expiryDate: item.expiryDate,
				billingAddress: item.billingAddress,
				// Identity fields
				firstName: item.firstName,
				middleName: item.middleName,
				lastName: item.lastName,
				email: item.email,
				addresses: item.addresses,
				phoneNumbers: item.phoneNumbers,
				ssn: item.ssn,
				passportNumber: item.passportNumber,
				driversLicense: item.driversLicense,
				dateOfBirth: item.dateOfBirth,
				// TOTP fields
				totpSecret: item.totpSecret,
				totpIssuer: item.totpIssuer,
				totpAccountName: item.totpAccountName,
				totpAlgorithm: item.totpAlgorithm,
				totpDigits: item.totpDigits,
				totpPeriod: item.totpPeriod,
			};

			// Encrypt item data with the share key
			const encryptedData = await encrypt(
				JSON.stringify(itemDataToShare),
				shareKey,
			);

			// Encode the share key as base64 for the URL
			const shareKeyBase64 = arrayBufferToBase64(shareKey);

			// Encrypt the share key for storage (we'll use a simple encoding for now)
			// In production, you might want to use a server-side key
			const shareKeyEncrypted = await encrypt(shareKeyBase64, shareKey);

			const result = await trpcClient.share.create.mutate({
				itemId: item.id,
				accessMode,
				isOneTimeUse,
				expiresIn,
				allowedEmails: accessMode === "email-restricted" ? allowedEmails : undefined,
				encryptedItemData: encryptedData.ciphertext,
				encryptionIv: encryptedData.iv,
				encryptedShareKey: shareKeyEncrypted.ciphertext,
				shareKeyIv: shareKeyEncrypted.iv,
			});

			// Generate the shareable link with the key in the fragment
			const baseUrl = window.location.origin;
			const shareUrl = `${baseUrl}/share/${result.token}#${shareKeyBase64}`;

			return { ...result, shareUrl };
		},
		onSuccess: (data) => {
			setGeneratedLink(data.shareUrl);
			queryClient.invalidateQueries({ queryKey: ["share"] });
			toast.success("Share link created successfully!");
		},
		onError: (error: Error) => {
			toast.error(error.message);
		},
	});

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

	const handleCopyLink = async () => {
		if (!generatedLink) return;
		await navigator.clipboard.writeText(generatedLink);
		toast.success("Link copied to clipboard!");
	};

	const handleCreateLink = () => {
		// Show confirmation for sensitive items
		setShowConfirmation(true);
	};

	const handleConfirmCreate = () => {
		setShowConfirmation(false);
		createShareMutation.mutate();
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
			<Dialog open={open} onOpenChange={(isOpen) => isOpen ? setOpen(true) : handleClose()}>
				<DialogTrigger asChild>
					<Button size="sm" variant="outline">
						<Share2 className="mr-2 h-4 w-4" />
						Share
					</Button>
				</DialogTrigger>
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
									link {accessMode === "email-restricted" ? "and a verified email " : ""}
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
									onValueChange={(value: AccessMode) => setAccessMode(value)}
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
										<Button type="button" onClick={handleAddEmail} variant="secondary">
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
									onValueChange={(value: ExpirationOption) => setExpiresIn(value)}
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
									onCheckedChange={(checked) => setIsOneTimeUse(checked === true)}
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
										createShareMutation.isPending ||
										(accessMode === "email-restricted" && allowedEmails.length === 0)
									}
								>
									{createShareMutation.isPending ? (
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
							You are about to share "{item.title}". This will create a link that
							allows others to view this item's contents.
							<br /><br />
							<strong>Security reminders:</strong>
							<ul className="mt-2 list-inside list-disc">
								<li>The link will contain encrypted data</li>
								<li>Anyone with the link can access the item until it expires</li>
								<li>Consider using email-restricted access for sensitive items</li>
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
