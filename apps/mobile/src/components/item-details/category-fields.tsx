import type { ItemCategory } from "@bittery/shared/types";
import type { ComponentType } from "react";
import { CreditCardFields } from "./credit-card-fields";
import { IdentityFields } from "./identity-fields";
import { LoginFields } from "./login-fields";
import { SecureNoteFields } from "./secure-note-fields";
import { TotpFields } from "./totp-fields";
import type { ItemDetailProps } from "./types";

interface CategoryFieldsProps extends ItemDetailProps {
	category: ItemCategory;
}

const categoryComponentMap: Record<
	ItemCategory,
	ComponentType<ItemDetailProps>
> = {
	login: LoginFields,
	"credit-card": CreditCardFields,
	identity: IdentityFields,
	"secure-note": SecureNoteFields,
	totp: TotpFields,
};

export function CategoryFields({
	category,
	item,
	onCopy,
}: CategoryFieldsProps) {
	const Component = categoryComponentMap[category];
	return Component ? <Component item={item} onCopy={onCopy} /> : null;
}
