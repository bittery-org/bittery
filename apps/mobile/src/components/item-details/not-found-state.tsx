import { Button, Card } from "heroui-native";
import { SafeAreaView } from "../safe-area-view";

interface NotFoundStateProps {
	onBack: () => void;
}

export function NotFoundState({ onBack }: NotFoundStateProps) {
	return (
		<SafeAreaView className="flex-1 items-center justify-center bg-background p-8">
			<Card variant="default" className="w-full max-w-sm items-center p-8">
				<Card.Title className="mb-4 text-center text-lg">
					Item not found
				</Card.Title>
				<Button onPress={onBack} variant="primary">
					Go Back
				</Button>
			</Card>
		</SafeAreaView>
	);
}
