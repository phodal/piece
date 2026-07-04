import { spawn } from "node:child_process";
import { constants } from "node:fs";
import { access, mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import { performance } from "node:perf_hooks";
import { fileURLToPath } from "node:url";

const PACKAGE_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

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

function isKotlinSourcePath(path) {
  return /\.(?:kt|kts)$/i.test(String(path ?? ""));
}

function resolveHostPath(path, cwd) {
  return isAbsolute(path) ? path : resolve(cwd, path);
}

function sameSourceIdentity(left, right, cwd) {
  if (!left || !right) return false;
  if (left === right) return true;
  return resolveHostPath(String(left), cwd) === resolveHostPath(String(right), cwd);
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

async function collectKotlinCompanionSources(options, primaryFilePath) {
  const cwd = resolve(options.cwd ?? process.cwd());
  const companions = [];
  const seen = new Set();

  function addCompanion(filePath, source) {
    if (!filePath || !isKotlinSourcePath(filePath) || sameSourceIdentity(filePath, primaryFilePath, cwd)) {
      return;
    }
    const key = String(filePath);
    if (seen.has(key)) return;
    seen.add(key);
    companions.push({ filePath: key, source: source ?? "" });
  }

  for (const sourceFile of Array.isArray(options.sourceFiles) ? options.sourceFiles : []) {
    if (typeof sourceFile === "string") {
      const actualPath = resolveHostPath(sourceFile, cwd);
      if (isKotlinSourcePath(sourceFile) && !sameSourceIdentity(sourceFile, primaryFilePath, cwd)) {
        addCompanion(sourceFile, await readFile(actualPath, "utf8"));
      }
      continue;
    }
    addCompanion(sourceFile?.filePath, sourceFile?.source);
  }

  for (const sourceRoot of Array.isArray(options.sourceRoots) ? options.sourceRoots : []) {
    const sourceRootPath = String(sourceRoot);
    const root = resolveHostPath(sourceRootPath, cwd);
    const files = await collectFiles(root);
    for (const file of files) {
      const filePath = isAbsolute(sourceRootPath) ? file.path : relative(cwd, file.path);
      if (isKotlinSourcePath(filePath) && !sameSourceIdentity(filePath, primaryFilePath, cwd)) {
        addCompanion(filePath, await readFile(file.path, "utf8"));
      }
    }
  }

  return companions;
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

function resolveGradleCommand(command) {
  if (!command) return defaultGradleCommand();
  if (!command.includes("/") && !command.includes("\\")) return command;
  return isAbsolute(command) ? command : resolve(PACKAGE_ROOT, command);
}

async function readJsonFile(path) {
  return JSON.parse(await readFile(path, "utf8"));
}

function errorKotlinPsiManifest({ filePath, source, parserName, commands }) {
  return {
    version: 1,
    filePath,
    source,
    parser: parserName,
    slices: [],
    headers: [],
    effects: [],
    importBindings: [],
    hasTopLevelEffect: false,
    diagnostics: diagnosticsFromCommands(commands)
  };
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
  const pieceAction = options.pieceAction;
  if (!["jvm", "js", "wasmJs", "all"].includes(target)) {
    throw new TypeError(`Unsupported Kotlin compile target: ${target}`);
  }

  const hostWorkspaceInfo = await prepareWorkspace("piece-kotlin-host-");
  const hostWorkspace = hostWorkspaceInfo.path;
  const sourceFile = join(hostWorkspace, sourceBasename(filePath, "Main.kt"));
  const outputReport = join(hostWorkspace, "compile-report.json");

  try {
    await writeFile(sourceFile, source, "utf8");
    const args = [
      "-p",
      join(PACKAGE_ROOT, "piece-core"),
      "runKotlinCompileBackend",
      "--quiet",
      `-PpieceCompile.filePath=${filePath}`,
      `-PpieceCompile.sourceFile=${sourceFile}`,
      `-PpieceCompile.outputReport=${outputReport}`,
      `-PpieceCompile.target=${target}`,
      `-PpieceCompile.sourceSet=${options.sourceSet ?? ""}`,
      `-PpieceCompile.gradleCommand=${resolveGradleCommand(options.gradleCommand)}`,
      `-PpieceCompile.kotlinPluginVersion=${options.kotlinPluginVersion ?? ""}`,
      `-PpieceCompile.tasks=${options.tasks?.join(",") ?? ""}`,
      `-PpieceCompile.keepWorkspace=${options.keepWorkspace ? "true" : "false"}`,
      `-PpieceCompile.pieceTargetLabel=${pieceAction?.targetLabel ?? ""}`,
      `-PpieceCompile.pieceActionId=${pieceAction?.actionId ?? ""}`,
      `-PpieceCompile.pieceArtifactId=${pieceAction?.artifactId ?? ""}`,
      `-PpieceCompile.pieceActionKind=${pieceAction?.kind ?? "compile"}`
    ];
    if (options.workspace) {
      args.push(`-PpieceCompile.workspace=${resolve(options.workspace)}`);
    }

    const backendCommand = await runCommand(defaultGradleCommand(), args, { cwd: PACKAGE_ROOT, env: options.env });
    if (await pathExists(outputReport)) {
      return readJsonFile(outputReport);
    }
    const commands = [backendCommand];
    return {
      version: 1,
      language: "kotlin",
      backend: "kotlin-jvm",
      filePath,
      target,
      sourceSet: options.sourceSet ?? "",
      ...(pieceAction ? { pieceAction } : {}),
      status: "error",
      outputFiles: [],
      commands,
      diagnostics: diagnosticsFromCommands(commands)
    };
  } finally {
    await cleanupWorkspace(hostWorkspace, false);
  }
}

export async function analyzeKotlinPieceFile(options = {}) {
  const filePath = options.filePath ?? "Main.kt";
  const source = options.source ?? "";
  const parserName = options.parserName ?? "kotlin-psi-declaration-extractor";
  const semanticDiagnostics = options.semanticDiagnostics === true;
  const semanticSymbols = options.semanticSymbols === true;
  const companionSources = await collectKotlinCompanionSources(options, filePath);
  const hostWorkspaceInfo = await prepareWorkspace("piece-kotlin-analysis-host-");
  const hostWorkspace = hostWorkspaceInfo.path;
  const sourceFile = join(hostWorkspace, sourceBasename(filePath, "Main.kt"));
  const companionDir = join(hostWorkspace, "companions");
  const companionSourcesFile = join(hostWorkspace, "companion-sources.tsv");
  const outputReport = join(hostWorkspace, "analysis-report.json");

  try {
    await writeFile(sourceFile, source, "utf8");
    const companionLines = [];
    if (companionSources.length > 0) {
      await mkdir(companionDir, { recursive: true });
      for (const [index, companion] of companionSources.entries()) {
        const companionFilePath = companion?.filePath;
        if (!companionFilePath || companionFilePath === filePath) continue;
        const companionSourceFile = join(companionDir, `${index}-${sourceBasename(companionFilePath, "Companion.kt")}`);
        await writeFile(companionSourceFile, companion.source ?? "", "utf8");
        companionLines.push(`${companionFilePath}\t${companionSourceFile}`);
      }
      if (companionLines.length > 0) {
        await writeFile(companionSourcesFile, `${companionLines.join("\n")}\n`, "utf8");
      }
    }
    const args = [
      "-p",
      join(PACKAGE_ROOT, "piece-core"),
      "runKotlinPsiAnalysisBackend",
      "--quiet",
      `-PpieceAnalysis.filePath=${filePath}`,
      `-PpieceAnalysis.sourceFile=${sourceFile}`,
      `-PpieceAnalysis.outputReport=${outputReport}`,
      `-PpieceAnalysis.parserName=${parserName}`,
      `-PpieceAnalysis.semanticDiagnostics=${semanticDiagnostics ? "true" : "false"}`,
      `-PpieceAnalysis.semanticSymbols=${semanticSymbols ? "true" : "false"}`,
      `-PpieceAnalysis.companionSources=${companionLines.length > 0 ? companionSourcesFile : ""}`
    ];

    const backendCommand = await runCommand(defaultGradleCommand(), args, { cwd: PACKAGE_ROOT, env: options.env });
    if (await pathExists(outputReport)) {
      return readJsonFile(outputReport);
    }
    return errorKotlinPsiManifest({ filePath, source, parserName, commands: [backendCommand] });
  } finally {
    await cleanupWorkspace(hostWorkspace, false);
  }
}

export function createNodeKotlinPsiDeclarationExtractor(options = {}) {
  const name = options.name ?? "kotlin-psi-declaration-extractor";
  return {
    name,
    extract({ filePath, source }) {
      return analyzeKotlinPieceFile({
        filePath,
        source,
        parserName: name,
        semanticDiagnostics: options.semanticDiagnostics === true,
        semanticSymbols: options.semanticSymbols === true,
        sourceFiles: options.sourceFiles,
        sourceRoots: options.sourceRoots,
        cwd: options.cwd,
        env: options.env
      });
    }
  };
}
