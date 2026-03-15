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
	open?: boolean;
	onOpenChange?: (open: boolean) => void;
}

export function ShareHistoryDialog({
	itemId,
	trigger,
	open: controlledOpen,
	onOpenChange: controlledOnOpenChange,
}: ShareHistoryDialogProps) {
	const [internalOpen, setInternalOpen] = useState(false);
	const isControlled = controlledOpen !== undefined;
	const open = isControlled ? controlledOpen : internalOpen;
	const setOpen = isControlled ? (v: boolean) => controlledOnOpenChange?.(v) : setInternalOpen;
	const { m } = useI18n();

	return (
		<Dialog open={open} onOpenChange={setOpen}>
			{!isControlled && (
				<DialogTrigger asChild>
					{trigger || (
						<Button size="sm" variant="outline">
							<History className="mr-2 size-4" />
							{m.sharing_history_dialog_trigger()}
						</Button>
					)}
				</DialogTrigger>
			)}
			<DialogContent className="flex max-h-[80vh] max-w-2xl flex-col overflow-hidden">
				<DialogHeader>
					<DialogTitle>{m.sharing_history_dialog_title()}</DialogTitle>
					<DialogDescription>
						{m.sharing_history_dialog_description()}
					</DialogDescription>
				</DialogHeader>
				<div className="flex-1 overflow-y-auto pr-2">
					<ShareLinksList itemId={itemId} />
				</div>
			</DialogContent>
		</Dialog>
	);
}
