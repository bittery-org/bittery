import { generateTotp, type TotpResult } from "@bittery/shared/totp";
import type {
	DecryptedItem,
	TotpAlgorithm,
	TotpDigits,
} from "@bittery/shared/types";
import { Button, Card, cn, copyWithToast, Label, toast } from "@bittery/ui";
import {
	IconCopy,
	IconEye,
	IconEyeOff,
	IconLoaderCircle,
	IconOpenExternal,
	IconQrCode,
	IconWand,
} from "@bittery/ui/icons";
import { useCallback, useEffect, useState } from "react";
import { useI18n } from "@/providers/i18n-provider";
import { Favicon } from "./favicon";
import { QRScanner, type QRScanResult } from "./qr-scanner";

const getItemNotes = (item: DecryptedItem) => item.notes || item.note || "";

const normalizeUrl = (url: string) =>
	url.includes("://") ? url : `https://${url}`;

const handleCopy = copyWithToast;

interface ItemDetailPanelProps {
	item: DecryptedItem;
	onItemUpdated?: () => void;
	/** True when the item matches the active tab's domain. */
	matchesActiveTab?: boolean;
	/** Trigger autofill of this item into the active tab. */
	onAutofill?: () => void;
	/** Open the item in the desktop app for editing. */
	onOpenInApp?: () => void;
}

/** Hover-revealed size-7 icon action used inside field cards. */
function FieldAction({
	label,
	onClick,
	disabled,
	children,
}: {
	label: string;
	onClick: () => void;
	disabled?: boolean;
	children: React.ReactNode;
}) {
	return (
		<Button
			type="button"
			variant="ghost"
			size="icon"
			className="size-7 text-muted-foreground opacity-0 transition-opacity focus-visible:opacity-100 group-focus-within:opacity-100 group-hover:opacity-100"
			title={label}
			disabled={disabled}
			onClick={onClick}
		>
			{children}
		</Button>
	);
}

/** A single field row inside a `bg-card` field card. */
function FieldRow({
	label,
	children,
	actions,
}: {
	label: string;
	children: React.ReactNode;
	actions?: React.ReactNode;
}) {
	return (
		<div className="group flex min-h-11 items-center gap-2 px-3 py-2 transition-colors hover:bg-accent">
			<div className="min-w-0 flex-1">
				<div className="font-semibold text-[10.5px] text-muted-foreground uppercase tracking-[0.05em]">
					{label}
				</div>
				<div className="mt-px">{children}</div>
			</div>
			{actions ? <div className="flex gap-0.5">{actions}</div> : null}
		</div>
	);
}

/**
 * Inline TOTP row: mono code with a small countdown ring, rendered as a field
 * row inside the login field card. Copy action is revealed on hover.
 */
interface InlineTotpRowProps {
	totpSecret: string;
	totpAlgorithm?: TotpAlgorithm;
	totpDigits?: TotpDigits;
	totpPeriod?: number;
	label: string;
}

function InlineTotpRow({
	totpSecret,
	totpAlgorithm = "SHA1",
	totpDigits = 6,
	totpPeriod = 30,
	label,
}: InlineTotpRowProps) {
	const { m } = useI18n();
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
		const interval = setInterval(generateCode, 1000);
		return () => clearInterval(interval);
	}, [generateCode]);

	const handleCopyCode = () =>
		copyWithToast(totpResult?.code, "Code", { showAutoClearMessage: false });

	const progress = totpResult?.progress ?? 0;
	const circumference = 2 * Math.PI * 6;
	const strokeDashoffset = circumference - (progress / 100) * circumference;
	const code = totpResult?.code
		? `${totpResult.code.slice(0, 3)} ${totpResult.code.slice(3)}`
		: "--- ---";

	return (
		<FieldRow
			label={label}
			actions={
				<FieldAction
					label={m.ext_detail_action_copy()}
					onClick={handleCopyCode}
					disabled={!totpResult?.code}
				>
					<IconCopy className="size-3.5" />
				</FieldAction>
			}
		>
			<div className="flex items-center gap-2.5">
				<span className="font-medium font-mono text-[15px] text-foreground tracking-[0.12em]">
					{code}
				</span>
				<svg
					className="size-[15px] -rotate-90"
					viewBox="0 0 16 16"
					aria-hidden="true"
				>
					<circle
						cx="8"
						cy="8"
						r="6"
						fill="none"
						strokeWidth="2.5"
						className="stroke-muted-foreground/35"
					/>
					<circle
						cx="8"
						cy="8"
						r="6"
						fill="none"
						strokeWidth="2.5"
						strokeLinecap="round"
						className={cn(
							"transition-all duration-300",
							totpResult && totpResult.remainingSeconds <= 5
								? "stroke-destructive"
								: "stroke-primary",
						)}
						style={{
							strokeDasharray: circumference,
							strokeDashoffset,
							filter:
								"drop-shadow(0 0 3px color-mix(in oklab, var(--color-primary) 70%, transparent))",
						}}
					/>
				</svg>
			</div>
		</FieldRow>
	);
}

function LoginItemDetail({
	item,
	onItemUpdated,
}: {
	item: DecryptedItem;
	onItemUpdated?: () => void;
}) {
	const { m } = useI18n();
	const [showPassword, setShowPassword] = useState(false);
	const [showQRScanner, setShowQRScanner] = useState(false);
	const [isSaving, setIsSaving] = useState(false);
	const notes = getItemNotes(item);
	const passkeys = [...(item.passkeys ?? [])].sort((left, right) => {
		const leftTs = Date.parse(left.lastUsedAt ?? left.createdAt);
		const rightTs = Date.parse(right.lastUsedAt ?? right.createdAt);
		return rightTs - leftTs;
	});

	const handleOpenUrl = (targetUrl: string | undefined) => {
		if (!targetUrl) {
			toast.error(m.ext_detail_toast_no_url());
			return;
		}
		window.open(normalizeUrl(targetUrl), "_blank", "noopener,noreferrer");
	};

	const formatPasskeyLastUsed = (value?: string) => {
		if (!value) return m.ext_detail_last_used_never();
		const timestamp = Date.parse(value);
		if (Number.isNaN(timestamp)) return m.ext_detail_last_used_recently();
		const deltaMs = Date.now() - timestamp;
		const deltaDays = Math.floor(deltaMs / (24 * 60 * 60 * 1000));
		if (deltaDays <= 0) return m.ext_detail_last_used_today();
		if (deltaDays === 1) return m.ext_detail_last_used_yesterday();
		if (deltaDays < 30)
			return m.ext_detail_last_used_days_ago({ count: deltaDays });
		return new Date(timestamp).toLocaleDateString();
	};

	const handleQRScanComplete = useCallback(
		async (result: QRScanResult) => {
			if (result.status !== "success" || !result.data) {
				return;
			}

			setIsSaving(true);

			try {
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
					toast.success(m.ext_detail_totp_saved());
					setShowQRScanner(false);
					onItemUpdated?.();
				} else {
					toast.error(response?.error || m.ext_detail_totp_save_failed());
				}
			} catch (error: any) {
				console.error("Error saving TOTP:", error);
				toast.error(m.ext_detail_totp_save_failed());
			} finally {
				setIsSaving(false);
			}
		},
		[
			item.id,
			onItemUpdated,
			m.ext_detail_totp_save_failed,
			m.ext_detail_totp_saved,
		],
	);

	const handleCancelQRScanner = useCallback(() => {
		setShowQRScanner(false);
	}, []);

	return (
		<div className="space-y-3">
			<div className="divide-y overflow-hidden rounded-lg border bg-card">
				{item.url && (
					<FieldRow
						label={m.ext_detail_label_website()}
						actions={
							<>
								<FieldAction
									label={m.ext_detail_action_copy()}
									onClick={() => handleCopy(item.url, "URL")}
								>
									<IconCopy className="size-3.5" />
								</FieldAction>
								<FieldAction
									label={m.ext_detail_action_open()}
									onClick={() => handleOpenUrl(item.url)}
								>
									<IconOpenExternal className="size-3.5" />
								</FieldAction>
							</>
						}
					>
						<div className="truncate text-[13px] text-[color-mix(in_oklab,var(--color-primary)_55%,var(--color-foreground))]">
							{item.url}
						</div>
					</FieldRow>
				)}

				{item.username && (
					<FieldRow
						label={m.ext_detail_label_username()}
						actions={
							<FieldAction
								label={m.ext_detail_action_copy()}
								onClick={() => handleCopy(item.username, "Username")}
							>
								<IconCopy className="size-3.5" />
							</FieldAction>
						}
					>
						<div className="truncate text-[13px] text-foreground">
							{item.username}
						</div>
					</FieldRow>
				)}

				{item.password && (
					<FieldRow
						label={m.ext_detail_label_password()}
						actions={
							<>
								<FieldAction
									label={
										showPassword
											? m.ext_detail_action_hide()
											: m.ext_detail_action_reveal()
									}
									onClick={() => setShowPassword(!showPassword)}
								>
									{showPassword ? (
										<IconEyeOff className="size-3.5" />
									) : (
										<IconEye className="size-3.5" />
									)}
								</FieldAction>
								<FieldAction
									label={m.ext_detail_action_copy()}
									onClick={() => handleCopy(item.password, "Password")}
								>
									<IconCopy className="size-3.5" />
								</FieldAction>
							</>
						}
					>
						<div
							className={cn(
								"truncate font-mono text-[12.5px]",
								showPassword
									? "text-foreground tracking-[0.04em]"
									: "text-muted-foreground tracking-[0.22em]",
							)}
						>
							{showPassword ? item.password : "•".repeat(12)}
						</div>
					</FieldRow>
				)}

				{item.totpSecret && (
					<InlineTotpRow
						totpSecret={item.totpSecret}
						totpAlgorithm={item.totpAlgorithm}
						totpDigits={item.totpDigits}
						totpPeriod={item.totpPeriod}
						label={m.ext_detail_otp()}
					/>
				)}

				{passkeys.map((passkey, index) => (
					<FieldRow
						key={`${passkey.credentialId}-${index}`}
						label={m.ext_detail_label_passkeys()}
						actions={
							<FieldAction
								label={m.ext_detail_passkey_copy_id()}
								onClick={() => handleCopy(passkey.credentialId, "Passkey ID")}
							>
								<IconCopy className="size-3.5" />
							</FieldAction>
						}
					>
						<div className="truncate text-[13px] text-foreground">
							{passkey.userDisplayName ||
								passkey.userName ||
								m.ext_detail_passkey_fallback_name()}
						</div>
						<div className="truncate text-[11px] text-muted-foreground">
							{passkey.rpId}
							{" • "}
							{m.ext_detail_passkey_used()}{" "}
							{formatPasskeyLastUsed(passkey.lastUsedAt ?? passkey.createdAt)}
						</div>
					</FieldRow>
				))}
			</div>

			{/* Add-2FA affordance when the item has no TOTP configured. */}
			{!item.totpSecret &&
				(showQRScanner ? (
					isSaving ? (
						<Card className="flex items-center justify-center gap-2 p-4">
							<IconLoaderCircle className="size-5 animate-spin" />
							<span className="text-sm">{m.ext_detail_saving_totp()}</span>
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
						className="h-[34px] w-full gap-2"
						onClick={() => setShowQRScanner(true)}
					>
						<IconQrCode className="size-4" />
						{m.ext_detail_scan_qr()}
					</Button>
				))}

			{notes && (
				<div className="space-y-1.5">
					<Label className="font-semibold text-[10.5px] text-muted-foreground uppercase tracking-[0.05em]">
						{m.ext_detail_label_notes()}
					</Label>
					<div className="whitespace-pre-wrap rounded-lg border bg-card px-3 py-2.5 text-[13px]">
						{notes}
					</div>
				</div>
			)}
		</div>
	);
}

function SecureNoteDetail({ item }: { item: DecryptedItem }) {
	const { m } = useI18n();
	const notes = getItemNotes(item);

	return (
		<div className="space-y-1.5">
			<Label className="font-semibold text-[10.5px] text-muted-foreground uppercase tracking-[0.05em]">
				{m.ext_detail_label_note()}
			</Label>
			<div className="whitespace-pre-wrap rounded-lg border bg-card px-3 py-2.5 text-[13px]">
				{notes || m.ext_detail_no_notes()}
			</div>
		</div>
	);
}

function PlaceholderDetail({
	item,
	message,
}: {
	item: DecryptedItem;
	message: string;
}) {
	const { m } = useI18n();
	const notes = getItemNotes(item);

	return (
		<div className="space-y-3">
			<div className="rounded-lg border bg-card px-3 py-2.5 text-[13px] text-muted-foreground">
				{message}
			</div>
			{notes && (
				<div className="space-y-1.5">
					<Label className="font-semibold text-[10.5px] text-muted-foreground uppercase tracking-[0.05em]">
						{m.ext_detail_label_notes()}
					</Label>
					<div className="whitespace-pre-wrap rounded-lg border bg-card px-3 py-2.5 text-[13px]">
						{notes}
					</div>
				</div>
			)}
		</div>
	);
}

export function ItemDetailPanel({
	item,
	onItemUpdated,
	matchesActiveTab,
	onAutofill,
	onOpenInApp,
}: ItemDetailPanelProps) {
	const { m } = useI18n();
	const isSecureNote = item.category === "secure-note";
	const domain = item.url ?? null;

	return (
		<div className="relative p-[18px] pb-6">
			{/* Brand moment: radial primary-deep glow behind the header — dark mode only. */}
			<div
				aria-hidden
				className="pointer-events-none absolute -top-8 -left-5 hidden h-[170px] w-[300px] dark:block dark:bg-[radial-gradient(60%_60%_at_30%_40%,color-mix(in_oklab,var(--color-primary-deep)_9%,transparent),transparent_70%)]"
			/>

			<div className="relative mb-3.5 flex items-center gap-3">
				<Favicon
					item={isSecureNote ? { ...item, url: undefined } : item}
					size="md"
					className="size-10 rounded-[10px] shadow-[0_2px_8px_oklch(0_0_0/0.1),0_0_24px_color-mix(in_oklab,var(--color-primary-deep)_12%,transparent)] dark:shadow-[0_2px_8px_oklch(0_0_0/0.3),0_0_24px_color-mix(in_oklab,var(--color-primary-deep)_20%,transparent)]"
				/>
				<div className="min-w-0 flex-1">
					<h1 className="truncate font-semibold text-[16px] tracking-[-0.015em]">
						{item.title}
					</h1>
					{domain ? (
						<p className="truncate text-[11.5px] text-muted-foreground">
							{domain}
						</p>
					) : isSecureNote ? (
						<p className="text-[11.5px] text-muted-foreground">
							{m.ext_detail_secure_note()}
						</p>
					) : null}
				</div>
				{onOpenInApp && (
					<Button
						type="button"
						variant="ghost"
						size="icon"
						className="size-7 text-muted-foreground"
						title={m.ext_vault_open_in_app()}
						onClick={onOpenInApp}
					>
						<IconOpenExternal className="size-3.5" />
					</Button>
				)}
			</div>

			{item.category === "login" && matchesActiveTab && onAutofill && (
				<div className="relative mb-3.5">
					<Button className="h-[34px] w-full gap-2" onClick={onAutofill}>
						<IconWand className="size-3.5" />
						{m.ext_vault_autofill_page()}
					</Button>
				</div>
			)}

			<div className="relative">
				{item.category === "secure-note" && <SecureNoteDetail item={item} />}
				{item.category === "login" && (
					<LoginItemDetail item={item} onItemUpdated={onItemUpdated} />
				)}
				{item.category === "credit-card" && (
					<PlaceholderDetail
						item={item}
						message={m.ext_detail_credit_card_soon()}
					/>
				)}
				{item.category === "identity" && (
					<PlaceholderDetail
						item={item}
						message={m.ext_detail_identity_soon()}
					/>
				)}
			</div>
		</div>
	);
}
