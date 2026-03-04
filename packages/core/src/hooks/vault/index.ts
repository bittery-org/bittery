/**
 * Vault Mutation Hooks
 *
 * Single-function hooks for vault CRUD operations.
 * Each hook returns a React Query mutation - apps handle UI side effects.
 */

export {
	type ConvertVaultTypeInput,
	type ConvertVaultTypeResult,
	useConvertVaultType,
} from "./use-convert-vault-type";
export {
	type CreateVaultInput,
	type CreateVaultResult,
	useCreateVault,
} from "./use-create-vault";
export { type DeleteVaultInput, useDeleteVault } from "./use-delete-vault";
export { type UpdateVaultInput, useUpdateVault } from "./use-update-vault";
