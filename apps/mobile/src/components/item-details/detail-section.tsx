import { View } from "react-native";
import { SectionLabel } from "@/components/ui";

/**
 * One labelled block of the item-detail scroll view. The spacing between
 * sections comes from the screen's gap, never from margins on the cards.
 */
export function DetailSection({
	title,
	action,
	children,
}: {
	title?: string;
	/** Right-aligned control on the section label, e.g. "Attach". */
	action?: React.ReactNode;
	children: React.ReactNode;
}) {
	return (
		<View>
			{title ? <SectionLabel trailing={action}>{title}</SectionLabel> : null}
			{children}
		</View>
	);
}
