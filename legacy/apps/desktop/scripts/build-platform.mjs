export function resolveBuildPlatform(args, hostPlatform) {
	const targetIndex = args.indexOf("--target");
	const inlineTarget = args
		.find((argument) => argument.startsWith("--target="))
		?.slice("--target=".length);
	const target = targetIndex === -1 ? inlineTarget : args[targetIndex + 1];

	if (target?.includes("windows")) return "windows";
	if (target?.includes("apple")) return "macos";
	if (target?.includes("linux")) return "linux";
	if (hostPlatform === "win32") return "windows";
	if (hostPlatform === "darwin") return "macos";
	return "linux";
}
