import { useTRPCClient } from "@bittery/shared/trpc";
import { Button, Input, Label, toast } from "@bittery/ui";
import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { Eye, EyeOff, Loader2 } from "lucide-react";
import { type FormEvent, useMemo, useState } from "react";
import { resolveActiveAuthServerUrl } from "@/lib/auth-server";
import { storage } from "@/lib/storage";
import { WorkerCrypto } from "@/lib/worker-crypto";

type RecoveryStep = "email" | "code" | "keys" | "password";

function getRecoveryStepNumber(step: RecoveryStep): number {
	if (step === "email") return 1;
	if (step === "code") return 2;
	if (step === "keys") return 3;
	return 4;
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
	const [secretKey, setSecretKey] = useState("");
	const [recoveryKey, setRecoveryKey] = useState("");
	const [newPassword, setNewPassword] = useState("");
	const [confirmPassword, setConfirmPassword] = useState("");
	const [showSecretKey, setShowSecretKey] = useState(false);
	const [showRecoveryKey, setShowRecoveryKey] = useState(false);
	const [showPassword, setShowPassword] = useState(false);
	const [showConfirmPassword, setShowConfirmPassword] = useState(false);
	const [isSubmitting, setIsSubmitting] = useState(false);

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
			setStep("keys");
		} catch (error: any) {
			toast.error(error?.message || "Failed to verify code");
		} finally {
			setIsSubmitting(false);
		}
	};

	const handleValidateKeys = async (e: FormEvent) => {
		e.preventDefault();

		const workerCrypto = new WorkerCrypto();
		try {
			const [isSecretKeyValid, isRecoveryKeyValid] = await Promise.all([
				workerCrypto.validateSecretKey(secretKey.trim()),
				workerCrypto.validateRecoveryKey(recoveryKey.trim()),
			]);

			if (!isSecretKeyValid) {
				toast.error("Invalid Secret Key format");
				return;
			}

			if (!isRecoveryKeyValid) {
				toast.error("Invalid Recovery Key format");
				return;
			}

			setSecretKey(secretKey.trim());
			setRecoveryKey(recoveryKey.trim());
			setStep("password");
		} catch (error: any) {
			toast.error(error?.message || "Failed to validate keys");
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

			const newMasterKey = await workerCrypto.deriveMasterKey(
				newPassword,
				secretKey,
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

			const resetResult = await trpcClient.auth.resetPassword.mutate({
				recoveryToken,
				srpSalt,
				srpVerifier,
				encryptedPrivateKey: JSON.stringify(newEncryptedPrivateKey),
				encryptedMasterKey: JSON.stringify(newEncryptedMasterKey),
				recoveryKeyHint,
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
			await storage.storeSecretKey(secretKey);
			await storage.storeSessionData(
				newMasterUnlockKey,
				email,
				resetResult.userId,
				undefined,
				resetResult.sessionId,
			);
			await storage.setMasterUnlockKey(newMasterUnlockKey);

			toast.success("Password reset successfully");
			navigate({ to: "/home" });
		} catch (error: any) {
			console.error("Recovery flow failed:", error);
			toast.error(error?.message || "Failed to reset password");
		} finally {
			workerCrypto.terminate();
			setIsSubmitting(false);
		}
	};

	return (
		<div className="w-full">
			<h1 className="mb-6 text-center font-semibold text-2xl tracking-tight">
				Recover your account
			</h1>
			<div>
				<div className="mb-6 text-center text-muted-foreground text-xs">
					Step {stepNumber} of 4
				</div>

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

				{step === "keys" && (
					<form onSubmit={handleValidateKeys} className="space-y-4">
						<div className="space-y-2">
							<Label htmlFor="secretKey">Secret Key</Label>
							<div className="relative">
								<Input
									id="secretKey"
									type={showSecretKey ? "text" : "password"}
									placeholder="A3-XXXXXX-XXXXXX-XXXXX-XXXXX-XXXXX"
									value={secretKey}
									onChange={(e) => setSecretKey(e.target.value.toUpperCase())}
									required
									className="h-10 pr-10 font-mono"
								/>
								<Button
									type="button"
									variant="ghost"
									size="icon"
									className="absolute top-0 right-0 h-10 w-10 text-muted-foreground hover:text-foreground"
									onClick={() => setShowSecretKey(!showSecretKey)}
								>
									{showSecretKey ? <EyeOff size={16} /> : <Eye size={16} />}
								</Button>
							</div>
						</div>

						<div className="space-y-2">
							<Label htmlFor="recoveryKey">Recovery Key</Label>
							<div className="relative">
								<Input
									id="recoveryKey"
									type={showRecoveryKey ? "text" : "password"}
									placeholder="R1-XXXXXX-XXXXXX-XXXXX-XXXXX-XXXXX-XXXXX-XXXXX"
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
								onClick={() => setStep("keys")}
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
			</div>
		</div>
	);
}
