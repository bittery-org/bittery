// Expo's own `expo-env.d.ts` is generated and git-ignored, so asset module declarations
// (`*.css`, `*.png`, ...) are referenced here to keep CI type-checks self-contained.
/// <reference types="expo/types" />

// `@bittery/shared` probes Vite's `import.meta.env`; Metro never defines it, so the type
// must exist and stay optional.
interface ImportMeta {
	readonly env?: Record<string, string | undefined>;
}
