import {
	AuthDoorsInitialRevealLoader,
	AuthDoorsPendingLoader,
} from "@bittery/ui";

const WEB_LOGO_POSITION = "top-4 left-4 sm:top-5 sm:left-6";

export function PendingLoader() {
	return (
		<AuthDoorsPendingLoader logoPositionClassName={WEB_LOGO_POSITION} />
	);
}

export function RevealLoader({ isLoading }: { isLoading: boolean }) {
	return (
		<AuthDoorsInitialRevealLoader
			isLoading={isLoading}
			logoPositionClassName={WEB_LOGO_POSITION}
		/>
	);
}
