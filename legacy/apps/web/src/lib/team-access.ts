import type { Entitlements } from "@bittery/shared/billing";

type TeamEntitlements = Partial<Pick<Entitlements, "teamManagement">>;

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
	const teamManagementEnabled = entitlements?.teamManagement === true;
	const canManageTeam = canEditProfile && teamManagementEnabled;

	return {
		canEditProfile,
		teamManagementEnabled,
		canManageTeam,
		canViewInvitations: canManageTeam,
	};
}
