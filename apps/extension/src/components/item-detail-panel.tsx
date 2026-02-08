import { generateTotp, type TotpResult } from "@bittery/shared/totp";
import type {
	DecryptedItem,
	TotpAlgorithm,
	TotpDigits,
} from "@bittery/shared/types";
import {
	Button,
	ButtonGroup,
	Card,
	copyWithToast,
	InputGroup,
	InputGroupAddon,
	InputGroupButton,
	InputGroupInput,
	Label,
	toast,
} from "@bittery/ui";
import {
	IconCopyOutlineDuo18,
	IconEyeOutlineDuo18,
	IconEyeSlashOutlineDuo18,
	IconLoader2OutlineDuo18,
	IconOpenExternalOutlineDuo18,
	IconQrcodeOutlineDuo18,
} from "@bittery/ui/icons";
import { useCallback, useEffect, useState } from "react";
import { Favicon } from "./favicon";
import { QRScanner, type QRScanResult } from "./qr-scanner";

const getItemNotes = (item: DecryptedItem) => item.notes || item.note || "";

const normalizeUrl = (url: string) =>
	url.includes("://") ? url : `https://${url}`;

const handleOpenUrl = (targetUrl: string | undefined) => {
	if (!targetUrl) {
		toast.error("No URL to open");
		return;
	}

	window.open(normalizeUrl(targetUrl), "_blank", "noopener,noreferrer");
};

const handleCopy = copyWithToast;

interface ItemDetailPanelProps {
	item: DecryptedItem;
	onItemUpdated?: () => void;
}

/**
 * Inline TOTP Display Component
 * Shows the TOTP code with a countdown timer
 */
interface InlineTotpDisplayProps {
	totpSecret: string;
	totpAlgorithm?: TotpAlgorithm;
	totpDigits?: TotpDigits;
	totpPeriod?: number;
}

function InlineTotpDisplay({
	totpSecret,
	totpAlgorithm = "SHA1",
	totpDigits = 6,
	totpPeriod = 30,
}: InlineTotpDisplayProps) {
	const [totpResult, setTotpResult] = useState<TotpResult | null>(null);

	const generateCode = useCallback(async () => {
		try {
			const result = await generateTotp({
				secret: totpSecret,
				algorithm: totpAlgorithm,
				digits: totpDigits,
				period: totpPeriod,
			});
			setTotpResult(result);
		} catch (error) {
			console.error("Failed to generate TOTP code:", error);
		}
	}, [totpSecret, totpAlgorithm, totpDigits, totpPeriod]);

	useEffect(() => {
		generateCode();

		const interval = setInterval(() => {
			generateCode();
		}, 1000);

		return () => clearInterval(interval);
	}, [generateCode]);

	const handleCopyCode = () => {
		copyWithToast(totpResult?.code, "Code", { showAutoClearMessage: false });
	};

	const progress = totpResult?.progress || 0;
	const circumference = 2 * Math.PI * 14;
	const strokeDashoffset = circumference - (progress / 100) * circumference;

	const getProgressColor = () => {
		if (!totpResult) return "stroke-muted";
		if (totpResult.remainingSeconds <= 5) return "stroke-destructive";
		if (totpResult.remainingSeconds <= 10) return "stroke-yellow-500";
		return "stroke-primary";
	};

	return (
		<div className="flex items-center justify-between rounded-lg border bg-muted/30 p-3">
			<button
				type="button"
				onClick={handleCopyCode}
				className="group flex cursor-pointer items-center gap-3 rounded-lg transition-colors hover:bg-muted/50"
				title="Click to copy"
			>
				<div className="relative flex size-9 items-center justify-center">
					<svg
						className="size-9 -rotate-90"
						viewBox="0 0 32 32"
						aria-hidden="true"
					>
						<circle
							cx="16"
							cy="16"
							r="14"
							fill="none"
							stroke="currentColor"
							strokeWidth="2.5"
							className="text-muted/30"
						/>
						<circle
							cx="16"
							cy="16"
							r="14"
							fill="none"
							strokeWidth="2.5"
							strokeLinecap="round"
							className={`transition-all duration-300 ${getProgressColor()}`}
							style={{
								strokeDasharray: circumference,
								strokeDashoffset: strokeDashoffset,
							}}
						/>
					</svg>
					<span className="absolute font-medium font-mono text-xs">
						{totpResult?.remainingSeconds || "--"}
					</span>
				</div>

				<div className="flex flex-col">
					<span className="font-bold font-mono text-xl tracking-widest">
						{totpResult?.code
							? `${totpResult.code.slice(0, 3)} ${totpResult.code.slice(3)}`
							: "--- ---"}
					</span>
					<span className="text-muted-foreground text-xs">
						One-time password
					</span>
				</div>
			</button>

			<Button
				size="icon"
				variant="outline"
				onClick={handleCopyCode}
				disabled={!totpResult?.code}
			>
				<IconCopyOutlineDuo18 size={16} />
			</Button>
		</div>
	);
}

function LoginItemDetail({
	item,
	onItemUpdated,
}: {
	item: DecryptedItem;
	onItemUpdated?: () => void;
}) {
	const [showPassword, setShowPassword] = useState(false);
	const [showQRScanner, setShowQRScanner] = useState(false);
	const [isSaving, setIsSaving] = useState(false);
	const notes = getItemNotes(item);

	const handleQRScanComplete = useCallback(
		async (result: QRScanResult) => {
			if (result.status !== "success" || !result.data) {
				return;
			}

			setIsSaving(true);

			try {
				// Send the TOTP data to the background to update the item
				const response = await chrome.runtime.sendMessage({
					type: "UPDATE_ITEM_TOTP",
					payload: {
						itemId: item.id,
						totp: {
							totpSecret: result.data.secret,
							totpIssuer: result.data.issuer,
							totpAccountName: result.data.accountName,
							totpAlgorithm: result.data.algorithm,
							totpDigits: result.data.digits,
							totpPeriod: result.data.period,
						},
					},
				});

				if (response?.success) {
					toast.success("TOTP added successfully!");
					setShowQRScanner(false);
					// Trigger a refresh of the item data
					onItemUpdated?.();
				} else {
					toast.error(response?.error || "Failed to save TOTP");
				}
			} catch (error: any) {
				console.error("Error saving TOTP:", error);
				toast.error("Failed to save TOTP");
			} finally {
				setIsSaving(false);
			}
		},
		[item.id, onItemUpdated],
	);

	const handleCancelQRScanner = useCallback(() => {
		setShowQRScanner(false);
	}, []);

	return (
		<div className="space-y-3">
			{item.url && (
				<div className="space-y-2">
					<Label className="font-medium text-sm">Website</Label>
					<InputGroup>
						<InputGroupInput value={item.url} readOnly />
						<InputGroupAddon align="inline-end">
							<ButtonGroup>
								<InputGroupButton
									size="icon-sm"
									onClick={() => handleCopy(item.url, "URL")}
								>
									<IconCopyOutlineDuo18 className="size-4" />
								</InputGroupButton>
								<InputGroupButton
									size="icon-sm"
									onClick={() => handleOpenUrl(item.url)}
								>
									<IconOpenExternalOutlineDuo18 className="size-4" />
								</InputGroupButton>
							</ButtonGroup>
						</InputGroupAddon>
					</InputGroup>
				</div>
			)}

			{item.username && (
				<div className="space-y-2">
					<Label className="font-medium text-sm">Username</Label>
					<InputGroup>
						<InputGroupInput value={item.username} readOnly />
						<InputGroupAddon align="inline-end">
							<InputGroupButton
								size="icon-sm"
								onClick={() => handleCopy(item.username, "Username")}
							>
								<IconCopyOutlineDuo18 className="size-4" />
							</InputGroupButton>
						</InputGroupAddon>
					</InputGroup>
				</div>
			)}

			{item.password && (
				<div className="space-y-2">
					<Label className="font-medium text-sm">Password</Label>
					<InputGroup>
						<InputGroupInput
							type={showPassword ? "text" : "password"}
							value={item.password}
							readOnly
							className="font-mono"
						/>
						<InputGroupAddon align="inline-end">
							<ButtonGroup>
								<InputGroupButton
									size="icon-sm"
									onClick={() => setShowPassword(!showPassword)}
								>
									{showPassword ? (
										<IconEyeSlashOutlineDuo18 className="size-4" />
									) : (
										<IconEyeOutlineDuo18 className="size-4" />
									)}
								</InputGroupButton>
								<InputGroupButton
									size="icon-sm"
									onClick={() => handleCopy(item.password, "Password")}
								>
									<IconCopyOutlineDuo18 className="size-4" />
								</InputGroupButton>
							</ButtonGroup>
						</InputGroupAddon>
					</InputGroup>
				</div>
			)}

			{/* TOTP Section */}
			<div className="space-y-2">
				<Label className="font-medium text-sm">Two-Factor Authentication</Label>
				{item.totpSecret ? (
					<InlineTotpDisplay
						totpSecret={item.totpSecret}
						totpAlgorithm={item.totpAlgorithm}
						totpDigits={item.totpDigits}
						totpPeriod={item.totpPeriod}
					/>
				) : showQRScanner ? (
					isSaving ? (
						<Card className="flex items-center justify-center gap-2 p-4">
							<IconLoader2OutlineDuo18 className="h-5 w-5 animate-spin" />
							<span className="text-sm">Saving TOTP...</span>
						</Card>
					) : (
						<QRScanner
							onScanComplete={handleQRScanComplete}
							onCancel={handleCancelQRScanner}
						/>
					)
				) : (
					<Button
						variant="outline"
						className="w-full gap-2"
						onClick={() => setShowQRScanner(true)}
					>
						<IconQrcodeOutlineDuo18 size={16} />
						Scan QR Code to Add 2FA
					</Button>
				)}
			</div>

			{notes && (
				<div className="space-y-2">
					<Label className="font-medium text-sm">Notes</Label>
					<Card>
						<div className="whitespace-pre-wrap px-4 py-1 text-sm">{notes}</div>
					</Card>
				</div>
			)}
		</div>
	);
}

function SecureNoteDetail({ item }: { item: DecryptedItem }) {
	const notes = getItemNotes(item);

	return (
		<div className="space-y-2">
			<Label className="font-medium text-sm">Note</Label>
			<Card>
				<div className="whitespace-pre-wrap px-4 py-1 text-sm">
					{notes || "No notes added yet."}
				</div>
			</Card>
		</div>
	);
}

function CreditCardDetail({ item }: { item: DecryptedItem }) {
	const notes = getItemNotes(item);

	return (
		<div className="space-y-3">
			<div className="text-muted-foreground text-sm">
				Credit card details coming soon
			</div>
			{notes && (
				<div className="space-y-2">
					<Label className="font-medium text-sm">Notes</Label>
					<Card>
						<div className="whitespace-pre-wrap px-4 py-1 text-sm">{notes}</div>
					</Card>
				</div>
			)}
		</div>
	);
}

function IdentityDetail({ item }: { item: DecryptedItem }) {
	const notes = getItemNotes(item);

	return (
		<div className="space-y-3">
			<div className="text-muted-foreground text-sm">
				Identity details coming soon
			</div>
			{notes && (
				<div className="space-y-2">
					<Label className="font-medium text-sm">Notes</Label>
					<Card>
						<div className="whitespace-pre-wrap px-4 py-1 text-sm">{notes}</div>
					</Card>
				</div>
			)}
		</div>
	);
}

export function ItemDetailPanel({ item, onItemUpdated }: ItemDetailPanelProps) {
	const isSecureNote = item.category === "secure-note";

	return (
		<div className="space-y-4">
			<div className="flex items-center gap-4">
				<Favicon
					url={isSecureNote ? undefined : item.url}
					title={item.title}
					category={item.category}
					size="lg"
				/>
				<div className="min-w-0 flex-1">
					<h2 className="truncate font-semibold text-lg tracking-tight">
						{item.title}
					</h2>
					{item.url ? (
						<p className="mt-0.5 truncate text-muted-foreground text-xs">
							{item.url}
						</p>
					) : isSecureNote ? (
						<p className="mt-0.5 text-muted-foreground text-xs">Secure Note</p>
					) : null}
				</div>
			</div>

			{item.category === "secure-note" && <SecureNoteDetail item={item} />}
			{item.category === "login" && (
				<LoginItemDetail item={item} onItemUpdated={onItemUpdated} />
			)}
			{item.category === "credit-card" && <CreditCardDetail item={item} />}
			{item.category === "identity" && <IdentityDetail item={item} />}
		</div>
	);
}
