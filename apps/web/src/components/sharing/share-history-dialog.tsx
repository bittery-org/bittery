import {
	Button,
	Dialog,
	DialogContent,
	DialogDescription,
	DialogHeader,
	DialogTitle,
	DialogTrigger,
} from "@bittery/ui";
import { IconHistoryOutlineDuo18 as History } from "@bittery/ui/icons";
import { useState } from "react";
import { useI18n } from "@/providers/i18n-provider";
import { ShareLinksList } from "./share-links-list";

interface ShareHistoryDialogProps {
	itemId: string;
	trigger?: React.ReactNode;
}

export function ShareHistoryDialog({
	itemId,
	trigger,
}: ShareHistoryDialogProps) {
	const [open, setOpen] = useState(false);
	const { m } = useI18n();

	return (
		<Dialog open={open} onOpenChange={setOpen}>
			<DialogTrigger asChild>
				{trigger || (
					<Button size="sm" variant="outline">
						<History className="mr-2 size-4" />
						{m["sharing.history_dialog.trigger"]()}
					</Button>
				)}
			</DialogTrigger>
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
