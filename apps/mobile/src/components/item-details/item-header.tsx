import type { ItemCategory } from "@bittery/shared/types";
import type { PopoverTriggerRef } from "heroui-native";
import { Button, Card, Popover } from "heroui-native";
import {
	ArrowLeft,
	Edit,
	History,
	MoreVertical,
	Share2,
	Star,
	Trash2,
} from "lucide-react-native";
import type { RefObject } from "react";
import { View } from "react-native";
import { withUniwind } from "uniwind";
import { getCategoryLabels } from "@/constants/item-categories";
import { useI18n } from "@/providers/i18n-provider";
import { ItemIcon } from "../item-icon";

const StyledArrowLeft = withUniwind(ArrowLeft);
const StyledEdit = withUniwind(Edit);
const StyledHistory = withUniwind(History);
const StyledShare2 = withUniwind(Share2);
const StyledStar = withUniwind(Star);
const StyledMoreVertical = withUniwind(MoreVertical);
const StyledTrash2 = withUniwind(Trash2);

interface ItemHeaderProps {
	item: {
		category: ItemCategory;
		url?: string;
		serverUrl?: string;
		title: string;
		favorite?: boolean;
	};
	vaultId: string;
	onBack: () => void;
	onEdit: () => void;
	onDelete: () => void;
	onShare: () => void;
	onPasswordHistory?: () => void;
	isDeleting: boolean;
	isSharing?: boolean;
	popoverRef: RefObject<PopoverTriggerRef | null>;
}

export function ItemHeader({
	item,
	vaultId: _vaultId,
	onBack,
	onEdit,
	onDelete,
	onShare,
	onPasswordHistory,
	isDeleting,
	isSharing,
	popoverRef,
}: ItemHeaderProps) {
	const { m } = useI18n();
	const categoryLabels = getCategoryLabels(m);

	return (
		<View className="flex-row items-center px-4 py-4">
			<Button
				isIconOnly
				size="sm"
				variant="secondary"
				onPress={onBack}
				className="mr-3"
			>
				<StyledArrowLeft size={20} className="text-muted" />
			</Button>

			<ItemIcon
				category={item.category}
				url={item.url}
				serverUrl={item.serverUrl}
				size="md"
				className="mr-3"
			/>

			<View className="flex-1">
				<View className="flex-row items-center">
					<Card.Title className="text-base">{item.title}</Card.Title>
					{item.favorite && (
						<StyledStar
							size={14}
							fill="#eab308"
							className="ml-2 text-yellow-500"
						/>
					)}
				</View>
				<Card.Description className="text-sm">
					{categoryLabels[item.category]}
				</Card.Description>
			</View>

			<Button
				isIconOnly
				variant="primary"
				size="sm"
				onPress={onEdit}
				className="mr-2"
			>
				<StyledEdit size={18} className="text-accent-foreground" />
			</Button>

			<Popover presentation="popover">
				<Popover.Trigger ref={popoverRef} asChild>
					<Button isIconOnly variant="ghost" size="sm">
						<StyledMoreVertical size={18} className="text-muted" />
					</Button>
				</Popover.Trigger>
				<Popover.Portal>
					<Popover.Overlay />
					<Popover.Content presentation="popover" className="px-0.5 py-1">
						<View className="gap-0 pt-0.5 pb-0.5">
							<Popover.Title className="mb-2 hidden">Actions</Popover.Title>
							<Button
								variant="ghost"
								onPress={() => {
									popoverRef.current?.close();
									onEdit();
								}}
								className="justify-start text-left"
								size="sm"
							>
								<StyledEdit size={18} className="mr-1.5 text-current" />
								<Button.Label>{m.mob_item_header_action_edit()}</Button.Label>
							</Button>
							<Button
								variant="ghost"
								onPress={() => {
									popoverRef.current?.close();
									onShare();
								}}
								isDisabled={isSharing}
								className="justify-start text-left"
								size="sm"
							>
								<StyledShare2 size={18} className="mr-1.5 text-current" />
								<Button.Label>
									{isSharing ? m.mob_item_header_action_share_creating() : m.mob_item_header_action_share()}
								</Button.Label>
							</Button>
							{item.category === "login" && onPasswordHistory && (
								<Button
									variant="ghost"
									onPress={() => {
										popoverRef.current?.close();
										onPasswordHistory();
									}}
									className="justify-start text-left"
									size="sm"
								>
									<StyledHistory size={18} className="mr-1.5 text-current" />
									<Button.Label>{m.mob_item_header_action_password_history()}</Button.Label>
								</Button>
							)}
							<Button
								variant="ghost"
								onPress={onDelete}
								isDisabled={isDeleting}
								className="justify-start text-left"
								size="sm"
							>
								<StyledTrash2 size={18} className="mr-1.5 text-danger" />
								<Button.Label className="text-danger">
									{isDeleting ? m.mob_item_header_action_deleting() : m.mob_item_header_action_delete()}
								</Button.Label>
							</Button>
						</View>
					</Popover.Content>
				</Popover.Portal>
			</Popover>
		</View>
	);
}
