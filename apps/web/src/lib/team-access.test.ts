import assert from "node:assert/strict";
import test from "node:test";
import { getTeamPageAccess } from "./team-access.ts";

test("personal owner stays read-only when team management entitlement is disabled", () => {
	const access = getTeamPageAccess({
		userRole: "owner",
		entitlements: { teamManagement: false },
	});

	assert.deepEqual(access, {
		canEditProfile: true,
		teamManagementEnabled: false,
		canManageTeam: false,
		canViewInvitations: false,
	});
});

test("family or team owner can manage the team when team management entitlement is enabled", () => {
	const access = getTeamPageAccess({
		userRole: "owner",
		entitlements: { teamManagement: true },
	});

	assert.deepEqual(access, {
		canEditProfile: true,
		teamManagementEnabled: true,
		canManageTeam: true,
		canViewInvitations: true,
	});
});

test("team members stay read-only even when the entitlement is enabled", () => {
	const access = getTeamPageAccess({
		userRole: "member",
		entitlements: { teamManagement: true },
	});

	assert.deepEqual(access, {
		canEditProfile: false,
		teamManagementEnabled: true,
		canManageTeam: false,
		canViewInvitations: false,
	});
});

test("self-hosted owners can manage the team when the entitlement is enabled", () => {
	const access = getTeamPageAccess({
		userRole: "owner",
		entitlements: { teamManagement: true },
	});

	assert.deepEqual(access, {
		canEditProfile: true,
		teamManagementEnabled: true,
		canManageTeam: true,
		canViewInvitations: true,
	});
});
