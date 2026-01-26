/**
 * Item Mutation Hooks
 *
 * Single-function hooks for vault item CRUD operations.
 * Each hook returns a React Query mutation - apps handle UI side effects.
 */

export {
	useCreateItem,
	type CreateItemInput,
	type CreateItemResult,
} from "./use-create-item";

export { useUpdateItem, type UpdateItemInput } from "./use-update-item";

export { useDeleteItem, type DeleteItemInput } from "./use-delete-item";

export {
	useToggleFavorite,
	type ToggleFavoriteInput,
} from "./use-toggle-favorite";

export { useMoveItem, type MoveItemInput } from "./use-move-item";

export { useRestoreItem, type RestoreItemInput } from "./use-restore-item";

export {
	usePermanentDeleteItem,
	type PermanentDeleteItemInput,
} from "./use-permanent-delete-item";
