import { stripToDecryptedData } from "@bittery/shared/item-mapping";
import type {
	DecryptedItem,
	DecryptedItemData,
	DecryptedItemWithContext,
} from "@bittery/shared/types";
import type { DragItemData } from "@bittery/ui";

/** Desktop's current drag producer reads the full legacy repository Item. */
export type DesktopPrivateDragItemData = Omit<DragItemData, "item"> & {
	item: DecryptedItemWithContext;
};

/** The legacy Move command still needs private credentials until ticket 72 migrates it. */
export function privateMoveData(item: DecryptedItem): DecryptedItemData {
	return stripToDecryptedData(item);
}
