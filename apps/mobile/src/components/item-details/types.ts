import type { AppIcon } from "@/components/ui";

export interface ItemDetailProps {
	item: any; // Will be typed from useVaultItems
	onCopy: (value: string, label: string) => Promise<void>;
}

/**
 * One value on an item as the detail view shows it. Groups are built from
 * arrays of these, so a field with no value simply never reaches the card and
 * the hairline dividers stay correct.
 */
export interface FieldDefinition {
	/** Stable within its group; also keys the reveal state. */
	key: string;
	label: string;
	value: string | undefined;
	icon?: AppIcon;
	/** Hides the value behind dots until the reveal action is used. */
	masked?: boolean;
	mono?: boolean;
	/** Lets the value wrap instead of truncating — notes and addresses. */
	multiline?: boolean;
	/** Small neutral chip after the label, e.g. a detected card brand. */
	badge?: string;
	/** Shown instead of the raw value once revealed, e.g. a grouped card number. */
	formattedValue?: string;
}
