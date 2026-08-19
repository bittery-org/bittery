/**
 * Item Mutation Hooks
 *
 * Single-function hooks for vault item CRUD operations.
 * Each hook returns a React Query mutation - apps handle UI side effects.
 */

export {
	type CreateItemInput,
	type CreateItemResult,
	useCreateItem,
} from "./use-create-item";
export { type DeleteItemInput, useDeleteItem } from "./use-delete-item";
export { type MoveItemInput, useMoveItem } from "./use-move-item";
export {
	type PermanentDeleteItemInput,
	usePermanentDeleteItem,
} from "./use-permanent-delete-item";
export { type RestoreItemInput, useRestoreItem } from "./use-restore-item";
export {
	type ToggleFavoriteInput,
	useToggleFavorite,
} from "./use-toggle-favorite";
export { type UpdateItemInput, useUpdateItem } from "./use-update-item";
