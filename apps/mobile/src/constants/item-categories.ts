import type { ItemCategory } from "@bittery/shared/types";

export const categoryLabels: Record<ItemCategory | "all", string> = {
	all: "All",
	login: "Login",
	"credit-card": "Card",
	identity: "Identity",
	"secure-note": "Note",
	totp: "TOTP",
};

export const categories: (ItemCategory | "all")[] = [
	"all",
	"login",
	"credit-card",
	"identity",
	"secure-note",
	"totp",
];
