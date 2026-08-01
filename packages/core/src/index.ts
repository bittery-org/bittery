export {
	type CoreContext,
	type CreateCoreContextOptions,
	createCoreContext,
} from "./core-context";
export {
	type ResolvedAccountRepository,
	resolveRepositoryForItem,
	resolveRepositoryForVault,
} from "./services/account-context-resolver";
export {
	type AccountInfo,
	AccountResolver,
	createStoredAccountRpcClient,
	type DefaultRpcClient,
	findAccountForItem,
	getClientForAccount,
	getItemAccountEmail,
	type ItemWithOptionalAccount,
	type ResolveAccountsResult,
} from "./services/account-resolver";
export {
	type BiometricUnlockAvailability,
	type CheckEmailResult,
	checkEmailExists,
	clearSession,
	deriveSrpLoginProof,
	type FinishLoginResponse,
	getBiometricUnlockAvailability,
	getSessionState,
	type IAuthClient,
	type LoginResult,
	type LoginUserData,
	performSRPLogin,
	performSRPUnlock,
	type SessionState,
	type SRPLoginDeps,
	type SRPLoginInput,
	type SRPUnlockDeps,
	type SRPUnlockInput,
	type SrpLoginProof,
	type StartLoginResponse,
	type StoreAuthSessionOptions,
	storeLoginSession,
	storeUnlockSession,
	type UnlockResult,
} from "./services/auth-service";
export {
	type CreateItemInput,
	type CreateItemResult,
	type FetchDecryptedItemResult,
	ItemService,
	type MoveItemInput,
	type MoveItemResult,
	type MultiAccountDeletedItem,
	type MultiAccountItem,
	type RawEncryptedItem,
	type RawEncryptedItemWithVault,
	type UpdateItemInput,
	type UpdateItemResult,
} from "./services/item-service";
export {
	buildShareUrl,
	type CreateShareInput,
	type CreateShareResult,
	type ShareAccessMode,
	type ShareExpirationOption,
	ShareService,
} from "./services/share-service";
export {
	filterItemsByTravelMode,
	filterVaultKeys,
	isVaultHidden,
	type TravelModeRpcClient,
	type TravelModeServerResponse,
} from "./services/travel-mode-service";
export {
	handleTravelModeSyncEvent,
	restoreAfterTravelModeDisabled,
	type TravelModeSyncRestoreOptions,
} from "./services/travel-mode-sync";
export {
	type PasswordUnlockDeps,
	type UnlockDeps,
	type UnlockFailure,
	type UnlockFailureReason,
	type UnlockOptions,
	type UnlockOutcome,
	unlockAccountWithBiometric,
	unlockAccountWithPassword,
	unlockAllWithBiometric,
	unlockAllWithPassword,
} from "./services/unlock";
export {
	type BootstrapItemsClient,
	type EncryptedPayload as RepositoryEncryptedPayload,
	VaultRepository,
	type VaultRepositoryItem,
	type VaultView,
} from "./services/vault-repository";
export {
	type CoordinatedItem,
	getOrCreateVaultRepositoryCoordinator,
	VaultRepositoryCoordinator,
} from "./services/vault-repository-coordinator";
export {
	type ConvertVaultTypeInput,
	type ConvertVaultTypeResult,
	type CreateVaultInput,
	type CreateVaultResult,
	type ImageFileInput,
	type RpcVaultClient,
	refreshVaultKeys,
	type TRPCVaultClient,
	type UpdateVaultInput,
	type VaultListItem,
	VaultService,
} from "./services/vault-service";
export type {
	DerivedKeys,
	ICrypto,
	SRPClientEphemeral,
	SRPClientSession,
	SRPServerChallenge,
} from "./types";
