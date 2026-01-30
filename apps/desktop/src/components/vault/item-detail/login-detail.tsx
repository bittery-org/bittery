/** biome-ignore-all lint/style/noNonNullAssertion: Thats fine here */

import { Button, Card, Label } from "@bittery/ui";
import { Favicon } from "../favicon";
import { TagInput } from "../tag-input";
import {
	DetailCustomField,
	DetailField,
	DetailHeader,
	DetailPasswordField,
	DetailUrlField,
} from "./field-components";
import { InlineTotpDisplay } from "./inline-totp-display";
import type { CategoryDetailProps, LoginDisplayData } from "./shared";

export function LoginDetail({
	data,
	onEdit,
	onDelete,
	onTagsChange,
	onTagClick,
	availableTags = [],
	isUpdatingTags,
}: CategoryDetailProps<LoginDisplayData>) {
	return (
		<div className="space-y-4">
			<DetailHeader
				icon={
					<Favicon
						url={data.url}
						title={data.title}
						category="login"
						size="lg"
					/>
				}
				title={data.title}
				subtitle={data.url}
			/>

			<div className="flex gap-2">
				{onEdit && (
					<Button size="sm" variant="outline" onClick={onEdit}>
						Edit
					</Button>
				)}
				{onDelete && (
					<Button
						size="sm"
						variant="ghost"
						className="text-destructive hover:bg-destructive/10 hover:text-destructive"
						onClick={onDelete}
					>
						Delete
					</Button>
				)}
			</div>

			<div className="space-y-3">
				<DetailUrlField label="Website" value={data.url} />
				<DetailField label="Username" value={data.username} />
				<DetailPasswordField label="Password" value={data.password} />

				{data.totpSecret && (
					<div className="space-y-2">
						<Label>One-Time Password</Label>
						<InlineTotpDisplay
							totpSecret={data.totpSecret}
							totpAlgorithm={data.totpAlgorithm}
							totpDigits={data.totpDigits}
							totpPeriod={data.totpPeriod}
						/>
					</div>
				)}

				{data.notes && (
					<div className="space-y-2">
						<Label className="font-medium text-sm">Notes</Label>
						<Card>
							<div className="whitespace-pre-wrap px-4 py-1 text-sm">
								{data.notes}
							</div>
						</Card>
					</div>
				)}

				{data.urls && data.urls.length > 0 && (
					<div className="space-y-3">
						<Label className="font-medium text-sm">Additional Websites</Label>
						{data.urls.map((url) => (
							<DetailUrlField key={url} label="" value={url} />
						))}
					</div>
				)}

				{data.customFields && data.customFields.length > 0 && (
					<div className="space-y-3">
						{data.customFields.map((field) => (
							<DetailCustomField key={field.id} field={field} />
						))}
					</div>
				)}
			</div>

			{/* Tags */}
			{onTagsChange && (
				<div className="space-y-2">
					<Label>Tags</Label>
					<TagInput
						tags={data.tags || []}
						availableTags={availableTags}
						onChange={onTagsChange}
						onTagClick={onTagClick}
						disabled={isUpdatingTags}
					/>
				</div>
			)}
		</div>
	);
}
