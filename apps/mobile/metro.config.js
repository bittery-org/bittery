const { getDefaultConfig } = require("expo/metro-config");
const { withNativeWind } = require("nativewind/metro");
const path = require("node:path");

// Find the project and workspace directories
const projectRoot = __dirname;
// This can be replaced with `find-yarn-workspace-root`
const monorepoRoot = path.resolve(projectRoot, "../..");

const config = getDefaultConfig(projectRoot);

// 1. Watch all files within the monorepo (extend Expo's defaults)
config.watchFolders = [...(config.watchFolders || []), monorepoRoot];

// 2. Let Metro know where to resolve packages and in what order
config.resolver.nodeModulesPaths = [
	path.resolve(projectRoot, "node_modules"),
	path.resolve(monorepoRoot, "node_modules"),
];

// 3. Resolve workspace packages
config.resolver.extraNodeModules = {
	"@bittery/api": path.resolve(monorepoRoot, "packages/api"),
	"@bittery/crypto": path.resolve(monorepoRoot, "packages/crypto"),
	"@bittery/shared": path.resolve(monorepoRoot, "packages/shared"),
};

module.exports = withNativeWind(config, { input: "./src/global.css" });
