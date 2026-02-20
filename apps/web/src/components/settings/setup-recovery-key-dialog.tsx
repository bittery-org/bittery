import { useTRPC, useTRPCClient } from "@bittery/shared/trpc";
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

export function SetupRecoveryKeyDialog({ userEmail }: { userEmail: string }) {
	const [open, setOpen] = useState(false);
	const [step, setStep] = useState<"verify" | "display">("verify");
	const [currentPassword, setCurrentPassword] = useState("");
	const [showPassword, setShowPassword] = useState(false);
	const [recoveryKey, setRecoveryKey] = useState("");
	const [encryptedMasterKey, setEncryptedMasterKey] = useState("");
	const [hasAcknowledged, setHasAcknowledged] = useState(false);
	const [isProcessing, setIsProcessing] = useState(false);

	const trpc = useTRPC();
	const trpcClient = useTRPCClient();
	const queryClient = useQueryClient();
	const userQuery = useQuery(trpc.auth.me.queryOptions());

	const storeRecoveryKeyMutation = useMutation({
		mutationFn: (input: {
			encryptedMasterKey: string;
			recoveryKeyHint: string;
		}) => trpcClient.auth.storeRecoveryKey.mutate(input),
		onSuccess: async () => {
			await queryClient.invalidateQueries();
			toast.success("Recovery Key has been set up.");
			handleOpenChange(false);
		},
		onError: (error: Error) => {
			toast.error(error.message || "Failed to store Recovery Key");
			setIsProcessing(false);
		},
	});

	const handleGenerateRecoveryKey = async (e: React.FormEvent) => {
		e.preventDefault();

		if (!currentPassword.trim()) {
			toast.error("Please enter your current password");
			return;
		}

		const secretKey = await storage.getStoredSecretKey();
		if (!secretKey) {
			toast.error(
				"Secret key not found. Please sign out and sign in with full credentials.",
			);
			return;
		}

		if (!userQuery.data?.encryptedPrivateKey) {
			toast.error("Could not load your account metadata");
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
			toast.error("Failed to verify password. Please try again.");
		} finally {
			setIsProcessing(false);
		}
	};

	const handleConfirmSetup = async () => {
		if (!hasAcknowledged) {
			toast.error("Please confirm you saved the Recovery Key");
			return;
		}

		if (!recoveryKey || !encryptedMasterKey) {
			toast.error("Recovery setup data missing. Please retry.");
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
		copyWithToast(recoveryKey, "Recovery Key", {
			showAutoClearMessage: false,
		});
	};

	const downloadEmergencyKit = async () => {
		const result = await downloadRecoveryKit({
			fileName: "bittery-recovery-kit",
			title: "Bittery Recovery Kit",
			subtitle:
				"Generated on-device to help you recover account access if your password is lost.",
			entries: [
				{
					label: "Recovery Key",
					value: recoveryKey,
					description:
						"Use this Recovery Key to reset your password and recover access.",
				},
			],
			cautions: [
				"Store this kit separately from your password manager.",
				"Keep at least one offline backup in a secure place.",
				"Anyone with this key and your Secret Key can reset your password.",
			],
			footerNote:
				"This document is generated client-side and never uploaded to Bittery servers.",
		});

		if (result === "pdf-downloaded") {
			toast.success("Recovery Kit PDF downloaded.");
			return;
		}

		toast.success("PDF failed. Recovery Kit downloaded as text backup.");
	};

	return (
		<Dialog open={open} onOpenChange={handleOpenChange}>
			<DialogTrigger asChild>
				<Button variant="outline">
					<Shield className="mr-2 h-4 w-4" />
					Set up Recovery Key
				</Button>
			</DialogTrigger>
			<DialogContent className="sm:max-w-md">
				{step === "verify" ? (
					<form onSubmit={handleGenerateRecoveryKey}>
						<DialogHeader>
							<DialogTitle>Set up Recovery Key</DialogTitle>
							<DialogDescription>
								Enter your password to generate a Recovery Key for password
								recovery.
							</DialogDescription>
						</DialogHeader>
						<div className="grid gap-4 py-4">
							<div className="grid gap-2">
								<Label htmlFor="setupRecoveryPassword">Current Password</Label>
								<div className="relative">
									<Input
										id="setupRecoveryPassword"
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
							<Button type="submit" disabled={isProcessing}>
								{isProcessing ? "Verifying..." : "Generate Recovery Key"}
							</Button>
						</DialogFooter>
					</form>
				) : (
					<>
						<DialogHeader>
							<DialogTitle>Save Your Recovery Key</DialogTitle>
							<DialogDescription>
								This key is shown once. Store it securely before continuing.
							</DialogDescription>
						</DialogHeader>
						<div className="grid gap-4 py-4">
							<div className="relative rounded-xl border bg-muted/30 p-4">
								<div className="mb-2 font-medium text-muted-foreground text-xs uppercase tracking-wider">
									Your Recovery Key
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
									Copy
								</Button>
								<Button
									type="button"
									variant="outline"
									onClick={downloadEmergencyKit}
								>
									<Download size={16} className="mr-2" />
									Download Kit
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
									I have saved my Recovery Key in a secure location
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
								onClick={handleConfirmSetup}
								disabled={
									!hasAcknowledged ||
									isProcessing ||
									storeRecoveryKeyMutation.isPending
								}
							>
								{isProcessing || storeRecoveryKeyMutation.isPending
									? "Saving..."
									: "Confirm & Save"}
							</Button>
						</DialogFooter>
					</>
				)}
			</DialogContent>
		</Dialog>
	);
}
