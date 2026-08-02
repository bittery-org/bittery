/**
 * Share Mutation Hooks
 *
 * Single-function hooks for sharing vault items.
 * Each hook returns a React Query mutation - apps handle UI side effects.
 */

export {
	type CreateShareInput,
	type CreateShareResult,
	useCreateShare,
} from "./use-create-share";
