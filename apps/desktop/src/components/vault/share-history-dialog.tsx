import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogHeader,
	DialogTitle,
} from "@bittery/ui";
import { useI18n } from "../../providers/i18n-provider";
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
	const { m } = useI18n();

	return (
		<Dialog open={open} onOpenChange={onOpenChange}>
			<DialogContent className="flex max-h-[80vh] max-w-2xl flex-col overflow-hidden">
				<DialogHeader>
					<DialogTitle>{m["sharing.history_dialog.title"]()}</DialogTitle>
					<DialogDescription>
						{m["sharing.history_dialog.description"]()}
					</DialogDescription>
				</DialogHeader>
				<div className="flex-1 overflow-y-auto pr-2">
					<ShareLinksList itemId={itemId} />
				</div>
			</DialogContent>
		</Dialog>
	);
}
