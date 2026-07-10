import { posix, win32 } from "node:path";

function pathForPlatform(platform) {
  return platform === "win32" ? win32 : posix;
}

export function resolveNodeGradleWrapperPath({ platform = process.platform, packageRoot } = {}) {
  if (!packageRoot) {
    throw new TypeError("resolveNodeGradleWrapperPath() requires packageRoot.");
  }
  const path = pathForPlatform(platform);
  return path.join(packageRoot, platform === "win32" ? "gradlew.bat" : "gradlew");
}

export function resolveNodeGradleCommand(command, { platform = process.platform, baseDirectory } = {}) {
  if (!command) {
    throw new TypeError("resolveNodeGradleCommand() requires a command.");
  }
  const value = String(command);
  // Preserve a bare custom command such as `gradle`: PATH resolution is a
  // deliberate caller choice and must not be rewritten to a wrapper path.
  if (!value.includes("/") && !value.includes("\\")) {
    return value;
  }
  const path = pathForPlatform(platform);
  if (path.isAbsolute(value)) return value;
  if (!baseDirectory) {
    throw new TypeError("resolveNodeGradleCommand() requires baseDirectory for a relative command path.");
  }
  return path.resolve(baseDirectory, value);
}
