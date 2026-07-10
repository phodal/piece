import { spawn } from "node:child_process";
import { dirname, join, posix, resolve, win32 } from "node:path";
import { fileURLToPath } from "node:url";

const PACKAGE_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

function pathForPlatform(platform) {
  return platform === "win32" ? win32 : posix;
}

export function resolveGradleWrapperPath({ platform = process.platform, packageRoot = PACKAGE_ROOT } = {}) {
  return pathForPlatform(platform).join(packageRoot, platform === "win32" ? "gradlew.bat" : "gradlew");
}

export function createGradleInvocation(args, options = {}) {
  const platform = options.platform ?? process.platform;
  const wrapper = resolveGradleWrapperPath({ platform, packageRoot: options.packageRoot ?? PACKAGE_ROOT });
  if (platform !== "win32") return { command: wrapper, args: [...args], cwd: options.packageRoot ?? PACKAGE_ROOT };

  // cmd.exe is required for .bat wrappers. Keep shell execution constrained to
  // this checked-in wrapper rather than enabling a shell for arbitrary tools.
  return {
    command: options.comSpec ?? process.env.ComSpec ?? process.env.COMSPEC ?? "cmd.exe",
    args: ["/d", "/s", "/c", "call", wrapper, ...args],
    cwd: options.packageRoot ?? PACKAGE_ROOT
  };
}

export async function runGradle(args, options = {}) {
  const invocation = createGradleInvocation(args, options);
  return new Promise((resolveResult, rejectResult) => {
    const child = spawn(invocation.command, invocation.args, {
      cwd: invocation.cwd,
      env: { ...process.env, ...options.env },
      shell: false,
      stdio: "inherit"
    });
    child.on("error", rejectResult);
    child.on("close", (code, signal) => {
      if (signal) {
        rejectResult(new Error(`Gradle wrapper exited from signal ${signal}.`));
        return;
      }
      resolveResult(code ?? 1);
    });
  });
}

const invokedPath = process.argv[1] ? resolve(process.argv[1]) : undefined;
if (invokedPath === fileURLToPath(import.meta.url)) {
  try {
    process.exitCode = await runGradle(process.argv.slice(2));
  } catch (error) {
    console.error(error?.stack ?? error?.message ?? String(error));
    process.exitCode = 1;
  }
}
