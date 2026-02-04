/**
 * Share Item Sheet
 * Bottom sheet modal for configuring and creating share links on mobile
 */

import {
	buildShareUrl,
	type ShareExpirationOption,
	useCreateShare,
} from "@bittery/hooks";
import type { DecryptedItem } from "@bittery/shared/types";
import { Button, ControlField, Label, Switch, useToast } from "heroui-native";
import { Link, Loader2, Share2, X } from "lucide-react-native";
import { useState } from "react";
import {
	Modal,
	Pressable,
	Share,
	Text,
	TouchableOpacity,
	View,
} from "react-native";
import { withUniwind } from "uniwind";

const StyledLink = withUniwind(Link);
const StyledLoader2 = withUniwind(Loader2);
const StyledShare2 = withUniwind(Share2);
const StyledX = withUniwind(X);

const EXPIRATION_OPTIONS: {
	value: ShareExpirationOption;
	label: string;
}[] = [
	{ value: "1hour", label: "1 hour" },
	{ value: "1day", label: "1 day" },
	{ value: "7days", label: "7 days" },
	{ value: "14days", label: "14 days" },
	{ value: "30days", label: "30 days" },
];

interface ShareItemSheetProps {
	item: DecryptedItem;
	visible: boolean;
	onClose: () => void;
}

export function ShareItemSheet({
	item,
	visible,
	onClose,
}: ShareItemSheetProps) {
	const [expiresIn, setExpiresIn] = useState<ShareExpirationOption>("7days");
	const [isOneTimeUse, setIsOneTimeUse] = useState(false);

	const createShare = useCreateShare();
	const { toast } = useToast();

	const handleCreateAndShare = async () => {
		try {
			const result = await createShare.mutateAsync({
				item,
				accessMode: "anyone",
				expiresIn,
				isOneTimeUse,
			});

			// Build the share URL using the server-provided base URL
			const shareUrl = buildShareUrl(result);

			// Close the sheet
			onClose();

			// Open native share menu
			const shareResult = await Share.share({
				message: shareUrl,
				title: `Share: ${item.title}`,
			});

			if (shareResult.action === Share.sharedAction) {
				toast.show({
					variant: "accent",
					label: "Link shared",
					description: "The secure share link has been shared.",
					placement: "bottom",
				});
			}
		} catch (error) {
			toast.show({
				variant: "danger",
				label: "Failed to create share link",
				description: error instanceof Error ? error.message : "Unknown error",
				placement: "bottom",
			});
		}
	};

	const handleClose = () => {
		if (!createShare.isPending) {
			onClose();
		}
	};

	return (
		<Modal
			visible={visible}
			transparent
			animationType="slide"
			onRequestClose={handleClose}
		>
			<View className="flex-1 justify-end bg-black/50">
				<Pressable className="flex-1" onPress={handleClose} />
				<View className="rounded-t-2xl bg-background px-4 pt-4 pb-8">
					{/* Header */}
					<View className="mb-4 flex-row items-center justify-between">
						<Text className="font-semibold text-foreground text-lg">
							Share Item
						</Text>
						<TouchableOpacity
							onPress={handleClose}
							disabled={createShare.isPending}
						>
							<StyledX size={24} className="text-muted" />
						</TouchableOpacity>
					</View>

					<Text className="mb-4 text-muted text-sm">
						Create a secure link to share "{item.title}"
					</Text>

					{/* Expiration Selection */}
					<View className="mb-4">
						<Text className="mb-2 font-medium text-foreground text-sm">
							Link expires in
						</Text>
						<View className="flex-row flex-wrap gap-2">
							{EXPIRATION_OPTIONS.map((option) => (
								<Button
									key={option.value}
									variant={
										expiresIn === option.value ? "primary" : "secondary"
									}
									size="sm"
									onPress={() => setExpiresIn(option.value)}
								>
									<Button.Label>{option.label}</Button.Label>
								</Button>
							))}
						</View>
					</View>

					{/* One-time use toggle */}
					<ControlField
						isSelected={isOneTimeUse}
						onSelectedChange={setIsOneTimeUse}
						className="mb-4 rounded-lg bg-card py-3"
					>
						<View className="flex-1">
							<Label>One-time use</Label>
							<Text className="text-muted text-xs">
								Link becomes invalid after first access
							</Text>
						</View>
						<ControlField.Indicator>
							<Switch />
						</ControlField.Indicator>
					</ControlField>

					{/* Security notice */}
					<View className="mb-4 flex-row items-start rounded-lg bg-amber-50 p-3 dark:bg-amber-950/30">
						<StyledLink size={16} className="mr-2 mt-0.5 text-amber-600" />
						<Text className="flex-1 text-amber-800 text-xs dark:text-amber-200">
							Anyone with this link can view the item's contents until it
							expires. Share carefully.
						</Text>
					</View>

					{/* Actions */}
					<View className="flex-row gap-3">
						<Button
							variant="secondary"
							className="flex-1"
							onPress={handleClose}
							isDisabled={createShare.isPending}
						>
							<Button.Label>Cancel</Button.Label>
						</Button>
						<Button
							variant="primary"
							className="flex-1"
							onPress={handleCreateAndShare}
							isDisabled={createShare.isPending}
						>
							{createShare.isPending ? (
								<>
									<StyledLoader2
										size={18}
										className="animate-spin text-primary-foreground"
									/>
									<Button.Label>Creating...</Button.Label>
								</>
							) : (
								<>
									<StyledShare2 size={18} className="text-primary-foreground" />
									<Button.Label>Create & Share</Button.Label>
								</>
							)}
						</Button>
					</View>
				</View>
			</View>
		</Modal>
	);
}
