import { spawn } from "node:child_process";
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const PACKAGE_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const PACKAGE_NAME = "piece-compiler";
const allowMissingBin = process.argv.includes("--allow-missing-bin");

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function formatCommand(command, args) {
  return [command, ...args].map((part) => JSON.stringify(part)).join(" ");
}

function run(command, args, options = {}) {
  return new Promise((resolveResult, rejectResult) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: { ...process.env, ...options.env },
      shell: false
    });
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    const timeout = setTimeout(() => {
      timedOut = true;
      child.kill();
    }, options.timeoutMs ?? 120_000);

    child.stdout?.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr?.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("error", (error) => {
      clearTimeout(timeout);
      rejectResult(error);
    });
    child.on("close", (exitCode, signal) => {
      clearTimeout(timeout);
      if (exitCode === 0 && !timedOut) {
        resolveResult({ stdout, stderr });
        return;
      }
      rejectResult(
        new Error(
          `${formatCommand(command, args)} failed${timedOut ? " after timeout" : ""} (exit=${exitCode}, signal=${signal ?? "none"})\n${stderr || stdout}`
        )
      );
    });
  });
}

function npmInvocation(args) {
  if (process.platform !== "win32") return { command: "npm", args };
  const command = ["npm", ...args].map((part) => `"${String(part).replaceAll('"', '""')}"`).join(" ");
  return { command: process.env.ComSpec ?? "cmd.exe", args: ["/d", "/s", "/c", command] };
}

async function runNpm(args, options) {
  const invocation = npmInvocation(args);
  return run(invocation.command, invocation.args, options);
}

function normalizeBins(packageJson) {
  if (typeof packageJson.bin === "string") return { [packageJson.name]: packageJson.bin };
  return packageJson.bin && typeof packageJson.bin === "object" ? packageJson.bin : {};
}

async function main() {
  const packageJson = JSON.parse(await readFile(join(PACKAGE_ROOT, "package.json"), "utf8"));
  assert(packageJson.name === PACKAGE_NAME, `Expected package name '${PACKAGE_NAME}', received '${packageJson.name}'.`);

  const temporaryRoot = await mkdtemp(join(tmpdir(), "piece-packed-package-"));
  const packDirectory = join(temporaryRoot, "pack");
  const fixtureDirectory = join(temporaryRoot, "fixture");
  try {
    await Promise.all([mkdir(packDirectory, { recursive: true }), mkdir(fixtureDirectory, { recursive: true })]);
    const packed = await runNpm(["pack", "--json", `--pack-destination=${packDirectory}`], { cwd: PACKAGE_ROOT });
    const [packResult] = JSON.parse(packed.stdout);
    assert(packResult?.filename, `npm pack did not return a tarball: ${packed.stdout}`);
    const tarball = join(packDirectory, packResult.filename);
    await access(tarball);

    await writeFile(
      join(fixtureDirectory, "package.json"),
      `${JSON.stringify({ name: "piece-packed-package-smoke", private: true, type: "module" }, null, 2)}\n`,
      "utf8"
    );
    await runNpm(["install", "--no-audit", "--no-fund", "--package-lock=false", tarball], { cwd: fixtureDirectory });

    const importProbe = join(fixtureDirectory, "probe-imports.mjs");
    await writeFile(
      importProbe,
      `const entrypoints = [${["piece-compiler", "piece-compiler/browser", "piece-compiler/node", "piece-compiler/testing"].map((entrypoint) => JSON.stringify(entrypoint)).join(", ")}];\n` +
        "for (const entrypoint of entrypoints) {\n" +
        "  const api = await import(entrypoint);\n" +
        "  if (Object.keys(api).length === 0) throw new Error(`${entrypoint} exported no API.`);\n" +
        "}\n" +
        "const core = await import('piece-compiler');\n" +
        "if (typeof core.createPieceCompiler !== 'function') throw new Error('Root package did not export createPieceCompiler().');\n",
      "utf8"
    );
    await run(process.execPath, [importProbe], { cwd: fixtureDirectory });

    const bins = normalizeBins(packageJson);
    const binEntries = Object.entries(bins);
    if (binEntries.length === 0) {
      if (!allowMissingBin) {
        throw new Error("Packed package does not declare a CLI bin. Add package.json#bin before enabling this smoke test in CI.");
      }
      console.warn("Skipping CLI probe because package.json has no bin entry (--allow-missing-bin).");
    } else {
      const installedPackageRoot = join(fixtureDirectory, "node_modules", ...PACKAGE_NAME.split("/"));
      for (const [binName, binPath] of binEntries) {
        const entrypoint = join(installedPackageRoot, binPath);
        await access(entrypoint);
        await run(process.execPath, [entrypoint, "--help"], { cwd: fixtureDirectory });
        console.log(`CLI '${binName}' --help passed.`);
      }
    }

    console.log(`Packed ${basename(tarball)} imports passed.`);
  } finally {
    await rm(temporaryRoot, { recursive: true, force: true });
  }
}

await main();
