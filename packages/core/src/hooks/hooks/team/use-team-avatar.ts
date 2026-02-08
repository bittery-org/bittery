/**
 * Hook for managing team avatar upload and removal
 */

import { useTRPCClient } from "@bittery/shared/trpc";
import { useMutation, useQueryClient } from "@tanstack/react-query";

interface UploadAvatarInput {
	teamId: string;
	file: File;
}

interface RemoveAvatarInput {
	teamId: string;
}

export function useTeamAvatar() {
	const trpcClient = useTRPCClient();
	const queryClient = useQueryClient();

	const uploadAvatar = useMutation({
		mutationFn: async ({ teamId, file }: UploadAvatarInput) => {
			// 1. Validate file type
			if (!file.type.startsWith("image/")) {
				throw new Error("Only image files are allowed");
			}

			// 2. Validate file size (max 5MB)
			const maxSize = 5 * 1024 * 1024; // 5MB
			if (file.size > maxSize) {
				throw new Error("File size must be less than 5MB");
			}

			// 3. Get presigned upload URL from server
			const { key, uploadUrl, publicUrl } =
				await trpcClient.team.createImageUpload.mutate({
					teamId,
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
				throw new Error("Failed to upload image to storage");
			}

			// 5. Update team with new imageKey
			await trpcClient.team.update.mutate({
				teamId,
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
			await trpcClient.team.update.mutate({
				teamId,
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
