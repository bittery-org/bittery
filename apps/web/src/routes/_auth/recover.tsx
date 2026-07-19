import { m as messages } from "@bittery/i18n/paraglide/messages";
import { buildVaultKeyEncryptionContext } from "@bittery/shared";
import { currentKdfProfile } from "@bittery/shared/kdf-policy";
import { getDefaultServerUrl } from "@bittery/shared/rpc-client-factory";
import { useRPCClient } from "@bittery/shared/rpc";
import { resolveOrCreateAccountId } from "@bittery/storage/account-id";
import { Button, cn, Input, Label, toast } from "@bittery/ui";
import {
	IconCheck as Check,
	IconCopy as Copy,
	IconClipboardPaste as Download,
	IconEye as Eye,
	IconEyeOff as EyeOff,
	IconLoaderCircle as Loader2,
} from "@bittery/ui/icons";
import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { type FormEvent, Fragment, useMemo, useState } from "react";
import { downloadRecoveryKit } from "@/lib/recovery-kit";
import { normalizeVaultListEntry } from "@/lib/rpc-normalizers";
import { storage } from "@/lib/storage";
import { generateSecretKeyAsync } from "@/lib/wasm-crypto";
import { WorkerCrypto } from "@/lib/worker-crypto";
import { useI18n } from "@/providers/i18n-provider";

type RecoveryStep =
	| "email"
	| "code"
	| "recoveryKey"
	| "password"
	| "newSecretKey";

type RecoveryMessageCatalog = ReturnType<typeof useI18n>["m"];
type RecoveryFlowErrorCode = "invalid_encrypted_data_payload";

class RecoveryFlowError extends Error {
	code: RecoveryFlowErrorCode;

	constructor(code: RecoveryFlowErrorCode) {
		super(code);
		this.code = code;
		this.name = "RecoveryFlowError";
	}
}

function getRecoveryFlowErrorMessage(
	error: unknown,
	m: RecoveryMessageCatalog,
): string | null {
	if (!(error instanceof RecoveryFlowError)) {
		return null;
	}

	switch (error.code) {
		case "invalid_encrypted_data_payload":
			return m.auth_recover_error_invalid_encrypted_data_payload();
		default:
			return null;
	}
}

function getRecoveryStepNumber(step: RecoveryStep): number {
	if (step === "email") return 1;
	if (step === "code") return 2;
	if (step === "recoveryKey") return 3;
	if (step === "password") return 4;
	return 5;
}

function parseEncryptedData(value: string): {
	ciphertext: string;
	iv: string;
	algorithm: string;
} {
	const parsed = JSON.parse(value);
	if (
		!parsed ||
		typeof parsed !== "object" ||
		typeof parsed.ciphertext !== "string" ||
		typeof parsed.iv !== "string" ||
		typeof parsed.algorithm !== "string"
	) {
		throw new RecoveryFlowError("invalid_encrypted_data_payload");
	}

	return {
		ciphertext: parsed.ciphertext,
		iv: parsed.iv,
		algorithm: parsed.algorithm,
	};
}

export const Route = createFileRoute("/_auth/recover")({
	component: RecoverRouteComponent,
	head: () => ({
		meta: [{ title: messages.auth_recover_meta_title() }],
	}),
});

function RecoverRouteComponent() {
	const navigate = useNavigate();
	const rpcClient = useRPCClient();
	const { m } = useI18n();

	const [step, setStep] = useState<RecoveryStep>("email");
	const [email, setEmail] = useState("");
	const [code, setCode] = useState("");
	const [recoveryToken, setRecoveryToken] = useState("");
	const [recoveryKey, setRecoveryKey] = useState("");
	const [newPassword, setNewPassword] = useState("");
	const [confirmPassword, setConfirmPassword] = useState("");
	const [showRecoveryKey, setShowRecoveryKey] = useState(false);
	const [showPassword, setShowPassword] = useState(false);
	const [showConfirmPassword, setShowConfirmPassword] = useState(false);
	const [isSubmitting, setIsSubmitting] = useState(false);

	const [generatedSecretKey, setGeneratedSecretKey] = useState("");
	const [hasDownloadedKit, setHasDownloadedKit] = useState(false);
	const [hasCopiedKey, setHasCopiedKey] = useState(false);

	const stepNumber = useMemo(() => getRecoveryStepNumber(step), [step]);
	const getLocalizedErrorMessage = (
		error: unknown,
		fallback: string,
	): string => {
		const recoveryFlowErrorMessage = getRecoveryFlowErrorMessage(error, m);
		if (recoveryFlowErrorMessage) {
			return recoveryFlowErrorMessage;
		}

		return fallback;
	};

	const handleRequestCode = async (e: FormEvent) => {
		e.preventDefault();

		if (!email.trim()) {
			toast.error(m.auth_recover_toast_email_required());
			return;
		}

		setIsSubmitting(true);
		try {
			await rpcClient.auth.requestRecoveryVerification.mutate({
				email: email.trim(),
			});
			toast.success(m.auth_recover_toast_code_requested());
			setStep("code");
		} catch (error: unknown) {
			toast.error(
				getLocalizedErrorMessage(
					error,
					m.auth_recover_toast_request_code_failed(),
				),
			);
		} finally {
			setIsSubmitting(false);
		}
	};

	const handleVerifyCode = async (e: FormEvent) => {
		e.preventDefault();

		if (code.trim().length !== 6) {
			toast.error(m.auth_recover_toast_code_length_invalid());
			return;
		}

		setIsSubmitting(true);
		try {
			const result = await rpcClient.auth.verifyRecoveryCode.mutate({
				email: email.trim(),
				code: code.trim(),
			});

			if (!result.success || !result.recoveryToken) {
				toast.error(m.auth_recover_toast_code_invalid_or_expired());
				return;
			}

			setRecoveryToken(result.recoveryToken);
			setStep("recoveryKey");
		} catch (error: unknown) {
			toast.error(
				getLocalizedErrorMessage(
					error,
					m.auth_recover_toast_verify_code_failed(),
				),
			);
		} finally {
			setIsSubmitting(false);
		}
	};

	const handleValidateRecoveryKey = async (e: FormEvent) => {
		e.preventDefault();

		const workerCrypto = new WorkerCrypto();
		try {
			const isRecoveryKeyValid = await workerCrypto.validateRecoveryKey(
				recoveryKey.trim(),
			);

			if (!isRecoveryKeyValid) {
				toast.error(m.auth_recover_toast_recovery_key_invalid());
				return;
			}

			setRecoveryKey(recoveryKey.trim());
			setStep("password");
		} catch (error: unknown) {
			toast.error(
				getLocalizedErrorMessage(
					error,
					m.auth_recover_toast_validate_key_failed(),
				),
			);
		} finally {
			workerCrypto.terminate();
		}
	};

	const handleResetPassword = async (e: FormEvent) => {
		e.preventDefault();

		if (!recoveryToken) {
			toast.error(m.auth_recover_toast_session_expired());
			setStep("email");
			return;
		}

		if (newPassword.length < 8) {
			toast.error(m.auth_recover_toast_password_too_short());
			return;
		}

		if (newPassword !== confirmPassword) {
			toast.error(m.auth_recover_toast_password_mismatch());
			return;
		}

		setIsSubmitting(true);
		const workerCrypto = new WorkerCrypto();

		try {
			const recoveryData = await rpcClient.auth.getRecoveryData.query({
				recoveryToken,
			});

			const encryptedMasterKeyData = parseEncryptedData(
				recoveryData.encryptedMasterKey,
			);
			const oldMasterKey = await workerCrypto.decryptMasterKey(
				encryptedMasterKeyData,
				recoveryKey,
				email,
			);

			const { masterUnlockKey: oldMasterUnlockKey } =
				await workerCrypto.deriveKeysFromMasterKey(oldMasterKey, email);

			const encryptedPrivateKeyData = parseEncryptedData(
				recoveryData.encryptedPrivateKey,
			);
			const privateKey = await workerCrypto.decrypt(
				encryptedPrivateKeyData,
				oldMasterUnlockKey,
			);

			const decryptedPersonalVaultKeys: Array<{
				vaultId: string;
				vaultKeyBase64: string;
				keyVersion: number;
			}> = [];

			for (const vaultKeyEntry of recoveryData.vaultKeys) {
				if (vaultKeyEntry.createdById !== recoveryData.userId) {
					continue;
				}

				const parsedVaultKey = parseEncryptedData(
					vaultKeyEntry.encryptedVaultKey,
				) as {
					ciphertext: string;
					iv: string;
					algorithm: string;
					context?: { keyVersion?: number };
				};
				const keyVersion = Number.isInteger(parsedVaultKey.context?.keyVersion)
					? (parsedVaultKey.context?.keyVersion as number)
					: 1;
				const decryptedVaultKeyBase64 = await workerCrypto.decrypt(
					parsedVaultKey,
					oldMasterUnlockKey,
					buildVaultKeyEncryptionContext({
						vaultId: vaultKeyEntry.vaultId,
						userId: recoveryData.userId,
						keyVersion,
					}),
				);

				decryptedPersonalVaultKeys.push({
					vaultId: vaultKeyEntry.vaultId,
					vaultKeyBase64: decryptedVaultKeyBase64,
					keyVersion,
				});
			}

			const newSecretKey = await generateSecretKeyAsync();

			const newProfile = currentKdfProfile();
			const newMasterKey = await workerCrypto.deriveMasterKey(
				newPassword,
				newSecretKey,
				email,
				newProfile,
			);
			const { authKey: newAuthKey, masterUnlockKey: newMasterUnlockKey } =
				await workerCrypto.deriveKeysFromMasterKey(newMasterKey, email);

			const authKeyString = new TextDecoder().decode(newAuthKey);
			const { salt: srpSalt, verifier: srpVerifier } =
				await workerCrypto.generateSRPRegistration(authKeyString);

			const newEncryptedPrivateKey = await workerCrypto.encrypt(
				privateKey,
				newMasterUnlockKey,
			);

			const encryptedVaultKeys: Array<{
				vaultId: string;
				encryptedVaultKey: string;
			}> = [];

			for (const vaultKeyEntry of decryptedPersonalVaultKeys) {
				const reEncryptedVaultKey = await workerCrypto.encrypt(
					vaultKeyEntry.vaultKeyBase64,
					newMasterUnlockKey,
					buildVaultKeyEncryptionContext({
						vaultId: vaultKeyEntry.vaultId,
						userId: recoveryData.userId,
						keyVersion: vaultKeyEntry.keyVersion,
					}),
				);

				encryptedVaultKeys.push({
					vaultId: vaultKeyEntry.vaultId,
					encryptedVaultKey: JSON.stringify(reEncryptedVaultKey),
				});
			}

			const newEncryptedMasterKey = await workerCrypto.encryptMasterKey(
				newMasterKey,
				recoveryKey,
				email,
			);
			const recoveryKeyHint =
				recoveryKey.split("-").slice(0, 2).join("-") || "R1";
			const secretKeyHint = await workerCrypto.getSecretKeyHint(newSecretKey);

			const resetResult = await rpcClient.auth.resetPassword.mutate({
				recoveryToken,
				srpSalt,
				srpVerifier,
				encryptedPrivateKey: JSON.stringify(newEncryptedPrivateKey),
				encryptedMasterKey: JSON.stringify(newEncryptedMasterKey),
				recoveryKeyHint,
				secretKeyHint,
				encryptedVaultKeys,
				kdfParams: newProfile,
			});

			const serverUrl = getDefaultServerUrl();
			const accountId = resolveOrCreateAccountId(
				await storage.getAccountsList(),
				serverUrl,
				resetResult.userId,
			);
			await storage.storeAuthToken(resetResult.token, accountId);
			await storage.storeServerUrl(serverUrl, accountId);

			const vaultList = await rpcClient.vault.list.query();
			await storage.storeVaultKeys(
				vaultList.map(normalizeVaultListEntry),
				accountId,
			);

			await storage.storeEncryptedPrivateKey(
				JSON.stringify(newEncryptedPrivateKey),
				accountId,
			);
			await storage.storeSecretKey(newSecretKey, accountId);
			await storage.storeSessionData(
				newMasterUnlockKey,
				accountId,
				email,
				resetResult.userId,
				resetResult.expiresAt,
				resetResult.sessionId,
			);
			await storage.setMasterUnlockKey(newMasterUnlockKey, accountId);
			await storage.storePinnedKdfProfile(newProfile, accountId);

			setGeneratedSecretKey(newSecretKey);
			setStep("newSecretKey");
			toast.success(m.auth_recover_toast_reset_success());
		} catch (error: unknown) {
			console.error("Recovery flow failed:", error);
			toast.error(
				getLocalizedErrorMessage(error, m.auth_recover_toast_reset_failed()),
			);
		} finally {
			workerCrypto.terminate();
			setIsSubmitting(false);
		}
	};

	const handleDownloadEmergencyKit = async () => {
		if (!generatedSecretKey || !recoveryKey) {
			toast.error(m.auth_recover_toast_missing_keys());
			return;
		}

		const result = await downloadRecoveryKit({
			fileName: m.auth_recover_kit_file_name(),
			title: m.auth_recover_kit_title(),
			subtitle: m.auth_recover_kit_subtitle(),
			entries: [
				{
					label: m.auth_recover_kit_entry_secret_key_label(),
					value: generatedSecretKey,
					description: m.auth_recover_kit_entry_secret_key_description(),
				},
				{
					label: m.auth_recover_kit_entry_recovery_key_label(),
					value: recoveryKey,
					description: m.auth_recover_kit_entry_recovery_key_description(),
				},
			],
			cautions: [
				m.auth_recover_kit_caution_secret_key_changed(),
				m.auth_recover_kit_caution_store_offline(),
				m.auth_recover_kit_caution_avoid_shared(),
			],
			footerNote: m.auth_recover_kit_footer_note(),
			includeHandwrittenPasswordSection: true,
		});

		setHasDownloadedKit(true);
		if (result === "pdf-downloaded") {
			toast.success(m.auth_recover_toast_kit_pdf_downloaded());
			return;
		}

		toast.success(m.auth_recover_toast_kit_text_downloaded());
	};

	const handleCopySecretKey = async () => {
		try {
			await navigator.clipboard.writeText(generatedSecretKey);
			setHasCopiedKey(true);
			toast.success(m.auth_recover_toast_secret_key_copied());
			setTimeout(() => setHasCopiedKey(false), 2000);
		} catch {
			toast.error(m.auth_recover_toast_copy_failed());
		}
	};

	return (
		<div className="w-full">
			<div className="text-center">
				<h1 className="font-semibold text-2xl tracking-tight">
					{m.auth_recover_header_title()}
				</h1>
				<p className="mx-auto mt-2 max-w-80 text-muted-foreground text-sm">
					{m.auth_recover_header_description()}
				</p>
			</div>

			<div className="mt-6">
				{step !== "newSecretKey" && (
					<div className="mb-6 flex items-center">
						{[1, 2, 3, 4, 5].map((num) => (
							<Fragment key={num}>
								{num > 1 && (
									<div
										className={cn(
											"h-px flex-1 transition-colors",
											stepNumber >= num ? "bg-primary" : "bg-border",
										)}
									/>
								)}
								<div
									className={cn(
										"flex items-center justify-center rounded-full font-medium text-[10px] transition-all",
										stepNumber === num
											? "h-7 w-7 border-2 border-primary/50 bg-primary/10 text-primary"
											: stepNumber > num
												? "h-5 w-5 bg-primary text-primary-foreground"
												: "h-5 w-5 border border-border text-muted-foreground",
									)}
								>
									{stepNumber > num ? <Check size={10} /> : num}
								</div>
							</Fragment>
						))}
					</div>
				)}

				{step === "email" && (
					<form onSubmit={handleRequestCode} className="space-y-3.5">
						<div className="space-y-1.5">
							<Label htmlFor="email" className="font-medium text-xs">
								{m.auth_recover_form_email_label()}
							</Label>
							<Input
								id="email"
								type="email"
								placeholder={m.auth_recover_form_email_placeholder()}
								value={email}
								onChange={(e) => setEmail(e.target.value)}
								required
								className="h-10"
							/>
						</div>

						<div className="pt-1">
							<Button
								type="submit"
								className="h-10 w-full font-medium shadow-sm"
								disabled={isSubmitting}
							>
								{isSubmitting ? (
									<>
										<Loader2 size={16} className="mr-2 animate-spin" />
										{m.auth_recover_button_sending_code()}
									</>
								) : (
									m.auth_recover_button_send_code()
								)}
							</Button>
						</div>
					</form>
				)}

				{step === "code" && (
					<form onSubmit={handleVerifyCode} className="space-y-3.5">
						<div className="flex items-center gap-2 rounded-lg bg-muted/50 px-3 py-2">
							<span className="text-muted-foreground text-xs">
								{m.auth_recover_info_code_sent_to({ email })}
							</span>
						</div>

						<div className="space-y-1.5">
							<Label htmlFor="code" className="font-medium text-xs">
								{m.auth_recover_form_code_label()}
							</Label>
							<Input
								id="code"
								type="text"
								inputMode="numeric"
								maxLength={6}
								placeholder={m.auth_recover_form_code_placeholder()}
								value={code}
								onChange={(e) =>
									setCode(e.target.value.replace(/\D/g, "").slice(0, 6))
								}
								required
								className="h-10 text-center font-mono text-lg tracking-[0.3em]"
							/>
						</div>

						<div className="grid grid-cols-2 gap-2 pt-1">
							<Button
								type="button"
								variant="outline"
								onClick={() => setStep("email")}
								disabled={isSubmitting}
							>
								{m.auth_recover_button_back()}
							</Button>
							<Button
								type="submit"
								className="shadow-sm"
								disabled={isSubmitting}
							>
								{isSubmitting ? (
									<>
										<Loader2 size={16} className="mr-2 animate-spin" />
										{m.auth_recover_button_verifying_code()}
									</>
								) : (
									m.auth_recover_button_verify_code()
								)}
							</Button>
						</div>
					</form>
				)}

				{step === "recoveryKey" && (
					<form onSubmit={handleValidateRecoveryKey} className="space-y-3.5">
						<div className="space-y-1.5">
							<Label htmlFor="recoveryKey" className="font-medium text-xs">
								{m.auth_recover_form_recovery_key_label()}
							</Label>
							<div className="relative">
								<Input
									id="recoveryKey"
									type={showRecoveryKey ? "text" : "password"}
									placeholder={m.auth_recover_form_recovery_key_placeholder()}
									value={recoveryKey}
									onChange={(e) => setRecoveryKey(e.target.value.toUpperCase())}
									required
									className="h-10 pr-10 font-mono"
								/>
								<Button
									type="button"
									variant="ghost"
									size="icon"
									className="absolute top-0 right-0 h-10 w-10 text-muted-foreground hover:text-foreground"
									onClick={() => setShowRecoveryKey(!showRecoveryKey)}
								>
									{showRecoveryKey ? <EyeOff size={16} /> : <Eye size={16} />}
								</Button>
							</div>
						</div>

						<p className="text-[11px] text-muted-foreground/70">
							{m.auth_recover_form_recovery_key_help()}
						</p>

						<div className="grid grid-cols-2 gap-2 pt-1">
							<Button
								type="button"
								variant="outline"
								onClick={() => setStep("code")}
							>
								{m.auth_recover_button_back()}
							</Button>
							<Button type="submit" className="shadow-sm">
								{m.auth_recover_button_continue()}
							</Button>
						</div>
					</form>
				)}

				{step === "password" && (
					<form onSubmit={handleResetPassword} className="space-y-3.5">
						<div className="space-y-1.5">
							<Label htmlFor="newPassword" className="font-medium text-xs">
								{m.auth_recover_form_password_new_label()}
							</Label>
							<div className="relative">
								<Input
									id="newPassword"
									type={showPassword ? "text" : "password"}
									value={newPassword}
									onChange={(e) => setNewPassword(e.target.value)}
									placeholder={m.auth_recover_form_password_new_placeholder()}
									required
									className="h-10 pr-10"
								/>
								<Button
									type="button"
									variant="ghost"
									size="icon"
									className="absolute top-0 right-0 h-10 w-10 text-muted-foreground hover:text-foreground"
									onClick={() => setShowPassword(!showPassword)}
								>
									{showPassword ? <EyeOff size={16} /> : <Eye size={16} />}
								</Button>
							</div>
						</div>

						<div className="space-y-1.5">
							<Label htmlFor="confirmPassword" className="font-medium text-xs">
								{m.auth_recover_form_password_confirm_label()}
							</Label>
							<div className="relative">
								<Input
									id="confirmPassword"
									type={showConfirmPassword ? "text" : "password"}
									value={confirmPassword}
									onChange={(e) => setConfirmPassword(e.target.value)}
									placeholder={m.auth_recover_form_password_confirm_placeholder()}
									required
									className="h-10 pr-10"
								/>
								<Button
									type="button"
									variant="ghost"
									size="icon"
									className="absolute top-0 right-0 h-10 w-10 text-muted-foreground hover:text-foreground"
									onClick={() => setShowConfirmPassword(!showConfirmPassword)}
								>
									{showConfirmPassword ? (
										<EyeOff size={16} />
									) : (
										<Eye size={16} />
									)}
								</Button>
							</div>
						</div>

						<div className="grid grid-cols-2 gap-2 pt-1">
							<Button
								type="button"
								variant="outline"
								onClick={() => setStep("recoveryKey")}
								disabled={isSubmitting}
							>
								{m.auth_recover_button_back()}
							</Button>
							<Button
								type="submit"
								className="shadow-sm"
								disabled={isSubmitting}
							>
								{isSubmitting ? (
									<>
										<Loader2 size={16} className="mr-2 animate-spin" />
										{m.auth_recover_button_resetting_password()}
									</>
								) : (
									m.auth_recover_button_reset_password()
								)}
							</Button>
						</div>
					</form>
				)}

				{step === "newSecretKey" && (
					<div className="space-y-3.5">
						<div className="flex items-start gap-3 rounded-xl border border-amber-200/60 bg-amber-50/40 px-4 py-3.5 dark:border-amber-800/40 dark:bg-amber-950/20">
							<span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-amber-100 text-base dark:bg-amber-900/30">
								⚠️
							</span>
							<div>
								<p className="font-medium text-amber-900 text-sm leading-none dark:text-amber-100">
									{m.auth_recover_secret_key_banner_title()}
								</p>
								<p className="mt-1.5 text-[11px] text-amber-700/70 leading-snug dark:text-amber-300/60">
									{m.auth_recover_secret_key_banner_description()}
								</p>
							</div>
						</div>

						<div className="space-y-1.5">
							<Label className="font-medium text-xs">
								{m.auth_recover_secret_key_label()}
							</Label>
							<div className="flex items-center gap-2 rounded-lg bg-muted/50 px-3 py-2.5 font-mono text-sm">
								<span className="flex-1 select-all break-all">
									{generatedSecretKey}
								</span>
								<Button
									type="button"
									variant="ghost"
									size="icon"
									className="h-8 w-8 shrink-0"
									onClick={handleCopySecretKey}
								>
									{hasCopiedKey ? <Check size={14} /> : <Copy size={14} />}
								</Button>
							</div>
						</div>

						<Button
							type="button"
							variant="outline"
							className="h-10 w-full"
							onClick={handleDownloadEmergencyKit}
						>
							<Download size={16} className="mr-2" />
							{m.auth_recover_button_download_kit()}
						</Button>

						<Button
							type="button"
							className="h-10 w-full font-medium shadow-sm"
							disabled={!hasDownloadedKit}
							onClick={() => navigate({ to: "/home" })}
						>
							{m.auth_recover_button_continue_to_vault()}
						</Button>

						{!hasDownloadedKit && (
							<p className="text-center text-[11px] text-muted-foreground/70">
								{m.auth_recover_secret_key_download_required()}
							</p>
						)}
					</div>
				)}

				{step !== "newSecretKey" && (
					<div className="pt-6 text-center text-muted-foreground text-sm">
						{m.auth_recover_footer_remembered_password()}{" "}
						<button
							type="button"
							onClick={() => navigate({ to: "/login" })}
							className="font-medium text-primary underline-offset-4 hover:underline"
						>
							{m.auth_recover_footer_back_to_sign_in()}
						</button>
					</div>
				)}
			</div>
		</div>
	);
}
