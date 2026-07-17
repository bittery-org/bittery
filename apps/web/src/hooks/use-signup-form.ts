import { m } from "@bittery/i18n/paraglide/messages";
import { buildVaultKeyEncryptionContext } from "@bittery/shared";
import { useRPC, useRPCClient } from "@bittery/shared/rpc";
import { DEFAULT_SESSION_EXPIRY_MS } from "@bittery/storage";
import { toast } from "@bittery/ui";
import { useForm } from "@tanstack/react-form";
import { useMutation, useQuery } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { useEffect, useState } from "react";

import { downloadRecoveryKit } from "@/lib/recovery-kit";
import { normalizeAuthVaultKey } from "@/lib/rpc-normalizers";
import { storage } from "@/lib/storage";
import {
	generateRecoveryKeyAsync,
	generateSecretKeyAsync,
} from "@/lib/wasm-crypto";
import { WorkerCrypto } from "@/lib/worker-crypto";

export type { CloudPlanId } from "@bittery/shared/pricing";

type CloudPlanId = import("@bittery/shared/pricing").CloudPlanId;

type SignupFormValues = {
	email: string;
	password: string;
	name: string;
	plan: CloudPlanId;
	organizationName: string;
};

type SignupMutationInput = {
	userId?: string;
	vaultId?: string;
	email: string;
	name: string;
	plan?: CloudPlanId;
	signupVerificationToken: string;
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
};

export function useSignupForm({
	invitationToken,
	redirectTo,
	initialPlan,
	verificationMode = "dialog",
	onVerificationRequested,
}: {
	invitationToken?: string;
	redirectTo?: string;
	initialPlan?: CloudPlanId;
	verificationMode?: "dialog" | "inline";
	onVerificationRequested?: () => void;
}) {
	const navigate = useNavigate();
	const rpc = useRPC();
	const rpcClient = useRPCClient();
	const [secretKey, setSecretKey] = useState<string>("");
	const [recoveryKey, setRecoveryKey] = useState<string>("");
	const [hasDownloadedKit, setHasDownloadedKit] = useState(false);
	const [showPassword, setShowPassword] = useState(false);
	const [isEncrypting, setIsEncrypting] = useState(false);
	const [verificationDialogOpen, setVerificationDialogOpen] = useState(false);
	const [verificationCode, setVerificationCode] = useState("");
	const [verificationEmail, setVerificationEmail] = useState("");
	const [pendingSubmission, setPendingSubmission] =
		useState<SignupFormValues | null>(null);
	const [signupVerificationToken, setSignupVerificationToken] = useState<
		string | null
	>(null);
	const [verifiedEmail, setVerifiedEmail] = useState<string | null>(null);
	const [verifiedInvitationToken, setVerifiedInvitationToken] = useState<
		string | null
	>(null);

	// Query invitation details if token is provided
	const invitationQuery = useQuery({
		...rpc.team.invitations.getByToken.queryOptions({
			token: invitationToken || "",
		}),
		enabled: !!invitationToken,
	});
	const registrationStatusQuery = useQuery(
		rpc.auth.registrationStatus.queryOptions(),
	);

	const invitation = invitationQuery.data;
	const hasInvitationToken = !!invitationToken;
	const isInvitationSignup = hasInvitationToken && !!invitation;
	const registrationStatus = registrationStatusQuery.data;
	const isSelfHostedMode = registrationStatus?.mode === "self-hosted";
	const isCloudMode = registrationStatus?.mode !== "self-hosted";
	const isCloudSelfServeSignup = isCloudMode && !isInvitationSignup;
	const isCloudBillingEnabled = registrationStatus?.billingEnabled ?? true;
	const allowPublicSignup = registrationStatus?.allowPublicSignup ?? true;
	const requiresEmailVerification =
		registrationStatus?.requiresEmailVerification ?? true;

	const normalizeSignupEmail = (email: string) => email.trim().toLowerCase();

	const getSignupEmail = (value: SignupFormValues) => {
		if (isInvitationSignup) {
			return invitation?.email ?? "";
		}

		return value.email;
	};

	const resetVerifiedSignup = () => {
		setSignupVerificationToken(null);
		setVerifiedEmail(null);
		setVerifiedInvitationToken(null);
	};

	// Generate Secret Key + Recovery Key on mount (WASM auto-initializes)
	useEffect(() => {
		Promise.all([generateSecretKeyAsync(), generateRecoveryKeyAsync()]).then(
			([generatedSecretKey, generatedRecoveryKey]) => {
				setSecretKey(generatedSecretKey);
				setRecoveryKey(generatedRecoveryKey);
			},
		);
	}, []);

	const requestSignupVerificationMutation = useMutation({
		mutationFn: async (input: { email: string }) =>
			rpcClient.auth.requestSignupVerification.mutate({
				email: input.email,
				invitationToken: invitationToken ?? null,
			}),
		onError: (error: any) => {
			toast.error(error.message || "Failed to send verification code");
		},
	});

	const verifySignupVerificationMutation = useMutation({
		mutationFn: async (input: { email: string; code: string }) =>
			rpcClient.auth.verifySignupVerification.mutate({
				email: input.email,
				code: input.code,
				invitationToken: invitationToken ?? null,
			}),
		onError: (error: any) => {
			toast.error(error.message || "Failed to verify code");
		},
	});

	const signupMutation = useMutation({
		mutationFn: async (input: SignupMutationInput) => {
			if (isInvitationSignup) {
				return rpcClient.auth.signupWithInvitation.mutate({
					token: input.token || "",
					userId: input.userId ?? null,
					vaultId: input.vaultId ?? null,
					email: input.email,
					signupVerificationToken: input.signupVerificationToken,
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

			return rpcClient.auth.signup.mutate({
				userId: input.userId ?? null,
				vaultId: input.vaultId ?? null,
				email: input.email,
				signupVerificationToken: input.signupVerificationToken,
				name: input.name,
				plan: input.plan ?? null,
				organizationName: input.organizationName ?? null,
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
			await storage.storeVaultKeys(data.vaultKeys.map(normalizeAuthVaultKey));

			toast.success(m.auth_signup_toast_account_created());

			if (
				isCloudSelfServeSignup &&
				!isInvitationSignup &&
				isCloudBillingEnabled &&
				variables.plan &&
				variables.plan !== "free"
			) {
				try {
					const checkout = await rpcClient.billing.createCheckoutSession.mutate(
						{
							plan: variables.plan,
						},
					);

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

	const completeSignupSubmission = async (
		value: SignupFormValues,
		verificationToken: string,
	) => {
		const teamName = value.organizationName.trim();

		setIsEncrypting(true);
		const workerCrypto = new WorkerCrypto();
		try {
			const email = getSignupEmail(value);
			if (!email) {
				toast.error("Unable to determine the signup email.");
				return;
			}

			const masterKey = await workerCrypto.deriveMasterKey(
				value.password,
				secretKey,
				email,
			);
			const { authKey, masterUnlockKey } =
				await workerCrypto.deriveKeysFromMasterKey(masterKey, email);

			const srpPassword = new TextDecoder().decode(authKey);
			const { salt, verifier } =
				await workerCrypto.generateSRPRegistration(srpPassword);

			const { publicKey, privateKey } = await workerCrypto.generateRSAKeyPair();

			const encryptedPrivateKey = await workerCrypto.encrypt(
				privateKey,
				masterUnlockKey,
			);

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

			const secretKeyHint = await workerCrypto.getSecretKeyHint(secretKey);
			const encryptedMasterKey = await workerCrypto.encryptMasterKey(
				masterKey,
				recoveryKey,
				email,
			);
			const recoveryKeyHint =
				recoveryKey.split("-").slice(0, 2).join("-") || "R1";

			const result = await signupMutation.mutateAsync({
				userId: signupUserId,
				vaultId: signupVaultId,
				email,
				name: value.name,
				plan: isCloudBillingEnabled ? value.plan : "free",
				signupVerificationToken: verificationToken,
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
			});

			const accountId = crypto.randomUUID();
			await storage.setMasterUnlockKey(masterUnlockKey);
			await storage.storeEncryptedPrivateKey(
				JSON.stringify(encryptedPrivateKey),
			);
			await storage.storeSecretKey(secretKey);
			await storage.storeSessionData(
				masterUnlockKey,
				accountId,
				email,
				result.userId,
				result.expiresAt,
				result.sessionId,
			);

			const daysUntil = Math.floor(
				DEFAULT_SESSION_EXPIRY_MS / (1000 * 60 * 60 * 24),
			);

			toast.success(
				m.auth_signup_toast_quick_unlock_days({ daysUntil: String(daysUntil) }),
			);
		} catch (error: any) {
			console.error("Signup error:", error);
			toast.error(error.message || "Failed to create account");
		} finally {
			workerCrypto.terminate();
			setIsEncrypting(false);
		}
	};

	const beginSignupVerification = async (value: SignupFormValues) => {
		const email = getSignupEmail(value);
		if (!email) {
			toast.error("Unable to determine the signup email.");
			return;
		}

		resetVerifiedSignup();
		try {
			await requestSignupVerificationMutation.mutateAsync({ email });
		} catch {
			return;
		}
		setPendingSubmission(value);
		setVerificationEmail(email);
		setVerificationCode("");
		if (verificationMode === "dialog") {
			setVerificationDialogOpen(true);
		}
		onVerificationRequested?.();
		toast.success("Verification code sent. Check your inbox.");
	};

	const submitSignupVerificationCode = async () => {
		const currentValues = form.state.values;
		const currentEmail = normalizeSignupEmail(getSignupEmail(currentValues));
		const hasMatchingVerification =
			signupVerificationToken &&
			verifiedEmail === currentEmail &&
			verifiedInvitationToken === (invitationToken ?? null);

		if (hasMatchingVerification && signupVerificationToken) {
			await completeSignupSubmission(currentValues, signupVerificationToken);
			return;
		}

		if (!pendingSubmission) {
			return;
		}

		const code = verificationCode.trim();
		if (code.length !== 6) {
			toast.error("Enter the 6-digit verification code.");
			return;
		}

		try {
			const result = await verifySignupVerificationMutation.mutateAsync({
				email: verificationEmail,
				code,
			});

			if (!result.success || !result.signupVerificationToken) {
				toast.error("Invalid or expired verification code.");
				return;
			}

			setSignupVerificationToken(result.signupVerificationToken);
			setVerifiedEmail(normalizeSignupEmail(verificationEmail));
			setVerifiedInvitationToken(invitationToken ?? null);
			if (verificationMode === "dialog") {
				setVerificationDialogOpen(false);
			}
			setVerificationCode("");
			const submission = pendingSubmission;
			setPendingSubmission(null);
			await completeSignupSubmission(
				submission,
				result.signupVerificationToken,
			);
		} catch {
			return;
		}
	};

	const resendSignupVerificationCode = async () => {
		if (!verificationEmail) {
			return;
		}

		try {
			await requestSignupVerificationMutation.mutateAsync({
				email: verificationEmail,
			});
		} catch {
			return;
		}
		toast.success("A new verification code has been sent.");
	};

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
			const email = normalizeSignupEmail(getSignupEmail(value));
			const hasMatchingVerification =
				signupVerificationToken &&
				verifiedEmail === email &&
				verifiedInvitationToken === (invitationToken ?? null);
			const hasMatchingPendingVerification =
				pendingSubmission && normalizeSignupEmail(verificationEmail) === email;

			if (!requiresEmailVerification) {
				await completeSignupSubmission(value, "");
				return;
			}

			if (!hasMatchingVerification || !signupVerificationToken) {
				if (hasMatchingPendingVerification) {
					setPendingSubmission(value);
					onVerificationRequested?.();
					return;
				}

				await beginSignupVerification(value);
				return;
			}

			await completeSignupSubmission(value, signupVerificationToken);
		},
	});

	const hasPendingVerification = Boolean(pendingSubmission);
	const currentSignupEmail = normalizeSignupEmail(
		getSignupEmail(form.state.values),
	);
	const hasVerifiedSignup =
		Boolean(signupVerificationToken) &&
		verifiedEmail === currentSignupEmail &&
		verifiedInvitationToken === (invitationToken ?? null);

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
		verificationDialogOpen,
		setVerificationDialogOpen,
		verificationCode,
		setVerificationCode,
		verificationEmail,
		hasPendingVerification,
		hasVerifiedSignup,
		requestSignupVerificationMutation,
		verifySignupVerificationMutation,
		submitSignupVerificationCode,
		resendSignupVerificationCode,
		downloadEmergencyKit,
		invitationQuery,
		registrationStatusQuery,
		invitation,
		hasInvitationToken,
		isInvitationSignup,
		isSelfHostedMode,
		isCloudMode,
		isCloudSelfServeSignup,
		isCloudBillingEnabled,
		allowPublicSignup,
		requiresEmailVerification,
		hasAllKeyMaterial,
	};
}
