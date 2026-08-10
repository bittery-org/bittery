/**
 * Hook for managing team avatar upload and removal
 */

import { useApiClient } from "@bittery/shared/api";
import { useMutation, useQueryClient } from "@tanstack/react-query";

interface UploadAvatarInput {
	teamId: string;
	file: File;
}

interface RemoveAvatarInput {
	teamId: string;
}

export type TeamAvatarErrorCode =
	| "INVALID_FILE_TYPE"
	| "FILE_TOO_LARGE"
	| "UPLOAD_TO_STORAGE_FAILED";

export class TeamAvatarError extends Error {
	public readonly code: TeamAvatarErrorCode;

	constructor(code: TeamAvatarErrorCode) {
		super(code);
		this.name = "TeamAvatarError";
		this.code = code;
	}
}

export function useTeamAvatar() {
	const apiClient = useApiClient();
	const queryClient = useQueryClient();

	const uploadAvatar = useMutation({
		mutationFn: async ({ teamId, file }: UploadAvatarInput) => {
			// 1. Validate file type
			if (!file.type.startsWith("image/")) {
				throw new TeamAvatarError("INVALID_FILE_TYPE");
			}

			// 2. Validate file size (max 5MB)
			const maxSize = 5 * 1024 * 1024; // 5MB
			if (file.size > maxSize) {
				throw new TeamAvatarError("FILE_TOO_LARGE");
			}

			// 3. Get presigned upload URL from server
			const {
				data: { key, uploadUrl, publicUrl },
			} = await apiClient.teams.createImageUpload(teamId, {
				fileName: file.name,
				contentType: file.type,
			});

			// 4. Upload file to S3
			const uploadResponse = await fetch(uploadUrl, {
				method: "PUT",
				headers: {
					"Content-Type": file.type,
				},
				body: file,
			});

			if (!uploadResponse.ok) {
				throw new TeamAvatarError("UPLOAD_TO_STORAGE_FAILED");
			}

			// 5. Update team with new imageKey
			await apiClient.teams.update(teamId, {
				imageKey: key,
			});

			return { key, publicUrl };
		},
		onSuccess: () => {
			// Invalidate team queries to refetch with new avatar
			queryClient.invalidateQueries({ queryKey: ["team"] });
			// Invalidate auth queries to update account metadata
			queryClient.invalidateQueries({ queryKey: ["auth"] });
		},
	});

	const removeAvatar = useMutation({
		mutationFn: async ({ teamId }: RemoveAvatarInput) => {
			await apiClient.teams.update(teamId, {
				imageKey: null,
			});
		},
		onSuccess: () => {
			// Invalidate team queries to refetch without avatar
			queryClient.invalidateQueries({ queryKey: ["team"] });
			// Invalidate auth queries to update account metadata
			queryClient.invalidateQueries({ queryKey: ["auth"] });
		},
	});

	return {
		uploadAvatar: uploadAvatar.mutateAsync,
		removeAvatar: removeAvatar.mutateAsync,
		isUploading: uploadAvatar.isPending,
		isRemoving: removeAvatar.isPending,
		uploadError: uploadAvatar.error,
		removeError: removeAvatar.error,
	};
}
