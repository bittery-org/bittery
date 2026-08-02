/**
 * Share Mutation Hooks
 *
 * Single-function hooks for sharing vault items.
 * Each hook returns a React Query mutation - apps handle UI side effects.
 */

export {
	readShareKeyFromUrl,
	SHARE_EXPIRATION_OPTIONS,
} from "../../services/share-service";
export {
	type CreateShareInput,
	type CreateShareResult,
	type ShareAccessMode,
	type ShareExpirationOption,
	useCreateShare,
} from "./use-create-share";
