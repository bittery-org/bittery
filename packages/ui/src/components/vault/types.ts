export type { CustomField } from "@bittery/shared/types";

export interface VaultOption {
	id: string;
	name: string;
	type: "personal" | "team";
	icon?: string | null;
	imageUrl?: string | null;
	accountId?: string;
	accountEmail?: string;
	accountName?: string;
	accountTeamName?: string;
	accountTeamAvatarUrl?: string | null;
}
