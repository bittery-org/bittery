/**
 * Share Mutation Hooks
 *
 * Single-function hooks for sharing vault items.
 * Each hook returns a React Query mutation - apps handle UI side effects.
 */

export {
	useCreateShare,
	type CreateShareInput,
	type CreateShareResult,
	type ShareExpirationOption,
	type ShareAccessMode,
} from "./use-create-share";
