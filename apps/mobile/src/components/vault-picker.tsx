import { useQuery } from "@tanstack/react-query";
import { Shield, Users, X } from "lucide-react-native";
import {
	ActivityIndicator,
	Modal,
	Pressable,
	Text,
	TouchableOpacity,
	View,
} from "react-native";

import { useTRPC } from "../lib/trpc";

interface VaultPickerProps {
	visible: boolean;
	onClose: () => void;
	onSelect: (vaultId: string) => void;
}

export function VaultPicker({ visible, onClose, onSelect }: VaultPickerProps) {
	const trpc = useTRPC();
	const { data: vaults, isLoading } = useQuery(trpc.vault.list.queryOptions());

	return (
		<Modal
			visible={visible}
			transparent
			animationType="slide"
			onRequestClose={onClose}
		>
			<Pressable className="flex-1 justify-end bg-black/50" onPress={onClose}>
				<Pressable
					className="rounded-t-3xl bg-background pb-8"
					onPress={(e) => e.stopPropagation()}
				>
					{/* Handle bar */}
					<View className="items-center py-3">
						<View className="h-1 w-10 rounded-full bg-muted" />
					</View>

					{/* Header */}
					<View className="flex-row items-center justify-between border-border border-b px-4 pb-3">
						<Text className="font-semibold text-foreground text-lg">
							Select Vault
						</Text>
						<TouchableOpacity
							onPress={onClose}
							className="rounded-full bg-secondary p-2"
						>
							<X size={18} color="#6b7280" />
						</TouchableOpacity>
					</View>

					{/* Vault list */}
					{isLoading ? (
						<View className="items-center py-8">
							<ActivityIndicator size="small" color="#000" />
						</View>
					) : (
						<View className="max-h-80">
							{vaults?.map((vault) => (
								<TouchableOpacity
									key={vault.id}
									onPress={() => {
										onSelect(vault.id);
										onClose();
									}}
									className="flex-row items-center px-4 py-3"
									activeOpacity={0.7}
								>
									<View
										className={`mr-3 h-10 w-10 items-center justify-center rounded-xl ${
											vault.type === "team" ? "bg-blue-100" : "bg-primary/10"
										}`}
									>
										{vault.type === "team" ? (
											<Users size={20} color="#3b82f6" />
										) : (
											<Shield size={20} color="#000" />
										)}
									</View>
									<View className="flex-1">
										<Text className="font-medium text-foreground">
											{vault.name}
										</Text>
										<Text className="text-muted-foreground text-sm">
											{vault.type === "team" ? "Team vault" : "Personal vault"}
										</Text>
									</View>
								</TouchableOpacity>
							))}
						</View>
					)}
				</Pressable>
			</Pressable>
		</Modal>
	);
}
