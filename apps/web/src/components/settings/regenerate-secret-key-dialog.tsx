import { decrypt, encrypt } from "@bittery/crypto/encryption";
import { deriveKeys } from "@bittery/crypto/key-derivation";
import { generateSecretKey, getSecretKeyHint } from "@bittery/crypto/secret-key";
import { getStoredSecretKey } from "@bittery/crypto/session-storage";
import { generateSRPRegistration } from "@bittery/crypto/srp-client";
import { useTRPC, useTRPCClient } from "@bittery/shared/trpc";
import {
	Button,
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
import { useMutation, useQuery } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { Copy, Download, Eye, EyeOff, RefreshCw } from "lucide-react";
import { useState } from "react";

export function RegenerateSecretKeyDialog({
	userEmail,
}: {
	userEmail: string;
}) {
	const [open, setOpen] = useState(false);
	const [step, setStep] = useState<"confirm" | "display">("confirm");
	const [currentPassword, setCurrentPassword] = useState("");
	const [showPassword, setShowPassword] = useState(false);
	const [newSecretKey, setNewSecretKey] = useState("");
	const [hasAcknowledged, setHasAcknowledged] = useState(false);
	const [isProcessing, setIsProcessing] = useState(false);
	const trpcClient = useTRPCClient();
	const trpc = useTRPC();
	const navigate = useNavigate();

	const userQuery = useQuery(trpc.auth.me.queryOptions());
	const vaultListQuery = useQuery(trpc.vault.list.queryOptions());

	const regenerateSecretKeyMutation = useMutation({
		mutationFn: (input: {
			secretKeyHint: string;
			srpSalt: string;
			srpVerifier: string;
			encryptedPrivateKey: string;
			encryptedVaultKeys: Array<{
				vaultId: string;
				encryptedVaultKey: string;
			}>;
		}) => trpcClient.auth.regenerateSecretKey.mutate(input),
		onSuccess: () => {
			toast.success(
				"Secret key regenerated successfully. Please sign in with your new secret key.",
			);
			setOpen(false);
			navigate({ to: "/login" });
		},
		onError: (error: Error) => {
			toast.error(error.message);
			setIsProcessing(false);
		},
	});

	const handleGenerateNewKey = async (e: React.FormEvent) => {
		e.preventDefault();

		if (!currentPassword.trim()) {
			toast.error("Please enter your current password");
			return;
		}

		const oldSecretKey = getStoredSecretKey();
		if (!oldSecretKey) {
			toast.error(
				"Secret key not found. Please log out and log in again with your full credentials.",
			);
			return;
		}

		if (!userQuery.data?.encryptedPrivateKey) {
			toast.error("Could not load user data. Please try again.");
			return;
		}

		setIsProcessing(true);

		try {
			// 1. Derive old keys to decrypt private key
			const { masterUnlockKey: oldMasterUnlockKey } = await deriveKeys(
				currentPassword,
				oldSecretKey,
				userEmail,
			);

			// 2. Decrypt private key with old master unlock key to verify password is correct
			const encryptedPrivateKeyData = JSON.parse(
				userQuery.data.encryptedPrivateKey,
			);
			await decrypt(encryptedPrivateKeyData, oldMasterUnlockKey);

			// 3. Generate new secret key
			const generatedSecretKey = generateSecretKey();
			setNewSecretKey(generatedSecretKey);
			setStep("display");
			setIsProcessing(false);
		} catch (error) {
			console.error("Secret key regeneration error:", error);
			toast.error(
				"Failed to verify password. Please check your current password.",
			);
			setIsProcessing(false);
		}
	};

	const handleConfirmRegeneration = async () => {
		if (!hasAcknowledged) {
			toast.error("Please confirm that you have saved your new Secret Key");
			return;
		}

		const oldSecretKey = getStoredSecretKey();
		if (!oldSecretKey) {
			toast.error("Secret key not found");
			return;
		}

		if (!userQuery.data?.encryptedPrivateKey) {
			toast.error("Could not load user data");
			return;
		}

		if (!vaultListQuery.data || vaultListQuery.data.length === 0) {
			toast.error("Could not load vault keys. Please try again.");
			return;
		}

		setIsProcessing(true);

		try {
			// 1. Derive old keys to decrypt private key
			const { masterUnlockKey: oldMasterUnlockKey } = await deriveKeys(
				currentPassword,
				oldSecretKey,
				userEmail,
			);

			// 2. Decrypt private key with old master unlock key
			const encryptedPrivateKeyData = JSON.parse(
				userQuery.data.encryptedPrivateKey,
			);
			const privateKey = await decrypt(
				encryptedPrivateKeyData,
				oldMasterUnlockKey,
			);

			// 3. Derive new keys with new secret key
			const { authKey: newAuthKey, masterUnlockKey: newMasterUnlockKey } =
				await deriveKeys(currentPassword, newSecretKey, userEmail);

			// 4. Generate new SRP credentials
			const authKeyString = new TextDecoder().decode(newAuthKey);
			const { salt: srpSalt, verifier: srpVerifier } =
				await generateSRPRegistration(authKeyString);

			// 5. Re-encrypt private key with new master unlock key
			const newEncryptedPrivateKey = await encrypt(
				privateKey,
				newMasterUnlockKey,
			);

			// 6. Re-encrypt vault keys with new master unlock key
			// Only re-encrypt vault keys for vaults the user created (MUK-encrypted)
			// Shared vault keys are RSA-encrypted and don't need re-encryption
			const serverVaultKeys = vaultListQuery.data;
			const currentUserId = userQuery.data.id;
			const encryptedVaultKeys: Array<{
				vaultId: string;
				encryptedVaultKey: string;
			}> = [];

			for (const vk of serverVaultKeys) {
				// Skip vaults where user was added (RSA-encrypted vault keys)
				// Only re-encrypt vaults the user created (MUK-encrypted vault keys)
				if (vk.createdById !== currentUserId) {
					continue;
				}

				// Decrypt vault key with old MUK
				const encryptedVaultKeyData = JSON.parse(vk.encryptedVaultKey);
				const decryptedVaultKeyBase64 = await decrypt(
					encryptedVaultKeyData,
					oldMasterUnlockKey,
				);

				// Re-encrypt vault key with new MUK
				const newEncryptedVaultKey = await encrypt(
					decryptedVaultKeyBase64,
					newMasterUnlockKey,
				);

				encryptedVaultKeys.push({
					vaultId: vk.id,
					encryptedVaultKey: JSON.stringify(newEncryptedVaultKey),
				});
			}

			// 7. Send to server
			regenerateSecretKeyMutation.mutate({
				secretKeyHint: getSecretKeyHint(newSecretKey),
				srpSalt,
				srpVerifier,
				encryptedPrivateKey: JSON.stringify(newEncryptedPrivateKey),
				encryptedVaultKeys,
			});
		} catch (error) {
			console.error("Secret key regeneration error:", error);
			toast.error("Failed to regenerate secret key");
			setIsProcessing(false);
		}
	};

	const copySecretKey = async () => {
		await navigator.clipboard.writeText(newSecretKey);
		toast.success("Secret Key copied to clipboard");
	};

	const downloadEmergencyKit = () => {
		const content = `
BITTERY EMERGENCY KIT - NEW SECRET KEY
======================================

IMPORTANT: Keep this information safe and private!

Your NEW Secret Key: ${newSecretKey}

This Secret Key replaces your previous one.
This key is required to access your account along with your Account Password.
Store it in a safe place - you cannot recover your account without it.

Generated: ${new Date().toLocaleString()}
		`;

		const blob = new Blob([content], { type: "text/plain" });
		const url = URL.createObjectURL(blob);
		const a = document.createElement("a");
		a.href = url;
		a.download = "bittery-new-secret-key.txt";
		document.body.appendChild(a);
		a.click();
		document.body.removeChild(a);
		URL.revokeObjectURL(url);
		toast.success("Emergency Kit downloaded");
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
					Regenerate Secret Key
				</Button>
			</DialogTrigger>
			<DialogContent className="sm:max-w-md">
				{step === "confirm" ? (
					<form onSubmit={handleGenerateNewKey}>
						<DialogHeader>
							<DialogTitle>Regenerate Secret Key</DialogTitle>
							<DialogDescription>
								Generate a new secret key for your account. Your current secret
								key will be invalidated and you'll need to use the new one to
								sign in.
							</DialogDescription>
						</DialogHeader>
						<div className="grid gap-4 py-4">
							<div className="rounded-lg border border-destructive/50 bg-destructive/10 p-3">
								<p className="text-destructive text-xs">
									<strong>Warning:</strong> This action cannot be undone. Make
									sure you save your new secret key before proceeding.
								</p>
							</div>
							<div className="grid gap-2">
								<Label htmlFor="currentPassword">
									Enter your password to continue
								</Label>
								<div className="relative">
									<Input
										id="currentPassword"
										type={showPassword ? "text" : "password"}
										value={currentPassword}
										onChange={(e) => setCurrentPassword(e.target.value)}
										placeholder="Enter your password"
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
								Cancel
							</Button>
							<Button
								type="submit"
								variant="destructive"
								disabled={isProcessing}
							>
								{isProcessing ? "Verifying..." : "Generate New Key"}
							</Button>
						</DialogFooter>
					</form>
				) : (
					<>
						<DialogHeader>
							<DialogTitle>Save Your New Secret Key</DialogTitle>
							<DialogDescription>
								This is your new secret key. Save it before continuing - you
								cannot access it again!
							</DialogDescription>
						</DialogHeader>
						<div className="grid gap-4 py-4">
							<div className="relative rounded-xl border bg-muted/30 p-4">
								<div className="mb-2 font-medium text-muted-foreground text-xs uppercase tracking-wider">
									Your New Secret Key
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
									Copy
								</Button>
								<Button
									type="button"
									variant="outline"
									className="w-full"
									onClick={downloadEmergencyKit}
								>
									<Download size={16} className="mr-2" />
									Download Kit
								</Button>
							</div>

							<div className="rounded-lg border border-amber-200 bg-amber-50 p-3 dark:border-amber-900 dark:bg-amber-950/30">
								<p className="text-amber-700 text-xs dark:text-amber-300">
									<strong>Important:</strong> If you lose this secret key, you
									will lose access to your account and all your data.
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
									I have saved my new secret key in a safe place
								</span>
							</label>
						</div>
						<DialogFooter>
							<Button
								type="button"
								variant="outline"
								onClick={() => setOpen(false)}
							>
								Cancel
							</Button>
							<Button
								type="button"
								onClick={handleConfirmRegeneration}
								disabled={
									!hasAcknowledged ||
									isProcessing ||
									regenerateSecretKeyMutation.isPending
								}
							>
								{isProcessing || regenerateSecretKeyMutation.isPending
									? "Saving..."
									: "Confirm & Update"}
							</Button>
						</DialogFooter>
					</>
				)}
			</DialogContent>
		</Dialog>
	);
}
