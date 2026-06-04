import { Button, Card } from "heroui-native";
import { useI18n } from "@/providers/i18n-provider";
import { SafeAreaView } from "../safe-area-view";

interface ErrorStateProps {
	error: Error | unknown;
	onBack: () => void;
}

export function ErrorState({ error, onBack }: ErrorStateProps) {
	const { m } = useI18n();

	return (
		<SafeAreaView className="flex-1 items-center justify-center bg-background p-8">
			<Card variant="default" className="w-full max-w-sm items-center p-8">
				<Card.Title className="mb-2 text-center text-danger text-lg">
					{m.mob_detail_error_title()}
				</Card.Title>
				<Card.Description className="mb-4 text-center">
					{error instanceof Error ? error.message : m.mob_detail_error_unknown()}
				</Card.Description>
				<Button onPress={onBack} variant="primary">
					Go Back
				</Button>
			</Card>
		</SafeAreaView>
	);
}
