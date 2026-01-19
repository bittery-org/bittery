import { decrypt, encrypt } from "@bittery/crypto/encryption";
import { deriveKeys } from "@bittery/crypto/key-derivation";
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
import { Eye, EyeOff, Key } from "lucide-react";
import { useState } from "react";

export function ChangePasswordDialog({ userEmail }: { userEmail: string }) {
	const [open, setOpen] = useState(false);
	const [currentPassword, setCurrentPassword] = useState("");
	const [newPassword, setNewPassword] = useState("");
	const [confirmPassword, setConfirmPassword] = useState("");
	const [showCurrentPassword, setShowCurrentPassword] = useState(false);
	const [showNewPassword, setShowNewPassword] = useState(false);
	const [isProcessing, setIsProcessing] = useState(false);
	const trpcClient = useTRPCClient();
	const trpc = useTRPC();
	const navigate = useNavigate();

	const userQuery = useQuery(trpc.auth.me.queryOptions());
	const vaultListQuery = useQuery(trpc.vault.list.queryOptions());

	const changePasswordMutation = useMutation({
		mutationFn: (input: {
			srpSalt: string;
			srpVerifier: string;
			encryptedPrivateKey: string;
			encryptedVaultKeys: Array<{
				vaultId: string;
				encryptedVaultKey: string;
			}>;
		}) => trpcClient.auth.changePassword.mutate(input),
		onSuccess: () => {
			toast.success(
				"Password changed successfully. Please sign in with your new password.",
			);
			setOpen(false);
			navigate({ to: "/login" });
		},
		onError: (error: Error) => {
			toast.error(error.message);
			setIsProcessing(false);
		},
	});

	const handleSubmit = async (e: React.FormEvent) => {
		e.preventDefault();

		if (!currentPassword.trim()) {
			toast.error("Please enter your current password");
			return;
		}
		if (!newPassword.trim()) {
			toast.error("Please enter a new password");
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

		const secretKey = getStoredSecretKey();
		if (!secretKey) {
			toast.error(
				"Secret key not found. Please log out and log in again with your full credentials.",
			);
			return;
		}

		if (!userQuery.data?.encryptedPrivateKey) {
			toast.error("Could not load user data. Please try again.");
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
				secretKey,
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

			// 3. Derive new keys from new password
			const { authKey: newAuthKey, masterUnlockKey: newMasterUnlockKey } =
				await deriveKeys(newPassword, secretKey, userEmail);

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
			changePasswordMutation.mutate({
				srpSalt,
				srpVerifier,
				encryptedPrivateKey: JSON.stringify(newEncryptedPrivateKey),
				encryptedVaultKeys,
			});
		} catch (error) {
			console.error("Password change error:", error);
			toast.error(
				"Failed to change password. Please verify your current password is correct.",
			);
			setIsProcessing(false);
		}
	};

	return (
		<Dialog open={open} onOpenChange={setOpen}>
			<DialogTrigger asChild>
				<Button variant="outline">
					<Key className="mr-2 h-4 w-4" />
					Change Password
				</Button>
			</DialogTrigger>
			<DialogContent>
				<form onSubmit={handleSubmit}>
					<DialogHeader>
						<DialogTitle>Change Password</DialogTitle>
						<DialogDescription>
							Change your master password. Your private key will be re-encrypted
							with the new password. You will be logged out and need to sign in
							again.
						</DialogDescription>
					</DialogHeader>
					<div className="grid gap-4 py-4">
						<div className="grid gap-2">
							<Label htmlFor="currentPassword">Current Password</Label>
							<div className="relative">
								<Input
									id="currentPassword"
									type={showCurrentPassword ? "text" : "password"}
									value={currentPassword}
									onChange={(e) => setCurrentPassword(e.target.value)}
									placeholder="Enter current password"
									autoFocus
									className="pr-10"
								/>
								<Button
									type="button"
									variant="ghost"
									size="icon"
									className="absolute top-0 right-0 h-full w-10 text-muted-foreground hover:text-foreground"
									onClick={() => setShowCurrentPassword(!showCurrentPassword)}
								>
									{showCurrentPassword ? (
										<EyeOff size={16} />
									) : (
										<Eye size={16} />
									)}
								</Button>
							</div>
						</div>
						<div className="grid gap-2">
							<Label htmlFor="newPassword">New Password</Label>
							<div className="relative">
								<Input
									id="newPassword"
									type={showNewPassword ? "text" : "password"}
									value={newPassword}
									onChange={(e) => setNewPassword(e.target.value)}
									placeholder="Enter new password"
									className="pr-10"
								/>
								<Button
									type="button"
									variant="ghost"
									size="icon"
									className="absolute top-0 right-0 h-full w-10 text-muted-foreground hover:text-foreground"
									onClick={() => setShowNewPassword(!showNewPassword)}
								>
									{showNewPassword ? <EyeOff size={16} /> : <Eye size={16} />}
								</Button>
							</div>
							<p className="text-muted-foreground text-xs">
								Must be at least 8 characters long
							</p>
						</div>
						<div className="grid gap-2">
							<Label htmlFor="confirmPassword">Confirm New Password</Label>
							<Input
								id="confirmPassword"
								type="password"
								value={confirmPassword}
								onChange={(e) => setConfirmPassword(e.target.value)}
								placeholder="Confirm new password"
							/>
						</div>
					</div>
					<div className="mb-4 rounded-lg border border-amber-200 bg-amber-50 p-3 dark:border-amber-900 dark:bg-amber-950/30">
						<p className="text-amber-700 text-xs dark:text-amber-300">
							<strong>Warning:</strong> Make sure you remember your new
							password. If you forget it, you will lose access to your account
							and all your data.
						</p>
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
							disabled={isProcessing || changePasswordMutation.isPending}
						>
							{isProcessing || changePasswordMutation.isPending
								? "Changing..."
								: "Change Password"}
						</Button>
					</DialogFooter>
				</form>
			</DialogContent>
		</Dialog>
	);
}
