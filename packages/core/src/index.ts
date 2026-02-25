export {
	type CoreContext,
	type CreateCoreContextOptions,
	createCoreContext,
} from "./core-context";
export {
	type AccountInfo,
	AccountResolver,
	type DefaultTrpcClient,
	findAccountForItem,
	getClientForAccount,
	getItemAccountEmail,
	type ItemWithOptionalAccount,
	type ResolveAccountsResult,
} from "./services/account-resolver";
export {
	type CheckEmailResult,
	checkEmailExists,
	clearSession,
	type FinishLoginResponse,
	getSessionState,
	type IAuthTRPCClient,
	type LoginResult,
	type LoginUserData,
	performSRPLogin,
	performSRPUnlock,
	type SessionState,
	type SRPLoginDeps,
	type SRPLoginInput,
	type SRPUnlockDeps,
	type SRPUnlockInput,
	type StartLoginResponse,
	storeLoginSession,
	storeUnlockSession,
	type UnlockResult,
} from "./services/auth-service";
export {
	type CreateItemInput,
	type CreateItemResult,
	type FetchDecryptedItemResult,
	type FetchDeletedItemsOptions,
	type FetchItemsOptions,
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
	type CreateVaultInput,
	type CreateVaultResult,
	type ImageFileInput,
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
