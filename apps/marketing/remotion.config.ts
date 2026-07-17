import { Config } from "@remotion/cli/config";
import { enableTailwind } from "@remotion/tailwind-v4";

Config.setEntryPoint("src/remotion/index.ts");
Config.overrideWebpackConfig(enableTailwind);
Config.setVideoImageFormat("jpeg");
Config.setOverwriteOutput(true);
// Render at 2x so the video stays crisp on retina displays.
Config.setScale(2);
