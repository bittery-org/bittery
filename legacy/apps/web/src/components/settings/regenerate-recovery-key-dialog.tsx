import { usePlatformCrypto } from "@bittery/core/hooks";
import {
	InvalidAccountPasswordError,
	type PreparedRecoveryKey,
	prepareRecoveryKey,
} from "@bittery/core/services/vault-crypto";
import { useApiClient } from "@bittery/shared/api";
import { apiQueries } from "@bittery/shared/api-query";
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
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { downloadRecoveryKit } from "@/lib/recovery-kit";
import { storage } from "@/lib/storage";
import { useI18n } from "@/providers/i18n-provider";

export function RegenerateRecoveryKeyDialog({
	userEmail,
}: {
	userEmail: string;
}) {
	const { m } = useI18n();
	const [open, setOpen] = useState(false);
	const [step, setStep] = useState<"verify" | "display">("verify");
	const [currentPassword, setCurrentPassword] = useState("");
	const [showPassword, setShowPassword] = useState(false);
	const [prepared, setPrepared] = useState<PreparedRecoveryKey | null>(null);
	const [hasAcknowledged, setHasAcknowledged] = useState(false);
	const [isProcessing, setIsProcessing] = useState(false);

	const api = useApiClient();
	const crypto = usePlatformCrypto();
	const queryClient = useQueryClient();
	const userQuery = useQuery(apiQueries.auth.me(api));

	// Shown in the emergency kit and in the dialog; nothing else reads it.
	const recoveryKey = prepared?.recoveryKey ?? "";

	const storeRecoveryKeyMutation = useMutation({
		mutationFn: (input: {
			encryptedMasterKey: string;
			recoveryKeyHint: string;
		}) => api.auth.storeRecoveryKey(input),
		onSuccess: async () => {
			await queryClient.invalidateQueries();
			toast.success(m.settings_recovery_key_regenerate_toast_regenerated());
			handleOpenChange(false);
		},
		onError: () => {
			toast.error(m.settings_recovery_key_regenerate_toast_regenerate_failed());
			setIsProcessing(false);
		},
	});

	const handleGenerateRecoveryKey = async (e: React.FormEvent) => {
		e.preventDefault();

		if (!currentPassword.trim()) {
			toast.error(
				m.settings_recovery_key_common_toast_current_password_required(),
			);
			return;
		}

		const secretKey = await storage.getStoredSecretKey();
		if (!secretKey) {
			toast.error(m.settings_common_toast_secret_key_not_found_sign_out());
			return;
		}

		if (!userQuery.data?.encryptedPrivateKey) {
			toast.error(
				m.settings_recovery_key_common_toast_account_metadata_failed(),
			);
			return;
		}

		setIsProcessing(true);
		try {
			const accountId = await storage.getActiveAccount();
			if (!accountId) {
				toast.error(
					m.settings_recovery_key_common_toast_account_metadata_failed(),
				);
				return;
			}

			setPrepared(
				await prepareRecoveryKey(
					{
						accountId,
						email: userEmail,
						password: currentPassword,
						secretKey,
						encryptedPrivateKey: userQuery.data.encryptedPrivateKey,
					},
					{ crypto, storage },
				),
			);
			setStep("display");
		} catch (error) {
			if (!(error instanceof InvalidAccountPasswordError)) {
				console.error("Recovery key preparation failed:", error);
			}
			toast.error(
				m.settings_recovery_key_common_toast_verify_password_failed(),
			);
		} finally {
			setIsProcessing(false);
		}
	};

	const handleConfirmRegeneration = async () => {
		if (!hasAcknowledged) {
			toast.error(
				m.settings_recovery_key_regenerate_toast_acknowledgement_required(),
			);
			return;
		}

		if (!prepared) {
			toast.error(m.settings_recovery_key_common_toast_data_missing());
			return;
		}

		setIsProcessing(true);
		storeRecoveryKeyMutation.mutate({
			encryptedMasterKey: prepared.encryptedMasterKey,
			recoveryKeyHint: prepared.recoveryKeyHint,
		});
	};

	const handleOpenChange = (nextOpen: boolean) => {
		setOpen(nextOpen);
		if (!nextOpen) {
			setStep("verify");
			setCurrentPassword("");
			setShowPassword(false);
			setPrepared(null);
			setHasAcknowledged(false);
			setIsProcessing(false);
		}
	};

	const copyRecoveryKey = () => {
		copyWithToast(recoveryKey, m.settings_recovery_key_common_copy_label(), {
			showAutoClearMessage: false,
		});
	};

	const downloadEmergencyKit = async () => {
		const result = await downloadRecoveryKit({
			fileName: "bittery-recovery-kit-regenerated",
			title: m.settings_recovery_key_regenerate_kit_title(),
			subtitle: m.settings_recovery_key_regenerate_kit_subtitle(),
			entries: [
				{
					label: m.settings_recovery_key_regenerate_kit_entry_label(),
					value: recoveryKey,
					description:
						m.settings_recovery_key_regenerate_kit_entry_description(),
				},
			],
			cautions: [
				m.settings_recovery_key_regenerate_kit_caution_destroy_old(),
				m.settings_recovery_key_regenerate_kit_caution_store_offline(),
				m.settings_recovery_key_regenerate_kit_caution_separate_backups(),
			],
			footerNote: m.settings_recovery_key_common_kit_footer_note(),
			labels: {
				documentTitle: m.settings_recovery_key_common_kit_document_title(),
				generatedLabel: m.settings_recovery_key_common_kit_generated_label(),
				storeOfflineHeading:
					m.settings_recovery_key_common_kit_store_offline_heading(),
				badgeText: m.settings_recovery_key_common_kit_badge_text(),
			},
		});

		if (result === "pdf-downloaded") {
			toast.success(m.settings_recovery_key_common_toast_kit_pdf_downloaded());
			return;
		}

		toast.success(m.settings_recovery_key_common_toast_kit_text_downloaded());
	};

	return (
		<Dialog open={open} onOpenChange={handleOpenChange}>
			<DialogTrigger asChild>
				<Button variant="outline">
					<RefreshCw className="mr-2 h-4 w-4" />
					{m.settings_recovery_key_regenerate_trigger()}
				</Button>
			</DialogTrigger>
			<DialogContent
				className="sm:max-w-md"
				data-testid="regenerate-recovery-key-dialog"
			>
				{step === "verify" ? (
					<form onSubmit={handleGenerateRecoveryKey}>
						<DialogHeader>
							<DialogTitle>
								{m.settings_recovery_key_regenerate_title()}
							</DialogTitle>
							<DialogDescription>
								{m.settings_recovery_key_regenerate_description()}
							</DialogDescription>
						</DialogHeader>
						<div className="grid gap-4 py-4">
							<div className="rounded-lg border border-destructive/50 bg-destructive/10 p-3">
								<p className="text-destructive text-xs">
									<strong>{m.settings_common_warning()}</strong>{" "}
									{m.settings_recovery_key_regenerate_warning()}
								</p>
							</div>

							<div className="grid gap-2">
								<Label htmlFor="regenRecoveryPassword">
									{m.settings_recovery_key_common_field_current_password()}
								</Label>
								<div className="relative">
									<Input
										id="regenRecoveryPassword"
										type={showPassword ? "text" : "password"}
										value={currentPassword}
										onChange={(e) => setCurrentPassword(e.target.value)}
										placeholder={m.settings_recovery_key_common_placeholder_password()}
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
							<Button type="submit" disabled={isProcessing}>
								{isProcessing
									? m.settings_recovery_key_common_action_verifying()
									: m.settings_recovery_key_regenerate_action_generate()}
							</Button>
						</DialogFooter>
					</form>
				) : (
					<>
						<DialogHeader>
							<DialogTitle>
								{m.settings_recovery_key_regenerate_display_title()}
							</DialogTitle>
							<DialogDescription>
								{m.settings_recovery_key_common_display_description()}
							</DialogDescription>
						</DialogHeader>
						<div className="grid gap-4 py-4">
							<div className="relative rounded-xl border bg-muted/30 p-4">
								<div className="mb-2 font-medium text-muted-foreground text-xs uppercase tracking-wider">
									{m.settings_recovery_key_regenerate_display_key_label()}
								</div>
								<div
									className="break-all font-mono text-sm tracking-wide"
									data-testid="recovery-key-value"
								>
									{recoveryKey}
								</div>
							</div>

							<div className="grid grid-cols-2 gap-3">
								<Button
									type="button"
									variant="outline"
									onClick={copyRecoveryKey}
								>
									<Copy size={16} className="mr-2" />
									{m.settings_common_action_copy()}
								</Button>
								<Button
									type="button"
									variant="outline"
									onClick={downloadEmergencyKit}
								>
									<Download size={16} className="mr-2" />
									{m.settings_common_action_download_kit()}
								</Button>
							</div>

							<label className="flex items-start gap-2">
								<input
									type="checkbox"
									checked={hasAcknowledged}
									onChange={(e) => setHasAcknowledged(e.target.checked)}
									className="mt-1"
								/>
								<span className="text-sm">
									{m.settings_recovery_key_regenerate_display_acknowledgement()}
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
								disabled={
									!hasAcknowledged ||
									isProcessing ||
									storeRecoveryKeyMutation.isPending
								}
							>
								{isProcessing || storeRecoveryKeyMutation.isPending
									? m.settings_common_action_saving()
									: m.settings_recovery_key_regenerate_action_confirm()}
							</Button>
						</DialogFooter>
					</>
				)}
			</DialogContent>
		</Dialog>
	);
}
