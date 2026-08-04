import { readShareKeyFromUrl } from "@bittery/core/services/share-service";
import { useRPC, useRPCClient } from "@bittery/shared/rpc";
import type { SharedItemPayload } from "@bittery/shared/types";
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
	IconTriangleAlert as TriangleAlert,
	IconX as X,
} from "@bittery/ui/icons";
import { useMutation, useQuery } from "@tanstack/react-query";
import { createFileRoute, Link } from "@tanstack/react-router";
import { useState } from "react";
import {
	isOneTimeShareLink,
	resolveShareAccessStage,
	type ShareLinkInfoStatus,
} from "@/lib/share-access-gate";
import { base64ToArrayBuffer, decrypt } from "@/lib/wasm-crypto";
import { useI18n } from "@/providers/i18n-provider";

const MISSING_SHARE_KEY_MESSAGE =
	"Missing decryption key. Please use the complete share link.";
const GENERIC_DECRYPTION_ERROR_MESSAGE =
	"Failed to decrypt the shared item. The link may be invalid or corrupted.";

export const Route = createFileRoute("/share/$token")({
	component: ShareAccessPage,
	head: () => ({
		meta: [{ title: "Shared Item - Bittery" }],
	}),
});

function ShareAccessPage() {
	const { token } = Route.useParams();
	const rpc = useRPC();
	const rpcClient = useRPCClient();
	const { m } = useI18n();

	const [email, setEmail] = useState("");
	const [verificationCode, setVerificationCode] = useState("");
	const [emailSent, setEmailSent] = useState(false);
	const [decryptedItem, setDecryptedItem] = useState<SharedItemPayload | null>(
		null,
	);
	const [decryptionError, setDecryptionError] = useState<string | null>(null);

	const [shareKey] = useState<string | null>(() =>
		readShareKeyFromUrl(window.location.href),
	);

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
						: GENERIC_DECRYPTION_ERROR_MESSAGE,
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
			throw new Error(MISSING_SHARE_KEY_MESSAGE);
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

		return JSON.parse(decrypted) as SharedItemPayload;
	}
	// Consuming the link is a deliberate user action, never a side effect of
	// navigation: `share.accessPublic` increments `access_count` server-side, so
	// firing it on mount would let a plain refresh burn a one-time link.
	const revealMutation = useMutation({
		mutationFn: async () => {
			const data = await rpcClient.share.accessPublic.mutate({ token });
			return await decryptSharedItem(data);
		},
		onSuccess: (item) => {
			setDecryptionError(null);
			setDecryptedItem(item);
		},
		onError: (error: Error) => {
			console.error("Share access error:", error);
			setDecryptionError(GENERIC_DECRYPTION_ERROR_MESSAGE);
		},
	});

	const linkInfo = linkInfoQuery.data;
	const linkInfoStatus: ShareLinkInfoStatus = linkInfoQuery.isLoading
		? "loading"
		: linkInfoQuery.error
			? "error"
			: "ready";
	const stage = resolveShareAccessStage({
		linkInfoStatus,
		linkInfo,
		hasShareKey: !!shareKey,
		revealPending: revealMutation.isPending,
		hasDecryptedItem: !!decryptedItem,
		hasFailure: !!decryptionError,
	});
	const isOneTimeUse = isOneTimeShareLink(linkInfo);
	const expiresAt =
		linkInfo && "expiresAt" in linkInfo ? linkInfo.expiresAt : null;

	// Loading state
	if (stage === "loading") {
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
	if (stage === "link-not-found" || !linkInfo) {
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

	// Link not valid
	if (stage === "link-unavailable") {
		const reason =
			"reason" in linkInfo
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

	// Decryption error — including a link opened without its `#` fragment key,
	// which is caught up-front so the recipient cannot burn the link on an
	// access that could never have decrypted.
	if (stage === "missing-key" || stage === "failed") {
		return (
			<div className="flex min-h-screen w-full items-center justify-center bg-muted/30 p-4">
				<Card className="w-full max-w-md">
					<CardHeader className="text-center">
						<div className="mx-auto mb-4 flex h-12 w-12 items-center justify-center rounded-full bg-destructive/10">
							<AlertCircle className="h-6 w-6 text-destructive" />
						</div>
						<CardTitle>Decryption Failed</CardTitle>
						<CardDescription>
							{stage === "missing-key"
								? MISSING_SHARE_KEY_MESSAGE
								: decryptionError}
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

	// Show decrypted item
	if (stage === "revealed" && decryptedItem) {
		return (
			<div className="flex min-h-screen w-full items-center justify-center bg-muted/30 p-4">
				<Card className="w-full max-w-lg">
					<CardHeader>
						<div className="flex items-center gap-3">
							<div className="flex h-10 w-10 items-center justify-center rounded-lg bg-primary text-primary-foreground">
								<ShieldCheck className="h-6 w-6" />
							</div>
							<div>
								<CardTitle>{decryptedItem.title}</CardTitle>
								<CardDescription className="capitalize">
									{decryptedItem.category.replace("-", " ")}
								</CardDescription>
							</div>
						</div>
					</CardHeader>
					<CardContent>
						<SharedItemDisplay item={decryptedItem} />
					</CardContent>
					<CardFooter className="justify-between text-muted-foreground text-xs">
						<span className="flex items-center gap-1">
							<Lock className="h-3 w-3" />
							End-to-end encrypted
						</span>
						{expiresAt && (
							<span className="flex items-center gap-1">
								<Calendar className="h-3 w-3" />
								Expires: {new Date(expiresAt).toLocaleDateString()}
							</span>
						)}
					</CardFooter>
				</Card>
			</div>
		);
	}

	// Email-restricted mode - the code-entry step is itself the explicit gate:
	// nothing is consumed until a valid 6-digit code is submitted.
	if (stage === "email-verification") {
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
								{isOneTimeUse && (
									<OneTimeUseWarning
										message={m.share_access_gate_one_time_warning()}
									/>
								)}
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

	// Anyone mode - access in flight after the recipient confirmed
	if (stage === "revealing") {
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

	// Anyone mode - the gate. Nothing has been consumed yet; only the button
	// below calls `share.accessPublic`.
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
					<CardTitle>
						{isOneTimeUse
							? m.share_access_gate_title_one_time()
							: m.share_access_gate_title()}
					</CardTitle>
					<CardDescription>
						{isOneTimeUse
							? m.share_access_gate_description_one_time()
							: m.share_access_gate_description()}
					</CardDescription>
				</CardHeader>
				<CardContent className="space-y-4">
					<dl className="divide-y rounded-lg border bg-card text-sm">
						<div className="flex items-center justify-between gap-4 px-3 py-2">
							<dt className="text-muted-foreground">
								{m.share_access_gate_label_access()}
							</dt>
							<dd className="text-right">
								{linkInfo.accessMode === "email-restricted"
									? m.share_access_gate_access_email_restricted()
									: m.share_access_gate_access_anyone()}
							</dd>
						</div>
						<div className="flex items-center justify-between gap-4 px-3 py-2">
							<dt className="text-muted-foreground">
								{m.share_access_gate_label_usage()}
							</dt>
							<dd className="text-right">
								{isOneTimeUse
									? m.share_access_gate_usage_one_time()
									: m.share_access_gate_usage_multi()}
							</dd>
						</div>
						{expiresAt && (
							<div className="flex items-center justify-between gap-4 px-3 py-2">
								<dt className="text-muted-foreground">
									{m.share_access_gate_label_expires()}
								</dt>
								<dd className="flex items-center gap-1 text-right">
									<Calendar className="size-3.5 text-muted-foreground" />
									{new Date(expiresAt).toLocaleString()}
								</dd>
							</div>
						)}
					</dl>
					{isOneTimeUse && (
						<OneTimeUseWarning
							message={m.share_access_gate_one_time_warning()}
						/>
					)}
				</CardContent>
				<CardFooter className="flex-col gap-3">
					<Button
						type="button"
						className="w-full"
						onClick={() => revealMutation.mutate()}
						data-testid="share-reveal-button"
					>
						<Eye className="mr-2 h-4 w-4" />
						{isOneTimeUse
							? m.share_access_gate_action_reveal_one_time()
							: m.share_access_gate_action_reveal()}
					</Button>
					<p className="flex items-start gap-1.5 text-muted-foreground text-xs">
						<Lock aria-hidden className="mt-0.5 size-3 shrink-0" />
						{m.share_access_gate_privacy_note()}
					</p>
				</CardFooter>
			</Card>
		</div>
	);
}

function OneTimeUseWarning({ message }: { message: string }) {
	return (
		<div className="flex gap-2 rounded-lg border border-warning/30 bg-warning/10 p-3 text-sm">
			<TriangleAlert
				aria-hidden
				className="mt-0.5 size-4 shrink-0 text-warning"
			/>
			<p>{message}</p>
		</div>
	);
}

// Component to display the shared item data
function SharedItemDisplay({ item }: { item: SharedItemPayload }) {
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
