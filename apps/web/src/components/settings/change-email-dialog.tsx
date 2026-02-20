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
import {
	IconEyeOutlineDuo18 as Eye,
	IconEyeSlashOutlineDuo18 as EyeOff,
	IconEnvelopeOutlineDuo18 as Mail,
} from "@bittery/ui/icons";
import { useQuery } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { useState } from "react";
import { storage } from "@/lib/storage";
import {
	decrypt,
	deriveKeys,
	encrypt,
	generateSRPRegistration,
} from "@/lib/wasm-crypto";

export function ChangeEmailDialog({ currentEmail }: { currentEmail: string }) {
	const [open, setOpen] = useState(false);
	const [newEmail, setNewEmail] = useState("");
	const [confirmEmail, setConfirmEmail] = useState("");
	const [currentPassword, setCurrentPassword] = useState("");
	const [showPassword, setShowPassword] = useState(false);
	const [isProcessing, setIsProcessing] = useState(false);
	const trpcClient = useTRPCClient();
	const trpc = useTRPC();
	const navigate = useNavigate();

	const userQuery = useQuery(trpc.auth.me.queryOptions());
	const vaultListQuery = useQuery(trpc.vault.list.queryOptions());

	const handleSubmit = async (e: React.FormEvent) => {
		e.preventDefault();

		if (!newEmail.trim()) {
			toast.error("Please enter a new email address");
			return;
		}
		if (newEmail !== confirmEmail) {
			toast.error("Email addresses do not match");
			return;
		}
		if (newEmail.toLowerCase() === currentEmail.toLowerCase()) {
			toast.error("New email must be different from current email");
			return;
		}
		if (!currentPassword.trim()) {
			toast.error("Please enter your password");
			return;
		}

		const secretKey = await storage.getStoredSecretKey();
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
			// 1. Derive old keys with current email
			const { masterUnlockKey: oldMasterUnlockKey } = await deriveKeys(
				currentPassword,
				secretKey,
				currentEmail,
			);

			// 2. Decrypt private key with old MUK to verify password
			const encryptedPrivateKeyData = JSON.parse(
				userQuery.data.encryptedPrivateKey,
			);
			const privateKey = await decrypt(
				encryptedPrivateKeyData,
				oldMasterUnlockKey,
			);

			// 3. Derive new keys with new email (same password, same secret key)
			const normalizedNewEmail = newEmail.trim().toLowerCase();
			const { authKey: newAuthKey, masterUnlockKey: newMasterUnlockKey } =
				await deriveKeys(currentPassword, secretKey, normalizedNewEmail);

			// 4. Generate new SRP credentials
			const authKeyString = new TextDecoder().decode(newAuthKey);
			const { salt: srpSalt, verifier: srpVerifier } =
				await generateSRPRegistration(authKeyString);

			// 5. Re-encrypt private key with new MUK
			const newEncryptedPrivateKey = await encrypt(
				privateKey,
				newMasterUnlockKey,
			);

			// 6. Re-encrypt vault keys with new MUK
			const serverVaultKeys = vaultListQuery.data;
			const currentUserId = userQuery.data.id;
			const encryptedVaultKeys: Array<{
				vaultId: string;
				encryptedVaultKey: string;
			}> = [];

			for (const vk of serverVaultKeys) {
				// Skip shared vaults (RSA-encrypted vault keys)
				if (vk.createdById !== currentUserId) {
					continue;
				}

				const encryptedVaultKeyData = JSON.parse(vk.encryptedVaultKey);
				const decryptedVaultKeyBase64 = await decrypt(
					encryptedVaultKeyData,
					oldMasterUnlockKey,
				);

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
			await trpcClient.auth.updateEmail.mutate({
				newEmail: normalizedNewEmail,
				srpSalt,
				srpVerifier,
				encryptedPrivateKey: JSON.stringify(newEncryptedPrivateKey),
				encryptedVaultKeys,
			});

			toast.success(
				"Email updated successfully. Please sign in with your new email.",
			);
			setOpen(false);
			navigate({ to: "/login" });
		} catch (error) {
			console.error("Email change error:", error);
			toast.error(
				"Failed to change email. Please verify your password is correct.",
			);
			setIsProcessing(false);
		}
	};

	const handleOpenChange = (newOpen: boolean) => {
		setOpen(newOpen);
		if (!newOpen) {
			setNewEmail("");
			setConfirmEmail("");
			setCurrentPassword("");
			setShowPassword(false);
			setIsProcessing(false);
		}
	};

	return (
		<Dialog open={open} onOpenChange={handleOpenChange}>
			<DialogTrigger asChild>
				<Button variant="outline">
					<Mail className="mr-2 h-4 w-4" />
					Change Email
				</Button>
			</DialogTrigger>
			<DialogContent>
				<form onSubmit={handleSubmit}>
					<DialogHeader>
						<DialogTitle>Change Email Address</DialogTitle>
						<DialogDescription>
							Update your account email address. Your encryption keys will be
							re-derived with the new email. You will be logged out and need to
							sign in again.
						</DialogDescription>
					</DialogHeader>
					<div className="grid gap-4 py-4">
						<div className="grid gap-2">
							<Label htmlFor="currentEmail">Current Email</Label>
							<Input
								id="currentEmail"
								value={currentEmail}
								disabled
								className="bg-muted"
							/>
						</div>
						<div className="grid gap-2">
							<Label htmlFor="newEmail">New Email</Label>
							<Input
								id="newEmail"
								type="email"
								value={newEmail}
								onChange={(e) => setNewEmail(e.target.value)}
								placeholder="Enter new email address"
								autoFocus
							/>
						</div>
						<div className="grid gap-2">
							<Label htmlFor="confirmEmail">Confirm New Email</Label>
							<Input
								id="confirmEmail"
								type="email"
								value={confirmEmail}
								onChange={(e) => setConfirmEmail(e.target.value)}
								placeholder="Confirm new email address"
							/>
						</div>
						<div className="grid gap-2">
							<Label htmlFor="emailChangePassword">
								Enter your password to continue
							</Label>
							<div className="relative">
								<Input
									id="emailChangePassword"
									type={showPassword ? "text" : "password"}
									value={currentPassword}
									onChange={(e) => setCurrentPassword(e.target.value)}
									placeholder="Enter your password"
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
					<div className="mb-4 rounded-lg border border-amber-200 bg-amber-50 p-3 dark:border-amber-900 dark:bg-amber-950/30">
						<p className="text-amber-700 text-xs dark:text-amber-300">
							<strong>Warning:</strong> After changing your email, your Recovery
							Key setup will be cleared and must be configured again.
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
						<Button type="submit" disabled={isProcessing}>
							{isProcessing ? "Updating..." : "Update Email"}
						</Button>
					</DialogFooter>
				</form>
			</DialogContent>
		</Dialog>
	);
}
