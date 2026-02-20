import { useTRPCClient } from "@bittery/shared/trpc";
import { Button, Card, CardContent, Input, Label, toast } from "@bittery/ui";
import {
	IconCheckOutlineDuo18 as Check,
	IconCopyOutlineDuo18 as Copy,
	IconClipboardArrowInOutlineDuo18 as Download,
	IconEyeOutlineDuo18 as Eye,
	IconEyeSlashOutlineDuo18 as EyeOff,
	IconLoader2OutlineDuo18 as Loader2,
} from "@bittery/ui/icons";
import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { type FormEvent, useMemo, useState } from "react";
import { resolveActiveAuthServerUrl } from "@/lib/auth-server";
import { downloadRecoveryKit } from "@/lib/recovery-kit";
import { storage } from "@/lib/storage";
import { generateSecretKeyAsync } from "@/lib/wasm-crypto";
import { WorkerCrypto } from "@/lib/worker-crypto";

type RecoveryStep =
	| "email"
	| "code"
	| "recoveryKey"
	| "password"
	| "newSecretKey";

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
		throw new Error("Invalid encrypted data payload");
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
		meta: [{ title: "Recover Account - Bittery" }],
	}),
});

function RecoverRouteComponent() {
	const navigate = useNavigate();
	const trpcClient = useTRPCClient();

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

	const handleRequestCode = async (e: FormEvent) => {
		e.preventDefault();

		if (!email.trim()) {
			toast.error("Please enter your email");
			return;
		}

		await resolveActiveAuthServerUrl();

		setIsSubmitting(true);
		try {
			await trpcClient.auth.requestRecoveryVerification.mutate({
				email: email.trim(),
			});
			toast.success(
				"If recovery is configured for this account, a verification code has been sent.",
			);
			setStep("code");
		} catch (error: any) {
			toast.error(error?.message || "Failed to request recovery code");
		} finally {
			setIsSubmitting(false);
		}
	};

	const handleVerifyCode = async (e: FormEvent) => {
		e.preventDefault();

		if (code.trim().length !== 6) {
			toast.error("Enter the 6-digit verification code");
			return;
		}

		setIsSubmitting(true);
		try {
			const result = await trpcClient.auth.verifyRecoveryCode.mutate({
				email: email.trim(),
				code: code.trim(),
			});

			if (!result.success || !result.recoveryToken) {
				toast.error("Invalid or expired verification code");
				return;
			}

			setRecoveryToken(result.recoveryToken);
			setStep("recoveryKey");
		} catch (error: any) {
			toast.error(error?.message || "Failed to verify code");
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
				toast.error("Invalid Recovery Key format");
				return;
			}

			setRecoveryKey(recoveryKey.trim());
			setStep("password");
		} catch (error: any) {
			toast.error(error?.message || "Failed to validate key");
		} finally {
			workerCrypto.terminate();
		}
	};

	const handleResetPassword = async (e: FormEvent) => {
		e.preventDefault();

		if (!recoveryToken) {
			toast.error("Recovery session expired. Start again.");
			setStep("email");
			return;
		}

		if (newPassword.length < 8) {
			toast.error("Password must be at least 8 characters");
			return;
		}

		if (newPassword !== confirmPassword) {
			toast.error("Passwords do not match");
			return;
		}

		await resolveActiveAuthServerUrl();

		setIsSubmitting(true);
		const workerCrypto = new WorkerCrypto();

		try {
			const recoveryData = await trpcClient.auth.getRecoveryData.query({
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
			}> = [];

			for (const vaultKeyEntry of recoveryData.vaultKeys) {
				if (vaultKeyEntry.createdById !== recoveryData.userId) {
					continue;
				}

				const decryptedVaultKeyBase64 = await workerCrypto.decrypt(
					parseEncryptedData(vaultKeyEntry.encryptedVaultKey),
					oldMasterUnlockKey,
				);

				decryptedPersonalVaultKeys.push({
					vaultId: vaultKeyEntry.vaultId,
					vaultKeyBase64: decryptedVaultKeyBase64,
				});
			}

			const newSecretKey = await generateSecretKeyAsync();

			const newMasterKey = await workerCrypto.deriveMasterKey(
				newPassword,
				newSecretKey,
				email,
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

			const resetResult = await trpcClient.auth.resetPassword.mutate({
				recoveryToken,
				srpSalt,
				srpVerifier,
				encryptedPrivateKey: JSON.stringify(newEncryptedPrivateKey),
				encryptedMasterKey: JSON.stringify(newEncryptedMasterKey),
				recoveryKeyHint,
				secretKeyHint,
				encryptedVaultKeys,
			});

			await storage.storeAuthToken(resetResult.token);

			const vaultList = await trpcClient.vault.list.query();
			await storage.storeVaultKeys(
				vaultList.map((vaultRecord) => ({
					vaultId: vaultRecord.id,
					vaultName: vaultRecord.name,
					vaultType: vaultRecord.type,
					vaultIcon: vaultRecord.icon,
					vaultImageUrl: vaultRecord.imageUrl,
					encryptedVaultKey: vaultRecord.encryptedVaultKey,
					role: vaultRecord.role,
				})),
			);

			await storage.storeEncryptedPrivateKey(
				JSON.stringify(newEncryptedPrivateKey),
			);
			await storage.storeSecretKey(newSecretKey);
			await storage.storeSessionData(
				newMasterUnlockKey,
				email,
				resetResult.userId,
				undefined,
				resetResult.sessionId,
			);
			await storage.setMasterUnlockKey(newMasterUnlockKey);

			setGeneratedSecretKey(newSecretKey);
			setStep("newSecretKey");
			toast.success("Password reset successfully");
		} catch (error: any) {
			console.error("Recovery flow failed:", error);
			toast.error(error?.message || "Failed to reset password");
		} finally {
			workerCrypto.terminate();
			setIsSubmitting(false);
		}
	};

	const handleDownloadEmergencyKit = async () => {
		if (!generatedSecretKey || !recoveryKey) {
			toast.error("Missing keys. Please try again.");
			return;
		}

		const result = await downloadRecoveryKit({
			fileName: "bittery-emergency-kit",
			title: "Bittery Emergency Kit",
			subtitle:
				"Contains your new Secret Key and Recovery Key for offline storage.",
			entries: [
				{
					label: "Secret Key",
					value: generatedSecretKey,
					description:
						"Required with your master password to unlock your account.",
				},
				{
					label: "Recovery Key",
					value: recoveryKey,
					description: "Required to reset your password if forgotten.",
				},
			],
			cautions: [
				"Your Secret Key has changed. Previous Emergency Kits are now outdated.",
				"Store this kit offline in a secure location you trust.",
				"Do not save this file in shared folders or chats.",
			],
			footerNote:
				"Bittery is zero-knowledge: recovery material is generated and handled locally in your browser.",
			includeHandwrittenPasswordSection: true,
		});

		setHasDownloadedKit(true);
		if (result === "pdf-downloaded") {
			toast.success("Emergency Kit PDF downloaded.");
			return;
		}

		toast.success("PDF failed. Emergency Kit downloaded as text backup.");
	};

	const handleCopySecretKey = async () => {
		try {
			await navigator.clipboard.writeText(generatedSecretKey);
			setHasCopiedKey(true);
			toast.success("Secret Key copied to clipboard");
			setTimeout(() => setHasCopiedKey(false), 2000);
		} catch {
			toast.error("Failed to copy to clipboard");
		}
	};

	return (
		<div className="w-full">
			<h1 className="text-center font-semibold text-2xl tracking-tight">
				Recover your account
			</h1>
			<p className="mx-auto mt-2 max-w-80 text-center text-muted-foreground text-sm">
				Verify your identity, enter your Recovery Key, and set a new password.
			</p>
			<Card className="mt-6">
				<CardContent>
					{step !== "newSecretKey" && (
						<div className="mb-6 text-muted-foreground text-xs">
							Step {stepNumber} of 5
						</div>
					)}

					{step === "email" && (
						<form onSubmit={handleRequestCode} className="space-y-4">
							<div className="space-y-2">
								<Label htmlFor="email">Email</Label>
								<Input
									id="email"
									type="email"
									placeholder="name@example.com"
									value={email}
									onChange={(e) => setEmail(e.target.value)}
									required
									className="h-10"
								/>
							</div>

							<Button
								type="submit"
								className="h-10 w-full"
								disabled={isSubmitting}
							>
								{isSubmitting ? (
									<>
										<Loader2 size={16} className="mr-2 animate-spin" />
										Sending code...
									</>
								) : (
									"Send Verification Code"
								)}
							</Button>
						</form>
					)}

					{step === "code" && (
						<form onSubmit={handleVerifyCode} className="space-y-4">
							<div className="rounded-md bg-muted px-3 py-2 text-muted-foreground text-xs">
								Code sent to <span className="font-medium">{email}</span>
							</div>

							<div className="space-y-2">
								<Label htmlFor="code">Verification Code</Label>
								<Input
									id="code"
									type="text"
									inputMode="numeric"
									maxLength={6}
									placeholder="123456"
									value={code}
									onChange={(e) =>
										setCode(e.target.value.replace(/\D/g, "").slice(0, 6))
									}
									required
									className="h-10 text-center font-mono text-lg tracking-[0.3em]"
								/>
							</div>

							<div className="grid grid-cols-2 gap-2">
								<Button
									type="button"
									variant="outline"
									onClick={() => setStep("email")}
									disabled={isSubmitting}
								>
									Back
								</Button>
								<Button type="submit" disabled={isSubmitting}>
									{isSubmitting ? (
										<>
											<Loader2 size={16} className="mr-2 animate-spin" />
											Verifying...
										</>
									) : (
										"Verify Code"
									)}
								</Button>
							</div>
						</form>
					)}

					{step === "recoveryKey" && (
						<form onSubmit={handleValidateRecoveryKey} className="space-y-4">
							<div className="space-y-2">
								<Label htmlFor="recoveryKey">Recovery Key</Label>
								<div className="relative">
									<Input
										id="recoveryKey"
										type={showRecoveryKey ? "text" : "password"}
										placeholder="R1-XXXXXX-XXXXXX-XXXXX-XXXXX-XXXXX-XXXXX-XXXXX"
										value={recoveryKey}
										onChange={(e) =>
											setRecoveryKey(e.target.value.toUpperCase())
										}
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

							<p className="text-muted-foreground text-xs">
								A new Secret Key will be generated for you after resetting your
								password.
							</p>

							<div className="grid grid-cols-2 gap-2">
								<Button
									type="button"
									variant="outline"
									onClick={() => setStep("code")}
								>
									Back
								</Button>
								<Button type="submit">Continue</Button>
							</div>
						</form>
					)}

					{step === "password" && (
						<form onSubmit={handleResetPassword} className="space-y-4">
							<div className="space-y-2">
								<Label htmlFor="newPassword">New Password</Label>
								<div className="relative">
									<Input
										id="newPassword"
										type={showPassword ? "text" : "password"}
										value={newPassword}
										onChange={(e) => setNewPassword(e.target.value)}
										placeholder="Enter new password"
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

							<div className="space-y-2">
								<Label htmlFor="confirmPassword">Confirm Password</Label>
								<div className="relative">
									<Input
										id="confirmPassword"
										type={showConfirmPassword ? "text" : "password"}
										value={confirmPassword}
										onChange={(e) => setConfirmPassword(e.target.value)}
										placeholder="Confirm new password"
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

							<div className="grid grid-cols-2 gap-2">
								<Button
									type="button"
									variant="outline"
									onClick={() => setStep("recoveryKey")}
									disabled={isSubmitting}
								>
									Back
								</Button>
								<Button type="submit" disabled={isSubmitting}>
									{isSubmitting ? (
										<>
											<Loader2 size={16} className="mr-2 animate-spin" />
											Resetting...
										</>
									) : (
										"Reset Password"
									)}
								</Button>
							</div>
						</form>
					)}

					{step === "newSecretKey" && (
						<div className="space-y-4">
							<div className="rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-amber-800 text-xs dark:border-amber-800 dark:bg-amber-950 dark:text-amber-200">
								Your Secret Key has changed. Save it now — you won't see it
								again.
							</div>

							<div className="space-y-2">
								<Label>New Secret Key</Label>
								<div className="flex items-center gap-2 rounded-md bg-muted px-3 py-2.5 font-mono text-sm">
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
								Download Emergency Kit
							</Button>

							<Button
								type="button"
								className="h-10 w-full"
								disabled={!hasDownloadedKit}
								onClick={() => navigate({ to: "/home" })}
							>
								Continue to Vault
							</Button>

							{!hasDownloadedKit && (
								<p className="text-center text-muted-foreground text-xs">
									Download your Emergency Kit to continue.
								</p>
							)}
						</div>
					)}

					{step !== "newSecretKey" && (
						<div className="mt-4 text-center text-muted-foreground text-sm">
							Remembered your password?{" "}
							<button
								type="button"
								onClick={() => navigate({ to: "/login" })}
								className="font-medium text-primary underline-offset-4 hover:underline"
							>
								Back to sign in
							</button>
						</div>
					)}
				</CardContent>
			</Card>
		</div>
	);
}
