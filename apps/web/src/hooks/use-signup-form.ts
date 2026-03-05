import { useTRPC, useTRPCClient } from "@bittery/shared/trpc";
import { buildVaultKeyEncryptionContext } from "@bittery/shared";
import { DEFAULT_SESSION_EXPIRY_MS } from "@bittery/storage";
import { toast } from "@bittery/ui";
import { useForm } from "@tanstack/react-form";
import { useMutation, useQuery } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { useEffect, useState } from "react";

import { downloadRecoveryKit } from "@/lib/recovery-kit";
import { storage } from "@/lib/storage";
import {
	generateRecoveryKeyAsync,
	generateSecretKeyAsync,
} from "@/lib/wasm-crypto";
import { WorkerCrypto } from "@/lib/worker-crypto";

export type { CloudPlanId } from "@bittery/shared/pricing";

type CloudPlanId = import("@bittery/shared/pricing").CloudPlanId;

export function useSignupForm({
	invitationToken,
	redirectTo,
	initialPlan,
}: {
	invitationToken?: string;
	redirectTo?: string;
	initialPlan?: CloudPlanId;
}) {
	const navigate = useNavigate();
	const trpc = useTRPC();
	const trpcClient = useTRPCClient();
	const [secretKey, setSecretKey] = useState<string>("");
	const [recoveryKey, setRecoveryKey] = useState<string>("");
	const [hasDownloadedKit, setHasDownloadedKit] = useState(false);
	const [showPassword, setShowPassword] = useState(false);
	const [isEncrypting, setIsEncrypting] = useState(false);

	// Query invitation details if token is provided
	const invitationQuery = useQuery({
		...trpc.team.invitations.getByToken.queryOptions({
			token: invitationToken || "",
		}),
		enabled: !!invitationToken,
	});
	const registrationStatusQuery = useQuery(
		trpc.auth.registrationStatus.queryOptions(),
	);

	const invitation = invitationQuery.data;
	const hasInvitationToken = !!invitationToken;
	const isInvitationSignup = hasInvitationToken && !!invitation;
	const registrationStatus = registrationStatusQuery.data;
	const isSelfHostedMode = registrationStatus?.mode === "self-hosted";
	const isCloudMode = registrationStatus?.mode !== "self-hosted";
	const isCloudSelfServeSignup = isCloudMode && !isInvitationSignup;
	const allowPublicSignup = registrationStatus?.allowPublicSignup ?? true;

	// Generate Secret Key + Recovery Key on mount (WASM auto-initializes)
	useEffect(() => {
		Promise.all([generateSecretKeyAsync(), generateRecoveryKeyAsync()]).then(
			([generatedSecretKey, generatedRecoveryKey]) => {
				setSecretKey(generatedSecretKey);
				setRecoveryKey(generatedRecoveryKey);
			},
		);
	}, []);

	const signupMutation = useMutation({
		mutationFn: async (input: {
			userId?: string;
			vaultId?: string;
			email: string;
			name: string;
			plan?: CloudPlanId;
			secretKeyHint: string;
			srpSalt: string;
			srpVerifier: string;
			publicKey: string;
			encryptedPrivateKey: string;
			encryptedMasterKey: string;
			recoveryKeyHint: string;
			encryptedVaultKey: string;
			organizationName?: string;
			token?: string;
		}) => {
			if (isInvitationSignup) {
				return trpcClient.auth.signupWithInvitation.mutate({
					token: input.token || "",
					userId: input.userId,
					vaultId: input.vaultId,
					email: input.email,
					name: input.name,
					secretKeyHint: input.secretKeyHint,
					srpSalt: input.srpSalt,
					srpVerifier: input.srpVerifier,
					publicKey: input.publicKey,
					encryptedPrivateKey: input.encryptedPrivateKey,
					encryptedMasterKey: input.encryptedMasterKey,
					recoveryKeyHint: input.recoveryKeyHint,
					encryptedVaultKey: input.encryptedVaultKey,
				});
			}

			return trpcClient.auth.signup.mutate({
				userId: input.userId,
				vaultId: input.vaultId,
				email: input.email,
				name: input.name,
				plan: input.plan,
				organizationName: input.organizationName,
				secretKeyHint: input.secretKeyHint,
				srpSalt: input.srpSalt,
				srpVerifier: input.srpVerifier,
				publicKey: input.publicKey,
				encryptedPrivateKey: input.encryptedPrivateKey,
				encryptedMasterKey: input.encryptedMasterKey,
				recoveryKeyHint: input.recoveryKeyHint,
				encryptedVaultKey: input.encryptedVaultKey,
			});
		},
		onSuccess: async (data, variables) => {
			// Store auth token and vault keys
			await storage.storeAuthToken(data.token);
			await storage.storeVaultKeys(data.vaultKeys);

			toast.success("Account created successfully!");

			if (
				isCloudSelfServeSignup &&
				!isInvitationSignup &&
				variables.plan &&
				variables.plan !== "free"
			) {
				try {
					const checkout =
						await trpcClient.billing.createCheckoutSession.mutate({
							plan: variables.plan,
						});

					if (checkout.url) {
						window.location.href = checkout.url;
						return;
					}
				} catch (error: any) {
					toast.error(
						error?.message ||
							"Account created, but checkout could not be started. Open billing to continue.",
					);
					navigate({ to: "/billing" });
					return;
				}
			}

			// Invitation signup is accepted server-side.
			if (isInvitationSignup) {
				navigate({ to: "/team" });
			} else if (redirectTo) {
				// Navigate to redirect URL (invitation page) if provided, otherwise go to home
				navigate({ to: redirectTo });
			} else {
				navigate({ to: "/home" });
			}
		},
		onError: (error: any) => {
			toast.error(error.message || "Failed to create account");
		},
	});

	const form = useForm({
		defaultValues: {
			email: "",
			password: "",
			name: "",
			plan: (initialPlan ?? "free") as CloudPlanId,
			organizationName: "",
		},
		onSubmit: async ({ value }) => {
			if (!hasDownloadedKit) {
				toast.error("Please download your Emergency Kit before continuing");
				return;
			}

			const teamName = value.organizationName.trim();
			if (isCloudSelfServeSignup && value.plan === "team" && !teamName) {
				toast.error("Please enter a team or business name to continue");
				return;
			}

			setIsEncrypting(true);
			const workerCrypto = new WorkerCrypto();
			try {
				// Use invitation email if signing up via invitation
				const email = isInvitationSignup
					? invitation?.email || value.email
					: value.email;

				// All heavy crypto runs in a Web Worker via WorkerCrypto,
				// keeping the main thread responsive with the spinner.

				// 1. Derive raw master key, then split into auth + unlock keys
				const masterKey = await workerCrypto.deriveMasterKey(
					value.password,
					secretKey,
					email,
				);
				const { authKey, masterUnlockKey } =
					await workerCrypto.deriveKeysFromMasterKey(masterKey, email);

				// 2. Generate SRP credentials
				const srpPassword = new TextDecoder().decode(authKey);
				const { salt, verifier } =
					await workerCrypto.generateSRPRegistration(srpPassword);

				// 3. Generate RSA-4096 key pair
				const { publicKey, privateKey } =
					await workerCrypto.generateRSAKeyPair();

				// 4. Encrypt private key with Master Unlock Key
				const encryptedPrivateKey = await workerCrypto.encrypt(
					privateKey,
					masterUnlockKey,
				);

					// 5. Generate vault key and encrypt it
					const vaultKey = await workerCrypto.generateEncryptionKey();
					const vaultKeyBase64 = btoa(String.fromCharCode(...vaultKey));
					const signupUserId = crypto.randomUUID();
					const signupVaultId = crypto.randomUUID();
					const encryptedVaultKey = await workerCrypto.encrypt(
						vaultKeyBase64,
						masterUnlockKey,
						buildVaultKeyEncryptionContext({
							vaultId: signupVaultId,
							userId: signupUserId,
							keyVersion: 1,
						}),
					);

				// 6. Get secret key hint
				const secretKeyHint = await workerCrypto.getSecretKeyHint(secretKey);

				// 7. Encrypt raw master key with recovery key material
				const encryptedMasterKey = await workerCrypto.encryptMasterKey(
					masterKey,
					recoveryKey,
					email,
				);
				const recoveryKeyHint =
					recoveryKey.split("-").slice(0, 2).join("-") || "R1";

				// 8. Call signup mutation
					const result = await signupMutation.mutateAsync({
						userId: signupUserId,
						vaultId: signupVaultId,
						email,
					name: value.name,
					plan: value.plan,
					...(isCloudSelfServeSignup && value.plan === "team" && teamName
						? { organizationName: teamName }
						: {}),
					...(isInvitationSignup ? { token: invitationToken } : {}),
					secretKeyHint,
					srpSalt: salt,
					srpVerifier: verifier,
					publicKey,
					encryptedPrivateKey: JSON.stringify(encryptedPrivateKey),
					encryptedMasterKey: JSON.stringify(encryptedMasterKey),
					recoveryKeyHint,
						encryptedVaultKey: JSON.stringify(encryptedVaultKey),
					} as any);

				// 9. Store Master Unlock Key in memory
				await storage.setMasterUnlockKey(masterUnlockKey);

				// 10. Store encrypted private key for RSA decryption of shared vault keys
				await storage.storeEncryptedPrivateKey(
					JSON.stringify(encryptedPrivateKey),
				);

				// 11. Store secret key and encrypted session for quick unlock
				await storage.storeSecretKey(secretKey);
				await storage.storeSessionData(
					masterUnlockKey,
					email,
					result.userId,
					undefined,
					result.sessionId,
				);

				const daysUntil = Math.floor(
					DEFAULT_SESSION_EXPIRY_MS / (1000 * 60 * 60 * 24),
				);

				toast.success(
					`Account created! Quick unlock available for ${daysUntil} days.`,
				);
			} catch (error: any) {
				console.error("Signup error:", error);
				toast.error(error.message || "Failed to create account");
			} finally {
				workerCrypto.terminate();
				setIsEncrypting(false);
			}
		},
	});

	const downloadEmergencyKit = async () => {
		if (!secretKey || !recoveryKey) {
			toast.error("Still generating account keys. Please try again.");
			return;
		}

		const result = await downloadRecoveryKit({
			fileName: "bittery-emergency-kit",
			title: "Bittery Emergency Kit",
			subtitle:
				"Contains your Secret Key and Recovery Key for offline storage.",
			entries: [
				{
					label: "Secret Key",
					value: secretKey,
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
				"Store this kit offline in a secure location you trust.",
				"Do not save this file in shared folders or chats.",
				"If Secret Key, Recovery Key, and password are all lost, your vault cannot be recovered.",
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

	const hasAllKeyMaterial = Boolean(secretKey) && Boolean(recoveryKey);

	return {
		form,
		signupMutation,
		secretKey,
		recoveryKey,
		hasDownloadedKit,
		showPassword,
		setShowPassword,
		isEncrypting,
		downloadEmergencyKit,
		invitationQuery,
		registrationStatusQuery,
		invitation,
		hasInvitationToken,
		isInvitationSignup,
		isSelfHostedMode,
		isCloudMode,
		isCloudSelfServeSignup,
		allowPublicSignup,
		hasAllKeyMaterial,
	};
}
