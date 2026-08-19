export const BITTERY_PASSKEY_SOURCE_PAGE = "BITTERY_PASSKEY_PAGE";
export const BITTERY_PASSKEY_SOURCE_CONTENT = "BITTERY_PASSKEY_CONTENT";

export const BITTERY_PASSKEY_CREATE_REQUEST = "BITTERY_PASSKEY_CREATE_REQUEST";
export const BITTERY_PASSKEY_CREATE_RESPONSE =
	"BITTERY_PASSKEY_CREATE_RESPONSE";
export const BITTERY_PASSKEY_GET_REQUEST = "BITTERY_PASSKEY_GET_REQUEST";
export const BITTERY_PASSKEY_GET_RESPONSE = "BITTERY_PASSKEY_GET_RESPONSE";
export const BITTERY_PASSKEY_CANCEL_REQUEST = "BITTERY_PASSKEY_CANCEL_REQUEST";

export const PASSKEY_BRIDGE_TIMEOUT_MS = 15_000;

export type SerializedCredentialDescriptor = {
	type: "public-key";
	id: string;
	transports?: AuthenticatorTransport[];
};

export interface SerializedCreationOptions {
	rp: {
		id?: string;
		name: string;
	};
	user: {
		id: string;
		name: string;
		displayName: string;
	};
	challenge: string;
	pubKeyCredParams: PublicKeyCredentialParameters[];
	timeout?: number;
	excludeCredentials?: SerializedCredentialDescriptor[];
	authenticatorSelection?: AuthenticatorSelectionCriteria;
	attestation?: AttestationConveyancePreference;
}

export interface SerializedRequestOptions {
	challenge: string;
	rpId?: string;
	timeout?: number;
	allowCredentials?: SerializedCredentialDescriptor[];
	userVerification?: UserVerificationRequirement;
}

export type PasskeyPageCreatePayload = {
	origin: string;
	mediation?: CredentialMediationRequirement;
	publicKey: SerializedCreationOptions;
	clientDataJSON: string;
	clientDataHash: string;
};

export type PasskeyPageGetPayload = {
	origin: string;
	mediation?: CredentialMediationRequirement;
	publicKey: SerializedRequestOptions;
	clientDataJSON: string;
	clientDataHash: string;
};

export type PasskeyCreateSaveDecision =
	| {
			action: "attach-existing";
			itemId: string;
	  }
	| {
			action: "create-new";
			vaultId?: string;
	  };

export type PasskeyGetPromptOption = {
	credentialId: string;
	itemId: string;
	itemTitle?: string;
	itemUrl?: string;
	serverUrl?: string;
	itemUsername?: string;
	passkeyUserName: string;
	passkeyUserDisplayName?: string;
	vaultName?: string;
	accountEmail?: string;
	createdAt: string;
	lastUsedAt?: string;
};

export type PasskeyCreateExistingItemOption = {
	itemId: string;
	vaultId: string;
	itemTitle?: string;
	itemUrl?: string;
	serverUrl?: string;
	itemUsername?: string;
	vaultName?: string;
	accountEmail?: string;
	lastUsedAt?: string;
};

export type PasskeyWritableVaultOption = {
	id: string;
	name: string;
	accountId: string;
	accountEmail?: string;
	type: "personal" | "team";
	role: "owner" | "admin" | "member" | "read-only";
};

export type PasskeyUserInteractionRequest =
	| {
			kind: "get-picker";
			rpId: string;
			options: PasskeyGetPromptOption[];
	  }
	| {
			kind: "create-save-target";
			rpId: string;
			rpName: string;
			userName: string;
			userDisplayName: string;
			existingItems: PasskeyCreateExistingItemOption[];
			writableVaults: PasskeyWritableVaultOption[];
	  };

type BaseRequestMessage = {
	source: typeof BITTERY_PASSKEY_SOURCE_PAGE;
	requestId: string;
};

type BaseResponseMessage = {
	requestId: string;
};

export type PasskeyPageCreateRequestMessage = BaseRequestMessage & {
	type: typeof BITTERY_PASSKEY_CREATE_REQUEST;
	payload: PasskeyPageCreatePayload;
};

export type PasskeyPageGetRequestMessage = BaseRequestMessage & {
	type: typeof BITTERY_PASSKEY_GET_REQUEST;
	payload: PasskeyPageGetPayload;
};

export type PasskeyPageCancelMessage = BaseRequestMessage & {
	type: typeof BITTERY_PASSKEY_CANCEL_REQUEST;
};

export type PasskeyPageRequestMessage =
	| PasskeyPageCreateRequestMessage
	| PasskeyPageGetRequestMessage
	| PasskeyPageCancelMessage;

export type SerializedCreateResult = {
	kind: "create";
	id: string;
	rawId: string;
	type: PublicKeyCredentialType;
	response: {
		clientDataJSON: string;
		attestationObject: string;
	};
	authenticatorAttachment: AuthenticatorAttachment | null;
};

export type SerializedGetResult = {
	kind: "get";
	id: string;
	rawId: string;
	type: PublicKeyCredentialType;
	response: {
		clientDataJSON: string;
		authenticatorData: string;
		signature: string;
		userHandle?: string | null;
	};
	authenticatorAttachment: AuthenticatorAttachment | null;
};

export type PasskeySerializedResult =
	| SerializedCreateResult
	| SerializedGetResult;

export type PasskeyPageResponseMessage = BaseResponseMessage & {
	type:
		| typeof BITTERY_PASSKEY_CREATE_RESPONSE
		| typeof BITTERY_PASSKEY_GET_RESPONSE;
	success: boolean;
	fallbackToNative?: boolean;
	result?: PasskeySerializedResult;
	error?: string;
};

export type PasskeyBackgroundResponse = {
	success: boolean;
	fallbackToNative?: boolean;
	result?: PasskeySerializedResult;
	error?: string;
	requiresUserInteraction?: PasskeyUserInteractionRequest;
};

export type PasskeyCreateHandlerPayload = PasskeyPageCreatePayload & {
	requestId?: string;
	createDecision?: PasskeyCreateSaveDecision;
};

export type PasskeyGetHandlerPayload = PasskeyPageGetPayload & {
	requestId?: string;
	selectedCredentialId?: string;
};

export function isPasskeyPageRequestMessage(
	value: unknown,
): value is PasskeyPageRequestMessage {
	if (!value || typeof value !== "object") {
		return false;
	}

	const message = value as Partial<PasskeyPageRequestMessage>;
	if (typeof message.type !== "string") {
		return false;
	}
	if (typeof message.requestId !== "string" || message.requestId.length === 0) {
		return false;
	}

	return (
		message.type === BITTERY_PASSKEY_CREATE_REQUEST ||
		message.type === BITTERY_PASSKEY_GET_REQUEST ||
		message.type === BITTERY_PASSKEY_CANCEL_REQUEST
	);
}
