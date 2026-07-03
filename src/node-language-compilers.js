import { spawn } from "node:child_process";
import { constants } from "node:fs";
import { access, mkdir, mkdtemp, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { performance } from "node:perf_hooks";
import { fileURLToPath } from "node:url";

const PACKAGE_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const DEFAULT_KOTLIN_PLUGIN_VERSION = "2.2.21";

function durationSince(startedAt) {
  return Math.round((performance.now() - startedAt) * 100) / 100;
}

function sanitizeProjectName(value) {
  return String(value ?? "piece")
    .replace(/[^A-Za-z0-9_-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48) || "piece";
}

function sourceBasename(filePath, fallback) {
  const name = basename(String(filePath ?? ""));
  return name && name.includes(".") ? name : fallback;
}

function packageNameFromGo(source) {
  return source.match(/^\s*package\s+([A-Za-z_][A-Za-z0-9_]*)/m)?.[1] ?? "main";
}

function kotlinSourceSetForTarget(target) {
  if (target === "jvm") return "jvmMain";
  if (target === "js") return "jsMain";
  if (target === "wasmJs") return "wasmJsMain";
  return "commonMain";
}

function kotlinTasksForTarget(target) {
  if (target === "jvm") return ["jvmJar"];
  if (target === "js") return ["jsNodeProductionLibraryDistribution"];
  if (target === "wasmJs") return ["wasmJsBrowserDistribution"];
  return ["jvmJar", "jsNodeProductionLibraryDistribution", "wasmJsBrowserDistribution"];
}

function kotlinBuildScript({ target, kotlinPluginVersion }) {
  const includeJvm = target === "jvm" || target === "all";
  const includeJs = target === "js" || target === "all";
  const includeWasm = target === "wasmJs" || target === "all";
  return `@file:OptIn(org.jetbrains.kotlin.gradle.ExperimentalWasmDsl::class)

plugins {
    kotlin("multiplatform") version "${kotlinPluginVersion}"
}

group = "cc.phodal.piece.generated"
version = "0.1.0"

repositories {
    mavenCentral()
}

kotlin {
${includeJvm ? "    jvm()\n" : ""}${includeJs ? `    js(IR) {
        nodejs()
        binaries.library()
    }
` : ""}${includeWasm ? `    wasmJs {
        browser {
            testTask {
                enabled = false
            }
        }
        binaries.executable()
    }
` : ""}}
`;
}

async function runCommand(command, args, options = {}) {
  const startedAt = performance.now();
  return new Promise((resolveResult) => {
    let stdout = "";
    let stderr = "";
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: { ...process.env, ...options.env },
      shell: false
    });

    child.stdout?.on("data", (chunk) => {
      stdout += chunk.toString();
    });
    child.stderr?.on("data", (chunk) => {
      stderr += chunk.toString();
    });
    child.on("error", (error) => {
      resolveResult({
        command,
        args,
        cwd: options.cwd,
        exitCode: null,
        signal: null,
        stdout,
        stderr: stderr || error.message,
        errorCode: error.code,
        durationMs: durationSince(startedAt)
      });
    });
    child.on("close", (exitCode, signal) => {
      resolveResult({
        command,
        args,
        cwd: options.cwd,
        exitCode,
        signal,
        stdout,
        stderr,
        durationMs: durationSince(startedAt)
      });
    });
  });
}

async function prepareWorkspace(prefix, workspace) {
  if (workspace) {
    const resolved = resolve(workspace);
    await mkdir(resolved, { recursive: true });
    return { path: resolved, temporary: false };
  }
  return { path: await mkdtemp(join(tmpdir(), prefix)), temporary: true };
}

async function pathExists(path) {
  try {
    await access(path, constants.F_OK);
    return true;
  } catch {
    return false;
  }
}

async function collectFiles(root) {
  if (!(await pathExists(root))) return [];
  const files = [];
  async function visit(directory) {
    const entries = await readdir(directory, { withFileTypes: true });
    for (const entry of entries) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) {
        await visit(path);
      } else if (entry.isFile()) {
        const info = await stat(path);
        files.push({ path, sizeBytes: info.size });
      }
    }
  }
  await visit(root);
  return files.sort((left, right) => left.path.localeCompare(right.path));
}

function diagnosticsFromCommands(commands) {
  return commands
    .filter((command) => command.exitCode !== 0)
    .map((command) => ({
      code: command.errorCode === "ENOENT" ? "tool-not-found" : "compiler-error",
      severity: "error",
      message: command.stderr.trim() || command.stdout.trim() || `${command.command} exited with code ${command.exitCode}`,
      command: [command.command, ...command.args].join(" ")
    }));
}

function compileStatus(commands) {
  return commands.every((command) => command.exitCode === 0) ? "success" : "error";
}

async function cleanupWorkspace(workspace, keepWorkspace) {
  if (!keepWorkspace) {
    await rm(workspace, { recursive: true, force: true });
  }
}

function defaultGradleCommand() {
  return join(PACKAGE_ROOT, "gradlew");
}

export async function compileGoPieceFile(options = {}) {
  const filePath = options.filePath ?? "Main.go";
  const source = options.source ?? "";
  const workspaceInfo = await prepareWorkspace("piece-go-", options.workspace);
  const workspace = workspaceInfo.path;
  const outputDir = resolve(options.outDir ?? join(workspace, "piece-out"));
  const sourceName = sourceBasename(filePath, "Main.go");
  const packageName = packageNameFromGo(source);
  const goCommand = options.goCommand ?? "go";
  const modulePath = options.modulePath ?? `piece.local/${sanitizeProjectName(sourceName.replace(/\.go$/, ""))}`;
  const commands = [];

  try {
    await mkdir(outputDir, { recursive: true });
    await writeFile(join(workspace, sourceName), source, "utf8");
    await writeFile(join(workspace, "go.mod"), `module ${modulePath}\n\ngo 1.22\n`, "utf8");

    const buildArgs = packageName === "main" ? ["build", "-o", join(outputDir, sanitizeProjectName(sourceName.replace(/\.go$/, ""))), "."] : ["build", "./..."];
    commands.push(await runCommand(goCommand, buildArgs, { cwd: workspace, env: options.env }));
    if ((options.runTests ?? true) && commands.at(-1)?.exitCode === 0) {
      commands.push(await runCommand(goCommand, ["test", "./..."], { cwd: workspace, env: options.env }));
    }

    const outputFiles = await collectFiles(outputDir);
    const result = {
      version: 1,
      language: "go",
      filePath,
      target: packageName === "main" ? "binary" : "package",
      status: compileStatus(commands),
      workspace: options.keepWorkspace ? workspace : undefined,
      outputFiles,
      commands,
      diagnostics: diagnosticsFromCommands(commands)
    };
    await writeFile(join(outputDir, "compile-report.json"), `${JSON.stringify(result, null, 2)}\n`, "utf8");
    result.outputFiles = await collectFiles(outputDir);
    return result;
  } finally {
    if (workspaceInfo.temporary) {
      await cleanupWorkspace(workspace, options.keepWorkspace);
    }
  }
}

export async function compileKotlinPieceFile(options = {}) {
  const filePath = options.filePath ?? "Main.kt";
  const source = options.source ?? "";
  const target = options.target ?? "jvm";
  if (!["jvm", "js", "wasmJs", "all"].includes(target)) {
    throw new TypeError(`Unsupported Kotlin compile target: ${target}`);
  }

  const workspaceInfo = await prepareWorkspace("piece-kotlin-", options.workspace);
  const workspace = workspaceInfo.path;
  const sourceSet = options.sourceSet ?? kotlinSourceSetForTarget(target);
  const sourceName = sourceBasename(filePath, "Main.kt");
  const projectName = sanitizeProjectName(sourceName.replace(/\.kts?$/, ""));
  const gradleCommand = options.gradleCommand ?? defaultGradleCommand();
  const tasks = options.tasks ?? kotlinTasksForTarget(target);
  const commands = [];

  try {
    await writeFile(join(workspace, "settings.gradle.kts"), `rootProject.name = "${projectName}"\n`, "utf8");
    await writeFile(
      join(workspace, "build.gradle.kts"),
      kotlinBuildScript({ target, kotlinPluginVersion: options.kotlinPluginVersion ?? DEFAULT_KOTLIN_PLUGIN_VERSION }),
      "utf8"
    );
    const sourceDir = join(workspace, "src", sourceSet, "kotlin");
    await mkdir(sourceDir, { recursive: true });
    await writeFile(join(sourceDir, sourceName), source, "utf8");

    commands.push(await runCommand(gradleCommand, ["-p", workspace, ...tasks], { cwd: PACKAGE_ROOT, env: options.env }));

    const outputFiles = [
      ...(await collectFiles(join(workspace, "build", "libs"))),
      ...(await collectFiles(join(workspace, "build", "dist")))
    ];
    const result = {
      version: 1,
      language: "kotlin",
      filePath,
      target,
      sourceSet,
      status: compileStatus(commands),
      workspace: options.keepWorkspace ? workspace : undefined,
      outputFiles,
      commands,
      diagnostics: diagnosticsFromCommands(commands)
    };
    const reportDir = join(workspace, "build", "piece");
    await mkdir(reportDir, { recursive: true });
    await writeFile(join(reportDir, "compile-report.json"), `${JSON.stringify(result, null, 2)}\n`, "utf8");
    result.outputFiles = [...outputFiles, ...(await collectFiles(reportDir))].sort((left, right) => left.path.localeCompare(right.path));
    return result;
  } finally {
    if (workspaceInfo.temporary) {
      await cleanupWorkspace(workspace, options.keepWorkspace);
    }
  }
}
