import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogHeader,
	DialogTitle,
} from "@bittery/ui";
import { ShareLinksList } from "./share-links-list";

interface ShareHistoryDialogProps {
	itemId: string;
	open: boolean;
	onOpenChange: (open: boolean) => void;
}

export function ShareHistoryDialog({
	itemId,
	open,
	onOpenChange,
}: ShareHistoryDialogProps) {
	return (
		<Dialog open={open} onOpenChange={onOpenChange}>
			<DialogContent className="flex max-h-[80vh] max-w-2xl flex-col overflow-hidden">
				<DialogHeader>
					<DialogTitle>Share History</DialogTitle>
					<DialogDescription>
						View and manage all share links created for this item.
					</DialogDescription>
				</DialogHeader>
				<div className="flex-1 overflow-y-auto pr-2">
					<ShareLinksList itemId={itemId} />
				</div>
			</DialogContent>
		</Dialog>
	);
}
