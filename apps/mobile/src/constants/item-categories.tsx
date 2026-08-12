import type { ItemCategory } from "@bittery/shared/types";
import {
	CreditCard,
	FileText,
	Grid3x3,
	Key,
	Timer,
	User,
} from "lucide-react-native";
import { withUniwind } from "uniwind";
import type { AppIcon } from "@/components/ui";
import type { useI18n } from "@/providers/i18n-provider";

type MessageCatalog = ReturnType<typeof useI18n>["m"];

// Create styled icon components
const StyledGrid3x3 = withUniwind(Grid3x3);
const StyledKey = withUniwind(Key);
const StyledCreditCard = withUniwind(CreditCard);
const StyledUser = withUniwind(User);
const StyledFileText = withUniwind(FileText);
const StyledTimer = withUniwind(Timer);

export interface CategoryOption {
	value: ItemCategory | "all";
	label: string;
	icon: AppIcon;
}

export function getCategoryOptions(m: MessageCatalog): CategoryOption[] {
	return [
		{ value: "all", label: m.mob_category_all(), icon: StyledGrid3x3 },
		{ value: "login", label: m.mob_category_login(), icon: StyledKey },
		{
			value: "credit-card",
			label: m.mob_category_credit_card(),
			icon: StyledCreditCard,
		},
		{ value: "identity", label: m.mob_category_identity(), icon: StyledUser },
		{
			value: "secure-note",
			label: m.mob_category_secure_note(),
			icon: StyledFileText,
		},
		{ value: "totp", label: m.mob_category_totp(), icon: StyledTimer },
	];
}

export function getCategoryLabels(
	m: MessageCatalog,
): Record<ItemCategory | "all", string> {
	return {
		all: m.mob_category_all(),
		login: m.mob_category_login(),
		"credit-card": m.mob_category_credit_card(),
		identity: m.mob_category_identity(),
		"secure-note": m.mob_category_secure_note(),
		totp: m.mob_category_totp(),
	};
}

export const categories: (ItemCategory | "all")[] = [
	"all",
	"login",
	"credit-card",
	"identity",
	"secure-note",
	"totp",
];
