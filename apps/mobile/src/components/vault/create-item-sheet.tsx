/**
 * The "+" flow's sheet, in the mobile kit's shape.
 *
 * `@bittery/ui`'s `CreateItemSheet` is the same two steps, but its first step is a desktop
 * picker: hover-revealed chevrons, 13px type, a bordered `bg-card` list inside a bordered
 * sheet, and a corner ✕ instead of a grabber. Step 1 is therefore rebuilt here on `MobileSheet`
 * + `ListCard`; step 2 keeps rendering `@bittery/ui`'s `ItemForm`, which is the actual form
 * logic (validation, generators, TOTP clipboard auto-paste) and not something to fork.
 *
 * Prop-compatible with `@bittery/ui`'s `CreateItemSheet` apart from `side`, which a bottom
 * sheet does not need. Authenticator opens a "Scan QR" step first — jumping straight
 * to the camera hid the fact that this category is a QR import. Paste / type is still
 * one tap away. Device-setup QR stays on sign-in.
 */

import type { DecryptedItemData, ItemCategory } from "@bittery/shared/types";
import { ItemForm, toast, type VaultOption } from "@bittery/ui";
import {
	IconContact,
	IconCreditCard,
	IconFileLock,
	IconKey,
	IconQrCode,
	IconSmartphone,
} from "@bittery/ui/icons";
import { type ComponentType, useRef, useState } from "react";
import {
	BrandButton,
	IconTile,
	iconClass,
	ListCard,
	ListRow,
	MobileSheet,
	Pressable,
	QrScannerOverlay,
	SHEET_EXIT_MS,
	waitForScannerOverlayPaint,
} from "@/components/ui";
import {
	CameraPermissionDeniedError,
	cancelActiveScan,
	formatScanError,
	InvalidTotpSecretError,
	isScanCancelled,
	NotAnOtpAuthUriError,
	scanTotpSetupToClipboard,
	type TotpFormPrefill,
	totpFormPrefillFromScan,
} from "@/lib/barcode-scanner";
import { useI18n } from "@/providers/i18n-provider";

type Messages = ReturnType<typeof useI18n>["m"];

const CATEGORIES: ReadonlyArray<{
	type: ItemCategory;
	icon: ComponentType<{ className?: string }>;
}> = [
	{ type: "login", icon: IconKey },
	{ type: "totp", icon: IconSmartphone },
	{ type: "secure-note", icon: IconFileLock },
	{ type: "credit-card", icon: IconCreditCard },
	{ type: "identity", icon: IconContact },
];

function getCategoryTitle(category: ItemCategory, m: Messages) {
	switch (category) {
		case "totp":
			return m.vaults_detail_items_category_totp_title();
		case "secure-note":
			return m.vaults_detail_items_category_secure_note_title();
		case "credit-card":
			return m.vaults_detail_items_category_credit_card_title();
		case "identity":
			return m.vaults_detail_items_category_identity_title();
		default:
			return m.vaults_detail_items_category_login_title();
	}
}

function getCategoryDescription(category: ItemCategory, m: Messages) {
	switch (category) {
		case "totp":
			return m.mob_create_item_category_totp_description();
		case "secure-note":
			return m.vaults_detail_items_create_sheet_category_secure_note_description();
		case "credit-card":
			return m.vaults_detail_items_create_sheet_category_credit_card_description();
		case "identity":
			return m.vaults_detail_items_create_sheet_category_identity_description();
		default:
			return m.vaults_detail_items_create_sheet_category_login_description();
	}
}

interface CreateItemSheetProps {
	open: boolean;
	onOpenChange: (open: boolean) => void;
	vaults: VaultOption[];
	selectedVaultId?: string;
	/** Pre-fills the website field of the login form. */
	initialUrl?: string;
	onCreateItem: (
		data: DecryptedItemData,
		vaultId: string,
		category: ItemCategory,
	) => Promise<void>;
}

export function CreateItemSheet({
	open,
	onOpenChange,
	vaults,
	selectedVaultId,
	initialUrl,
	onCreateItem,
}: CreateItemSheetProps) {
	const { m } = useI18n();
	const [category, setCategory] = useState<ItemCategory | null>(null);
	const [totpPrefill, setTotpPrefill] = useState<TotpFormPrefill | undefined>();
	const [showTotpForm, setShowTotpForm] = useState(false);
	const [isSubmitting, setIsSubmitting] = useState(false);
	const [isScanning, setIsScanning] = useState(false);
	const scanningRef = useRef(false);

	const reset = () => {
		scanningRef.current = false;
		setCategory(null);
		setTotpPrefill(undefined);
		setShowTotpForm(false);
		setIsSubmitting(false);
		setIsScanning(false);
	};

	const closeScanner = () => {
		scanningRef.current = false;
		setIsScanning(false);
		void cancelActiveScan();
	};

	const scanTotpQr = async () => {
		scanningRef.current = true;
		setIsScanning(true);
		await waitForScannerOverlayPaint();
		if (!scanningRef.current) return;
		try {
			const scanned = await scanTotpSetupToClipboard();
			if (!scanningRef.current) return;
			setTotpPrefill(totpFormPrefillFromScan(scanned));
			setShowTotpForm(true);
			toast.success(m.mob_form_totp_toast_imported());
		} catch (error) {
			if (isScanCancelled(error)) {
				return;
			}
			if (error instanceof NotAnOtpAuthUriError) {
				toast.error(m.mob_qr_scanner_invalid_qr_message());
			} else if (error instanceof InvalidTotpSecretError) {
				toast.error(m.mob_qr_scanner_invalid_secret_message());
			} else if (error instanceof CameraPermissionDeniedError) {
				toast.error(m.mob_qr_scanner_permission_description());
			} else {
				console.warn(
					"[create-item] totp scan did not complete",
					formatScanError(error),
				);
			}
		} finally {
			scanningRef.current = false;
			setIsScanning(false);
		}
	};

	const handleSubmit = async (data: DecryptedItemData, vaultId: string) => {
		if (!category) return;
		if (!vaultId) {
			toast.error(m.vaults_detail_items_create_sheet_toast_no_vault_selected());
			return;
		}

		setIsSubmitting(true);
		try {
			await onCreateItem(data, vaultId, category);
			reset();
		} finally {
			setIsSubmitting(false);
		}
	};

	return (
		<>
			<MobileSheet
				open={open}
				onOpenChange={(nextOpen) => {
					onOpenChange(nextOpen);
					// Reset after the close animation, so the sheet does not visibly snap back to
					// step 1 on its way out.
					if (!nextOpen) setTimeout(reset, SHEET_EXIT_MS);
				}}
				title={
					category === "totp" && !showTotpForm
						? m.mob_totp_scan_intro_title()
						: category
							? m.vaults_detail_items_create_sheet_title_selected({
									category: getCategoryTitle(category, m),
								})
							: m.vaults_detail_items_create_sheet_title_default()
				}
				description={
					category === "totp" && !showTotpForm
						? m.mob_totp_scan_intro_description()
						: category
							? m.vaults_detail_items_create_sheet_description_selected()
							: m.vaults_detail_items_create_sheet_description_default()
				}
			>
				{category === "totp" && !showTotpForm ? (
					<div className="flex flex-col gap-5 px-4 pt-2 pb-6">
						<div className="flex justify-center">
							<IconTile tone="brand">
								<IconQrCode className={iconClass.bar} />
							</IconTile>
						</div>
						<BrandButton
							size="lg"
							label={m.mob_form_totp_scan_qr()}
							leading={<IconQrCode className={iconClass.bar} />}
							isLoading={isScanning}
							onClick={() => void scanTotpQr()}
						/>
						<Pressable
							surface="sheet"
							onClick={() => setShowTotpForm(true)}
							className="h-11 w-full rounded-xl border border-border font-medium text-sm"
						>
							{m.mob_totp_scan_enter_manually()}
						</Pressable>
						<Pressable
							surface="sheet"
							onClick={() => {
								setTotpPrefill(undefined);
								setShowTotpForm(false);
								setCategory(null);
							}}
							className="h-11 w-full rounded-xl font-medium text-muted-foreground text-sm"
						>
							{m.vaults_detail_items_create_sheet_action_back()}
						</Pressable>
					</div>
				) : category ? (
					<div className="flex min-h-0 flex-col pb-2">
						<ItemForm
							key={
								category === "totp"
									? (totpPrefill?.totpSecret ?? "totp-empty")
									: category
							}
							category={category}
							initialData={
								category === "totp"
									? totpPrefill
									: category === "login" && initialUrl
										? { url: initialUrl }
										: undefined
							}
							onSubmit={handleSubmit}
							onCancel={() => {
								if (category === "totp") {
									setTotpPrefill(undefined);
									setShowTotpForm(false);
									return;
								}
								setCategory(null);
							}}
							submitLabel={m.vaults_detail_items_form_action_create()}
							cancelLabel={m.vaults_detail_items_create_sheet_action_back()}
							isSubmitting={isSubmitting}
							vaults={vaults}
							selectedVaultId={selectedVaultId}
						/>
					</div>
				) : (
					<div className="px-4 pt-1 pb-6">
						<ListCard>
							{CATEGORIES.map(({ type, icon: Icon }) => (
								<ListRow
									key={type}
									title={getCategoryTitle(type, m)}
									subtitle={getCategoryDescription(type, m)}
									leading={
										<IconTile>
											<Icon className={iconClass.bar} />
										</IconTile>
									}
									showChevron
									onPress={() => setCategory(type)}
								/>
							))}
						</ListCard>
					</div>
				)}
			</MobileSheet>
			<QrScannerOverlay
				open={isScanning}
				title={m.mob_qr_scanner_title()}
				instruction={m.mob_qr_scanner_instruction()}
				backLabel={m.mob_common_go_back()}
				onCancel={closeScanner}
			/>
		</>
	);
}
