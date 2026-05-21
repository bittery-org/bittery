import { useRPC, useRPCClient } from "@bittery/shared/rpc";
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
	IconCopyOutlineDuo18 as Copy,
	IconClipboardArrowInOutlineDuo18 as Download,
	IconEyeOutlineDuo18 as Eye,
	IconEyeSlashOutlineDuo18 as EyeOff,
	IconMagicShieldOutlineDuo18 as Shield,
} from "@bittery/ui/icons";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { downloadRecoveryKit } from "@/lib/recovery-kit";
import { storage } from "@/lib/storage";
import {
	decrypt,
	deriveKeysFromMasterKey,
	deriveMasterKey,
	encryptMasterKey,
	generateRecoveryKey,
} from "@/lib/wasm-crypto";
import { useI18n } from "@/providers/i18n-provider";

export function SetupRecoveryKeyDialog({ userEmail }: { userEmail: string }) {
	const { m } = useI18n();
	const [open, setOpen] = useState(false);
	const [step, setStep] = useState<"verify" | "display">("verify");
	const [currentPassword, setCurrentPassword] = useState("");
	const [showPassword, setShowPassword] = useState(false);
	const [recoveryKey, setRecoveryKey] = useState("");
	const [encryptedMasterKey, setEncryptedMasterKey] = useState("");
	const [hasAcknowledged, setHasAcknowledged] = useState(false);
	const [isProcessing, setIsProcessing] = useState(false);

	const rpc = useRPC();
	const rpcClient = useRPCClient();
	const queryClient = useQueryClient();
	const userQuery = useQuery(rpc.auth.me.queryOptions());

	const storeRecoveryKeyMutation = useMutation({
		mutationFn: (input: {
			encryptedMasterKey: string;
			recoveryKeyHint: string;
		}) => rpcClient.auth.storeRecoveryKey.mutate(input),
		onSuccess: async () => {
			await queryClient.invalidateQueries();
			toast.success(m.settings_recovery_key_setup_toast_configured());
			handleOpenChange(false);
		},
		onError: () => {
			toast.error(m.settings_recovery_key_setup_toast_configure_failed());
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
			const masterKey = await deriveMasterKey(
				currentPassword,
				secretKey,
				userEmail,
			);
			const { masterUnlockKey } = await deriveKeysFromMasterKey(
				masterKey,
				userEmail,
			);

			// Validate password by attempting to decrypt the stored private key.
			await decrypt(
				JSON.parse(userQuery.data.encryptedPrivateKey),
				masterUnlockKey,
			);

			const generatedRecoveryKey = generateRecoveryKey();
			const encryptedMasterKeyData = await encryptMasterKey(
				masterKey,
				generatedRecoveryKey,
				userEmail,
			);

			setRecoveryKey(generatedRecoveryKey);
			setEncryptedMasterKey(JSON.stringify(encryptedMasterKeyData));
			setStep("display");
		} catch (error) {
			console.error("Recovery setup failed:", error);
			toast.error(
				m.settings_recovery_key_common_toast_verify_password_failed(),
			);
		} finally {
			setIsProcessing(false);
		}
	};

	const handleConfirmSetup = async () => {
		if (!hasAcknowledged) {
			toast.error(
				m.settings_recovery_key_setup_toast_acknowledgement_required(),
			);
			return;
		}

		if (!recoveryKey || !encryptedMasterKey) {
			toast.error(m.settings_recovery_key_common_toast_data_missing());
			return;
		}

		setIsProcessing(true);
		const recoveryKeyHint =
			recoveryKey.split("-").slice(0, 2).join("-") || "R1";

		storeRecoveryKeyMutation.mutate({
			encryptedMasterKey,
			recoveryKeyHint,
		});
	};

	const handleOpenChange = (nextOpen: boolean) => {
		setOpen(nextOpen);
		if (!nextOpen) {
			setStep("verify");
			setCurrentPassword("");
			setShowPassword(false);
			setRecoveryKey("");
			setEncryptedMasterKey("");
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
			fileName: "bittery-recovery-kit",
			title: m.settings_recovery_key_setup_kit_title(),
			subtitle: m.settings_recovery_key_setup_kit_subtitle(),
			entries: [
				{
					label: m.settings_recovery_key_setup_kit_entry_label(),
					value: recoveryKey,
					description: m.settings_recovery_key_setup_kit_entry_description(),
				},
			],
			cautions: [
				m.settings_recovery_key_setup_kit_caution_separate_manager(),
				m.settings_recovery_key_setup_kit_caution_keep_offline_backup(),
				m.settings_recovery_key_setup_kit_caution_anyone_can_reset(),
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
					<Shield className="mr-2 h-4 w-4" />
					{m.settings_recovery_key_setup_trigger()}
				</Button>
			</DialogTrigger>
			<DialogContent className="sm:max-w-md">
				{step === "verify" ? (
					<form onSubmit={handleGenerateRecoveryKey}>
						<DialogHeader>
							<DialogTitle>{m.settings_recovery_key_setup_title()}</DialogTitle>
							<DialogDescription>
								{m.settings_recovery_key_setup_description()}
							</DialogDescription>
						</DialogHeader>
						<div className="grid gap-4 py-4">
							<div className="grid gap-2">
								<Label htmlFor="setupRecoveryPassword">
									{m.settings_recovery_key_common_field_current_password()}
								</Label>
								<div className="relative">
									<Input
										id="setupRecoveryPassword"
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
									: m.settings_recovery_key_setup_action_generate()}
							</Button>
						</DialogFooter>
					</form>
				) : (
					<>
						<DialogHeader>
							<DialogTitle>
								{m.settings_recovery_key_setup_display_title()}
							</DialogTitle>
							<DialogDescription>
								{m.settings_recovery_key_common_display_description()}
							</DialogDescription>
						</DialogHeader>
						<div className="grid gap-4 py-4">
							<div className="relative rounded-xl border bg-muted/30 p-4">
								<div className="mb-2 font-medium text-muted-foreground text-xs uppercase tracking-wider">
									{m.settings_recovery_key_setup_display_key_label()}
								</div>
								<div className="break-all font-mono text-sm tracking-wide">
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
									{m.settings_recovery_key_setup_display_acknowledgement()}
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
								onClick={handleConfirmSetup}
								disabled={
									!hasAcknowledged ||
									isProcessing ||
									storeRecoveryKeyMutation.isPending
								}
							>
								{isProcessing || storeRecoveryKeyMutation.isPending
									? m.settings_common_action_saving()
									: m.settings_recovery_key_setup_action_confirm()}
							</Button>
						</DialogFooter>
					</>
				)}
			</DialogContent>
		</Dialog>
	);
}
