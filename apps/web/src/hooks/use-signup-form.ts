import { usePlatformCrypto } from "@bittery/core/hooks";
import { storeLoginSessionOwned } from "@bittery/core/services/auth-service";
import { createAccountKeys } from "@bittery/core/services/vault-crypto";
import type { KdfProfile } from "@bittery/crypto-port";
import { m } from "@bittery/i18n/paraglide/messages";
import { useApiClient } from "@bittery/shared/api";
import {
	createApiClientForServer,
	getDefaultServerUrl,
} from "@bittery/shared/api-client-factory";
import { apiQueryKeys } from "@bittery/shared/api-query";
import { isRemoteHttpServer } from "@bittery/shared/server-transport-policy";
import { toAuthVaultKeyEntry } from "@bittery/shared/vault-mapping";
import { DEFAULT_SESSION_EXPIRY_MS } from "@bittery/storage";
import { toast } from "@bittery/ui";
import { useForm } from "@tanstack/react-form";
import { useMutation, useQuery } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { useMemo, useState } from "react";
import { downloadRecoveryKit } from "@/lib/recovery-kit";
import { itemCache, refreshActiveAccountId, storage } from "@/lib/storage";

export type { CloudPlanId } from "@bittery/shared/pricing";

type CloudPlanId = import("@bittery/shared/pricing").CloudPlanId;

type SignupFormValues = {
	email: string;
	password: string;
	name: string;
	plan: CloudPlanId;
	organizationName: string;
};

/**
 * Message to surface for a thrown value. The API client rejects with `ApiError`, the crypto
 * seam and storage with plain `Error`s; anything else carries nothing worth showing, so the
 * caller's fallback wins.
 */
function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : "";
}

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
	kdfProfile: KdfProfile;
	organizationName?: string;
	token?: string;
};

export function useSignupForm({
	invitationToken,
	redirectTo,
	initialPlan,
	verificationMode = "dialog",
	onVerificationRequested,
	initialInsecureTransportConfirmed = false,
}: {
	invitationToken?: string;
	redirectTo?: string;
	initialPlan?: CloudPlanId;
	verificationMode?: "dialog" | "inline";
	onVerificationRequested?: () => void;
	initialInsecureTransportConfirmed?: boolean;
}) {
	const navigate = useNavigate();
	const apiClient = useApiClient();
	const crypto = usePlatformCrypto();
	const serverUrl = getDefaultServerUrl();
	const requiresInsecureTransportConfirmation = isRemoteHttpServer(serverUrl);
	const [insecureTransportConfirmed, setInsecureTransportConfirmed] = useState(
		initialInsecureTransportConfirmed,
	);
	const ceremonyApiClient = useMemo(
		() =>
			createApiClientForServer(serverUrl, undefined, {
				insecureTransportConfirmed,
				clientPlatform: "web",
			}),
		[insecureTransportConfirmed, serverUrl],
	);
	const [keyMaterialQueryId] = useState(() => globalThis.crypto.randomUUID());
	const keyMaterialQuery = useQuery({
		queryKey: ["signup-key-material", keyMaterialQueryId],
		queryFn: async () => {
			const [secretKey, recoveryKey] = await Promise.all([
				crypto.generateSecretKey(),
				crypto.generateRecoveryKey(),
			]);
			return { secretKey, recoveryKey };
		},
		staleTime: Number.POSITIVE_INFINITY,
	});
	const secretKey = keyMaterialQuery.data?.secretKey ?? "";
	const recoveryKey = keyMaterialQuery.data?.recoveryKey ?? "";
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

	const requireInsecureTransportConfirmation = () => {
		if (requiresInsecureTransportConfirmation && !insecureTransportConfirmed) {
			toast.error(m.auth_insecure_http_confirmation_required());
			return false;
		}
		return true;
	};

	// Query invitation details if token is provided
	const invitationQuery = useQuery({
		queryKey: [
			"api",
			"v1",
			"public",
			"team-invitations",
			invitationToken || "",
			serverUrl,
			insecureTransportConfirmed,
		],
		queryFn: async () =>
			(await ceremonyApiClient.teams.invitations.public(invitationToken || ""))
				.data,
		enabled:
			!!invitationToken &&
			(!requiresInsecureTransportConfirmation || insecureTransportConfirmed),
	});
	const registrationStatusQuery = useQuery({
		queryKey: [
			...apiQueryKeys.auth.registrationStatus,
			serverUrl,
			insecureTransportConfirmed,
		],
		queryFn: async () =>
			(await ceremonyApiClient.auth.registrationStatus()).data,
		enabled:
			!requiresInsecureTransportConfirmation || insecureTransportConfirmed,
	});

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

	const getSignupEmail = (value: SignupFormValues) => {
		if (isInvitationSignup) {
			return invitation?.email.trim().toLowerCase() ?? "";
		}

		return value.email.trim().toLowerCase();
	};

	const resetVerifiedSignup = () => {
		setSignupVerificationToken(null);
		setVerifiedEmail(null);
		setVerifiedInvitationToken(null);
	};

	const requestSignupVerificationMutation = useMutation({
		mutationFn: async (input: { email: string }) => {
			if (!requireInsecureTransportConfirmation()) {
				throw new Error(m.auth_insecure_http_confirmation_required());
			}
			return (
				await ceremonyApiClient.auth.requestSignupVerification({
					email: input.email,
					invitationToken: invitationToken ?? null,
				})
			).data;
		},
		onError: (error) => {
			toast.error(error.message || "Failed to send verification code");
		},
	});

	const verifySignupVerificationMutation = useMutation({
		mutationFn: async (input: { email: string; code: string }) => {
			if (!requireInsecureTransportConfirmation()) {
				throw new Error(m.auth_insecure_http_confirmation_required());
			}
			return (
				await ceremonyApiClient.auth.verifySignupVerification({
					email: input.email,
					code: input.code,
					invitationToken: invitationToken ?? null,
				})
			).data;
		},
		onError: (error) => {
			toast.error(error.message || "Failed to verify code");
		},
	});

	const signupMutation = useMutation({
		mutationFn: async (input: SignupMutationInput) => {
			if (!requireInsecureTransportConfirmation()) {
				throw new Error(m.auth_insecure_http_confirmation_required());
			}
			if (isInvitationSignup) {
				return (
					await ceremonyApiClient.auth.signUp(
						{
							invitationToken: input.token || "",
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
							kdfParams: input.kdfProfile,
						},
						{
							kind: "authCeremony",
							serverUrl,
							insecureTransportConfirmed,
						},
					)
				).data;
			}

			return (
				await ceremonyApiClient.auth.signUp(
					{
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
						kdfParams: input.kdfProfile,
					},
					{
						kind: "authCeremony",
						serverUrl,
						insecureTransportConfirmed,
					},
				)
			).data;
		},
		onError: (error) => {
			toast.error(error.message || "Failed to create account");
		},
	});

	/** Where a finished signup lands. Billing takes over when a paid plan was chosen. */
	const goAfterSignup = async (value: SignupFormValues) => {
		if (
			isCloudSelfServeSignup &&
			!isInvitationSignup &&
			isCloudBillingEnabled &&
			value.plan &&
			value.plan !== "free"
		) {
			try {
				const checkout = (
					await apiClient.billing.checkout({
						plan: value.plan,
					})
				).data;
				if (checkout.url) {
					window.location.href = checkout.url;
					return;
				}
			} catch (error) {
				toast.error(
					errorMessage(error) ||
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
			navigate({ to: redirectTo });
		} else {
			navigate({ to: "/home" });
		}
	};

	const completeSignupSubmission = async (
		value: SignupFormValues,
		verificationToken: string,
	) => {
		if (!requireInsecureTransportConfirmation()) {
			return;
		}
		const teamName = value.organizationName.trim();
		const email = getSignupEmail(value);
		if (!email) {
			toast.error("Unable to determine the signup email.");
			return;
		}

		setIsEncrypting(true);
		try {
			const { keys, result } = await createAccountKeys(
				{ email, password: value.password, secretKey, recoveryKey },
				{
					crypto,
					commit: (payload) =>
						signupMutation.mutateAsync({
							userId: payload.userId,
							vaultId: payload.vaultId,
							email,
							name: value.name,
							plan: isCloudBillingEnabled ? value.plan : "free",
							signupVerificationToken: verificationToken,
							...(isCloudSelfServeSignup && value.plan === "team" && teamName
								? { organizationName: teamName }
								: {}),
							...(isInvitationSignup ? { token: invitationToken } : {}),
							secretKeyHint: payload.secretKeyHint,
							srpSalt: payload.srpSalt,
							srpVerifier: payload.srpVerifier,
							publicKey: payload.publicKey,
							encryptedPrivateKey: payload.encryptedPrivateKey,
							encryptedMasterKey: payload.encryptedMasterKey,
							recoveryKeyHint: payload.recoveryKeyHint,
							encryptedVaultKey: payload.encryptedVaultKey,
							kdfProfile: payload.kdfProfile,
						}),
				},
			);

			// The same path a sign-in takes: it registers the account, points the active
			// account at it and clears any cache left under a reused id — none of which a
			// hand-rolled sequence of writes here ever did.
			await storeLoginSessionOwned(
				{
					token: result.token,
					sessionId: result.sessionId,
					expiresAt: result.expiresAt,
					user: {
						id: result.user.id,
						email: result.user.email,
						name: result.user.name,
						teamName: result.user.teamName ?? undefined,
						teamAvatarUrl: result.user.teamAvatarUrl,
						encryptedPrivateKey: keys.encryptedPrivateKey,
					},
					vaultKeys: result.vaultKeys.map((vault) =>
						toAuthVaultKeyEntry({
							...vault,
							vaultIcon: vault.vaultIcon ?? null,
							vaultImageUrl: vault.vaultImageUrl ?? null,
						}),
					),
					masterUnlockKey: keys.masterUnlockKey,
					kdfParams: keys.kdfProfile,
					serverUrl,
				},
				secretKey,
				storage,
				itemCache,
				crypto,
				email,
				{ serverUrl, insecureTransportConfirmed },
			);
			await refreshActiveAccountId();

			toast.success(m.auth_signup_toast_account_created());
			toast.success(
				m.auth_signup_toast_quick_unlock_days({
					daysUntil: String(
						Math.floor(DEFAULT_SESSION_EXPIRY_MS / (1000 * 60 * 60 * 24)),
					),
				}),
			);

			await goAfterSignup(value);
		} catch (error) {
			console.error("Signup error:", error);
			toast.error(errorMessage(error) || "Failed to create account");
		} finally {
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
		const currentEmail = getSignupEmail(currentValues);
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
			setVerifiedEmail(verificationEmail.trim().toLowerCase());
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
			const email = getSignupEmail(value);
			const hasMatchingVerification =
				signupVerificationToken &&
				verifiedEmail === email &&
				verifiedInvitationToken === (invitationToken ?? null);
			const hasMatchingPendingVerification =
				pendingSubmission && verificationEmail.trim().toLowerCase() === email;

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
	const currentSignupEmail = getSignupEmail(form.state.values);
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
		requiresInsecureTransportConfirmation,
		insecureTransportConfirmed,
		setInsecureTransportConfirmed,
	};
}
