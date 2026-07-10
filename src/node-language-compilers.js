import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { access, copyFile, lstat, mkdir, mkdtemp, open, readFile, readdir, realpath, rename, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import { performance } from "node:perf_hooks";
import { fileURLToPath } from "node:url";
import * as esbuild from "esbuild";
import { createPieceActionCacheRecord, explainPieceActionCacheStatus } from "./core/action-cache.js";
import { hashParts, stableTextHash } from "./core/hash.js";
import { mergePiecePackages, piecePackageToPicDsl } from "./core/pic-dsl.js";
import { createGoDeclarationExtractor } from "./languages/go/declaration-extractor.js";
import { canUseNodeActionOutput, isNodeActionFailure, runNodeAction } from "./node-action-runner.js";
import { resolveNodeGradleCommand, resolveNodeGradleWrapperPath } from "./node-gradle-command.js";

const PACKAGE_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const GO_ANALYZER_PATH = join(PACKAGE_ROOT, "go-backend", "analyzer", "main.go");
const LOCAL_ACTION_CACHE_SCHEMA_VERSION = 2;
const LOCAL_ACTION_CACHE_KEY_ALGORITHM = "sha256";
const ACTION_CACHE_LOCK_TIMEOUT_MS = 15_000;
const ACTION_CACHE_LOCK_RETRY_MS = 25;
const ACTION_CACHE_LOCK_STALE_MS = 60_000;

function durationSince(startedAt) {
  return Math.round((performance.now() - startedAt) * 100) / 100;
}

function compareStableJson(left, right) {
  return JSON.stringify(left).localeCompare(JSON.stringify(right));
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

function actionNameForId(id) {
  return String(id ?? "").includes("%") ? String(id).split("%").pop() : "";
}

function isCompileAction(action) {
  return String(action?.kind ?? "").toLowerCase() === "compile";
}

function actionPackageLabel(piecePackage) {
  return piecePackage?.label ?? piecePackage?.filePath ?? "Piece action package";
}

function selectActionPackageTarget(piecePackage, pieceTarget) {
  const targets = piecePackage?.targets ?? [];
  const requestedTarget = String(pieceTarget ?? "").trim();
  if (requestedTarget) {
    const target = targets.find((candidate) =>
      candidate.label === requestedTarget || candidate.id === requestedTarget || candidate.name === requestedTarget
    );
    if (!target) {
      throw new Error(`${actionPackageLabel(piecePackage)} does not contain Piece target '${requestedTarget}'.`);
    }
    return target;
  }

  const actionsByTarget = new Map((piecePackage?.actions ?? []).map((action) => [action.id, action]));
  const compileTargets = targets.filter((target) =>
    (target.actions ?? []).some((actionId) => isCompileAction(actionsByTarget.get(actionId)))
  );
  if (compileTargets.length === 1) {
    return compileTargets[0];
  }
  if (compileTargets.length > 1) {
    throw new Error(`${actionPackageLabel(piecePackage)} contains multiple compile targets; pass pieceTarget to select one.`);
  }
  throw new Error(`${actionPackageLabel(piecePackage)} does not contain a compile target.`);
}

function selectActionPackageCompileAction(piecePackage, target, pieceActionName) {
  const requestedAction = String(pieceActionName ?? "compile").trim() || "compile";
  const targetActionIds = new Set(target.actions ?? []);
  const actions = (piecePackage?.actions ?? []).filter(
    (action) => targetActionIds.has(action.id) || action.target === target.label
  );
  const action = actions.find((candidate) =>
    isCompileAction(candidate) &&
      (candidate.id === requestedAction ||
        candidate.id === `${target.label}%${requestedAction}` ||
        actionNameForId(candidate.id) === requestedAction ||
        String(candidate.kind ?? "").toLowerCase() === requestedAction)
  );
  if (!action) {
    throw new Error(`${actionPackageLabel(piecePackage)} does not contain compile action '${requestedAction}' for ${target.label}.`);
  }
  return action;
}

function compileArtifactIdForAction(piecePackage, target, action) {
  const output = action.outputs?.find((candidate) => typeof candidate === "string" && candidate.length > 0);
  if (output) {
    return output;
  }
  const artifact = (piecePackage?.artifacts ?? []).find((candidate) =>
    candidate.target === target.label && String(candidate.kind ?? "").toLowerCase() === "piece-compile"
  );
  return artifact?.id ?? `${target.label}.compile.json`;
}

function compileArtifactForAction(piecePackage, target, action) {
  const artifactId = compileArtifactIdForAction(piecePackage, target, action);
  const exactArtifact = (piecePackage?.artifacts ?? []).find((artifact) => artifact.id === artifactId);
  if (exactArtifact) {
    return exactArtifact;
  }
  const targetArtifact = (piecePackage?.artifacts ?? []).find(
    (artifact) => artifact.target === target.label && String(artifact.kind ?? "").toLowerCase() === "piece-compile"
  );
  return {
    ...(targetArtifact ?? {}),
    id: artifactId,
    target: target.label,
    kind: targetArtifact?.kind ?? "piece-compile",
    path: targetArtifact?.path ?? artifactId
  };
}

function selectCompileActionDetails(piecePackage, options = {}) {
  const target = selectActionPackageTarget(piecePackage, options.pieceAction?.targetLabel ?? options.pieceTarget);
  const action = options.pieceAction?.actionId
    ? (piecePackage?.actions ?? []).find((candidate) => candidate.id === options.pieceAction.actionId) ??
      selectActionPackageCompileAction(piecePackage, target, options.pieceActionName)
    : selectActionPackageCompileAction(piecePackage, target, options.pieceActionName);
  const artifact = options.pieceAction?.artifactId
    ? (piecePackage?.artifacts ?? []).find((candidate) => candidate.id === options.pieceAction.artifactId) ?? compileArtifactForAction(piecePackage, target, action)
    : compileArtifactForAction(piecePackage, target, action);
  return {
    target,
    action,
    artifact,
    pieceAction: {
      targetLabel: target.label,
      actionId: action.id,
      artifactId: artifact.id,
      kind: "compile"
    }
  };
}

function resolveCompilePieceAction(options = {}) {
  if (options.pieceAction) {
    return options.pieceAction;
  }
  if (!options.actionPackage) {
    return undefined;
  }
  const target = selectActionPackageTarget(options.actionPackage, options.pieceTarget);
  const action = selectActionPackageCompileAction(options.actionPackage, target, options.pieceActionName);
  return {
    targetLabel: target.label,
    actionId: action.id,
    artifactId: compileArtifactIdForAction(options.actionPackage, target, action),
    kind: "compile"
  };
}

function actionPackageForCompileAction(options = {}) {
  return (
    options.actionPackage ??
    options.analysis?.actionPackage ??
    options.analysis?.snapshot?.actionPackage ??
    (options.analysis?.packageScope?.status === "selected" ? options.analysis.packageScope.packageView : undefined) ??
    (options.analysis?.sourceSetScope?.status === "selected" ? options.analysis.sourceSetScope.packageView : undefined) ??
    options.analysis?.piecePackage
  );
}

function filePathForCompileAction(options = {}, actionPackage) {
  return options.filePath ?? options.analysis?.filePath ?? actionPackage?.filePath;
}

function sourceForCompileAction(options = {}) {
  return options.source ?? options.analysis?.manifest?.source;
}

function languageForCompileAction(options = {}, actionPackage, filePath) {
  const language = String(options.language ?? actionPackage?.language ?? "").toLowerCase();
  if (language === "go" || language === "kotlin") {
    return language;
  }
  if (language === "typescript" || language === "ts") {
    return "typescript";
  }
  if (language === "javascript" || language === "js") {
    return "javascript";
  }
  if (/\.go$/i.test(filePath ?? "")) {
    return "go";
  }
  if (/\.(?:kt|kts)$/i.test(filePath ?? "")) {
    return "kotlin";
  }
  if (/\.(?:tsx?|mts|cts)$/i.test(filePath ?? "")) {
    return "typescript";
  }
  if (/\.(?:jsx?|mjs|cjs)$/i.test(filePath ?? "")) {
    return "javascript";
  }
  throw new Error(`Unsupported Piece compile action language: ${options.language ?? actionPackage?.language ?? filePath ?? "unknown"}.`);
}

function parseConcatenatedJsonObjects(source) {
  const decoder = new TextDecoder();
  const bytes = new TextEncoder().encode(String(source ?? ""));
  const values = [];
  let offset = 0;

  while (offset < bytes.length) {
    while (offset < bytes.length && /\s/.test(decoder.decode(bytes.slice(offset, offset + 1)))) {
      offset += 1;
    }
    if (offset >= bytes.length) break;

    let depth = 0;
    let inString = false;
    let escaped = false;
    let end = offset;
    for (; end < bytes.length; end += 1) {
      const char = decoder.decode(bytes.slice(end, end + 1));
      if (inString) {
        if (escaped) {
          escaped = false;
        } else if (char === "\\") {
          escaped = true;
        } else if (char === "\"") {
          inString = false;
        }
        continue;
      }
      if (char === "\"") {
        inString = true;
        continue;
      }
      if (char === "{") depth += 1;
      if (char === "}") {
        depth -= 1;
        if (depth === 0) {
          end += 1;
          break;
        }
      }
    }
    values.push(JSON.parse(decoder.decode(bytes.slice(offset, end))));
    offset = end;
  }

  return values;
}

function normalizeGoListPackage(pkg, workspace) {
  return {
    importPath: pkg.ImportPath ?? "",
    name: pkg.Name ?? "",
    dir: pkg.Dir ? relative(workspace, pkg.Dir) || "." : "",
    module: pkg.Module
      ? {
          path: pkg.Module.Path ?? "",
          version: pkg.Module.Version ?? "",
          main: Boolean(pkg.Module.Main)
        }
      : undefined,
    goFiles: [...(pkg.GoFiles ?? [])].sort(),
    imports: [...(pkg.Imports ?? [])].sort(),
    deps: [...(pkg.Deps ?? [])].sort(),
    testGoFiles: [...(pkg.TestGoFiles ?? [])].sort(),
    testImports: [...(pkg.TestImports ?? [])].sort()
  };
}

function goListHash(packages) {
  if (packages.length === 0) return "";
  return hashParts(
    packages.flatMap((pkg) => [
      pkg.importPath,
      pkg.name,
      pkg.module?.path,
      pkg.module?.version,
      pkg.module?.main ? "main" : "",
      ...pkg.goFiles,
      ...pkg.imports,
      ...pkg.deps,
      ...pkg.testGoFiles,
      ...pkg.testImports
    ])
  );
}

function createGoListReport(commandResult, workspace) {
  if (commandResult.exitCode !== 0) {
    return {
      version: 1,
      status: "error",
      packageHash: "",
      packages: []
    };
  }
  let packages;
  try {
    packages = parseConcatenatedJsonObjects(commandResult.stdout).map((pkg) => normalizeGoListPackage(pkg, workspace));
  } catch {
    return {
      version: 1,
      status: "error",
      packageHash: "",
      packages: []
    };
  }
  return {
    version: 1,
    status: "success",
    packageHash: goListHash(packages),
    packages
  };
}

function goListManifestDiagnostics(commandResult, goList) {
  if (goList.status === "success") return [];
  return [
    {
      code: commandResult.errorCode === "ENOENT" ? "go-list-tool-not-found" : "go-list-fallback",
      severity: "warning",
      message: commandResult.stderr.trim() || commandResult.stdout.trim() || `${commandResult.command} list metadata was unavailable`,
      command: [commandResult.command, ...commandResult.args].join(" ")
    }
  ];
}

function isGoSourcePath(path) {
  return /\.go$/i.test(String(path ?? ""));
}

function createGoPackageScope({ filePath, source, companions = [], declarations = [] }) {
  const files = [
    { filePath, hash: stableTextHash(source ?? "") },
    ...companions.map((companion) => ({ filePath: companion.filePath, hash: stableTextHash(companion.source ?? "") }))
  ]
    .filter((file) => file.filePath)
    .sort((left, right) => String(left.filePath).localeCompare(String(right.filePath)));
  const hash = companions.length > 0 ? hashParts(files.flatMap((file) => [file.filePath, file.hash])) : "";
  return {
    version: 1,
    status: companions.length > 0 ? "selected" : "file",
    files,
    declarations,
    hash,
    input: hash ? `go-package-scope:${hash}` : undefined,
    targetPolicy: {
      version: 1,
      kind: "current-file-external-bindings",
      targetScope: "current-file",
      companionTargetMode: companions.length > 0 ? "external-binding" : "none",
      companionTargets: false,
      fastPath: true,
      companionFileCount: companions.length,
      reason:
        companions.length > 0
          ? "Go companion declarations stay as package-local external bindings until Piece has a multi-file package target model."
          : "No Go companion files are selected, so current-file targets remain the fast path."
    }
  };
}

function createGoListToolchainMetadata(goList, packageScope) {
  const inputs = [
    goList.status === "success" && goList.packageHash ? `go-list:${goList.packageHash}` : undefined,
    packageScope?.input
  ].filter(Boolean);
  return {
    version: 1,
    kind: "go-list",
    status: goList.status === "success" ? "success" : "fallback",
    hash: goList.packageHash,
    inputs,
    packageScope,
    goList
  };
}

function goAnalyzerFallbackDiagnostic(commandResult, message) {
  return {
    code: commandResult?.errorCode === "ENOENT" ? "go-analyzer-tool-not-found" : "go-analyzer-fallback",
    severity: "warning",
    message: commandResult?.stderr?.trim() || commandResult?.stdout?.trim() || message || "Go AST analyzer was unavailable",
    command: commandResult ? [commandResult.command, ...commandResult.args].join(" ") : undefined
  };
}

function goAnalyzerFallbackBackend(reason) {
  return {
    requested: "go-ast",
    actual: "javascript-go-extractor",
    declarations: "javascript",
    symbols: "javascript",
    diagnostics: "javascript",
    status: "fallback",
    fallbackReason: reason
  };
}

function compareGoImportBindings(left, right) {
  return `${left.local}:${left.imported}:${left.source}:${left.kind}`.localeCompare(
    `${right.local}:${right.imported}:${right.source}:${right.kind}`
  );
}

function uniqueGoImportBindings(bindings) {
  const seen = new Set();
  return bindings
    .filter((binding) => {
      const key = `${binding.local}:${binding.imported}:${binding.source}:${binding.kind}:${binding.isTypeOnly}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .sort(compareGoImportBindings);
}

function goCompanionBindingFromSlice(slice) {
  const name = slice?.exportName ?? slice?.name;
  if (!name || !slice?.filePath) return undefined;
  return {
    local: name,
    imported: name,
    source: slice.filePath,
    kind: "named",
    isTypeOnly: slice.kind === "type"
  };
}

function goPackageScopeDeclarationFromSlice(slice) {
  const name = slice?.exportName ?? slice?.name;
  if (!name || !slice?.filePath) return undefined;
  return {
    id: slice.id ?? `${slice.filePath}#${slice.kind}:${name}`,
    filePath: slice.filePath,
    name,
    kind: slice.kind,
    hash: slice.hashes?.bodyHash
  };
}

async function runGoAstAnalyzer({ filePath, source, goCommand = "go", env, actionRunner }) {
  const workspaceInfo = await prepareWorkspace("piece-go-analyzer-");
  const workspace = workspaceInfo.path;
  const sourceName = sourceBasename(filePath, "Main.go");
  const sourceFile = join(workspace, sourceName);
  try {
    await writeFile(sourceFile, source, "utf8");
    const command = await runCommand(goCommand, ["run", GO_ANALYZER_PATH, "--file", sourceFile, "--path", filePath], {
      cwd: workspace,
      env,
      ...actionRunner
    });
    if (command.exitCode !== 0) {
      return { command };
    }
    try {
      return { command, manifest: JSON.parse(command.stdout) };
    } catch (error) {
      return { command, error };
    }
  } finally {
    if (workspaceInfo.temporary) {
      await cleanupWorkspace(workspace, false);
    }
  }
}

async function collectGoCompanionBindings({ companions = [], goCommand = "go", env, actionRunner }) {
  const bindings = [];
  const declarations = [];
  const diagnostics = [];
  for (const companion of companions) {
    const analyzerResult = await runGoAstAnalyzer({
      filePath: companion.filePath,
      source: companion.source ?? "",
      goCommand,
      env,
      actionRunner
    });
    if (!analyzerResult.manifest) {
      diagnostics.push(
        goAnalyzerFallbackDiagnostic(
          analyzerResult.command,
          analyzerResult.error
            ? `Go AST analyzer returned invalid JSON for companion ${companion.filePath}: ${analyzerResult.error.message}`
            : `Go AST analyzer was unavailable for companion ${companion.filePath}`
        )
      );
      continue;
    }
    bindings.push(...(analyzerResult.manifest.slices ?? []).map(goCompanionBindingFromSlice).filter(Boolean));
    declarations.push(...(analyzerResult.manifest.slices ?? []).map(goPackageScopeDeclarationFromSlice).filter(Boolean));
    diagnostics.push(...(analyzerResult.manifest.diagnostics ?? []));
  }
  return {
    bindings: uniqueGoImportBindings(bindings),
    declarations: declarations.sort(compareStableJson),
    diagnostics
  };
}

function attachGoCompanionBindings(manifest, companionBindings, companionDiagnostics) {
  if (companionBindings.length === 0 && companionDiagnostics.length === 0) {
    return manifest;
  }
  return {
    ...manifest,
    importBindings: uniqueGoImportBindings([...(manifest.importBindings ?? []), ...companionBindings]),
    diagnostics: [...(manifest.diagnostics ?? []), ...companionDiagnostics]
  };
}

function goWorkspaceRelativePath(filePath, primaryFilePath, cwd) {
  const normalized = String(filePath ?? "").replace(/\\/g, "/");
  const normalizedPrimary = String(primaryFilePath ?? "").replace(/\\/g, "/");
  if (dirname(normalized) === dirname(normalizedPrimary)) {
    return sourceBasename(normalized, "Companion.go");
  }
  if (!isAbsolute(filePath)) {
    return normalized.replace(/^\.?\//, "");
  }
  const relativePath = relative(cwd, filePath).replace(/\\/g, "/");
  if (!relativePath.startsWith("..")) {
    return relativePath;
  }
  return join("__companions", sanitizeProjectName(dirname(normalized)), sourceBasename(normalized, "Companion.go"));
}

async function writeGoWorkspaceSources({ workspace, filePath, source, companions = [], cwd }) {
  const sourceName = sourceBasename(filePath, "Main.go");
  await writeFile(join(workspace, sourceName), source, "utf8");
  for (const companion of companions) {
    if (!companion.filePath || sameSourceIdentity(companion.filePath, filePath, cwd)) continue;
    const relativePath = goWorkspaceRelativePath(companion.filePath, filePath, cwd);
    const target = join(workspace, relativePath);
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, companion.source ?? "", "utf8");
  }
  return sourceName;
}

async function collectGoCompanionSources(options, primaryFilePath) {
  const cwd = resolve(options.cwd ?? process.cwd());
  const companions = [];
  const seen = new Set();

  function addCompanion(filePath, source) {
    if (!filePath || !isGoSourcePath(filePath) || sameSourceIdentity(filePath, primaryFilePath, cwd)) {
      return;
    }
    const key = resolveHostPath(String(filePath), cwd);
    if (seen.has(key)) return;
    seen.add(key);
    companions.push({ filePath: String(filePath), source: source ?? "" });
  }

  for (const sourceFile of Array.isArray(options.sourceFiles) ? options.sourceFiles : []) {
    if (typeof sourceFile === "string") {
      const actualPath = resolveHostPath(sourceFile, cwd);
      if (isGoSourcePath(sourceFile) && !sameSourceIdentity(sourceFile, primaryFilePath, cwd)) {
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
      if (isGoSourcePath(filePath) && !sameSourceIdentity(filePath, primaryFilePath, cwd)) {
        addCompanion(filePath, await readFile(file.path, "utf8"));
      }
    }
  }

  return companions;
}

async function collectGoListForSource({ filePath, source, companions = [], goCommand = "go", modulePath, env, actionRunner, cwd = process.cwd() }) {
  const workspaceInfo = await prepareWorkspace("piece-go-analysis-");
  const workspace = workspaceInfo.path;
  const sourceName = sourceBasename(filePath, "Main.go");
  const resolvedModulePath = modulePath ?? `piece.local/${sanitizeProjectName(sourceName.replace(/\.go$/, ""))}`;
  try {
    await writeGoWorkspaceSources({ workspace, filePath, source, companions, cwd });
    await writeFile(join(workspace, "go.mod"), `module ${resolvedModulePath}\n\ngo 1.22\n`, "utf8");
    const command = await runCommand(goCommand, ["list", "-json", "./..."], { cwd: workspace, env, ...actionRunner });
    return {
      command,
      goList: createGoListReport(command, workspace)
    };
  } finally {
    if (workspaceInfo.temporary) {
      await cleanupWorkspace(workspace, false);
    }
  }
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

function uniqueResolvedPaths(entries, cwd) {
  return [
    ...new Set(
      entries
        .filter(Boolean)
        .map((entry) => resolveHostPath(String(entry), cwd))
    )
  ];
}

function actionRunnerOptionsFor(options = {}) {
  const actionRunner = options.actionRunner ?? {};
  return {
    timeoutMs: actionRunner.timeoutMs,
    maxOutputBytes: actionRunner.maxOutputBytes,
    killGraceMs: actionRunner.killGraceMs,
    signal: actionRunner.signal,
    inheritProcessEnv: actionRunner.inheritProcessEnv,
    envAllowlist: actionRunner.envAllowlist
  };
}

async function runCommand(command, args, options = {}) {
  return runNodeAction(command, args, options);
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
    const key = resolveHostPath(String(filePath), cwd);
    if (seen.has(key)) return;
    seen.add(key);
    companions.push({ filePath: String(filePath), source: source ?? "" });
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

function collectKotlinClasspath(options) {
  const cwd = resolve(options.cwd ?? process.cwd());
  return uniqueResolvedPaths(Array.isArray(options.classpath) ? options.classpath : [], cwd);
}

async function resolveProjectGradleCommand(command, projectRoot) {
  if (!command) {
    const projectWrapper = projectRoot ? resolveNodeGradleWrapperPath({ packageRoot: projectRoot }) : undefined;
    if (projectWrapper && (await pathExists(projectWrapper))) return projectWrapper;
    return defaultGradleCommand();
  }
  return resolveNodeGradleCommand(command, { baseDirectory: projectRoot ?? PACKAGE_ROOT });
}

function commandFailureMessage(command) {
  if (command.stderr.trim() || command.stdout.trim()) {
    return command.stderr.trim() || command.stdout.trim();
  }
  if (command.errorCode === "ACTION_TIMEOUT") {
    return `${command.command} exceeded the configured action timeout.`;
  }
  if (command.errorCode === "ACTION_ABORTED") {
    return `${command.command} was cancelled by the action signal.`;
  }
  if (command.errorCode === "ACTION_OUTPUT_LIMIT") {
    return `${command.command} exceeded the configured stdout/stderr output limit.`;
  }
  return `${command.command} exited with code ${command.exitCode}`;
}

function diagnosticsFromCommands(commands) {
  return commands
    .filter(isNodeActionFailure)
    .map((command) => ({
      code:
        command.errorCode === "ENOENT"
          ? "tool-not-found"
          : command.errorCode === "ACTION_TIMEOUT"
            ? "action-timeout"
            : command.errorCode === "ACTION_ABORTED"
              ? "action-cancelled"
              : command.errorCode === "ACTION_OUTPUT_LIMIT"
                ? "action-output-limit"
                : "compiler-error",
      severity: "error",
      message: commandFailureMessage(command),
      command: [command.command, ...command.args].join(" ")
    }));
}

function compileStatus(commands) {
  return commands.every((command) => !isNodeActionFailure(command)) ? "success" : "error";
}

async function cleanupWorkspace(workspace, keepWorkspace) {
  if (!keepWorkspace) {
    await rm(workspace, { recursive: true, force: true });
  }
}

function defaultGradleCommand() {
  return resolveNodeGradleWrapperPath({ packageRoot: PACKAGE_ROOT });
}

function resolveGradleCommand(command) {
  if (!command) return defaultGradleCommand();
  return resolveNodeGradleCommand(command, { baseDirectory: PACKAGE_ROOT });
}

async function readJsonFile(path) {
  return JSON.parse(await readFile(path, "utf8"));
}

function actionCacheStoreReason(code, severity, message, extra = {}) {
  return {
    code,
    severity,
    message,
    ...extra
  };
}

function normalizeNodeActionCacheRecords(records) {
  if (!records || records === false) {
    return [];
  }
  if (records instanceof Map) {
    return [...records.entries()]
      .map(([key, record]) => (record?.key ? record : { ...record, key: String(key) }))
      .filter((record) => record?.key);
  }
  if (Array.isArray(records)) {
    return records.filter((record) => record?.key);
  }
  return Object.entries(records)
    .map(([key, record]) => (record?.key ? record : { ...record, key }))
    .filter((record) => record?.key);
}

function sha256Text(value) {
  return createHash(LOCAL_ACTION_CACHE_KEY_ALGORITHM).update(String(value ?? "")).digest("hex");
}

function isSha256Digest(value) {
  return typeof value === "string" && /^[a-f0-9]{64}$/i.test(value);
}

function canonicalCacheValue(value, ancestors = new Set()) {
  if (value === null) return "null";
  if (value === undefined) return "undefined";
  if (typeof value === "string") return `string:${JSON.stringify(value)}`;
  if (typeof value === "boolean") return `boolean:${value}`;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throw new TypeError("Local action-cache identity cannot contain a non-finite number.");
    }
    return `number:${value}`;
  }
  if (typeof value === "bigint" || typeof value === "function" || typeof value === "symbol") {
    throw new TypeError(`Local action-cache identity cannot contain ${typeof value} values.`);
  }
  if (Array.isArray(value)) {
    if (ancestors.has(value)) {
      throw new TypeError("Local action-cache identity cannot contain circular arrays.");
    }
    ancestors.add(value);
    try {
      return `array:[${value.map((entry) => canonicalCacheValue(entry, ancestors)).join(",")}]`;
    } finally {
      ancestors.delete(value);
    }
  }
  if (typeof value === "object") {
    if (ancestors.has(value)) {
      throw new TypeError("Local action-cache identity cannot contain circular objects.");
    }
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) {
      throw new TypeError("Local action-cache identity only supports plain objects and arrays.");
    }
    ancestors.add(value);
    try {
      return `object:{${Object.keys(value)
        .sort()
        .map((key) => `${JSON.stringify(key)}:${canonicalCacheValue(value[key], ancestors)}`)
        .join(",")}}`;
    } finally {
      ancestors.delete(value);
    }
  }
  throw new TypeError(`Unsupported local action-cache identity value: ${typeof value}.`);
}

function localActionCacheIdentityReason(code, message, extra = {}) {
  return actionCacheStoreReason(code, "warning", message, extra);
}

async function sourceForLocalActionCache(options, source, filePath) {
  if (source !== undefined) {
    return { source: String(source) };
  }
  const cwd = resolve(options.cwd ?? process.cwd());
  try {
    return { source: await readFile(resolveHostPath(filePath, cwd), "utf8") };
  } catch (error) {
    if (error?.code === "ENOENT") {
      // This matches the Node language rules, which compile a missing optional
      // source path as an empty source when no explicit source was supplied.
      return { source: "" };
    }
    return {
      reason: localActionCacheIdentityReason(
        "local-action-cache-source-unavailable",
        "Piece could not read the source needed to construct a cryptographic local action-cache identity.",
        { filePath, error: error?.message ?? String(error) }
      )
    };
  }
}

function secureLocalActionCacheIdentity(baseRecord, options, source) {
  const analysis = options.analysis;
  const actionCache = analysis?.actionCache ?? {};
  const compilerOptions = options.compilerOptions;
  if (actionCache.compilerOptionsHash && compilerOptions === undefined) {
    return {
      reason: localActionCacheIdentityReason(
        "local-action-cache-compiler-options-unavailable",
        "Piece cannot safely reuse a local action-cache entry because the raw compiler options behind the analysis hash were not supplied."
      )
    };
  }

  const dependencyArtifacts = options.dependencyArtifacts ?? actionCache.dependencyArtifacts;
  if (actionCache.dependencyArtifactsHash && dependencyArtifacts === undefined) {
    return {
      reason: localActionCacheIdentityReason(
        "local-action-cache-dependency-artifacts-unavailable",
        "Piece cannot safely reuse a local action-cache entry because the raw dependency-artifact identity is unavailable."
      )
    };
  }

  const toolchainInputs = options.toolchainInputs ?? actionCache.toolchainInputs;
  if (actionCache.toolchainInputsHash && toolchainInputs === undefined) {
    return {
      reason: localActionCacheIdentityReason(
        "local-action-cache-toolchain-inputs-unavailable",
        "Piece cannot safely reuse a local action-cache entry because the raw toolchain inputs are unavailable."
      )
    };
  }

  const projectModel = analysis?.manifest?.projectModel;
  if (baseRecord.identity.projectModelHash && !projectModel) {
    return {
      reason: localActionCacheIdentityReason(
        "local-action-cache-project-model-unavailable",
        "Piece cannot safely reuse a local action-cache entry because the project-model data behind its hash is unavailable."
      )
    };
  }

  const feedbackScope = analysis?.feedbackScope;
  if (baseRecord.identity.feedbackScopeHash && !feedbackScope) {
    return {
      reason: localActionCacheIdentityReason(
        "local-action-cache-feedback-scope-unavailable",
        "Piece cannot safely reuse a local action-cache entry because the feedback-scope data behind its hash is unavailable."
      )
    };
  }

  try {
    return {
      payload: {
        schema: "piece-local-action-cache",
        schemaVersion: LOCAL_ACTION_CACHE_SCHEMA_VERSION,
        keyAlgorithm: LOCAL_ACTION_CACHE_KEY_ALGORITHM,
        action: baseRecord.action,
        artifact: baseRecord.artifact,
        identity: {
          language: baseRecord.identity.language,
          filePath: baseRecord.identity.filePath,
          packageLabel: baseRecord.identity.packageLabel,
          packageFilePath: baseRecord.identity.packageFilePath,
          targetLabel: baseRecord.identity.targetLabel,
          targetSource: baseRecord.identity.targetSource,
          actionId: baseRecord.identity.actionId,
          actionKind: baseRecord.identity.actionKind
        },
        inputs: baseRecord.inputs,
        outputs: baseRecord.outputs,
        sourceSha256: sha256Text(source),
        compilerOptions: compilerOptions ?? null,
        dependencyArtifacts: dependencyArtifacts ?? [],
        toolchainInputs: toolchainInputs ?? [],
        projectModel: projectModel ?? null,
        feedbackScope: feedbackScope ?? null,
        execution: {
          target: options.target,
          languageTarget: options.languageTarget,
          kotlinTarget: options.kotlinTarget,
          platform: options.platform,
          format: options.format,
          bundle: options.bundle,
          sourcemap: options.sourcemap,
          runTests: options.runTests,
          modulePath: options.modulePath,
          goModulePath: options.goModulePath,
          goCommand: options.goCommand,
          sourceSet: options.sourceSet,
          projectRoot: options.projectRoot,
          gradleProjectRoot: options.gradleProjectRoot,
          gradleCommand: options.gradleCommand,
          gradleVersion: options.gradleVersion,
          kotlinPluginVersion: options.kotlinPluginVersion,
          tasks: options.tasks ?? [],
          classpath: options.classpath ?? [],
          env: options.env ?? {}
        }
      }
    };
  } catch (error) {
    return {
      reason: localActionCacheIdentityReason(
        "local-action-cache-identity-not-canonical",
        "Piece could not canonicalize all action inputs, so it will not reuse or persist this local action-cache entry.",
        { error: error?.message ?? String(error) }
      )
    };
  }
}

function createSecureLocalActionCacheRecord(baseRecord, options, source) {
  const secureIdentity = secureLocalActionCacheIdentity(baseRecord, options, source);
  if (!secureIdentity.payload) {
    return { reason: secureIdentity.reason };
  }
  try {
    const key = sha256Text(canonicalCacheValue(secureIdentity.payload));
    return {
      record: {
        ...baseRecord,
        version: LOCAL_ACTION_CACHE_SCHEMA_VERSION,
        key,
        cacheSchemaVersion: LOCAL_ACTION_CACHE_SCHEMA_VERSION,
        keyAlgorithm: LOCAL_ACTION_CACHE_KEY_ALGORITHM,
        legacyKey: baseRecord.key
      }
    };
  } catch (error) {
    return {
      reason: localActionCacheIdentityReason(
        "local-action-cache-identity-not-canonical",
        "Piece could not canonicalize all action inputs, so it will not reuse or persist this local action-cache entry.",
        { error: error?.message ?? String(error) }
      )
    };
  }
}

function isCurrentLocalActionCacheRecord(record) {
  return (
    record?.version === LOCAL_ACTION_CACHE_SCHEMA_VERSION &&
    record?.cacheSchemaVersion === LOCAL_ACTION_CACHE_SCHEMA_VERSION &&
    record?.keyAlgorithm === LOCAL_ACTION_CACHE_KEY_ALGORITHM &&
    isSha256Digest(record?.key)
  );
}

function isCurrentLocalActionCacheStore(store) {
  return (
    store?.version === LOCAL_ACTION_CACHE_SCHEMA_VERSION &&
    store?.schemaVersion === LOCAL_ACTION_CACHE_SCHEMA_VERSION &&
    store?.keyAlgorithm === LOCAL_ACTION_CACHE_KEY_ALGORITHM
  );
}

function localActionCacheStorePath(options = {}) {
  if (!options.actionCacheStorePath) {
    return undefined;
  }
  return resolveHostPath(String(options.actionCacheStorePath), options.cwd ?? process.cwd());
}

async function prepareActionCacheCompileWorkspace(options = {}, storePath) {
  if (!storePath || options.workspace || options.outDir || options.keepWorkspace) {
    return undefined;
  }
  return prepareWorkspace("piece-action-cache-");
}

function actionCacheRecordsFromStore(store) {
  const records = store?.records;
  return normalizeNodeActionCacheRecords(Array.isArray(records) ? records : records ?? {});
}

async function readLocalActionCacheStoreRecords(storePath) {
  if (!storePath || !(await pathExists(storePath))) {
    return {
      records: []
    };
  }
  try {
    const store = await readJsonFile(storePath);
    if (!isCurrentLocalActionCacheStore(store)) {
      return {
        records: [],
        reason: actionCacheStoreReason(
          "action-cache-store-schema-miss",
          "info",
          "The local action-cache store uses an unsupported schema, so Piece treated it as a cache miss instead of reusing it.",
          { path: storePath, expectedSchemaVersion: LOCAL_ACTION_CACHE_SCHEMA_VERSION }
        )
      };
    }
    const records = actionCacheRecordsFromStore(store).filter(isCurrentLocalActionCacheRecord);
    return {
      records,
      ...(records.length !== actionCacheRecordsFromStore(store).length
        ? {
            reason: actionCacheStoreReason(
              "action-cache-record-schema-miss",
              "info",
              "Some local action-cache records use an unsupported schema and were treated as misses.",
              { path: storePath, expectedSchemaVersion: LOCAL_ACTION_CACHE_SCHEMA_VERSION }
            )
          }
        : {})
    };
  } catch (error) {
    return {
      records: [],
      reason: actionCacheStoreReason(
        "action-cache-store-read-failed",
        "warning",
        "The local action-cache store could not be read, so Piece treated the lookup as a miss.",
        {
          path: storePath,
          error: error?.message ?? String(error)
        }
      )
    };
  }
}

function actionCacheLookupRecords(options = {}, storeRecords = []) {
  if (options.actionCacheRecords === false) {
    return false;
  }
  const explicitRecords = normalizeNodeActionCacheRecords(options.actionCacheRecords).filter(isCurrentLocalActionCacheRecord);
  if (storeRecords.length === 0 && explicitRecords.length === 0) {
    return options.actionCacheRecords === undefined ? undefined : [];
  }
  return [...storeRecords, ...explicitRecords].filter(isCurrentLocalActionCacheRecord);
}

function appendActionCacheReasons(actionCache, reasons = []) {
  if (!actionCache || reasons.length === 0) {
    return actionCache;
  }
  return {
    ...actionCache,
    reasons: [...(actionCache.reasons ?? []), ...reasons]
  };
}

function artifactStoreRootFor(storePath) {
  return join(dirname(storePath), "artifacts");
}

async function contentHashForFile(path) {
  return sha256Text(await readFile(path));
}

function actionCacheStoreError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

async function resolveActionCacheArtifactRoot(storePath, record, { create = false } = {}) {
  if (!storePath || !isCurrentLocalActionCacheRecord(record)) {
    throw actionCacheStoreError("action-cache-record-schema-invalid", "The local action-cache record does not use the current secure schema.");
  }

  const storeDirectory = dirname(storePath);
  if (create) {
    await mkdir(storeDirectory, { recursive: true });
  }
  const storeDirectoryRealPath = await realpath(storeDirectory);
  const artifactStoreRoot = artifactStoreRootFor(storePath);
  if (create) {
    await mkdir(artifactStoreRoot, { recursive: true });
  }
  const artifactStoreRootRealPath = await realpath(artifactStoreRoot);
  if (!isPathInside(storeDirectoryRealPath, artifactStoreRootRealPath)) {
    throw actionCacheStoreError(
      "action-cache-artifact-store-escaped",
      "The local action-cache artifact root resolves outside the cache-store directory."
    );
  }

  const artifactRoot = join(artifactStoreRoot, record.key);
  if (create) {
    await mkdir(artifactRoot, { recursive: true });
  }
  const artifactRootRealPath = await realpath(artifactRoot);
  if (!isPathInside(artifactStoreRootRealPath, artifactRootRealPath)) {
    throw actionCacheStoreError(
      "action-cache-artifact-record-root-escaped",
      "The local action-cache artifact record root resolves outside the artifact store."
    );
  }

  return {
    artifactStoreRoot,
    artifactStoreRootRealPath,
    artifactRoot,
    artifactRootRealPath
  };
}

async function promoteActionCacheOutputFiles(storePath, record, outputFiles = []) {
  if (!storePath || !record?.key || outputFiles.length === 0) {
    return outputFiles;
  }
  const { artifactRoot, artifactRootRealPath } = await resolveActionCacheArtifactRoot(storePath, record, { create: true });
  const promoted = [];
  for (const [index, outputFile] of outputFiles.entries()) {
    const outputPath = outputFile?.path;
    if (!outputPath) continue;
    if (!isAbsolute(outputPath)) {
      throw actionCacheStoreError("action-cache-output-path-relative", "Piece only promotes absolute output paths into the local action-cache store.");
    }
    const info = await lstat(outputPath);
    if (info.isSymbolicLink() || !info.isFile()) {
      throw actionCacheStoreError("action-cache-output-not-regular-file", "Piece only promotes regular output files into the local action-cache store.");
    }
    const contentHash = await contentHashForFile(outputPath);
    const artifactName = `${index}-${contentHash.slice(0, 16)}-${sanitizeProjectName(basename(outputPath))}`;
    const artifactPath = join(artifactRoot, artifactName);
    if (resolve(outputPath) !== resolve(artifactPath)) {
      let existing;
      try {
        existing = await lstat(artifactPath);
      } catch (error) {
        if (error?.code !== "ENOENT") throw error;
      }
      if (existing) {
        if (existing.isSymbolicLink() || !existing.isFile()) {
          throw actionCacheStoreError("action-cache-artifact-not-regular-file", "A local action-cache artifact destination is not a regular file.");
        }
        const existingRealPath = await realpath(artifactPath);
        if (!isPathInside(artifactRootRealPath, existingRealPath)) {
          throw actionCacheStoreError("action-cache-artifact-escaped", "A local action-cache artifact destination resolves outside its record root.");
        }
        if (existing.size !== info.size || (await contentHashForFile(existingRealPath)) !== contentHash) {
          throw actionCacheStoreError("action-cache-artifact-content-conflict", "A local action-cache artifact path already exists with different content.");
        }
      } else {
        const temporaryArtifactPath = join(artifactRoot, `.${artifactName}.${process.pid}.${randomUUID()}.tmp`);
        try {
          await copyFile(outputPath, temporaryArtifactPath);
          const temporaryInfo = await lstat(temporaryArtifactPath);
          if (temporaryInfo.isSymbolicLink() || !temporaryInfo.isFile() || temporaryInfo.size !== info.size) {
            throw actionCacheStoreError("action-cache-artifact-copy-invalid", "Piece could not safely copy an output into the local action-cache store.");
          }
          if ((await contentHashForFile(temporaryArtifactPath)) !== contentHash) {
            throw actionCacheStoreError("action-cache-artifact-copy-hash-mismatch", "A copied local action-cache artifact did not match its source content hash.");
          }
          await rename(temporaryArtifactPath, artifactPath);
        } finally {
          await rm(temporaryArtifactPath, { force: true });
        }
      }
    }
    promoted.push({
      path: artifactPath,
      sizeBytes: info.size,
      contentHash,
      originalPath: outputPath
    });
  }
  return promoted;
}

async function actionCacheStoreRecordForResult(storePath, record, result) {
  const outputFiles = await promoteActionCacheOutputFiles(storePath, record, result.outputFiles ?? []);
  return {
    ...record,
    result: {
      status: result.status,
      language: result.language,
      backend: result.backend,
      filePath: result.filePath,
      target: result.target,
      sourceSet: result.sourceSet,
      projectRoot: result.projectRoot,
      workspace: result.workspace,
      outputFiles,
      commandCount: result.commands?.length ?? 0,
      updatedAt: new Date().toISOString()
    }
  };
}

function actionCacheReuseRequested(options = {}) {
  return options.actionCacheMode === "reuse-local";
}

function matchedActionCacheRecord(records, key) {
  if (!key || records === false) {
    return undefined;
  }
  return normalizeNodeActionCacheRecords(records).find((record) => isCurrentLocalActionCacheRecord(record) && record.key === key);
}

function cachedArtifactReason(code, message, extra = {}) {
  return actionCacheStoreReason(code, "warning", message, extra);
}

async function validateCachedActionArtifacts(record, storePath) {
  if (!isCurrentLocalActionCacheRecord(record)) {
    return {
      status: "miss",
      reason: cachedArtifactReason("cached-record-schema-miss", "The cached action record does not use the current secure local-cache schema.")
    };
  }
  if (!storePath) {
    return {
      status: "miss",
      reason: cachedArtifactReason(
        "cached-artifact-store-path-missing",
        "Piece only reuses artifacts whose local action-cache store root can be verified."
      )
    };
  }
  if (record?.result?.status !== "success") {
    return {
      status: "miss",
      reason: cachedArtifactReason("cached-result-not-success", "The cached action record does not contain a successful compile result.")
    };
  }

  const outputFiles = record.result.outputFiles ?? [];
  if (outputFiles.length === 0) {
    return {
      status: "miss",
      reason: cachedArtifactReason("cached-artifacts-missing", "The cached action record does not contain output artifact metadata.")
    };
  }

  let artifactRoot;
  try {
    artifactRoot = await resolveActionCacheArtifactRoot(storePath, record);
  } catch (error) {
    return {
      status: "miss",
      reason: cachedArtifactReason(
        error?.code ?? "cached-artifact-store-root-invalid",
        error?.message ?? "Piece could not verify the cached artifact-store root."
      )
    };
  }

  const validatedOutputFiles = [];
  for (const outputFile of outputFiles) {
    const outputPath = outputFile?.path;
    if (!outputPath) {
      return {
        status: "miss",
        reason: cachedArtifactReason("cached-artifact-path-missing", "A cached output artifact is missing its file path.")
      };
    }
    if (!isAbsolute(outputPath)) {
      return {
        status: "miss",
        reason: cachedArtifactReason("cached-artifact-path-relative", "A cached output artifact path must be absolute.", { path: outputPath })
      };
    }
    let info;
    try {
      info = await lstat(outputPath);
    } catch {
      return {
        status: "miss",
        reason: cachedArtifactReason("cached-artifact-not-found", "A cached output artifact file no longer exists.", {
          path: outputPath
        })
      };
    }
    if (info.isSymbolicLink()) {
      return {
        status: "miss",
        reason: cachedArtifactReason("cached-artifact-symlink", "A cached output artifact must not be a symbolic link.", {
          path: outputPath
        })
      };
    }
    if (!info.isFile()) {
      return {
        status: "miss",
        reason: cachedArtifactReason("cached-artifact-not-file", "A cached output artifact path is not a regular file.", {
          path: outputPath
        })
      };
    }
    let outputRealPath;
    try {
      outputRealPath = await realpath(outputPath);
    } catch {
      return {
        status: "miss",
        reason: cachedArtifactReason("cached-artifact-realpath-failed", "Piece could not resolve a cached output artifact safely.", {
          path: outputPath
        })
      };
    }
    if (!isPathInside(artifactRoot.artifactRootRealPath, outputRealPath)) {
      return {
        status: "miss",
        reason: cachedArtifactReason("cached-artifact-outside-store", "A cached output artifact resolves outside its local action-cache record root.", {
          path: outputPath
        })
      };
    }
    if (Number.isFinite(outputFile.sizeBytes) && info.size !== outputFile.sizeBytes) {
      return {
        status: "miss",
        reason: cachedArtifactReason("cached-artifact-size-mismatch", "A cached output artifact file size changed after it was recorded.", {
          path: outputPath,
          expectedSizeBytes: outputFile.sizeBytes,
          actualSizeBytes: info.size
        })
      };
    }
    if (!isSha256Digest(outputFile.contentHash)) {
      return {
        status: "miss",
        reason: cachedArtifactReason("cached-artifact-content-hash-missing", "A cached output artifact is missing its SHA-256 content hash.", {
          path: outputPath
        })
      };
    }
    if ((await contentHashForFile(outputRealPath)) !== outputFile.contentHash.toLowerCase()) {
      return {
        status: "miss",
        reason: cachedArtifactReason("cached-artifact-content-hash-mismatch", "A cached output artifact no longer matches its recorded SHA-256 content hash.", {
          path: outputPath
        })
      };
    }
    validatedOutputFiles.push({
      path: outputRealPath,
      sizeBytes: info.size,
      contentHash: outputFile.contentHash.toLowerCase()
    });
  }

  return {
    status: "ready",
    outputFiles: validatedOutputFiles
  };
}

function actionCacheWithReuseMiss(actionCache, validation, record) {
  const { matchedRecordKey, ...rest } = actionCache;
  return {
    ...rest,
    status: "miss",
    reasons: [...(actionCache.reasons ?? []).filter((reason) => reason?.code !== "local-record-match"), validation.reason],
    execution: {
      skipped: false,
      reason: "cached-artifact-miss"
    },
    reuse: {
      status: "skipped",
      recordKey: record?.key,
      reason: validation.reason?.code
    }
  };
}

function cachedActionCompileResult({ record, actionCache, validation, language, filePath, pieceAction }) {
  const result = record.result ?? {};
  return {
    version: 1,
    language,
    ...(result.backend ? { backend: result.backend } : {}),
    filePath: result.filePath ?? filePath,
    target: result.target ?? "",
    ...(result.sourceSet ? { sourceSet: result.sourceSet } : {}),
    ...(result.projectRoot ? { projectRoot: result.projectRoot } : {}),
    ...(result.workspace ? { workspace: result.workspace } : {}),
    ...(pieceAction ? { pieceAction } : {}),
    status: "success",
    outputFiles: validation.outputFiles,
    commands: [],
    diagnostics: [],
    actionCache: {
      ...actionCache,
      execution: {
        skipped: true,
        reason: "cached-artifact-reuse"
      },
      reuse: {
        status: "reused",
        recordKey: record.key,
        outputFiles: validation.outputFiles
      }
    }
  };
}

function actionCacheLockPathFor(storePath) {
  return `${storePath}.lock`;
}

function isProcessAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code !== "ESRCH";
  }
}

async function actionCacheLockIsStale(lockPath) {
  try {
    const owner = JSON.parse(await readFile(join(lockPath, "owner.json"), "utf8"));
    if (Number.isSafeInteger(owner?.pid) && owner.pid > 0) {
      return !isProcessAlive(owner.pid);
    }
  } catch {
    // A process can terminate between mkdir() and owner metadata creation.
  }
  try {
    const info = await lstat(lockPath);
    return Date.now() - info.mtimeMs > ACTION_CACHE_LOCK_STALE_MS;
  } catch {
    return false;
  }
}

function waitForActionCacheLock(ms) {
  return new Promise((resolveWait) => setTimeout(resolveWait, ms));
}

async function acquireActionCacheStoreLock(storePath) {
  const lockPath = actionCacheLockPathFor(storePath);
  const deadline = Date.now() + ACTION_CACHE_LOCK_TIMEOUT_MS;
  await mkdir(dirname(lockPath), { recursive: true });
  while (true) {
    const token = randomUUID();
    try {
      await mkdir(lockPath);
      try {
        await writeFile(join(lockPath, "owner.json"), `${JSON.stringify({ pid: process.pid, token, createdAt: new Date().toISOString() })}\n`, {
          encoding: "utf8",
          flag: "wx"
        });
      } catch (error) {
        await rm(lockPath, { recursive: true, force: true });
        throw error;
      }
      return {
        acquired: true,
        lockPath,
        async release() {
          try {
            const owner = JSON.parse(await readFile(join(lockPath, "owner.json"), "utf8"));
            if (owner?.token === token) {
              await rm(lockPath, { recursive: true, force: true });
            }
          } catch {
            // A stale-lock recovery or process cleanup already removed the lock.
          }
        }
      };
    } catch (error) {
      if (error?.code !== "EEXIST") {
        throw error;
      }
      if (await actionCacheLockIsStale(lockPath)) {
        await rm(lockPath, { recursive: true, force: true });
        continue;
      }
      if (Date.now() >= deadline) {
        return { acquired: false, lockPath, reason: "action-cache-store-lock-timeout" };
      }
      await waitForActionCacheLock(Math.min(ACTION_CACHE_LOCK_RETRY_MS, Math.max(1, deadline - Date.now())));
    }
  }
}

async function syncDirectory(directory) {
  try {
    const directoryHandle = await open(directory, "r");
    try {
      await directoryHandle.sync();
    } finally {
      await directoryHandle.close();
    }
  } catch {
    // Directory fsync is not available on every supported filesystem. The
    // preceding same-directory rename still preserves atomic visibility.
  }
}

async function writeLocalActionCacheStoreAtomically(storePath, store) {
  const directory = dirname(storePath);
  await mkdir(directory, { recursive: true });
  const temporaryPath = join(directory, `.${basename(storePath)}.${process.pid}.${randomUUID()}.tmp`);
  let fileHandle;
  try {
    fileHandle = await open(temporaryPath, "wx", 0o600);
    await fileHandle.writeFile(`${JSON.stringify(store, null, 2)}\n`, "utf8");
    await fileHandle.sync();
    await fileHandle.close();
    fileHandle = undefined;
    await rename(temporaryPath, storePath);
    await syncDirectory(directory);
  } finally {
    if (fileHandle) {
      await fileHandle.close();
    }
    await rm(temporaryPath, { force: true });
  }
}

async function persistLocalActionCacheRecord(storePath, record, result, actionCache) {
  if (!storePath) {
    return undefined;
  }
  if (!record?.key) {
    return {
      status: "skipped",
      path: storePath,
      reason: "record-missing"
    };
  }
  if (result.status !== "success") {
    return {
      status: "skipped",
      path: storePath,
      recordKey: record.key,
      reason: "compile-failed"
    };
  }
  if (actionCache?.status === "unsafe") {
    return {
      status: "skipped",
      path: storePath,
      recordKey: record.key,
      reason: "unsafe"
    };
  }
  if (actionCache?.status === "bypass") {
    return {
      status: "skipped",
      path: storePath,
      recordKey: record.key,
      reason: "bypass"
    };
  }
  const incompleteIdentityReason = (actionCache?.reasons ?? []).find((reason) =>
    reason?.code === "artifact-id-missing" || reason?.code === "artifact-cache-key-missing"
  );
  if (incompleteIdentityReason) {
    return {
      status: "skipped",
      path: storePath,
      recordKey: record.key,
      reason: incompleteIdentityReason.code
    };
  }

  let lock;
  try {
    lock = await acquireActionCacheStoreLock(storePath);
    if (!lock.acquired) {
      return {
        status: "skipped",
        path: storePath,
        recordKey: record.key,
        reason: lock.reason
      };
    }
    let existingRecords = {};
    if (await pathExists(storePath)) {
      try {
        const existingStore = await readJsonFile(storePath);
        if (isCurrentLocalActionCacheStore(existingStore)) {
          existingRecords = Object.fromEntries(
            actionCacheRecordsFromStore(existingStore)
              .filter(isCurrentLocalActionCacheRecord)
              .map((candidate) => [candidate.key, candidate])
          );
        }
      } catch {
        // A malformed or legacy store is deliberately migrated as a cache miss.
        existingRecords = {};
      }
    }
    const recordForResult = await actionCacheStoreRecordForResult(storePath, record, result);
    const records = {
      ...existingRecords,
      [record.key]: recordForResult
    };
    await writeLocalActionCacheStoreAtomically(storePath, {
      version: LOCAL_ACTION_CACHE_SCHEMA_VERSION,
      schemaVersion: LOCAL_ACTION_CACHE_SCHEMA_VERSION,
      keyAlgorithm: LOCAL_ACTION_CACHE_KEY_ALGORITHM,
      kind: "piece-action-cache-store",
      updatedAt: recordForResult.result.updatedAt,
      records
    });
    return {
      status: "stored",
      path: storePath,
      recordKey: record.key
    };
  } catch (error) {
    return {
      status: "error",
      path: storePath,
      recordKey: record.key,
      reason: error?.code ?? "write-failed",
      message: error?.message ?? String(error)
    };
  } finally {
    await lock?.release?.();
  }
}

function inferKotlinSourceSetFromProjectFile(projectRoot, filePath, cwd) {
  if (!projectRoot || !filePath) return undefined;
  const sourcePath = resolveHostPath(String(filePath), cwd);
  const root = resolveHostPath(String(projectRoot), cwd);
  if (!isPathInside(root, sourcePath)) return undefined;
  const relativePath = relative(root, sourcePath);
  const parts = relativePath.split(/[\\/]+/);
  const sourceIndex = parts.indexOf("src");
  if (sourceIndex < 0 || parts[sourceIndex + 2] !== "kotlin") return undefined;
  return parts[sourceIndex + 1];
}

async function collectKotlinGradleProjectModel(options = {}) {
  const projectRootOption = options.gradleProjectRoot ?? options.projectRoot;
  if (!projectRootOption) return null;

  const cwd = resolve(options.cwd ?? process.cwd());
  const projectRoot = resolveHostPath(String(projectRootOption), cwd);
  const sourceSet = options.sourceSet ?? inferKotlinSourceSetFromProjectFile(projectRoot, options.filePath, cwd);
  const hostWorkspaceInfo = await prepareWorkspace("piece-kotlin-gradle-model-host-");
  const hostWorkspace = hostWorkspaceInfo.path;
  const outputReport = join(hostWorkspace, "gradle-project-model.json");

  try {
    const gradleCommand = await resolveProjectGradleCommand(options.gradleCommand, projectRoot);
    const args = [
      "-p",
      join(PACKAGE_ROOT, "piece-core"),
      "runKotlinGradleProjectModelBackend",
      "--quiet",
      `-PpieceGradleProjectModel.projectRoot=${projectRoot}`,
      `-PpieceGradleProjectModel.outputReport=${outputReport}`,
      `-PpieceGradleProjectModel.gradleCommand=${gradleCommand}`,
      `-PpieceGradleProjectModel.gradleVersion=${options.gradleVersion ?? ""}`,
      `-PpieceGradleProjectModel.sourceSet=${sourceSet ?? ""}`
    ];
    const backendCommand = await runCommand(defaultGradleCommand(), args, {
      cwd: PACKAGE_ROOT,
      env: options.env,
      ...actionRunnerOptionsFor(options)
    });
    if (canUseNodeActionOutput(backendCommand) && (await pathExists(outputReport))) {
      return readJsonFile(outputReport);
    }
    return withKotlinProjectModelHashes({
      version: 1,
      projectRoot,
      status: "fallback",
      sourceSets: [],
      classpaths: [],
      dependencies: [],
      projectDependencies: [],
      targetVariants: [],
      sourceRoots: [],
      classpath: [],
      commands: [backendCommand],
      diagnostics: [
        {
          code:
            backendCommand.errorCode === "ENOENT"
              ? "tool-not-found"
              : backendCommand.errorCode === "ACTION_TIMEOUT"
                ? "action-timeout"
                : backendCommand.errorCode === "ACTION_ABORTED"
                  ? "action-cancelled"
                  : backendCommand.errorCode === "ACTION_OUTPUT_LIMIT"
                    ? "action-output-limit"
                    : "kotlin-gradle-project-model-error",
          severity: "warning",
          message: commandFailureMessage(backendCommand),
          command: [backendCommand.command, ...backendCommand.args].join(" ")
        }
      ]
    });
  } finally {
    await cleanupWorkspace(hostWorkspace, false);
  }
}

function kotlinProjectModelHashes(projectModel) {
  const sourceRoots = [...new Set(projectModel?.sourceRoots ?? [])].sort();
  const classpath = [...new Set(projectModel?.classpath ?? [])].sort();
  const sourceSets = [...(projectModel?.sourceSets ?? [])]
    .map((sourceSet) => ({
      projectPath: sourceSet.projectPath ?? "",
      projectDir: sourceSet.projectDir ?? "",
      name: sourceSet.name ?? "",
      sourceRoots: [...(sourceSet.sourceRoots ?? [])].sort(),
      targetNames: [...(sourceSet.targetNames ?? [])].sort()
    }))
    .sort((left, right) => `${left.projectPath}:${left.name}`.localeCompare(`${right.projectPath}:${right.name}`));
  const classpaths = [...(projectModel?.classpaths ?? [])]
    .map((classpathEntry) => ({
      projectPath: classpathEntry.projectPath ?? "",
      name: classpathEntry.name ?? "",
      files: [...(classpathEntry.files ?? [])].sort()
    }))
    .sort((left, right) => `${left.projectPath}:${left.name}`.localeCompare(`${right.projectPath}:${right.name}`));
  const dependencies = [...(projectModel?.dependencies ?? [])]
    .map((dependency) => ({
      projectPath: dependency.projectPath ?? "",
      configuration: dependency.configuration ?? "",
      coordinates: dependency.coordinates ?? ""
    }))
    .sort((left, right) => `${left.projectPath}:${left.configuration}:${left.coordinates}`.localeCompare(`${right.projectPath}:${right.configuration}:${right.coordinates}`));
  const projectDependencies = [...(projectModel?.projectDependencies ?? [])]
    .map((dependency) => ({
      projectPath: dependency.projectPath ?? "",
      configuration: dependency.configuration ?? "",
      dependencyProjectPath: dependency.dependencyProjectPath ?? "",
      dependencyProjectDir: dependency.dependencyProjectDir ?? ""
    }))
    .sort((left, right) =>
      `${left.projectPath}:${left.configuration}:${left.dependencyProjectPath}`.localeCompare(
        `${right.projectPath}:${right.configuration}:${right.dependencyProjectPath}`
      )
    );
  const targetVariants = [...(projectModel?.targetVariants ?? [])]
    .map((variant) => ({
      projectPath: variant.projectPath ?? "",
      sourceSet: variant.sourceSet ?? "",
      targetName: variant.targetName ?? "",
      compilationName: variant.compilationName ?? "",
      compileTask: variant.compileTask ?? "",
      classpathConfiguration: variant.classpathConfiguration ?? ""
    }))
    .sort((left, right) => `${left.projectPath}:${left.sourceSet}:${left.targetName}`.localeCompare(`${right.projectPath}:${right.sourceSet}:${right.targetName}`));
  const sourceRootsHash = hashParts(sourceRoots);
  const classpathHash = hashParts(classpath);
  const modelHash = hashParts([
    "v1",
    projectModel?.projectRoot ?? "",
    projectModel?.status ?? "",
    sourceRootsHash,
    classpathHash,
    ...sourceSets.flatMap((sourceSet) => [
      "sourceSet",
      sourceSet.projectPath,
      sourceSet.projectDir,
      sourceSet.name,
      sourceSet.sourceRoots.join("\u001e"),
      sourceSet.targetNames.join("\u001e")
    ]),
    ...classpaths.flatMap((classpathEntry) => [
      "classpath",
      classpathEntry.projectPath,
      classpathEntry.name,
      classpathEntry.files.join("\u001e")
    ]),
    ...dependencies.flatMap((dependency) => [
      "dependency",
      dependency.projectPath,
      dependency.configuration,
      dependency.coordinates
    ]),
    ...projectDependencies.flatMap((dependency) => [
      "projectDependency",
      dependency.projectPath,
      dependency.configuration,
      dependency.dependencyProjectPath,
      dependency.dependencyProjectDir
    ]),
    ...targetVariants.flatMap((variant) => [
      "targetVariant",
      variant.projectPath,
      variant.sourceSet,
      variant.targetName,
      variant.compilationName,
      variant.compileTask,
      variant.classpathConfiguration
    ])
  ]);
  return {
    sourceRootsHash,
    classpathHash,
    modelHash
  };
}

function withKotlinProjectModelHashes(projectModel) {
  if (!projectModel) return projectModel;
  return {
    ...projectModel,
    hashes: projectModel.hashes ?? kotlinProjectModelHashes(projectModel)
  };
}

function isPathInside(root, child) {
  const relativePath = relative(root, child);
  return relativePath === "" || (!relativePath.startsWith("..") && !isAbsolute(relativePath));
}

function sourceSetForKotlinProjectFile(projectModel, filePath, cwd) {
  if (!filePath) return undefined;
  const sourcePath = resolveHostPath(filePath, cwd);
  let bestMatch;
  for (const sourceSet of projectModel?.sourceSets ?? []) {
    for (const sourceRoot of sourceSet.sourceRoots ?? []) {
      const root = resolveHostPath(sourceRoot, cwd);
      if (!isPathInside(root, sourcePath)) continue;
      const score = root.length;
      if (!bestMatch || score > bestMatch.score) {
        bestMatch = { sourceSet, score };
      }
    }
  }
  return bestMatch?.sourceSet;
}

function requiredKotlinSourceSetNames(sourceSetName) {
  if (!sourceSetName) return [];
  const names = new Set([sourceSetName]);
  if (sourceSetName !== "commonMain" && sourceSetName.endsWith("Main")) {
    names.add("commonMain");
  }
  if (sourceSetName.endsWith("Test")) {
    names.add("commonMain");
    names.add("commonTest");
    names.add(sourceSetName.replace(/Test$/, "Main"));
  }
  return [...names].sort();
}

function kotlinTargetPrefix(sourceSetName) {
  if (!sourceSetName || sourceSetName.startsWith("common")) return undefined;
  return sourceSetName.replace(/(?:Main|Test)$/, "");
}

function classpathMatchesKotlinSourceSet(classpathEntry, sourceSetName) {
  const prefix = kotlinTargetPrefix(sourceSetName);
  if (!prefix) return false;
  const lowerName = String(classpathEntry?.name ?? "").toLowerCase();
  const lowerPrefix = prefix.toLowerCase();
  if (!lowerName.includes(lowerPrefix) || !lowerName.includes("compileclasspath")) {
    return false;
  }
  return sourceSetName.endsWith("Test") || !lowerName.includes("test");
}

function projectDependencyMatchesKotlinSourceSet(projectDependency, sourceSetName) {
  return classpathMatchesKotlinSourceSet({ name: projectDependency?.configuration }, sourceSetName);
}

function reachableKotlinProjectPaths(projectModel, selectedProjectPath, sourceSetName) {
  if (!selectedProjectPath) return [];
  const reachable = new Set([selectedProjectPath]);
  let changed = true;
  while (changed) {
    changed = false;
    for (const dependency of projectModel?.projectDependencies ?? []) {
      if (!reachable.has(dependency.projectPath)) continue;
      if (!projectDependencyMatchesKotlinSourceSet(dependency, sourceSetName)) continue;
      if (!dependency.dependencyProjectPath || reachable.has(dependency.dependencyProjectPath)) continue;
      reachable.add(dependency.dependencyProjectPath);
      changed = true;
    }
  }
  return [...reachable].sort();
}

function kotlinProjectModelScopeDiagnostic(code, message, details = {}) {
  return {
    code,
    severity: "warning",
    message,
    ...details
  };
}

function kotlinProjectModelScopeHashes(scope) {
  const sourceRoots = [...new Set(scope.sourceRoots ?? [])].sort();
  const classpath = [...new Set(scope.classpath ?? [])].sort();
  const projectPaths = [...new Set(scope.projectPaths ?? [])].sort();
  const sourceRootsHash = hashParts(sourceRoots);
  const classpathHash = hashParts(classpath);
  const scopeHash = hashParts([
    "v1",
    scope.projectPath ?? "",
    scope.sourceSet ?? "",
    ...projectPaths,
    ...(scope.requiredSourceSets ?? []),
    sourceRootsHash,
    classpathHash,
    ...(scope.classpathConfigurations ?? []),
    ...(scope.dependencyCoordinates ?? []),
    ...(scope.projectDependencies ?? []).flatMap((dependency) => [
      dependency.projectPath,
      dependency.configuration,
      dependency.dependencyProjectPath,
      dependency.dependencyProjectDir
    ]),
    ...(scope.targetVariants ?? []).flatMap((variant) => [
      variant.projectPath,
      variant.sourceSet,
      variant.targetName,
      variant.compilationName,
      variant.compileTask,
      variant.classpathConfiguration
    ])
  ]);
  return {
    sourceRootsHash,
    classpathHash,
    scopeHash
  };
}

function focusKotlinProjectModel(projectModel, options = {}) {
  if (!projectModel) return projectModel;
  const cwd = resolve(options.cwd ?? process.cwd());
  const modelWithHashes = withKotlinProjectModelHashes(projectModel);
  const selectedSourceSet = sourceSetForKotlinProjectFile(modelWithHashes, options.filePath, cwd);
  const requiredSourceSets = requiredKotlinSourceSetNames(selectedSourceSet?.name);
  const requiredNames = new Set(requiredSourceSets);
  const projectPaths = reachableKotlinProjectPaths(modelWithHashes, selectedSourceSet?.projectPath, selectedSourceSet?.name);
  const projectPathSet = new Set(projectPaths);
  const selectedSourceRoots =
    selectedSourceSet?.name
      ? [
          ...new Set(
            (modelWithHashes.sourceSets ?? [])
              .filter((sourceSet) => projectPathSet.has(sourceSet.projectPath) && requiredNames.has(sourceSet.name))
              .flatMap((sourceSet) => sourceSet.sourceRoots ?? [])
          )
        ].sort()
      : [];
  const matchingClasspaths =
    selectedSourceSet?.name
      ? (modelWithHashes.classpaths ?? []).filter(
          (classpathEntry) => projectPathSet.has(classpathEntry.projectPath) && classpathMatchesKotlinSourceSet(classpathEntry, selectedSourceSet.name)
        )
      : [];
  const matchingClasspathNames = new Set(matchingClasspaths.map((entry) => `${entry.projectPath}:${entry.name}`));
  const matchingDependencies = (modelWithHashes.dependencies ?? []).filter((dependency) =>
    matchingClasspathNames.has(`${dependency.projectPath}:${dependency.configuration}`)
  );
  const matchingProjectDependencies = (modelWithHashes.projectDependencies ?? []).filter(
    (dependency) =>
      projectPathSet.has(dependency.projectPath) &&
      projectPathSet.has(dependency.dependencyProjectPath) &&
      projectDependencyMatchesKotlinSourceSet(dependency, selectedSourceSet?.name)
  );
  const matchingTargetVariants = selectedSourceSet?.name
    ? (modelWithHashes.targetVariants ?? []).filter((variant) => projectPathSet.has(variant.projectPath) && variant.sourceSet === selectedSourceSet.name)
    : [];
  const selectedClasspath = matchingClasspaths.length > 0 ? [...new Set(matchingClasspaths.flatMap((entry) => entry.files ?? []))].sort() : [];
  const diagnostics = [];
  if (modelWithHashes.status !== "success") {
    diagnostics.push(
      kotlinProjectModelScopeDiagnostic(
        "kotlin-project-model-discovery-fallback",
        "Gradle project model discovery did not return a successful model; Piece cannot prove a source-set-scoped Kotlin analysis boundary.",
        { projectRoot: modelWithHashes.projectRoot }
      )
    );
  }
  if (!selectedSourceSet) {
    diagnostics.push(
      kotlinProjectModelScopeDiagnostic(
        "kotlin-project-model-source-set-unmatched",
        "Gradle project model discovery did not map the edited Kotlin file to a discovered source set; Piece is falling back to file-level Kotlin analysis unless manual sourceRoots or classpath overrides are provided.",
        {
          filePath: options.filePath,
          projectRoot: modelWithHashes.projectRoot
        }
      )
    );
  } else {
    if (selectedSourceRoots.length === 0) {
      diagnostics.push(
        kotlinProjectModelScopeDiagnostic(
          "kotlin-project-model-source-roots-empty",
          "The selected Gradle source set did not expose Kotlin source roots; Piece cannot prove the source-set input boundary.",
          {
            projectPath: selectedSourceSet.projectPath,
            sourceSet: selectedSourceSet.name
          }
        )
      );
    }
    if (!selectedSourceSet.name.startsWith("common") && matchingClasspaths.length === 0) {
      diagnostics.push(
        kotlinProjectModelScopeDiagnostic(
          "kotlin-project-model-classpath-unmatched",
          "Gradle project model discovery did not expose a matching compile classpath for the selected Kotlin source set; Piece is falling back instead of reusing the full project classpath.",
          {
            projectPath: selectedSourceSet.projectPath,
            sourceSet: selectedSourceSet.name
          }
        )
      );
    }
  }
  const fallbackReason = diagnostics[0]?.message;
  const scope = {
    status: diagnostics.length === 0 ? "selected" : "fallback",
    ...(fallbackReason ? { fallbackReason } : {}),
    projectPath: selectedSourceSet?.projectPath,
    projectPaths,
    sourceSet: selectedSourceSet?.name,
    requiredSourceSets,
    sourceRoots: selectedSourceRoots,
    classpath: selectedClasspath,
    classpathConfigurations: matchingClasspaths.map((entry) => `${entry.projectPath}:${entry.name}`).sort(),
    dependencyCoordinates: [...new Set(matchingDependencies.map((dependency) => dependency.coordinates).filter(Boolean))].sort(),
    projectDependencies: matchingProjectDependencies,
    targetVariants: matchingTargetVariants,
    diagnostics
  };
  return {
    ...modelWithHashes,
    diagnostics: [...(modelWithHashes.diagnostics ?? []), ...diagnostics],
    analysisScope: {
      ...scope,
      hashes: kotlinProjectModelScopeHashes(scope)
    }
  };
}

function mergeKotlinProjectModelOptions(options, projectModel) {
  if (!projectModel) return options;

  const cwd = resolve(options.cwd ?? process.cwd());
  const modelSourceRoots = projectModel.analysisScope?.sourceRoots ?? projectModel.sourceRoots ?? [];
  const modelClasspath = projectModel.analysisScope?.classpath ?? projectModel.classpath ?? [];
  return {
    ...options,
    sourceRoots: uniqueResolvedPaths([...modelSourceRoots, ...(Array.isArray(options.sourceRoots) ? options.sourceRoots : [])], cwd),
    classpath: uniqueResolvedPaths([...modelClasspath, ...(Array.isArray(options.classpath) ? options.classpath : [])], cwd)
  };
}

function attachKotlinProjectModel(manifest, projectModel) {
  if (!projectModel) return manifest;
  const modelWithHashes = withKotlinProjectModelHashes(projectModel);
  return {
    ...manifest,
    projectModel: {
      kind: "gradle-kmp",
      projectRoot: modelWithHashes.projectRoot,
      status: modelWithHashes.status,
      sourceRoots: modelWithHashes.sourceRoots ?? [],
      classpath: modelWithHashes.classpath ?? [],
      sourceSets: modelWithHashes.sourceSets ?? [],
      classpaths: modelWithHashes.classpaths ?? [],
      dependencies: modelWithHashes.dependencies ?? [],
      projectDependencies: modelWithHashes.projectDependencies ?? [],
      targetVariants: modelWithHashes.targetVariants ?? [],
      hashes: modelWithHashes.hashes,
      analysisScope: modelWithHashes.analysisScope
    },
    diagnostics: [...(manifest.diagnostics ?? []), ...(modelWithHashes.diagnostics ?? [])]
  };
}

function normalizeKotlinAnalysisBackend(value) {
  if (value === undefined || value === null || value === "") return undefined;
  if (value === "psi" || value === "fe10-binding-context" || value === "analysis-api") {
    return value;
  }
  throw new TypeError(`Unsupported Kotlin analysis backend: ${value}`);
}

function kotlinAnalysisBackendMetadata({ backend, semanticDiagnostics = false, semanticSymbols = false, analysisApiEnabled = false, analysisApiVersion } = {}) {
  const requested = backend ?? (semanticSymbols ? "fe10-binding-context" : "psi");
  const actual = requested === "analysis-api" ? "fe10-binding-context" : requested;
  const fallbackReason =
    requested === "analysis-api"
      ? analysisApiEnabled
        ? "Kotlin Analysis API runtime is gated on, but the isolated Analysis API runner did not return a usable report; using explicit FE10 BindingContext fallback."
        : "Kotlin Analysis API Gradle gate is disabled; enable -PpieceAnalysisApi.enabled=true before using the analysis-api backend."
      : undefined;
  return {
    requested,
    actual,
    declarations: "psi",
    symbols: actual === "fe10-binding-context" ? "fe10-binding-context" : "psi",
    diagnostics: semanticDiagnostics ? "kotlin-compiler-diagnostics" : "none",
    status: fallbackReason ? "fallback" : "ready",
    ...(fallbackReason ? { fallbackReason } : {}),
    ...(requested === "analysis-api" ? { analysisApiEnabled } : {}),
    ...(requested === "analysis-api" && analysisApiVersion ? { analysisApiVersion } : {})
  };
}

function errorKotlinPsiManifest({ filePath, source, parserName, backend, semanticDiagnostics, semanticSymbols, analysisApiEnabled, analysisApiVersion, commands }) {
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
    analysisBackend: kotlinAnalysisBackendMetadata({ backend, semanticDiagnostics, semanticSymbols, analysisApiEnabled, analysisApiVersion }),
    diagnostics: diagnosticsFromCommands(commands)
  };
}

function errorPicDslReport({ filePath, source, commands }) {
  return {
    version: 1,
    parser: "antlr-pic-parser",
    filePath,
    source,
    piecePackage: null,
    diagnostics: diagnosticsFromCommands(commands)
  };
}

function errorKotlinPicGenerationReport({ filePath, source, commands }) {
  return {
    version: 1,
    generator: "kotlin-psi-pic-generator",
    filePath,
    source,
    pic: "",
    piecePackage: null,
    diagnostics: diagnosticsFromCommands(commands)
  };
}

function hasErrorDiagnostics(diagnostics = []) {
  return diagnostics.some((diagnostic) => diagnostic.severity === "error");
}

export async function parsePieceDslFile(options = {}) {
  const filePath = options.filePath ?? "package.pic";
  const source = options.source ?? await readFile(resolveHostPath(filePath, options.cwd ?? process.cwd()), "utf8");
  const hostWorkspaceInfo = await prepareWorkspace("piece-pic-dsl-host-");
  const hostWorkspace = hostWorkspaceInfo.path;
  const sourceFile = join(hostWorkspace, sourceBasename(filePath, "package.pic"));
  const outputReport = join(hostWorkspace, "pic-report.json");

  try {
    await writeFile(sourceFile, source, "utf8");
    const args = [
      "-p",
      join(PACKAGE_ROOT, "piece-core"),
      "runPicParserBackend",
      "--quiet",
      `-PpieceDsl.filePath=${filePath}`,
      `-PpieceDsl.sourceFile=${sourceFile}`,
      `-PpieceDsl.outputReport=${outputReport}`
    ];

    const backendCommand = await runCommand(defaultGradleCommand(), args, {
      cwd: PACKAGE_ROOT,
      env: options.env,
      ...actionRunnerOptionsFor(options)
    });
    if (canUseNodeActionOutput(backendCommand) && (await pathExists(outputReport))) {
      return readJsonFile(outputReport);
    }
    return errorPicDslReport({ filePath, source, commands: [backendCommand] });
  } finally {
    await cleanupWorkspace(hostWorkspace, false);
  }
}

export async function mergePieceDslFiles(options = {}) {
  const generatedFilePath = options.generatedFilePath ?? "generated.pic";
  const overrideFilePath = options.overrideFilePath ?? "override.pic";
  const generated = options.generatedPackage
    ? {
        piecePackage: options.generatedPackage,
        diagnostics: []
      }
    : await parsePieceDslFile({
        filePath: generatedFilePath,
        source: options.generatedSource,
        cwd: options.cwd,
        env: options.env,
        actionRunner: options.actionRunner
      });
  const override = await parsePieceDslFile({
    filePath: overrideFilePath,
    source: options.overrideSource,
    cwd: options.cwd,
    env: options.env,
    actionRunner: options.actionRunner
  });
  const parseDiagnostics = [...(generated.diagnostics ?? []), ...(override.diagnostics ?? [])];

  if (hasErrorDiagnostics(parseDiagnostics) || !generated.piecePackage || !override.piecePackage) {
    return {
      version: 1,
      merger: "piece-dsl-merge",
      generatedFilePath,
      overrideFilePath,
      pieceDsl: "",
      piecePackage: null,
      diagnostics: parseDiagnostics
    };
  }

  const merged = mergePiecePackages(generated.piecePackage, override.piecePackage);
  const pieceDsl = merged.piecePackage ? piecePackageToPicDsl(merged.piecePackage) : "";
  return {
    version: 1,
    merger: "piece-dsl-merge",
    generatedFilePath,
    overrideFilePath,
    pieceDsl,
    piecePackage: merged.piecePackage,
    diagnostics: [...parseDiagnostics, ...(merged.diagnostics ?? [])]
  };
}

export async function generateKotlinPieceDslFile(options = {}) {
  const filePath = options.filePath ?? "Main.kt";
  const source = options.source ?? "";
  const backend = normalizeKotlinAnalysisBackend(options.backend);
  const analysisApiEnabled = options.analysisApiEnabled === true || options.kotlinAnalysisApiEnabled === true;
  const analysisApiVersion = options.analysisApiVersion ?? options.kotlinAnalysisApiVersion;
  const hostWorkspaceInfo = await prepareWorkspace("piece-kotlin-pic-host-");
  const hostWorkspace = hostWorkspaceInfo.path;
  const sourceFile = join(hostWorkspace, sourceBasename(filePath, "Main.kt"));
  const outputReport = join(hostWorkspace, "kotlin-pic-report.json");

  try {
    await writeFile(sourceFile, source, "utf8");
    const args = [
      "-p",
      join(PACKAGE_ROOT, "piece-core"),
      "runKotlinPicGeneratorBackend",
      "--quiet",
      `-PpieceAnalysisApi.enabled=${analysisApiEnabled ? "true" : "false"}`,
      ...(analysisApiVersion ? [`-PpieceAnalysisApi.version=${analysisApiVersion}`] : []),
      `-PpiecePic.filePath=${filePath}`,
      `-PpiecePic.sourceFile=${sourceFile}`,
      `-PpiecePic.outputReport=${outputReport}`,
      `-PpiecePic.backend=${backend ?? ""}`
    ];

    const backendCommand = await runCommand(defaultGradleCommand(), args, {
      cwd: PACKAGE_ROOT,
      env: options.env,
      ...actionRunnerOptionsFor(options)
    });
    if (canUseNodeActionOutput(backendCommand) && (await pathExists(outputReport))) {
      return readJsonFile(outputReport);
    }
    return errorKotlinPicGenerationReport({ filePath, source, commands: [backendCommand] });
  } finally {
    await cleanupWorkspace(hostWorkspace, false);
  }
}

function jsTsLanguageForFile(filePath, fallback = "javascript") {
  if (/\.(?:tsx?|mts|cts)$/i.test(filePath ?? "")) return "typescript";
  if (/\.(?:jsx?|mjs|cjs)$/i.test(filePath ?? "")) return "javascript";
  return fallback;
}

function jsTsOutputName(filePath) {
  const sourceName = sourceBasename(filePath, "main.ts");
  return `${sanitizeProjectName(sourceName.replace(/\.[^.]+$/, ""))}.js`;
}

function esbuildErrorText(error) {
  const errors = error?.errors ?? [];
  if (errors.length > 0) {
    return errors
      .map((entry) => {
        const location = entry.location ? `${entry.location.file}:${entry.location.line}:${entry.location.column}: ` : "";
        return `${location}${entry.text}`;
      })
      .join("\n");
  }
  return error?.message ?? String(error);
}

async function runEsbuildCompileCommand(buildOptions, commandArgs, cwd) {
  const startedAt = performance.now();
  try {
    const result = await esbuild.build(buildOptions);
    return {
      command: "esbuild",
      args: commandArgs,
      cwd,
      exitCode: 0,
      signal: null,
      stdout: "",
      stderr: (result.warnings ?? []).map((warning) => warning.text).join("\n"),
      durationMs: durationSince(startedAt)
    };
  } catch (error) {
    return {
      command: "esbuild",
      args: commandArgs,
      cwd,
      exitCode: 1,
      signal: null,
      stdout: "",
      stderr: esbuildErrorText(error),
      durationMs: durationSince(startedAt)
    };
  }
}

export async function compileJavaScriptPieceFile(options = {}) {
  const filePath = options.filePath ?? "main.ts";
  const cwd = resolve(options.cwd ?? process.cwd());
  const sourcePath = resolveHostPath(filePath, cwd);
  const source = options.source ?? ((await pathExists(sourcePath)) ? await readFile(sourcePath, "utf8") : "");
  const language = jsTsLanguageForFile(filePath, options.language === "typescript" ? "typescript" : "javascript");
  const pieceAction = resolveCompilePieceAction(options);
  const workspaceInfo = await prepareWorkspace("piece-js-ts-", options.workspace);
  const workspace = workspaceInfo.path;
  const outputDir = resolve(options.outDir ?? join(workspace, "piece-out"));
  const sourceFile = join(workspace, sourceBasename(filePath, language === "typescript" ? "main.ts" : "main.js"));
  const outputFile = join(outputDir, jsTsOutputName(filePath));
  const target = options.target ?? "esm";
  const platform = options.platform ?? "browser";
  const format = options.format ?? "esm";

  try {
    await mkdir(outputDir, { recursive: true });
    await writeFile(sourceFile, source, "utf8");
    const buildOptions = {
      entryPoints: [sourceFile],
      outfile: outputFile,
      bundle: options.bundle ?? true,
      platform,
      format,
      sourcemap: options.sourcemap ?? false,
      write: true,
      logLevel: "silent"
    };
    const commandArgs = [
      sourceFile,
      "--bundle",
      `--outfile=${outputFile}`,
      `--platform=${platform}`,
      `--format=${format}`
    ];
    const command = await runEsbuildCompileCommand(buildOptions, commandArgs, workspace);
    const outputFiles = await collectFiles(outputDir);
    const result = {
      version: 1,
      language,
      backend: "esbuild",
      filePath,
      target,
      workspace: options.keepWorkspace ? workspace : undefined,
      ...(pieceAction ? { pieceAction } : {}),
      outputFiles,
      commands: [command],
      status: compileStatus([command]),
      diagnostics: diagnosticsFromCommands([command])
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

export async function compileGoPieceFile(options = {}) {
  const filePath = options.filePath ?? "Main.go";
  const source = options.source ?? "";
  const pieceAction = resolveCompilePieceAction(options);
  const cwd = resolve(options.cwd ?? process.cwd());
  const workspaceInfo = await prepareWorkspace("piece-go-", options.workspace);
  const workspace = workspaceInfo.path;
  const outputDir = resolve(options.outDir ?? join(workspace, "piece-out"));
  const sourceName = sourceBasename(filePath, "Main.go");
  const packageName = packageNameFromGo(source);
  const companionSources = (await collectGoCompanionSources(options, filePath)).filter(
    (companion) => packageNameFromGo(companion.source ?? "") === packageName
  );
  const goCommand = options.goCommand ?? "go";
  const modulePath = options.modulePath ?? `piece.local/${sanitizeProjectName(sourceName.replace(/\.go$/, ""))}`;
  const actionRunner = actionRunnerOptionsFor(options);
  const commands = [];

  try {
    await mkdir(outputDir, { recursive: true });
    await writeGoWorkspaceSources({ workspace, filePath, source, companions: companionSources, cwd });
    await writeFile(join(workspace, "go.mod"), `module ${modulePath}\n\ngo 1.22\n`, "utf8");

    const goListCommand = await runCommand(goCommand, ["list", "-json", "./..."], { cwd: workspace, env: options.env, ...actionRunner });
    commands.push(goListCommand);
    const goList = createGoListReport(goListCommand, workspace);
    const buildArgs = packageName === "main" ? ["build", "-o", join(outputDir, sanitizeProjectName(sourceName.replace(/\.go$/, ""))), "."] : ["build", "./..."];
    commands.push(await runCommand(goCommand, buildArgs, { cwd: workspace, env: options.env, ...actionRunner }));
    if ((options.runTests ?? true) && commands.at(-1)?.exitCode === 0) {
      commands.push(await runCommand(goCommand, ["test", "./..."], { cwd: workspace, env: options.env, ...actionRunner }));
    }

    const outputFiles = await collectFiles(outputDir);
    const result = {
      version: 1,
      language: "go",
      filePath,
      target: packageName === "main" ? "binary" : "package",
      status: compileStatus(commands),
      goList,
      workspace: options.keepWorkspace ? workspace : undefined,
      ...(pieceAction ? { pieceAction } : {}),
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

export function createNodeGoDeclarationExtractor(options = {}) {
  const baseExtractor = options.declarationExtractor ?? createGoDeclarationExtractor(options);
  const actionRunner = actionRunnerOptionsFor(options);
  return {
    name: options.name ?? baseExtractor.name,
    async extract({ filePath, source, previousTree }) {
      const cwd = resolve(options.cwd ?? process.cwd());
      const companionSources = await collectGoCompanionSources(options, filePath);
      let manifest;
      if (options.goAnalyzer === false || options.backend === "javascript") {
        manifest = await baseExtractor.extract({ filePath, source, previousTree });
      } else {
        const analyzerResult = await runGoAstAnalyzer({
          filePath,
          source,
          goCommand: options.goCommand ?? "go",
          env: options.env,
          actionRunner
        });
        if (analyzerResult.manifest) {
          manifest = analyzerResult.manifest;
        } else {
          const fallbackManifest = await baseExtractor.extract({ filePath, source, previousTree });
          const diagnostic = goAnalyzerFallbackDiagnostic(
            analyzerResult.command,
            analyzerResult.error ? `Go AST analyzer returned invalid JSON: ${analyzerResult.error.message}` : undefined
          );
          manifest = {
            ...fallbackManifest,
            analysisBackend: goAnalyzerFallbackBackend(diagnostic.message),
            diagnostics: [...(fallbackManifest.diagnostics ?? []), diagnostic]
          };
        }
      }
      let companionBindingResult = { bindings: [], declarations: [], diagnostics: [] };
      if (options.goAnalyzer !== false && options.backend !== "javascript" && companionSources.length > 0) {
        companionBindingResult = await collectGoCompanionBindings({
          companions: companionSources,
          goCommand: options.goCommand ?? "go",
          env: options.env,
          actionRunner
        });
        manifest = attachGoCompanionBindings(
          manifest,
          companionBindingResult.bindings,
          companionBindingResult.diagnostics
        );
      }
      if (options.goList === false) {
        return manifest;
      }
      const result = await collectGoListForSource({
        filePath,
        source,
        companions: companionSources,
        goCommand: options.goCommand ?? "go",
        modulePath: options.modulePath ?? options.goModulePath,
        env: options.env,
        actionRunner,
        cwd
      });
      const packageScope = createGoPackageScope({
        filePath,
        source,
        companions: companionSources,
        declarations: companionBindingResult.declarations
      });
      const toolchain = createGoListToolchainMetadata(result.goList, packageScope);
      return {
        ...manifest,
        toolchain,
        toolchains: [toolchain],
        diagnostics: [...(manifest.diagnostics ?? []), ...goListManifestDiagnostics(result.command, result.goList)]
      };
    }
  };
}

export async function compileKotlinPieceFile(options = {}) {
  const filePath = options.filePath ?? "Main.kt";
  const cwd = resolve(options.cwd ?? process.cwd());
  const sourcePath = resolveHostPath(filePath, cwd);
  const source = options.source ?? ((await pathExists(sourcePath)) ? await readFile(sourcePath, "utf8") : "");
  const target = options.target ?? "jvm";
  const pieceAction = resolveCompilePieceAction(options);
  const projectRootOption = options.gradleProjectRoot ?? options.projectRoot;
  const projectRoot = projectRootOption ? resolveHostPath(String(projectRootOption), cwd) : undefined;
  const companionSources = await collectKotlinCompanionSources(options, filePath);
  if (!["jvm", "js", "wasmJs", "all"].includes(target)) {
    throw new TypeError(`Unsupported Kotlin compile target: ${target}`);
  }
  const gradleCommand = projectRoot ? await resolveProjectGradleCommand(options.gradleCommand, projectRoot) : resolveGradleCommand(options.gradleCommand);

  const hostWorkspaceInfo = await prepareWorkspace("piece-kotlin-host-");
  const hostWorkspace = hostWorkspaceInfo.path;
  const sourceFile = join(hostWorkspace, sourceBasename(filePath, "Main.kt"));
  const companionDir = join(hostWorkspace, "compile-companions");
  const companionSourcesFile = join(hostWorkspace, "compile-companion-sources.tsv");
  const outputReport = join(hostWorkspace, "compile-report.json");

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
      "runKotlinCompileBackend",
      "--quiet",
      `-PpieceCompile.filePath=${filePath}`,
      `-PpieceCompile.sourceFile=${sourceFile}`,
      `-PpieceCompile.outputReport=${outputReport}`,
      `-PpieceCompile.target=${target}`,
      `-PpieceCompile.sourceSet=${options.sourceSet ?? ""}`,
      `-PpieceCompile.projectRoot=${projectRoot ?? ""}`,
      `-PpieceCompile.gradleCommand=${gradleCommand}`,
      `-PpieceCompile.gradleVersion=${options.gradleVersion ?? ""}`,
      `-PpieceCompile.kotlinPluginVersion=${options.kotlinPluginVersion ?? ""}`,
      `-PpieceCompile.tasks=${options.tasks?.join(",") ?? ""}`,
      `-PpieceCompile.keepWorkspace=${options.keepWorkspace ? "true" : "false"}`,
      `-PpieceCompile.companionSources=${companionLines.length > 0 ? companionSourcesFile : ""}`,
      `-PpieceCompile.pieceTargetLabel=${pieceAction?.targetLabel ?? ""}`,
      `-PpieceCompile.pieceActionId=${pieceAction?.actionId ?? ""}`,
      `-PpieceCompile.pieceArtifactId=${pieceAction?.artifactId ?? ""}`,
      `-PpieceCompile.pieceActionKind=${pieceAction?.kind ?? "compile"}`,
      `-PpieceCompile.pieceTarget=${options.pieceTarget ?? ""}`,
      `-PpieceCompile.pieceActionName=${options.pieceActionName ?? ""}`
    ];
    if (options.workspace) {
      args.push(`-PpieceCompile.workspace=${resolve(options.workspace)}`);
    }

    const backendCommand = await runCommand(defaultGradleCommand(), args, {
      cwd: PACKAGE_ROOT,
      env: options.env,
      ...actionRunnerOptionsFor(options)
    });
    if (canUseNodeActionOutput(backendCommand) && (await pathExists(outputReport))) {
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
      ...(projectRoot ? { projectRoot } : {}),
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

export async function compilePieceAction(options = {}) {
  const actionPackage = actionPackageForCompileAction(options);
  if (!actionPackage) {
    throw new Error("compilePieceAction() requires actionPackage or analysis with a Piece package.");
  }
  const filePath = filePathForCompileAction(options, actionPackage);
  if (!filePath) {
    throw new Error("compilePieceAction() requires filePath or an analyzed Piece package filePath.");
  }
  const source = sourceForCompileAction(options);
  const compileOptions = {
    ...options,
    filePath,
    actionPackage
  };
  if (source !== undefined) {
    compileOptions.source = source;
  }

  const language = languageForCompileAction(options, actionPackage, filePath);
  const actionDetails = selectCompileActionDetails(actionPackage, options);
  compileOptions.pieceAction = actionDetails.pieceAction;
  const baseActionCacheRecord = createPieceActionCacheRecord({
    actionPackage,
    target: actionDetails.target,
    action: actionDetails.action,
    artifact: actionDetails.artifact,
    analysis: options.analysis,
    actionCache: options.analysis?.actionCache,
    language,
    filePath,
    source
  });
  const actionCacheSource = await sourceForLocalActionCache(options, source, filePath);
  const secureActionCacheRecord = actionCacheSource.source === undefined
    ? { reason: actionCacheSource.reason }
    : createSecureLocalActionCacheRecord(baseActionCacheRecord, options, actionCacheSource.source);
  const actionCacheRecord = secureActionCacheRecord.record;
  const storePath = localActionCacheStorePath(options);
  const storeLookup =
    storePath && options.actionCacheMode !== "bypass" && options.actionCacheRecords !== false
      ? await readLocalActionCacheStoreRecords(storePath)
      : { records: [] };
  const lookupRecords = actionCacheLookupRecords(options, storeLookup.records);
  let actionCache = appendActionCacheReasons(
    explainPieceActionCacheStatus({
      record: actionCacheRecord,
      records: lookupRecords,
      mode: options.actionCacheMode,
      analysis: options.analysis,
      actionPackage,
      artifact: actionDetails.artifact
    }),
    [storeLookup.reason, actionCacheSource.reason, secureActionCacheRecord.reason].filter(Boolean)
  );
  if (actionCacheReuseRequested(options) && actionCache.status === "hit") {
    const matchedRecord = matchedActionCacheRecord(lookupRecords, actionCache.matchedRecordKey);
    const validation = await validateCachedActionArtifacts(matchedRecord, storePath);
    if (validation.status === "ready") {
      return cachedActionCompileResult({
        record: matchedRecord,
        actionCache,
        validation,
        language,
        filePath,
        pieceAction: actionDetails.pieceAction
      });
    }
    actionCache = actionCacheWithReuseMiss(actionCache, validation, matchedRecord);
  }
  const actionCacheCompileWorkspace = await prepareActionCacheCompileWorkspace(options, storePath);
  if (actionCacheCompileWorkspace) {
    compileOptions.workspace = actionCacheCompileWorkspace.path;
  }

  try {
    let result;
    if (language === "go") {
      result = await compileGoPieceFile(compileOptions);
    } else if (language === "kotlin") {
      result = await compileKotlinPieceFile(compileOptions);
    } else if (language === "typescript" || language === "javascript") {
      result = await compileJavaScriptPieceFile({ ...compileOptions, language });
    } else {
      throw new Error(`Unsupported Piece compile action language: ${language}.`);
    }
    const persistence = await persistLocalActionCacheRecord(storePath, actionCacheRecord, result, actionCache);
    if (persistence) {
      actionCache = {
        ...actionCache,
        persistence
      };
    }
    return {
      ...result,
      actionCache
    };
  } finally {
    if (actionCacheCompileWorkspace) {
      await cleanupWorkspace(actionCacheCompileWorkspace.path, false);
    }
  }
}

export async function analyzeKotlinPieceFile(options = {}) {
  const filePath = options.filePath ?? "Main.kt";
  const source = options.source ?? "";
  const parserName = options.parserName ?? "kotlin-psi-declaration-extractor";
  const backend = normalizeKotlinAnalysisBackend(options.backend ?? options.kotlinAnalysisBackend);
  const analysisApiEnabled = options.analysisApiEnabled === true || options.kotlinAnalysisApiEnabled === true;
  const analysisApiVersion = options.analysisApiVersion ?? options.kotlinAnalysisApiVersion;
  const semanticDiagnostics = options.semanticDiagnostics === true;
  const semanticSymbols = options.semanticSymbols === true;
  const projectModel = focusKotlinProjectModel(await collectKotlinGradleProjectModel(options), { ...options, filePath });
  const analysisOptions = mergeKotlinProjectModelOptions(options, projectModel);
  const companionSources = await collectKotlinCompanionSources(analysisOptions, filePath);
  const hostWorkspaceInfo = await prepareWorkspace("piece-kotlin-analysis-host-");
  const hostWorkspace = hostWorkspaceInfo.path;
  const sourceFile = join(hostWorkspace, sourceBasename(filePath, "Main.kt"));
  const companionDir = join(hostWorkspace, "companions");
  const companionSourcesFile = join(hostWorkspace, "companion-sources.tsv");
  const classpathFile = join(hostWorkspace, "analysis-classpath.txt");
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
    const classpath = collectKotlinClasspath(analysisOptions);
    if (classpath.length > 0) {
      await writeFile(classpathFile, `${classpath.join("\n")}\n`, "utf8");
    }
    const args = [
      "-p",
      join(PACKAGE_ROOT, "piece-core"),
      "runKotlinPsiAnalysisBackend",
      "--quiet",
      `-PpieceAnalysisApi.enabled=${analysisApiEnabled ? "true" : "false"}`,
      ...(analysisApiVersion ? [`-PpieceAnalysisApi.version=${analysisApiVersion}`] : []),
      `-PpieceAnalysis.filePath=${filePath}`,
      `-PpieceAnalysis.sourceFile=${sourceFile}`,
      `-PpieceAnalysis.outputReport=${outputReport}`,
      `-PpieceAnalysis.parserName=${parserName}`,
      `-PpieceAnalysis.backend=${backend ?? ""}`,
      `-PpieceAnalysis.semanticDiagnostics=${semanticDiagnostics ? "true" : "false"}`,
      `-PpieceAnalysis.semanticSymbols=${semanticSymbols ? "true" : "false"}`,
      `-PpieceAnalysis.companionSources=${companionLines.length > 0 ? companionSourcesFile : ""}`,
      `-PpieceAnalysis.classpathFile=${classpath.length > 0 ? classpathFile : ""}`
    ];

    const backendCommand = await runCommand(defaultGradleCommand(), args, {
      cwd: PACKAGE_ROOT,
      env: options.env,
      ...actionRunnerOptionsFor(options)
    });
    if (canUseNodeActionOutput(backendCommand) && (await pathExists(outputReport))) {
      return attachKotlinProjectModel(await readJsonFile(outputReport), projectModel);
    }
    return attachKotlinProjectModel(
      errorKotlinPsiManifest({
        filePath,
        source,
        parserName,
        backend,
        semanticDiagnostics,
        semanticSymbols,
        analysisApiEnabled,
        analysisApiVersion,
        commands: [backendCommand]
      }),
      projectModel
    );
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
        backend: options.backend,
        analysisApiEnabled: options.analysisApiEnabled === true || options.kotlinAnalysisApiEnabled === true,
        analysisApiVersion: options.analysisApiVersion ?? options.kotlinAnalysisApiVersion,
        semanticDiagnostics: options.semanticDiagnostics === true,
        semanticSymbols: options.semanticSymbols === true,
        sourceFiles: options.sourceFiles,
        sourceRoots: options.sourceRoots,
        classpath: options.classpath,
        projectRoot: options.projectRoot,
        gradleProjectRoot: options.gradleProjectRoot,
        gradleCommand: options.gradleCommand,
        gradleVersion: options.gradleVersion,
        cwd: options.cwd,
        env: options.env,
        actionRunner: options.actionRunner
      });
    }
  };
}
