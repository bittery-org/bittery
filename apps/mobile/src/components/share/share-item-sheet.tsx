/**
 * Share Item Sheet
 * Bottom sheet modal for configuring and creating share links on mobile
 */

import {
	buildShareUrl,
	type ShareExpirationOption,
	useCreateShare,
} from "@bittery/core/hooks";
import type { DecryptedItem } from "@bittery/shared/types";
import { Button, ControlField, Label, Switch, useToast } from "heroui-native";
import { Link, Loader2, Share2, X } from "lucide-react-native";
import { useMemo, useState } from "react";
import {
	Modal,
	Pressable,
	Share,
	Text,
	TouchableOpacity,
	View,
} from "react-native";
import { withUniwind } from "uniwind";

import { useI18n } from "@/providers/i18n-provider";

const StyledLink = withUniwind(Link);
const StyledLoader2 = withUniwind(Loader2);
const StyledShare2 = withUniwind(Share2);
const StyledX = withUniwind(X);

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
	const { m } = useI18n();
	const [expiresIn, setExpiresIn] = useState<ShareExpirationOption>("7days");
	const [isOneTimeUse, setIsOneTimeUse] = useState(false);

	const createShare = useCreateShare();
	const { toast } = useToast();

	const EXPIRATION_OPTIONS = useMemo(
		() => [
			{ value: "1hour" as ShareExpirationOption, label: m.mob_share_expiry_1hour() },
			{ value: "1day" as ShareExpirationOption, label: m.mob_share_expiry_1day() },
			{ value: "7days" as ShareExpirationOption, label: m.mob_share_expiry_7days() },
			{ value: "14days" as ShareExpirationOption, label: m.mob_share_expiry_14days() },
			{ value: "30days" as ShareExpirationOption, label: m.mob_share_expiry_30days() },
		],
		[m],
	);

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
				title: `${m.mob_share_title()}: ${item.title}`,
			});

			if (shareResult.action === Share.sharedAction) {
				toast.show({
					variant: "accent",
					label: m.mob_share_toast_shared(),
					description: m.mob_share_toast_shared_description(),
					placement: "bottom",
				});
			}
		} catch (error) {
			toast.show({
				variant: "danger",
				label: m.mob_share_toast_failed(),
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
							{m.mob_share_title()}
						</Text>
						<TouchableOpacity
							onPress={handleClose}
							disabled={createShare.isPending}
						>
							<StyledX size={24} className="text-muted" />
						</TouchableOpacity>
					</View>

					<Text className="mb-4 text-muted text-sm">
						{m.mob_share_description({ title: item.title })}
					</Text>

					{/* Expiration Selection */}
					<View className="mb-4">
						<Text className="mb-2 font-medium text-foreground text-sm">
							{m.mob_share_expires_label()}
						</Text>
						<View className="flex-row flex-wrap gap-2">
							{EXPIRATION_OPTIONS.map((option) => (
								<Button
									key={option.value}
									variant={expiresIn === option.value ? "primary" : "secondary"}
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
							<Label>{m.mob_share_one_time_use()}</Label>
							<Text className="text-muted text-xs">
								{m.mob_share_one_time_use_description()}
							</Text>
						</View>
						<ControlField.Indicator>
							<Switch />
						</ControlField.Indicator>
					</ControlField>

					{/* Security notice */}
					<View className="mb-4 flex-row items-start rounded-lg bg-amber-50 p-3 dark:bg-amber-950/30">
						<StyledLink size={16} className="mt-0.5 mr-2 text-amber-600" />
						<Text className="flex-1 text-amber-800 text-xs dark:text-amber-200">
							{m.mob_share_security_notice()}
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
							<Button.Label>{m.mob_share_cancel()}</Button.Label>
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
									<Button.Label>{m.mob_share_creating()}</Button.Label>
								</>
							) : (
								<>
									<StyledShare2 size={18} className="text-primary-foreground" />
									<Button.Label>{m.mob_share_create_button()}</Button.Label>
								</>
							)}
						</Button>
					</View>
				</View>
			</View>
		</Modal>
	);
}
