import { execFileSync } from "node:child_process";
import { resolveBuildPlatform } from "./build-platform.mjs";

const forwardedArgs = process.argv.slice(2);
const platform = resolveBuildPlatform(forwardedArgs, process.platform);

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
