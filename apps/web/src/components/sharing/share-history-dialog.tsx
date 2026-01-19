import {
	Button,
	Dialog,
	DialogContent,
	DialogDescription,
	DialogHeader,
	DialogTitle,
	DialogTrigger,
} from "@bittery/ui";
import { History } from "lucide-react";
import { useState } from "react";
import { ShareLinksList } from "./share-links-list";

interface ShareHistoryDialogProps {
	itemId: string;
	trigger?: React.ReactNode;
}

export function ShareHistoryDialog({ itemId, trigger }: ShareHistoryDialogProps) {
	const [open, setOpen] = useState(false);

	return (
		<Dialog open={open} onOpenChange={setOpen}>
			<DialogTrigger asChild>
				{trigger || (
					<Button size="sm" variant="outline">
						<History className="mr-2 size-4" />
						Share History
					</Button>
				)}
			</DialogTrigger>
			<DialogContent className="max-w-2xl max-h-[80vh] overflow-hidden flex flex-col">
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
