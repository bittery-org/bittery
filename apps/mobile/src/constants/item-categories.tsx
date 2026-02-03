import type { ItemCategory } from "@bittery/shared/types";
import {
	CreditCard,
	FileText,
	Grid3x3,
	Key,
	Timer,
	User,
} from "lucide-react-native";
import type { ComponentType } from "react";
import { withUniwind } from "uniwind";

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
	icon: ComponentType<any>;
}

export const categoryOptions: CategoryOption[] = [
	{ value: "all", label: "All Categories", icon: StyledGrid3x3 },
	{ value: "login", label: "Login", icon: StyledKey },
	{ value: "credit-card", label: "Credit Card", icon: StyledCreditCard },
	{ value: "identity", label: "Identity", icon: StyledUser },
	{ value: "secure-note", label: "Secure Note", icon: StyledFileText },
	{ value: "totp", label: "TOTP", icon: StyledTimer },
];

export const categoryLabels: Record<ItemCategory | "all", string> = {
	all: "All Categories",
	login: "Login",
	"credit-card": "Credit Card",
	identity: "Identity",
	"secure-note": "Secure Note",
	totp: "TOTP",
};

export const categories: (ItemCategory | "all")[] = categoryOptions.map(
	(opt) => opt.value,
);
