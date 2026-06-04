import type { Entitlements } from "@bittery/shared/billing";

type TeamEntitlements = Partial<Pick<Entitlements, "team_management">> & {
	teamManagement?: boolean;
};

interface GetTeamPageAccessInput {
	userRole?: string | null;
	entitlements?: TeamEntitlements | null;
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
	const teamManagementEnabled =
		entitlements?.team_management === true ||
		entitlements?.teamManagement === true;
	const canManageTeam = canEditProfile && teamManagementEnabled;

	return {
		canEditProfile,
		teamManagementEnabled,
		canManageTeam,
		canViewInvitations: canManageTeam,
	};
}
