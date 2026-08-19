import type { ApiClient } from "@bittery/api-contract";

export const apiQueryKeys = {
	auth: {
		registrationStatus: ["api", "v1", "auth", "registration-status"] as const,
		me: ["api", "v1", "users", "me"] as const,
		sessions: ["api", "v1", "sessions"] as const,
	},
	vaults: {
		list: ["api", "v1", "vaults"] as const,
		stats: ["api", "v1", "vault-stats"] as const,
		members: (vaultId: string) =>
			["api", "v1", "vaults", vaultId, "members"] as const,
		availableMembers: (vaultId: string) =>
			["api", "v1", "vaults", vaultId, "available-team-members"] as const,
	},
	items: {
		all: ["api", "v1", "items"] as const,
		get: (itemId: string) => ["api", "v1", "items", itemId] as const,
		inVault: (vaultId: string) =>
			["api", "v1", "vaults", vaultId, "items"] as const,
		trashed: ["api", "v1", "trashed-items"] as const,
		trashedInVault: (vaultId: string) =>
			["api", "v1", "vaults", vaultId, "trashed-items"] as const,
	},
	teams: {
		all: ["api", "v1", "teams"] as const,
		current: ["api", "v1", "teams", "current"] as const,
		details: (teamId: string) => ["api", "v1", "teams", teamId] as const,
		members: (teamId: string) =>
			["api", "v1", "teams", teamId, "members"] as const,
		invitations: (teamId: string) =>
			["api", "v1", "teams", teamId, "invitations"] as const,
		pendingInvitations: ["api", "v1", "invitations", "mine"] as const,
		vaults: (teamId: string) =>
			["api", "v1", "teams", teamId, "vaults"] as const,
		memberAccess: (teamId: string, userId: string) =>
			["api", "v1", "teams", teamId, "members", userId, "access"] as const,
	},
	billing: {
		entitlements: ["api", "v1", "billing", "entitlements"] as const,
		status: ["api", "v1", "billing", "status"] as const,
		attachmentUsage: ["api", "v1", "billing", "attachment-usage"] as const,
	},
	travelMode: ["api", "v1", "travel-mode"] as const,
	shares: {
		list: (itemId: string) =>
			["api", "v1", "items", itemId, "share-links"] as const,
		accessLogs: (linkId: string) =>
			["api", "v1", "share-links", linkId, "access-logs"] as const,
		public: (token: string) =>
			["api", "v1", "public", "share-links", token] as const,
	},
	audit: {
		all: ["api", "v1", "audit-events"] as const,
	},
};

export const apiQueries = {
	auth: {
		registrationStatus: (api: ApiClient) => ({
			queryKey: apiQueryKeys.auth.registrationStatus,
			queryFn: async () => (await api.auth.registrationStatus()).data,
		}),
		me: (api: ApiClient) => ({
			queryKey: apiQueryKeys.auth.me,
			queryFn: async () => (await api.auth.me()).data,
		}),
		sessions: (api: ApiClient) => ({
			queryKey: apiQueryKeys.auth.sessions,
			queryFn: async () => (await api.auth.sessions.list()).data,
		}),
	},
	vaults: {
		list: (api: ApiClient) => ({
			queryKey: apiQueryKeys.vaults.list,
			queryFn: async () => (await api.vaults.list()).data,
		}),
		stats: (api: ApiClient) => ({
			queryKey: apiQueryKeys.vaults.stats,
			queryFn: async () => (await api.vaults.stats()).data,
		}),
		members: (api: ApiClient, vaultId: string) => ({
			queryKey: apiQueryKeys.vaults.members(vaultId),
			queryFn: async () => (await api.vaults.members.list(vaultId)).data,
		}),
		availableMembers: (api: ApiClient, vaultId: string) => ({
			queryKey: apiQueryKeys.vaults.availableMembers(vaultId),
			queryFn: async () =>
				(await api.teams.availableMembersForVault(vaultId)).data,
		}),
	},
	teams: {
		current: (api: ApiClient) => ({
			queryKey: apiQueryKeys.teams.current,
			queryFn: async () => (await api.teams.current()).data,
		}),
		details: (api: ApiClient, teamId: string) => ({
			queryKey: apiQueryKeys.teams.details(teamId),
			queryFn: async () => (await api.teams.get(teamId)).data,
		}),
		members: (api: ApiClient, teamId: string) => ({
			queryKey: apiQueryKeys.teams.members(teamId),
			queryFn: async () => (await api.teams.members.list(teamId)).data,
		}),
		invitations: (api: ApiClient, teamId: string) => ({
			queryKey: apiQueryKeys.teams.invitations(teamId),
			queryFn: async () => (await api.teams.invitations.list(teamId)).data,
		}),
		pendingInvitations: (api: ApiClient) => ({
			queryKey: apiQueryKeys.teams.pendingInvitations,
			queryFn: async () => (await api.teams.invitations.mine()).data,
		}),
		vaults: (api: ApiClient, teamId: string) => ({
			queryKey: apiQueryKeys.teams.vaults(teamId),
			queryFn: async () => (await api.teams.vaults(teamId)).data,
		}),
		memberAccess: (api: ApiClient, teamId: string, userId: string) => ({
			queryKey: apiQueryKeys.teams.memberAccess(teamId, userId),
			queryFn: async () =>
				(await api.teams.members.access(teamId, userId)).data,
		}),
	},
	billing: {
		entitlements: (api: ApiClient) => ({
			queryKey: apiQueryKeys.billing.entitlements,
			queryFn: async () => (await api.billing.entitlements()).data,
		}),
		status: (api: ApiClient) => ({
			queryKey: apiQueryKeys.billing.status,
			queryFn: async () => (await api.billing.status()).data,
		}),
		attachmentUsage: (api: ApiClient) => ({
			queryKey: apiQueryKeys.billing.attachmentUsage,
			queryFn: async () => (await api.billing.attachmentUsage()).data,
		}),
	},
	shares: {
		list: (api: ApiClient, itemId: string) => ({
			queryKey: apiQueryKeys.shares.list(itemId),
			queryFn: async () => (await api.share.list(itemId)).data,
		}),
		accessLogs: (api: ApiClient, linkId: string) => ({
			queryKey: apiQueryKeys.shares.accessLogs(linkId),
			queryFn: async () => (await api.share.accessLogs(linkId)).data,
		}),
		public: (api: ApiClient, token: string) => ({
			queryKey: apiQueryKeys.shares.public(token),
			queryFn: async () => (await api.share.public(token)).data,
		}),
	},
};
