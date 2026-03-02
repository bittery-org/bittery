export interface CategoryMeta {
	slug: string;
	title: string;
	description: string;
	icon: string; // Lucide icon name
	order: number;
}

export const categories: CategoryMeta[] = [
	{
		slug: "getting-started",
		title: "Getting Started",
		description:
			"Set up your account, install Bittery on your devices, and learn the basics.",
		icon: "Rocket",
		order: 1,
	},
	{
		slug: "security",
		title: "Security & Privacy",
		description:
			"How Bittery protects your data with zero-knowledge encryption.",
		icon: "ShieldCheck",
		order: 2,
	},
	{
		slug: "account",
		title: "Account Management",
		description:
			"Manage your profile, devices, passwords, and account settings.",
		icon: "UserCog",
		order: 3,
	},
	{
		slug: "billing",
		title: "Plans & Billing",
		description:
			"Understand pricing plans, manage subscriptions, and billing questions.",
		icon: "CreditCard",
		order: 4,
	},
];

export function getCategoryBySlug(slug: string): CategoryMeta | undefined {
	return categories.find((c) => c.slug === slug);
}
