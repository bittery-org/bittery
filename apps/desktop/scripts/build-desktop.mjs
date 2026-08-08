import { execFileSync } from "node:child_process";

const forwardedArgs = process.argv.slice(2);
const targetIndex = forwardedArgs.indexOf("--target");
const platform = (() => {
	const target =
		targetIndex === -1 ? undefined : forwardedArgs[targetIndex + 1];
	if (target?.includes("windows")) return "windows";
	if (target?.includes("apple")) return "macos";
	if (target?.includes("linux")) return "linux";
	if (process.platform === "win32") return "windows";
	if (process.platform === "darwin") return "macos";
	return "linux";
})();

execFileSync(
	"pnpm",
	[
		"exec",
		"tauri",
		"build",
		"--config",
		`src-tauri/bundle.${platform}.conf.json`,
		...forwardedArgs,
	],
	{ stdio: "inherit" },
);
