import { z } from "zod";

const UUID_REGEX =
	/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const RESOURCE_NANOID_REGEX = /^[A-Za-z0-9_-]{10,64}$/;
const SESSION_ID_REGEX = /^[a-f0-9]{64}$/;
const LOGIN_ATTEMPT_ID_REGEX = /^[a-f0-9]{64}:[A-Za-z0-9_-]{1,64}$/;
const CLIENT_ID_REGEX = /^[A-Za-z0-9_-]{1,64}$/;
const NANOID_32_REGEX = /^[A-Za-z0-9_-]{32}$/;
const HEX_REGEX = /^[a-f0-9]+$/i;

export const MAX_ENCRYPTED_ITEM_CIPHERTEXT_LENGTH = 524_288;
export const MAX_ENCRYPTED_ENVELOPE_STRING_LENGTH = 131_072;
export const MAX_WRAPPED_KEY_LENGTH = 131_072;
export const MAX_IV_LENGTH = 256;
export const MAX_RSA_PUBLIC_KEY_LENGTH = 8_192;
export const MAX_TOKEN_LENGTH = 2_048;
export const MAX_HINT_LENGTH = 64;

export const algorithmSchema = z
	.string()
	.refine((value) => value === "AES-GCM-AAD-V1", "Unsupported algorithm");

export const resourceIdSchema = z
	.string()
	.max(64)
	.refine(
		(value) => UUID_REGEX.test(value) || RESOURCE_NANOID_REGEX.test(value),
		"Invalid resource ID",
	);

export const sessionIdSchema = z
	.string()
	.regex(SESSION_ID_REGEX, "Invalid session ID");

export const loginAttemptIdSchema = z
	.string()
	.regex(LOGIN_ATTEMPT_ID_REGEX, "Invalid login attempt ID");

export const clientIdSchema = z
	.string()
	.regex(CLIENT_ID_REGEX, "Invalid client ID");

export const opaqueTokenSchema = z.string().min(1).max(MAX_TOKEN_LENGTH);

export const nanoid32TokenSchema = z
	.string()
	.regex(NANOID_32_REGEX, "Invalid token");

export const srpSaltSchema = z
	.string()
	.length(64)
	.regex(HEX_REGEX, "Invalid SRP salt");

export const srpVerifierSchema = z
	.string()
	.min(256)
	.max(1_024)
	.regex(HEX_REGEX, "Invalid SRP verifier");

export const srpClientPublicKeySchema = z
	.string()
	.min(1)
	.max(2_048)
	.regex(HEX_REGEX, "Invalid SRP client public key");

export const srpClientProofSchema = z
	.string()
	.min(1)
	.max(512)
	.regex(HEX_REGEX, "Invalid SRP client proof");

export const encryptedItemCiphertextSchema = z
	.string()
	.min(1)
	.max(MAX_ENCRYPTED_ITEM_CIPHERTEXT_LENGTH);

const encryptedEnvelopeShapeSchema = z
	.object({
		ciphertext: z.string().min(1).max(MAX_ENCRYPTED_ENVELOPE_STRING_LENGTH),
		iv: z.string().min(1).max(MAX_IV_LENGTH),
		algorithm: algorithmSchema,
	})
	.strict();

export const encryptedEnvelopeStringSchema = z
	.string()
	.min(1)
	.max(MAX_ENCRYPTED_ENVELOPE_STRING_LENGTH)
	.superRefine((value, ctx) => {
		try {
			const parsed = JSON.parse(value);
			const result = encryptedEnvelopeShapeSchema.safeParse(parsed);
			if (!result.success) {
				ctx.addIssue({
					code: "custom",
					message: "Invalid encrypted envelope",
				});
			}
		} catch {
			ctx.addIssue({
				code: "custom",
				message: "Invalid encrypted envelope",
			});
		}
	});

export const wrappedKeySchema = z.string().min(1).max(MAX_WRAPPED_KEY_LENGTH);

export const ivSchema = z.string().min(1).max(MAX_IV_LENGTH);

export const rsaPublicKeySchema = z
	.string()
	.min(1)
	.max(MAX_RSA_PUBLIC_KEY_LENGTH);

export const secretKeyHintSchema = z.string().min(1).max(MAX_HINT_LENGTH);

export const recoveryKeyHintSchema = z.string().min(1).max(MAX_HINT_LENGTH);

export const shareEmailsSchema = z.array(z.string().email()).max(100);
export const syncVaultIdsSchema = z.array(resourceIdSchema).max(200);
export const syncEventIdsSchema = z.array(resourceIdSchema).max(500);

export const encryptedVaultKeyInputSchema = z
	.object({
		vaultId: resourceIdSchema,
		encryptedVaultKey: wrappedKeySchema,
	})
	.strict();

export const encryptedVaultKeysSchema = z
	.array(encryptedVaultKeyInputSchema)
	.max(200);

export const rotationMemberKeySchema = z
	.object({
		userId: resourceIdSchema,
		encryptedVaultKey: wrappedKeySchema,
	})
	.strict();

export const rotationReEncryptedItemSchema = z
	.object({
		itemId: resourceIdSchema,
		encryptedData: encryptedItemCiphertextSchema,
		encryptionIv: ivSchema,
		encryptionAlgorithm: algorithmSchema.default("AES-GCM-AAD-V1"),
	})
	.strict();

export const rotationMemberKeysSchema = z
	.array(rotationMemberKeySchema)
	.max(100);
export const rotationItemsSchema = z
	.array(rotationReEncryptedItemSchema)
	.max(100);

export const rotationVaultSchema = z
	.object({
		vaultId: resourceIdSchema,
		keyRotation: z
			.object({
				memberKeys: rotationMemberKeysSchema,
				reEncryptedItems: rotationItemsSchema,
			})
			.strict(),
	})
	.strict();

export const rotationVaultsSchema = z.array(rotationVaultSchema).max(100);

export const bulkImportItemSchema = z
	.object({
		itemId: resourceIdSchema,
		category: z.enum([
			"login",
			"secure-note",
			"credit-card",
			"identity",
			"totp",
		]),
		favorite: z.boolean().optional(),
		encryptedData: encryptedItemCiphertextSchema,
		encryptionIv: ivSchema,
		encryptionAlgorithm: algorithmSchema.default("AES-GCM-AAD-V1"),
	})
	.strict();

export const bulkImportItemsSchema = z.array(bulkImportItemSchema).max(200);
