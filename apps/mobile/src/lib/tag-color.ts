/**
 * Tag dot colours, mirroring `getTagColorFromName` in
 * `packages/ui/src/components/tag-badge.tsx`. Duplicated rather than imported
 * because `@bittery/ui` is a React DOM package that React Native cannot load.
 */
const TAG_COLORS = [
	"#3b82f6",
	"#10b981",
	"#f59e0b",
	"#ef4444",
	"#8b5cf6",
	"#ec4899",
	"#06b6d4",
	"#f97316",
];

export function getTagColorFromName(name: string): string {
	let hash = 0;
	for (let i = 0; i < name.length; i++) {
		hash = name.charCodeAt(i) + ((hash << 5) - hash);
	}
	return TAG_COLORS[Math.abs(hash) % TAG_COLORS.length] ?? "#3b82f6";
}
