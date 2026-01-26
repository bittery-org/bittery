/**
 * Vault Mutation Hooks
 *
 * Single-function hooks for vault CRUD operations.
 * Each hook returns a React Query mutation - apps handle UI side effects.
 */

export {
	useCreateVault,
	type CreateVaultInput,
	type CreateVaultResult,
} from "./use-create-vault";

export { useUpdateVault, type UpdateVaultInput } from "./use-update-vault";

export { useDeleteVault, type DeleteVaultInput } from "./use-delete-vault";
