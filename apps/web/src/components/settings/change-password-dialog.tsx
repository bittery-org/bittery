import { isAesEncryptedVaultKey } from "@bittery/shared";
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
	IconKeyOutlineDuo18 as Key,
} from "@bittery/ui/icons";
import { useMutation, useQuery } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { useState } from "react";
import { storage } from "@/lib/storage";
import { useI18n } from "@/providers/i18n-provider";
import {
	decrypt,
	deriveKeys,
	encrypt,
	generateSRPRegistration,
} from "@/lib/wasm-crypto";

export function ChangePasswordDialog({ userEmail }: { userEmail: string }) {
	const { m } = useI18n();
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
			toast.success(m["settings.change_password_dialog.toast.changed"]());
			setOpen(false);
			navigate({ to: "/login" });
		},
		onError: () => {
			toast.error(m["settings.change_password_dialog.toast.change_failed"]());
			setIsProcessing(false);
		},
	});

	const handleSubmit = async (e: React.FormEvent) => {
		e.preventDefault();

		if (!currentPassword.trim()) {
			toast.error(
				m["settings.change_password_dialog.toast.current_password_required"](),
			);
			return;
		}
		if (!newPassword.trim()) {
			toast.error(
				m["settings.change_password_dialog.toast.new_password_required"](),
			);
			return;
		}
		if (newPassword.length < 8) {
			toast.error(
				m["settings.change_password_dialog.toast.password_min_length"](),
			);
			return;
		}
		if (newPassword !== confirmPassword) {
			toast.error(m["settings.change_password_dialog.toast.password_mismatch"]());
			return;
		}

		const secretKey = await storage.getStoredSecretKey();
		if (!secretKey) {
			toast.error(m["settings.common.toast.secret_key_not_found"]());
			return;
		}

		if (!userQuery.data?.encryptedPrivateKey) {
			toast.error(m["settings.common.toast.user_data_load_failed"]());
			return;
		}

		if (!vaultListQuery.data || vaultListQuery.data.length === 0) {
			toast.error(m["settings.common.toast.vault_keys_load_failed"]());
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
			const encryptedVaultKeys: Array<{
				vaultId: string;
				encryptedVaultKey: string;
			}> = [];

			for (const vk of serverVaultKeys) {
				// Only re-encrypt AES(MUK)-wrapped keys.
				// RSA-wrapped keys are not tied to the master unlock key.
				if (!isAesEncryptedVaultKey(vk.encryptedVaultKey)) {
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
				toast.error(m["settings.change_password_dialog.toast.change_failed"]());
				setIsProcessing(false);
			}
		};

		return (
			<Dialog open={open} onOpenChange={setOpen}>
				<DialogTrigger asChild>
					<Button variant="outline">
						<Key className="mr-2 h-4 w-4" />
						{m["settings.change_password_dialog.trigger"]()}
					</Button>
				</DialogTrigger>
				<DialogContent>
					<form onSubmit={handleSubmit}>
						<DialogHeader>
							<DialogTitle>
								{m["settings.change_password_dialog.title"]()}
							</DialogTitle>
							<DialogDescription>
								{m["settings.change_password_dialog.description"]()}
							</DialogDescription>
						</DialogHeader>
						<div className="grid gap-4 py-4">
							<div className="grid gap-2">
								<Label htmlFor="currentPassword">
									{m["settings.change_password_dialog.field.current_password"]()}
								</Label>
								<div className="relative">
									<Input
									id="currentPassword"
										type={showCurrentPassword ? "text" : "password"}
										value={currentPassword}
										onChange={(e) => setCurrentPassword(e.target.value)}
										placeholder={m["settings.change_password_dialog.placeholder.current_password"]()}
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
								<Label htmlFor="newPassword">
									{m["settings.change_password_dialog.field.new_password"]()}
								</Label>
								<div className="relative">
									<Input
									id="newPassword"
										type={showNewPassword ? "text" : "password"}
										value={newPassword}
										onChange={(e) => setNewPassword(e.target.value)}
										placeholder={m["settings.change_password_dialog.placeholder.new_password"]()}
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
									{m["settings.change_password_dialog.hint.password_min_length"]()}
								</p>
							</div>
							<div className="grid gap-2">
								<Label htmlFor="confirmPassword">
									{m["settings.change_password_dialog.field.confirm_new_password"]()}
								</Label>
								<Input
									id="confirmPassword"
									type="password"
									value={confirmPassword}
									onChange={(e) => setConfirmPassword(e.target.value)}
									placeholder={m["settings.change_password_dialog.placeholder.confirm_new_password"]()}
								/>
							</div>
						</div>
						<div className="mb-4 rounded-lg border border-amber-200 bg-amber-50 p-3 dark:border-amber-900 dark:bg-amber-950/30">
							<p className="text-amber-700 text-xs dark:text-amber-300">
								<strong>{m["settings.common.warning"]()}</strong>{" "}
								{m["settings.change_password_dialog.warning.recovery_key_setup"]()}
							</p>
						</div>
						<DialogFooter>
						<Button
								type="button"
								variant="outline"
								onClick={() => setOpen(false)}
							>
								{m["settings.common.action.cancel"]()}
							</Button>
							<Button
								type="submit"
								disabled={isProcessing || changePasswordMutation.isPending}
							>
								{isProcessing || changePasswordMutation.isPending
									? m["settings.change_password_dialog.action.changing"]()
									: m["settings.change_password_dialog.action.submit"]()}
							</Button>
						</DialogFooter>
					</form>
			</DialogContent>
		</Dialog>
	);
}
