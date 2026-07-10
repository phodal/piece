import { spawn } from "node:child_process";
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { resolveNodeActionInvocation } from "../src/node-action-runner.js";

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

async function npmInvocation(args, options = {}) {
  return resolveNodeActionInvocation("npm", args, {
    environment: { ...process.env, ...options.env }
  });
}

async function runNpm(args, options) {
  const invocation = await npmInvocation(args, options);
  return run(invocation.command, invocation.args, options);
}

function normalizeBins(packageJson) {
  if (typeof packageJson.bin === "string") return { [packageJson.name]: packageJson.bin };
  return packageJson.bin && typeof packageJson.bin === "object" ? packageJson.bin : {};
}

function parseSingleJsonResult(stdout, label) {
  const lines = stdout.trim().split(/\r?\n/).filter(Boolean);
  assert(lines.length === 1, `${label} must emit exactly one JSON result line, received: ${stdout}`);
  try {
    return JSON.parse(lines[0]);
  } catch (error) {
    throw new Error(`${label} did not emit valid JSON: ${error?.message ?? String(error)}\n${stdout}`);
  }
}

function typeScriptTask(script, outputs) {
  return {
    request: { profile: "typescript", script },
    policy: {
      profiles: {
        typescript: { root: ".", allowScripts: [script], packageManager: "npm" }
      },
      // Keep the fixture cross-platform while retaining a controlled child
      // environment. Missing names are simply not inherited by the runner.
      envAllowlist: ["PATH", "HOME", "TMPDIR", "TEMP", "TMP", "SystemRoot", "USERPROFILE", "PATHEXT"]
    },
    ...(outputs ? { outputs } : {})
  };
}

async function writeWorkspaceProject(workspace, relativeRoot, name, source) {
  const projectRoot = join(workspace, relativeRoot);
  await mkdir(join(projectRoot, "src"), { recursive: true });
  await writeFile(join(projectRoot, "src", "index.ts"), source, "utf8");
  await writeFile(
    join(projectRoot, "package.json"),
    `${JSON.stringify(
      {
        name: `packed-piece-${name}`,
        private: true,
        type: "module",
        scripts: { build: "node build.mjs", check: "node check.mjs" }
      },
      null,
      2
    )}\n`,
    "utf8"
  );
  await writeFile(
    join(projectRoot, "build.mjs"),
    `import { mkdir, writeFile } from "node:fs/promises";\nawait mkdir("dist", { recursive: true });\nawait writeFile("dist/${name}.txt", "${name}\\n", "utf8");\n`,
    "utf8"
  );
  await writeFile(join(projectRoot, "check.mjs"), "process.exit(0);\n", "utf8");
  return projectRoot;
}

async function writeWorkspaceTaskFixture(fixtureDirectory) {
  const workspace = join(fixtureDirectory, "workspace");
  await writeWorkspaceProject(workspace, "packages/shared", "shared", 'export const shared = "ready";\n');
  await writeWorkspaceProject(
    workspace,
    "apps/web",
    "web",
    'import { shared } from "../../../packages/shared/src/index";\nexport const web = shared;\n'
  );
  const config = {
    schemaVersion: 2,
    defaultProject: "web",
    projects: [
      {
        id: "shared",
        root: "packages/shared",
        sourceRoots: ["src"],
        dependsOn: [],
        build: typeScriptTask("build", ["dist"]),
        check: typeScriptTask("check")
      },
      {
        id: "web",
        root: "apps/web",
        sourceRoots: ["src"],
        dependsOn: ["shared"],
        build: typeScriptTask("build", ["dist"]),
        check: typeScriptTask("check")
      }
    ]
  };
  await writeFile(join(workspace, "piece.config.json"), `${JSON.stringify(config, null, 2)}\n`, "utf8");
  return workspace;
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
      let pieceEntrypoint;
      for (const [binName, binPath] of binEntries) {
        const entrypoint = join(installedPackageRoot, binPath);
        await access(entrypoint);
        await run(process.execPath, [entrypoint, "--help"], { cwd: fixtureDirectory });
        if (binName === "piece") pieceEntrypoint = entrypoint;
        console.log(`CLI '${binName}' --help passed.`);
      }

      assert(pieceEntrypoint, "Packed package must expose the 'piece' CLI for workspace task verification.");
      await Promise.all([access(join(installedPackageRoot, "SECURITY.md")), access(join(installedPackageRoot, "CHANGELOG.md"))]);

      const workspace = await writeWorkspaceTaskFixture(fixtureDirectory);
      const build = await run(process.execPath, [pieceEntrypoint, "build", "--workspace", workspace, "--format", "json"], {
        cwd: fixtureDirectory
      });
      assert(build.stderr === "", `Packed piece build wrote unexpected stderr: ${build.stderr}`);
      const buildResult = parseSingleJsonResult(build.stdout, "Packed piece build");
      assert(buildResult.status === "success" && buildResult.exitCode === 0, `Packed piece build did not succeed: ${build.stdout}`);
      assert(
        JSON.stringify(buildResult.selection?.closure) === JSON.stringify(["shared", "web"]),
        `Packed piece build selected an unexpected closure: ${JSON.stringify(buildResult.selection)}`
      );
      assert(
        buildResult.projects?.every((project) => project.execution?.status === "success" && project.execution?.outputVerification === "verified"),
        `Packed piece build did not verify every declared output: ${build.stdout}`
      );
      await Promise.all([
        access(join(workspace, "packages", "shared", "dist", "shared.txt")),
        access(join(workspace, "apps", "web", "dist", "web.txt"))
      ]);

      const check = await run(process.execPath, [pieceEntrypoint, "check", "web", "--workspace", workspace, "--format", "json"], {
        cwd: fixtureDirectory
      });
      assert(check.stderr === "", `Packed piece check wrote unexpected stderr: ${check.stderr}`);
      const checkResult = parseSingleJsonResult(check.stdout, "Packed piece check");
      assert(checkResult.status === "success" && checkResult.exitCode === 0, `Packed piece check did not succeed: ${check.stdout}`);
      assert(
        checkResult.projects?.every((project) => project.execution?.status === "success"),
        `Packed piece check did not execute every configured project: ${check.stdout}`
      );
      console.log("Packed CLI schema v2 build/check passed.");
    }

    console.log(`Packed ${basename(tarball)} imports passed.`);
  } finally {
    await rm(temporaryRoot, { recursive: true, force: true });
  }
}

await main();
