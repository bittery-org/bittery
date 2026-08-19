import { Label } from "@bittery/ui";
import type { ReactNode } from "react";

interface SettingsFieldProps {
	id?: string;
	label: string;
	description?: string;
	children: ReactNode;
}

export function SettingsField({
	id,
	label,
	description,
	children,
}: SettingsFieldProps) {
	return (
		<div className="space-y-2">
			<Label htmlFor={id}>{label}</Label>
			{children}
			{description ? (
				<p className="text-muted-foreground text-xs">{description}</p>
			) : null}
		</div>
	);
}

interface SettingsSectionProps {
	title: string;
	description?: string;
	children: ReactNode;
}

export function SettingsSection({
	title,
	description,
	children,
}: SettingsSectionProps) {
	return (
		<section className="space-y-4">
			<div className="space-y-1">
				<h3 className="font-medium">{title}</h3>
				{description ? (
					<p className="text-muted-foreground text-sm">{description}</p>
				) : null}
			</div>
			{children}
		</section>
	);
}
