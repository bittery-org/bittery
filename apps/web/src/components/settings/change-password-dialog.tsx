import {
	buildVaultKeyEncryptionContext,
	isAesEncryptedVaultKey,
} from "@bittery/shared";
import { defaultKdfParamsInput } from "@bittery/shared/kdf-policy";
import { useRPC, useRPCClient } from "@bittery/shared/rpc";
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
	IconEye as Eye,
	IconEyeOff as EyeOff,
	IconKey as Key,
} from "@bittery/ui/icons";
import { useMutation, useQuery } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { useState } from "react";
import { storage } from "@/lib/storage";
import {
	decrypt,
	deriveKeys,
	encrypt,
	generateSRPRegistration,
} from "@/lib/wasm-crypto";
import { useI18n } from "@/providers/i18n-provider";

export function ChangePasswordDialog({ userEmail }: { userEmail: string }) {
	const { m } = useI18n();
	const [open, setOpen] = useState(false);
	const [currentPassword, setCurrentPassword] = useState("");
	const [newPassword, setNewPassword] = useState("");
	const [confirmPassword, setConfirmPassword] = useState("");
	const [showCurrentPassword, setShowCurrentPassword] = useState(false);
	const [showNewPassword, setShowNewPassword] = useState(false);
	const [isProcessing, setIsProcessing] = useState(false);
	const rpcClient = useRPCClient();
	const rpc = useRPC();
	const navigate = useNavigate();

	const userQuery = useQuery(rpc.auth.me.queryOptions());
	const vaultListQuery = useQuery(rpc.vault.list.queryOptions());

	const changePasswordMutation = useMutation({
		mutationFn: (input: {
			srpSalt: string;
			srpVerifier: string;
			encryptedPrivateKey: string;
			encryptedVaultKeys: Array<{
				vaultId: string;
				encryptedVaultKey: string;
			}>;
			kdfParams: ReturnType<typeof defaultKdfParamsInput>;
		}) => rpcClient.auth.changePassword.mutate(input),
		onSuccess: () => {
			toast.success(m.settings_change_password_dialog_toast_changed());
			setOpen(false);
			navigate({ to: "/login" });
		},
		onError: () => {
			toast.error(m.settings_change_password_dialog_toast_change_failed());
			setIsProcessing(false);
		},
	});

	const handleSubmit = async (e: React.FormEvent) => {
		e.preventDefault();

		if (!currentPassword.trim()) {
			toast.error(
				m.settings_change_password_dialog_toast_current_password_required(),
			);
			return;
		}
		if (!newPassword.trim()) {
			toast.error(
				m.settings_change_password_dialog_toast_new_password_required(),
			);
			return;
		}
		if (newPassword.length < 8) {
			toast.error(
				m.settings_change_password_dialog_toast_password_min_length(),
			);
			return;
		}
		if (newPassword !== confirmPassword) {
			toast.error(m.settings_change_password_dialog_toast_password_mismatch());
			return;
		}

		const secretKey = await storage.getStoredSecretKey();
		if (!secretKey) {
			toast.error(m.settings_common_toast_secret_key_not_found());
			return;
		}

		if (!userQuery.data?.encryptedPrivateKey) {
			toast.error(m.settings_common_toast_user_data_load_failed());
			return;
		}

		if (!vaultListQuery.data || vaultListQuery.data.length === 0) {
			toast.error(m.settings_common_toast_vault_keys_load_failed());
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
				const encryptedVaultKeyData = JSON.parse(vk.encryptedVaultKey) as {
					ciphertext: string;
					iv: string;
					algorithm: string;
					context?: { keyVersion?: number };
				};
				const keyVersion = Number.isInteger(
					encryptedVaultKeyData.context?.keyVersion,
				)
					? (encryptedVaultKeyData.context?.keyVersion as number)
					: 1;
				const vaultKeyContext = buildVaultKeyEncryptionContext({
					vaultId: vk.id,
					userId: userQuery.data.id,
					keyVersion,
				});
				const decryptedVaultKeyBase64 = await decrypt(
					encryptedVaultKeyData,
					oldMasterUnlockKey,
					vaultKeyContext,
				);

				// Re-encrypt vault key with new MUK
				const newEncryptedVaultKey = await encrypt(
					decryptedVaultKeyBase64,
					newMasterUnlockKey,
					vaultKeyContext,
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
				kdfParams: defaultKdfParamsInput(),
			});
		} catch (error) {
			console.error("Password change error:", error);
			toast.error(m.settings_change_password_dialog_toast_change_failed());
			setIsProcessing(false);
		}
	};

	return (
		<Dialog open={open} onOpenChange={setOpen}>
			<DialogTrigger asChild>
				<Button variant="outline">
					<Key className="mr-2 h-4 w-4" />
					{m.settings_change_password_dialog_trigger()}
				</Button>
			</DialogTrigger>
			<DialogContent>
				<form onSubmit={handleSubmit}>
					<DialogHeader>
						<DialogTitle>
							{m.settings_change_password_dialog_title()}
						</DialogTitle>
						<DialogDescription>
							{m.settings_change_password_dialog_description()}
						</DialogDescription>
					</DialogHeader>
					<div className="grid gap-4 py-4">
						<div className="grid gap-2">
							<Label htmlFor="currentPassword">
								{m.settings_change_password_dialog_field_current_password()}
							</Label>
							<div className="relative">
								<Input
									id="currentPassword"
									type={showCurrentPassword ? "text" : "password"}
									value={currentPassword}
									onChange={(e) => setCurrentPassword(e.target.value)}
									placeholder={m.settings_change_password_dialog_placeholder_current_password()}
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
								{m.settings_change_password_dialog_field_new_password()}
							</Label>
							<div className="relative">
								<Input
									id="newPassword"
									type={showNewPassword ? "text" : "password"}
									value={newPassword}
									onChange={(e) => setNewPassword(e.target.value)}
									placeholder={m.settings_change_password_dialog_placeholder_new_password()}
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
								{m.settings_change_password_dialog_hint_password_min_length()}
							</p>
						</div>
						<div className="grid gap-2">
							<Label htmlFor="confirmPassword">
								{m.settings_change_password_dialog_field_confirm_new_password()}
							</Label>
							<Input
								id="confirmPassword"
								type="password"
								value={confirmPassword}
								onChange={(e) => setConfirmPassword(e.target.value)}
								placeholder={m.settings_change_password_dialog_placeholder_confirm_new_password()}
							/>
						</div>
					</div>
					<div className="mb-4 rounded-lg border border-amber-200 bg-amber-50 p-3 dark:border-amber-900 dark:bg-amber-950/30">
						<p className="text-amber-700 text-xs dark:text-amber-300">
							<strong>{m.settings_common_warning()}</strong>{" "}
							{m.settings_change_password_dialog_warning_recovery_key_setup()}
						</p>
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
							disabled={isProcessing || changePasswordMutation.isPending}
						>
							{isProcessing || changePasswordMutation.isPending
								? m.settings_change_password_dialog_action_changing()
								: m.settings_change_password_dialog_action_submit()}
						</Button>
					</DialogFooter>
				</form>
			</DialogContent>
		</Dialog>
	);
}
