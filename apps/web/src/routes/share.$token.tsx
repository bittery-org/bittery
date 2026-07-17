import { useRPC, useRPCClient } from "@bittery/shared/rpc";
import type { ItemCategory } from "@bittery/shared/types";
import {
	Button,
	Card,
	CardContent,
	CardDescription,
	CardFooter,
	CardHeader,
	CardTitle,
	copyWithToast,
	Input,
	Label,
	toast,
} from "@bittery/ui";
import {
	IconCircleAlert as AlertCircle,
	IconCalendar as Calendar,
	IconCheck as Check,
	IconClock as Clock,
	IconCopy as Copy,
	IconExternalLink as ExternalLink,
	IconEye as Eye,
	IconEyeOff as EyeOff,
	IconLoaderCircle as Loader2,
	IconLock as Lock,
	IconMail as Mail,
	IconShieldCheck as ShieldCheck,
	IconX as X,
} from "@bittery/ui/icons";
import { useMutation, useQuery } from "@tanstack/react-query";
import { createFileRoute, Link } from "@tanstack/react-router";
import { useState } from "react";
import { base64ToArrayBuffer, decrypt } from "@/lib/wasm-crypto";

export const Route = createFileRoute("/share/$token")({
	component: ShareAccessPage,
	head: () => ({
		meta: [{ title: "Shared Item - Bittery" }],
	}),
});

interface SharedItemData {
	title: string;
	category: ItemCategory;
	url?: string;
	urls?: string[];
	username?: string;
	password?: string;
	notes?: string;
	note?: string;
	// Credit card fields
	cardholderName?: string;
	cardNumber?: string;
	cvv?: string;
	expiryDate?: string;
	billingAddress?: string;
	// Identity fields
	firstName?: string;
	middleName?: string;
	lastName?: string;
	email?: string;
	ssn?: string;
	passportNumber?: string;
	driversLicense?: string;
	dateOfBirth?: string;
	// TOTP fields
	totpSecret?: string;
	totpIssuer?: string;
	totpAccountName?: string;
}

function ShareAccessPage() {
	const { token } = Route.useParams();
	const rpc = useRPC();
	const rpcClient = useRPCClient();

	const [email, setEmail] = useState("");
	const [verificationCode, setVerificationCode] = useState("");
	const [emailSent, setEmailSent] = useState(false);
	const [decryptedItem, setDecryptedItem] = useState<SharedItemData | null>(
		null,
	);
	const [decryptionError, setDecryptionError] = useState<string | null>(null);

	const [shareKey] = useState<string | null>(() => {
		const fragment = window.location.hash.slice(1);
		return fragment || null;
	});

	// Get share link info
	const linkInfoQuery = useQuery(
		rpc.share.getPublicInfo.queryOptions({ token }),
	);

	// Request email verification
	const requestVerificationMutation = useMutation({
		mutationFn: () =>
			rpcClient.share.requestEmailVerification.mutate({ token, email }),
		onSuccess: () => {
			setEmailSent(true);
			toast.success("Verification code sent to your email!");
		},
		onError: (error: Error) => {
			toast.error(error.message);
		},
	});

	// Verify email and access
	const verifyAndAccessMutation = useMutation({
		mutationFn: () =>
			rpcClient.share.verifyEmailAndAccess.mutate({
				token,
				email,
				code: verificationCode,
			}),
		onSuccess: async (data) => {
			try {
				setDecryptionError(null);
				setDecryptedItem(await decryptSharedItem(data));
			} catch (error) {
				console.error("Decryption error:", error);
				setDecryptionError(
					error instanceof Error
						? error.message
						: "Failed to decrypt the shared item. The link may be invalid or corrupted.",
				);
			}
		},
		onError: (error: Error) => {
			toast.error(error.message);
		},
	});

	async function decryptSharedItem(data: {
		encryptedItemData: string;
		encryptionIv: string;
		encryptedShareKey: string;
		shareKeyIv: string;
	}) {
		if (!shareKey) {
			throw new Error(
				"Missing decryption key. Please use the complete share link.",
			);
		}

		const shareKeyBytes = base64ToArrayBuffer(shareKey);
		const decrypted = await decrypt(
			{
				ciphertext: data.encryptedItemData,
				iv: data.encryptionIv,
				algorithm: "AES-GCM-AAD-V1",
			},
			shareKeyBytes,
		);

		return JSON.parse(decrypted) as SharedItemData;
	}
	const publicAccessQuery = useQuery({
		queryKey: ["share", "public-access", token, shareKey],
		enabled:
			linkInfoQuery.data?.valid === true &&
			linkInfoQuery.data.accessMode === "anyone" &&
			!!shareKey &&
			!decryptedItem &&
			!decryptionError,
		queryFn: async () => {
			const data = await rpcClient.share.accessPublic.mutate({ token });
			return await decryptSharedItem(data);
		},
		retry: false,
	});
	const resolvedDecryptedItem = decryptedItem ?? publicAccessQuery.data ?? null;
	const resolvedDecryptionError =
		decryptionError ??
		(publicAccessQuery.error
			? "Failed to decrypt the shared item. The link may be invalid or corrupted."
			: null);

	// Loading state
	if (linkInfoQuery.isLoading) {
		return (
			<div className="flex min-h-screen w-full items-center justify-center bg-muted/30 p-4">
				<Card className="w-full max-w-md">
					<CardContent className="flex flex-col items-center justify-center py-12">
						<Loader2 className="h-8 w-8 animate-spin text-primary" />
						<p className="mt-4 text-muted-foreground">Loading shared item...</p>
					</CardContent>
				</Card>
			</div>
		);
	}

	// Error state
	if (linkInfoQuery.error) {
		return (
			<div className="flex min-h-screen w-full items-center justify-center bg-muted/30 p-4">
				<Card className="w-full max-w-md">
					<CardHeader className="text-center">
						<div className="mx-auto mb-4 flex h-12 w-12 items-center justify-center rounded-full bg-destructive/10">
							<AlertCircle className="h-6 w-6 text-destructive" />
						</div>
						<CardTitle>Share Link Not Found</CardTitle>
						<CardDescription>
							This share link is invalid or has been removed.
						</CardDescription>
					</CardHeader>
					<CardFooter className="justify-center">
						<Link to="/">
							<Button variant="outline">Go Home</Button>
						</Link>
					</CardFooter>
				</Card>
			</div>
		);
	}

	const linkInfo = linkInfoQuery.data;

	// Link not valid
	if (!linkInfo?.valid) {
		const reason =
			"reason" in (linkInfo || {})
				? (linkInfo as { reason?: string })?.reason
				: undefined;

		return (
			<div className="flex min-h-screen w-full items-center justify-center bg-muted/30 p-4">
				<Card className="w-full max-w-md">
					<CardHeader className="text-center">
						<div className="mx-auto mb-4 flex h-12 w-12 items-center justify-center rounded-full bg-muted">
							{reason === "expired" && (
								<Clock className="h-6 w-6 text-muted-foreground" />
							)}
							{reason === "revoked" && (
								<X className="h-6 w-6 text-muted-foreground" />
							)}
							{reason === "exhausted" && (
								<Check className="h-6 w-6 text-muted-foreground" />
							)}
						</div>
						<CardTitle>
							{reason === "expired" && "Link Expired"}
							{reason === "revoked" && "Link Revoked"}
							{reason === "exhausted" && "Link Already Used"}
							{!reason && "Link Not Available"}
						</CardTitle>
						<CardDescription>
							{reason === "expired" &&
								"This share link has expired. Please ask the sender for a new link."}
							{reason === "revoked" &&
								"This share link has been revoked by the owner."}
							{reason === "exhausted" &&
								"This was a one-time link and has already been accessed."}
							{!reason && "This share link is not available."}
						</CardDescription>
					</CardHeader>
					<CardFooter className="justify-center">
						<Link to="/">
							<Button variant="outline">Go Home</Button>
						</Link>
					</CardFooter>
				</Card>
			</div>
		);
	}

	// Decryption error
	if (resolvedDecryptionError) {
		return (
			<div className="flex min-h-screen w-full items-center justify-center bg-muted/30 p-4">
				<Card className="w-full max-w-md">
					<CardHeader className="text-center">
						<div className="mx-auto mb-4 flex h-12 w-12 items-center justify-center rounded-full bg-destructive/10">
							<AlertCircle className="h-6 w-6 text-destructive" />
						</div>
						<CardTitle>Decryption Failed</CardTitle>
						<CardDescription>{resolvedDecryptionError}</CardDescription>
					</CardHeader>
					<CardFooter className="justify-center">
						<Link to="/">
							<Button variant="outline">Go Home</Button>
						</Link>
					</CardFooter>
				</Card>
			</div>
		);
	}

	// Show decrypted item
	if (resolvedDecryptedItem) {
		return (
			<div className="flex min-h-screen w-full items-center justify-center bg-muted/30 p-4">
				<Card className="w-full max-w-lg">
					<CardHeader>
						<div className="flex items-center gap-3">
							<div className="flex h-10 w-10 items-center justify-center rounded-lg bg-primary text-primary-foreground">
								<ShieldCheck className="h-6 w-6" />
							</div>
							<div>
								<CardTitle>{resolvedDecryptedItem.title}</CardTitle>
								<CardDescription className="capitalize">
									{resolvedDecryptedItem.category.replace("-", " ")}
								</CardDescription>
							</div>
						</div>
					</CardHeader>
					<CardContent>
						<SharedItemDisplay item={resolvedDecryptedItem} />
					</CardContent>
					<CardFooter className="justify-between text-muted-foreground text-xs">
						<span className="flex items-center gap-1">
							<Lock className="h-3 w-3" />
							End-to-end encrypted
						</span>
						{"expiresAt" in linkInfo && linkInfo.expiresAt && (
							<span className="flex items-center gap-1">
								<Calendar className="h-3 w-3" />
								Expires: {new Date(linkInfo.expiresAt).toLocaleDateString()}
							</span>
						)}
					</CardFooter>
				</Card>
			</div>
		);
	}

	// Email-restricted mode - show email verification form
	if (linkInfo.accessMode === "email-restricted") {
		return (
			<div className="flex min-h-screen w-full items-center justify-center bg-muted/30 p-4">
				<Card className="w-full max-w-md">
					<CardHeader className="text-center">
						<div className="mx-auto mb-4 flex items-center gap-2">
							<div className="flex h-10 w-10 items-center justify-center rounded-lg bg-primary text-primary-foreground">
								<ShieldCheck className="h-6 w-6" />
							</div>
							<span className="font-bold text-xl">Bittery</span>
						</div>
						<div className="mx-auto mb-4 flex h-16 w-16 items-center justify-center rounded-full bg-primary/10">
							<Mail className="h-8 w-8 text-primary" />
						</div>
						<CardTitle>Email Verification Required</CardTitle>
						<CardDescription>
							{emailSent
								? "Enter the verification code sent to your email."
								: "Enter your email address to verify your access to this shared item."}
						</CardDescription>
					</CardHeader>
					<CardContent>
						{!emailSent ? (
							<form
								onSubmit={(e) => {
									e.preventDefault();
									requestVerificationMutation.mutate();
								}}
								className="space-y-4"
							>
								<div className="space-y-2">
									<Label htmlFor="email">Email Address</Label>
									<Input
										id="email"
										type="email"
										placeholder="you@example.com"
										value={email}
										onChange={(e) => setEmail(e.target.value)}
										required
									/>
								</div>
								<Button
									type="submit"
									className="w-full"
									disabled={requestVerificationMutation.isPending || !email}
								>
									{requestVerificationMutation.isPending ? (
										<Loader2 className="mr-2 h-4 w-4 animate-spin" />
									) : (
										<Mail className="mr-2 h-4 w-4" />
									)}
									Send Verification Code
								</Button>
							</form>
						) : (
							<form
								onSubmit={(e) => {
									e.preventDefault();
									verifyAndAccessMutation.mutate();
								}}
								className="space-y-4"
							>
								<div className="space-y-2">
									<Label htmlFor="code">Verification Code</Label>
									<Input
										id="code"
										type="text"
										placeholder="123456"
										maxLength={6}
										value={verificationCode}
										onChange={(e) =>
											setVerificationCode(e.target.value.replace(/\D/g, ""))
										}
										required
										className="text-center font-mono text-2xl tracking-widest"
									/>
									<p className="text-center text-muted-foreground text-xs">
										Code sent to {email}
									</p>
								</div>
								<Button
									type="submit"
									className="w-full"
									disabled={
										verifyAndAccessMutation.isPending ||
										verificationCode.length !== 6
									}
								>
									{verifyAndAccessMutation.isPending ? (
										<Loader2 className="mr-2 h-4 w-4 animate-spin" />
									) : (
										<Check className="mr-2 h-4 w-4" />
									)}
									Verify & Access
								</Button>
								<Button
									type="button"
									variant="ghost"
									className="w-full"
									onClick={() => {
										setEmailSent(false);
										setVerificationCode("");
									}}
								>
									Use a different email
								</Button>
							</form>
						)}
					</CardContent>
				</Card>
			</div>
		);
	}

	// Anyone mode - loading access
	return (
		<div className="flex min-h-screen w-full items-center justify-center bg-muted/30 p-4">
			<Card className="w-full max-w-md">
				<CardContent className="flex flex-col items-center justify-center py-12">
					<Loader2 className="h-8 w-8 animate-spin text-primary" />
					<p className="mt-4 text-muted-foreground">
						Decrypting shared item...
					</p>
				</CardContent>
			</Card>
		</div>
	);
}

// Component to display the shared item data
function SharedItemDisplay({ item }: { item: SharedItemData }) {
	const [showPassword, setShowPassword] = useState(false);
	const [showCardNumber, setShowCardNumber] = useState(false);
	const [showCVV, setShowCVV] = useState(false);
	const [showSSN, setShowSSN] = useState(false);

	const handleCopy = (text: string | undefined, label: string) => {
		copyWithToast(text, label, { showAutoClearMessage: false });
	};

	return (
		<div className="space-y-4">
			{/* Login fields */}
			{item.url && (
				<div className="space-y-1">
					<Label className="text-muted-foreground text-xs">Website</Label>
					<div className="flex gap-2">
						<Input value={item.url} readOnly className="flex-1" />
						<Button
							size="icon"
							variant="outline"
							onClick={() => handleCopy(item.url, "URL")}
						>
							<Copy className="h-4 w-4" />
						</Button>
						<Button
							size="icon"
							variant="outline"
							onClick={() => window.open(item.url, "_blank")}
						>
							<ExternalLink className="h-4 w-4" />
						</Button>
					</div>
				</div>
			)}

			{item.username && (
				<div className="space-y-1">
					<Label className="text-muted-foreground text-xs">Username</Label>
					<div className="flex gap-2">
						<Input value={item.username} readOnly className="flex-1" />
						<Button
							size="icon"
							variant="outline"
							onClick={() => handleCopy(item.username, "Username")}
						>
							<Copy className="h-4 w-4" />
						</Button>
					</div>
				</div>
			)}

			{item.password && (
				<div className="space-y-1">
					<Label className="text-muted-foreground text-xs">Password</Label>
					<div className="flex gap-2">
						<Input
							type={showPassword ? "text" : "password"}
							value={item.password}
							readOnly
							className="flex-1 font-mono"
						/>
						<Button
							size="icon"
							variant="outline"
							onClick={() => setShowPassword(!showPassword)}
						>
							{showPassword ? (
								<EyeOff className="h-4 w-4" />
							) : (
								<Eye className="h-4 w-4" />
							)}
						</Button>
						<Button
							size="icon"
							variant="outline"
							onClick={() => handleCopy(item.password, "Password")}
						>
							<Copy className="h-4 w-4" />
						</Button>
					</div>
				</div>
			)}

			{/* Credit card fields */}
			{item.cardholderName && (
				<div className="space-y-1">
					<Label className="text-muted-foreground text-xs">
						Cardholder Name
					</Label>
					<div className="flex gap-2">
						<Input value={item.cardholderName} readOnly className="flex-1" />
						<Button
							size="icon"
							variant="outline"
							onClick={() => handleCopy(item.cardholderName, "Cardholder name")}
						>
							<Copy className="h-4 w-4" />
						</Button>
					</div>
				</div>
			)}

			{item.cardNumber && (
				<div className="space-y-1">
					<Label className="text-muted-foreground text-xs">Card Number</Label>
					<div className="flex gap-2">
						<Input
							type={showCardNumber ? "text" : "password"}
							value={item.cardNumber}
							readOnly
							className="flex-1 font-mono"
						/>
						<Button
							size="icon"
							variant="outline"
							onClick={() => setShowCardNumber(!showCardNumber)}
						>
							{showCardNumber ? (
								<EyeOff className="h-4 w-4" />
							) : (
								<Eye className="h-4 w-4" />
							)}
						</Button>
						<Button
							size="icon"
							variant="outline"
							onClick={() => handleCopy(item.cardNumber, "Card number")}
						>
							<Copy className="h-4 w-4" />
						</Button>
					</div>
				</div>
			)}

			{item.expiryDate && (
				<div className="space-y-1">
					<Label className="text-muted-foreground text-xs">Expiry Date</Label>
					<div className="flex gap-2">
						<Input value={item.expiryDate} readOnly className="flex-1" />
						<Button
							size="icon"
							variant="outline"
							onClick={() => handleCopy(item.expiryDate, "Expiry date")}
						>
							<Copy className="h-4 w-4" />
						</Button>
					</div>
				</div>
			)}

			{item.cvv && (
				<div className="space-y-1">
					<Label className="text-muted-foreground text-xs">CVV</Label>
					<div className="flex gap-2">
						<Input
							type={showCVV ? "text" : "password"}
							value={item.cvv}
							readOnly
							className="flex-1 font-mono"
						/>
						<Button
							size="icon"
							variant="outline"
							onClick={() => setShowCVV(!showCVV)}
						>
							{showCVV ? (
								<EyeOff className="h-4 w-4" />
							) : (
								<Eye className="h-4 w-4" />
							)}
						</Button>
						<Button
							size="icon"
							variant="outline"
							onClick={() => handleCopy(item.cvv, "CVV")}
						>
							<Copy className="h-4 w-4" />
						</Button>
					</div>
				</div>
			)}

			{/* Identity fields */}
			{(item.firstName || item.lastName) && (
				<div className="space-y-1">
					<Label className="text-muted-foreground text-xs">Full Name</Label>
					<div className="flex gap-2">
						<Input
							value={[item.firstName, item.middleName, item.lastName]
								.filter(Boolean)
								.join(" ")}
							readOnly
							className="flex-1"
						/>
						<Button
							size="icon"
							variant="outline"
							onClick={() =>
								handleCopy(
									[item.firstName, item.middleName, item.lastName]
										.filter(Boolean)
										.join(" "),
									"Name",
								)
							}
						>
							<Copy className="h-4 w-4" />
						</Button>
					</div>
				</div>
			)}

			{item.email && (
				<div className="space-y-1">
					<Label className="text-muted-foreground text-xs">Email</Label>
					<div className="flex gap-2">
						<Input value={item.email} readOnly className="flex-1" />
						<Button
							size="icon"
							variant="outline"
							onClick={() => handleCopy(item.email, "Email")}
						>
							<Copy className="h-4 w-4" />
						</Button>
					</div>
				</div>
			)}

			{item.ssn && (
				<div className="space-y-1">
					<Label className="text-muted-foreground text-xs">SSN</Label>
					<div className="flex gap-2">
						<Input
							type={showSSN ? "text" : "password"}
							value={item.ssn}
							readOnly
							className="flex-1 font-mono"
						/>
						<Button
							size="icon"
							variant="outline"
							onClick={() => setShowSSN(!showSSN)}
						>
							{showSSN ? (
								<EyeOff className="h-4 w-4" />
							) : (
								<Eye className="h-4 w-4" />
							)}
						</Button>
						<Button
							size="icon"
							variant="outline"
							onClick={() => handleCopy(item.ssn, "SSN")}
						>
							<Copy className="h-4 w-4" />
						</Button>
					</div>
				</div>
			)}

			{/* TOTP fields */}
			{item.totpSecret && (
				<div className="space-y-1">
					<Label className="text-muted-foreground text-xs">TOTP Secret</Label>
					<div className="flex gap-2">
						<Input
							value={item.totpSecret}
							readOnly
							className="flex-1 font-mono"
						/>
						<Button
							size="icon"
							variant="outline"
							onClick={() => handleCopy(item.totpSecret, "TOTP Secret")}
						>
							<Copy className="h-4 w-4" />
						</Button>
					</div>
				</div>
			)}

			{/* Secure note */}
			{item.note && (
				<div className="space-y-1">
					<Label className="text-muted-foreground text-xs">Note</Label>
					<div className="rounded-lg border bg-muted/50 p-4">
						<pre className="whitespace-pre-wrap font-sans text-sm">
							{item.note}
						</pre>
					</div>
				</div>
			)}

			{/* Notes */}
			{item.notes && (
				<div className="space-y-1">
					<Label className="text-muted-foreground text-xs">Notes</Label>
					<div className="rounded-lg border bg-muted/50 p-4">
						<pre className="whitespace-pre-wrap font-sans text-sm">
							{item.notes}
						</pre>
					</div>
				</div>
			)}
		</div>
	);
}
