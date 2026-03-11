import type { Entitlements } from "@bittery/api/billing/entitlements";

interface GetTeamPageAccessInput {
	userRole?: string | null;
	entitlements?: Partial<Pick<Entitlements, "team_management">> | null;
}

export interface TeamPageAccess {
	canEditProfile: boolean;
	teamManagementEnabled: boolean;
	canManageTeam: boolean;
	canViewInvitations: boolean;
}

export function getTeamPageAccess({
	userRole,
	entitlements,
}: GetTeamPageAccessInput): TeamPageAccess {
	const canEditProfile = userRole === "owner" || userRole === "admin";
	const teamManagementEnabled = entitlements?.team_management === true;
	const canManageTeam = canEditProfile && teamManagementEnabled;

	return {
		canEditProfile,
		teamManagementEnabled,
		canManageTeam,
		canViewInvitations: canManageTeam,
	};
}
