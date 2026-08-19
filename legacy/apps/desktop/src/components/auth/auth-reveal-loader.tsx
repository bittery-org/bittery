import { AuthDoorsControlledRevealLoader } from "@bittery/ui";

export function AuthRevealLoader({
	isVisible,
	onComplete,
}: {
	isVisible: boolean;
	onComplete?: () => void;
}) {
	return (
		<AuthDoorsControlledRevealLoader
			isVisible={isVisible}
			onComplete={onComplete}
		/>
	);
}
