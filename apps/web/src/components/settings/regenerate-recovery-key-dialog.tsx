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
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Copy, Download, Eye, EyeOff, RefreshCw } from "lucide-react";
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

export function RegenerateRecoveryKeyDialog({
	userEmail,
}: {
	userEmail: string;
}) {
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
			toast.success("Recovery Key has been regenerated.");
			handleOpenChange(false);
		},
		onError: (error: Error) => {
			toast.error(error.message || "Failed to regenerate Recovery Key");
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
			console.error("Recovery key regeneration failed:", error);
			toast.error("Failed to verify password. Please try again.");
		} finally {
			setIsProcessing(false);
		}
	};

	const handleConfirmRegeneration = async () => {
		if (!hasAcknowledged) {
			toast.error("Please confirm you saved the Recovery Key");
			return;
		}

		if (!recoveryKey || !encryptedMasterKey) {
			toast.error("Recovery setup data missing. Please retry.");
			return;
		}

		setIsProcessing(true);
		const recoveryKeyHint = recoveryKey.split("-").slice(0, 2).join("-") || "R1";

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

	const downloadEmergencyKit = () => {
		const result = downloadRecoveryKit({
			fileName: "bittery-recovery-kit-regenerated",
			title: "Bittery Recovery Kit (Regenerated)",
			subtitle:
				"This new Recovery Key replaces your previous one for future password recovery.",
			entries: [
				{
					label: "New Recovery Key",
					value: recoveryKey,
					description:
						"Your previous Recovery Key is now invalid and cannot be used anymore.",
				},
			],
			cautions: [
				"Destroy old copies of your previous Recovery Key.",
				"Store this regenerated kit offline in a secure location.",
				"Keep this separate from your password and device backups.",
			],
			footerNote:
				"This document is generated client-side and never uploaded to Bittery servers.",
		});

		if (result === "print-opened") {
			toast.success("Recovery Kit opened. Use Print to save as PDF.");
			return;
		}

		toast.success("Recovery Kit downloaded as HTML. Open it and save to PDF.");
	};

	return (
		<Dialog open={open} onOpenChange={handleOpenChange}>
			<DialogTrigger asChild>
				<Button variant="outline">
					<RefreshCw className="mr-2 h-4 w-4" />
					Regenerate Recovery Key
				</Button>
			</DialogTrigger>
			<DialogContent className="sm:max-w-md">
				{step === "verify" ? (
					<form onSubmit={handleGenerateRecoveryKey}>
						<DialogHeader>
							<DialogTitle>Regenerate Recovery Key</DialogTitle>
							<DialogDescription>
								Generate a new Recovery Key. This invalidates your previous one.
							</DialogDescription>
						</DialogHeader>
						<div className="grid gap-4 py-4">
							<div className="rounded-lg border border-destructive/50 bg-destructive/10 p-3">
								<p className="text-destructive text-xs">
									<strong>Warning:</strong> The current Recovery Key will no
									longer work after regeneration.
								</p>
							</div>

							<div className="grid gap-2">
								<Label htmlFor="regenRecoveryPassword">Current Password</Label>
								<div className="relative">
									<Input
										id="regenRecoveryPassword"
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
								{isProcessing ? "Verifying..." : "Generate New Recovery Key"}
							</Button>
						</DialogFooter>
					</form>
				) : (
					<>
						<DialogHeader>
							<DialogTitle>Save Your New Recovery Key</DialogTitle>
							<DialogDescription>
								This key is shown once. Store it securely before continuing.
							</DialogDescription>
						</DialogHeader>
						<div className="grid gap-4 py-4">
							<div className="relative rounded-xl border bg-muted/30 p-4">
								<div className="mb-2 font-medium text-muted-foreground text-xs uppercase tracking-wider">
									Your New Recovery Key
								</div>
								<div className="break-all font-mono text-sm tracking-wide">
									{recoveryKey}
								</div>
							</div>

							<div className="grid grid-cols-2 gap-3">
								<Button type="button" variant="outline" onClick={copyRecoveryKey}>
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
									I have saved my new Recovery Key in a secure location
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
									!hasAcknowledged || isProcessing || storeRecoveryKeyMutation.isPending
								}
							>
								{isProcessing || storeRecoveryKeyMutation.isPending
									? "Saving..."
									: "Confirm & Regenerate"}
							</Button>
						</DialogFooter>
					</>
				)}
			</DialogContent>
		</Dialog>
	);
}
