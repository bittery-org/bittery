import { IconLoaderCircle } from "@bittery/ui/icons";

export default function Loader() {
	return (
		<div className="flex h-full items-center justify-center pt-8">
			<IconLoaderCircle className="animate-spin" />
		</div>
	);
}
