import { usePlatformCrypto } from "@bittery/core/hooks";
import {
	InvalidAccountPasswordError,
	LocalKeyAdoptionError,
	regenerateAccountSecretKey,
} from "@bittery/core/services/vault-crypto";
import { useRPC, useRPCClient } from "@bittery/shared/rpc";
import { toVaultKeyEntry } from "@bittery/shared/vault-mapping";
import {
	Button,
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
	toast,
} from "@bittery/ui";
import {
	IconCopy as Copy,
	IconClipboardPaste as Download,
	IconEye as Eye,
	IconEyeOff as EyeOff,
	IconArrowLeftRight as RefreshCw,
} from "@bittery/ui/icons";
import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { downloadRecoveryKit } from "@/lib/recovery-kit";
import { storage } from "@/lib/storage";
import { useI18n } from "@/providers/i18n-provider";

export function RegenerateSecretKeyDialog({
	userEmail,
}: {
	userEmail: string;
}) {
	const { m } = useI18n();
	const [open, setOpen] = useState(false);
	const [step, setStep] = useState<"confirm" | "display">("confirm");
	const [currentPassword, setCurrentPassword] = useState("");
	const [showPassword, setShowPassword] = useState(false);
	const [newSecretKey, setNewSecretKey] = useState("");
	const [hasAcknowledged, setHasAcknowledged] = useState(false);
	const [isProcessing, setIsProcessing] = useState(false);
	const rpcClient = useRPCClient();
	const rpc = useRPC();
	const crypto = usePlatformCrypto();

	const userQuery = useQuery(rpc.auth.me.queryOptions());
	const vaultListQuery = useQuery(rpc.vault.list.queryOptions());

	const handleGenerateNewKey = async (e: React.FormEvent) => {
		e.preventDefault();

		if (!currentPassword.trim()) {
			toast.error(
				m.settings_secret_key_regenerate_toast_current_password_required(),
			);
			return;
		}

		const oldSecretKey = await storage.getStoredSecretKey();
		if (!oldSecretKey) {
			toast.error(m.settings_common_toast_secret_key_not_found());
			return;
		}

		if (!userQuery.data?.encryptedPrivateKey) {
			toast.error(m.settings_common_toast_user_data_load_failed());
			return;
		}

		setIsProcessing(true);

		try {
			setNewSecretKey(await crypto.generateSecretKey());
			setStep("display");
			setIsProcessing(false);
		} catch (error) {
			console.error("Secret key regeneration error:", error);
			toast.error(m.settings_secret_key_regenerate_toast_regenerate_failed());
			setIsProcessing(false);
		}
	};

	const handleConfirmRegeneration = async () => {
		if (!hasAcknowledged) {
			toast.error(
				m.settings_secret_key_regenerate_toast_acknowledgement_required(),
			);
			return;
		}

		const oldSecretKey = await storage.getStoredSecretKey();
		if (!oldSecretKey) {
			toast.error(
				m.settings_secret_key_regenerate_toast_secret_key_not_found(),
			);
			return;
		}

		const accountId = await storage.getActiveAccount();
		if (!accountId || !userQuery.data?.encryptedPrivateKey) {
			toast.error(
				m.settings_secret_key_regenerate_toast_user_data_load_failed(),
			);
			return;
		}

		if (!vaultListQuery.data || vaultListQuery.data.length === 0) {
			toast.error(m.settings_common_toast_vault_keys_load_failed());
			return;
		}

		setIsProcessing(true);

		try {
			await regenerateAccountSecretKey(
				{
					accountId,
					email: userEmail,
					userId: userQuery.data.id,
					currentPassword,
					currentSecretKey: oldSecretKey,
					newSecretKey,
					encryptedPrivateKey: userQuery.data.encryptedPrivateKey,
					vaultKeys: vaultListQuery.data.map(toVaultKeyEntry),
				},
				{
					crypto,
					storage,
					commit: (payload) =>
						rpcClient.auth.regenerateSecretKey.mutate(payload),
				},
			);

			toast.success(m.settings_secret_key_regenerate_toast_regenerated());
			setOpen(false);
		} catch (error) {
			// The account is already keyed to the new Secret Key on the server; this device
			// is the stale copy, so the fix is a fresh sign-in and not another attempt.
			if (error instanceof LocalKeyAdoptionError) {
				toast.warning(m.settings_common_toast_keys_changed_sign_in_again());
				setOpen(false);
				return;
			}
			if (error instanceof InvalidAccountPasswordError) {
				toast.error(
					m.settings_secret_key_regenerate_toast_verify_password_failed(),
				);
				setIsProcessing(false);
				return;
			}
			console.error("Secret key regeneration error:", error);
			toast.error(m.settings_secret_key_regenerate_toast_regenerate_failed());
			setIsProcessing(false);
		}
	};

	const copySecretKey = () => {
		copyWithToast(newSecretKey, m.settings_secret_key_regenerate_copy_label(), {
			showAutoClearMessage: false,
		});
	};

	const downloadKit = async () => {
		const result = await downloadRecoveryKit({
			fileName: "bittery-new-secret-key",
			title: m.settings_secret_key_regenerate_kit_title(),
			subtitle: m.settings_secret_key_regenerate_kit_subtitle(),
			entries: [
				{
					label: m.settings_secret_key_regenerate_kit_entry_label(),
					value: newSecretKey,
					description: m.settings_secret_key_regenerate_kit_entry_description(),
				},
			],
			cautions: [
				m.settings_secret_key_regenerate_kit_caution_destroy_old(),
				m.settings_secret_key_regenerate_kit_caution_store_offline(),
				m.settings_secret_key_regenerate_kit_caution_setup_recovery_key(),
			],
			footerNote: m.settings_recovery_key_common_kit_footer_note(),
			includeHandwrittenPasswordSection: true,
			labels: {
				documentTitle: m.settings_recovery_key_common_kit_document_title(),
				generatedLabel: m.settings_recovery_key_common_kit_generated_label(),
				storeOfflineHeading:
					m.settings_recovery_key_common_kit_store_offline_heading(),
				badgeText: m.settings_recovery_key_common_kit_badge_text(),
				handwrittenTitle:
					m.settings_secret_key_regenerate_kit_handwritten_title(),
				handwrittenDescription:
					m.settings_secret_key_regenerate_kit_handwritten_description(),
				handwrittenPasswordLabel:
					m.settings_secret_key_regenerate_kit_handwritten_password_label(),
			},
		});

		if (result === "pdf-downloaded") {
			toast.success(
				m.settings_secret_key_regenerate_toast_kit_pdf_downloaded(),
			);
			return;
		}
		toast.success(m.settings_secret_key_regenerate_toast_kit_text_downloaded());
	};

	const handleOpenChange = (newOpen: boolean) => {
		setOpen(newOpen);
		if (!newOpen) {
			// Reset state when closing
			setStep("confirm");
			setCurrentPassword("");
			setNewSecretKey("");
			setHasAcknowledged(false);
			setIsProcessing(false);
		}
	};

	return (
		<Dialog open={open} onOpenChange={handleOpenChange}>
			<DialogTrigger asChild>
				<Button variant="outline">
					<RefreshCw className="mr-2 h-4 w-4" />
					{m.settings_secret_key_regenerate_trigger()}
				</Button>
			</DialogTrigger>
			<DialogContent
				className="sm:max-w-md"
				data-testid="regenerate-secret-key-dialog"
			>
				{step === "confirm" ? (
					<form onSubmit={handleGenerateNewKey}>
						<DialogHeader>
							<DialogTitle>
								{m.settings_secret_key_regenerate_title()}
							</DialogTitle>
							<DialogDescription>
								{m.settings_secret_key_regenerate_description()}
							</DialogDescription>
						</DialogHeader>
						<div className="grid gap-4 py-4">
							<div className="rounded-lg border border-destructive/50 bg-destructive/10 p-3">
								<p className="text-destructive text-xs">
									<strong>{m.settings_common_warning()}</strong>{" "}
									{m.settings_secret_key_regenerate_warning()}
								</p>
							</div>
							<div className="grid gap-2">
								<Label htmlFor="currentPassword">
									{m.settings_secret_key_regenerate_field_password()}
								</Label>
								<div className="relative">
									<Input
										id="currentPassword"
										type={showPassword ? "text" : "password"}
										value={currentPassword}
										onChange={(e) => setCurrentPassword(e.target.value)}
										placeholder={m.settings_secret_key_regenerate_placeholder_password()}
										autoFocus
										className="pr-10"
									/>
									<Button
										type="button"
										variant="ghost"
										size="icon"
										className="absolute top-0 right-0 h-full w-10 text-muted-foreground hover:text-foreground"
										onClick={() => setShowPassword(!showPassword)}
									>
										{showPassword ? <EyeOff size={16} /> : <Eye size={16} />}
									</Button>
								</div>
							</div>
						</div>
						<DialogFooter>
							<Button
								type="button"
								variant="outline"
								onClick={() => setOpen(false)}
							>
								{m.settings_common_action_cancel()}
							</Button>
							<Button
								type="submit"
								variant="destructive"
								disabled={isProcessing}
							>
								{isProcessing
									? m.settings_recovery_key_common_action_verifying()
									: m.settings_secret_key_regenerate_action_generate()}
							</Button>
						</DialogFooter>
					</form>
				) : (
					<>
						<DialogHeader>
							<DialogTitle>
								{m.settings_secret_key_regenerate_display_title()}
							</DialogTitle>
							<DialogDescription>
								{m.settings_secret_key_regenerate_display_description()}
							</DialogDescription>
						</DialogHeader>
						<div className="grid gap-4 py-4">
							<div className="relative rounded-xl border bg-muted/30 p-4">
								<div className="mb-2 font-medium text-muted-foreground text-xs uppercase tracking-wider">
									{m.settings_secret_key_regenerate_display_key_label()}
								</div>
								<div className="break-all font-mono text-sm tracking-wide">
									{newSecretKey}
								</div>
							</div>

							<div className="grid grid-cols-2 gap-3">
								<Button
									type="button"
									variant="outline"
									className="w-full"
									onClick={copySecretKey}
								>
									<Copy size={16} className="mr-2" />
									{m.settings_common_action_copy()}
								</Button>
								<Button
									type="button"
									variant="outline"
									className="w-full"
									onClick={downloadKit}
								>
									<Download size={16} className="mr-2" />
									{m.settings_common_action_download_kit()}
								</Button>
							</div>

							<div className="rounded-lg border border-amber-200 bg-amber-50 p-3 dark:border-amber-900 dark:bg-amber-950/30">
								<p className="text-amber-700 text-xs dark:text-amber-300">
									<strong>
										{m.settings_secret_key_regenerate_important()}
									</strong>{" "}
									{m.settings_secret_key_regenerate_display_recovery_key_notice()}
								</p>
							</div>

							<label className="flex items-start gap-2">
								<input
									type="checkbox"
									checked={hasAcknowledged}
									onChange={(e) => setHasAcknowledged(e.target.checked)}
									className="mt-1"
								/>
								<span className="text-sm">
									{m.settings_secret_key_regenerate_display_acknowledgement()}
								</span>
							</label>
						</div>
						<DialogFooter>
							<Button
								type="button"
								variant="outline"
								onClick={() => setOpen(false)}
							>
								{m.settings_common_action_cancel()}
							</Button>
							<Button
								type="button"
								onClick={handleConfirmRegeneration}
								disabled={!hasAcknowledged || isProcessing}
							>
								{isProcessing
									? m.settings_common_action_saving()
									: m.settings_secret_key_regenerate_action_confirm()}
							</Button>
						</DialogFooter>
					</>
				)}
			</DialogContent>
		</Dialog>
	);
}
