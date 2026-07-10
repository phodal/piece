import { access, readFile, realpath, stat } from "node:fs/promises";
import { constants } from "node:fs";
import { delimiter, dirname, basename, isAbsolute, join, posix, relative, resolve, sep, win32 } from "node:path";
import { fileURLToPath } from "node:url";
import { analyzePieceFile } from "../node.js";
import { PieceWorkspaceCliConfigError, normalizePieceWorkspaceCliConfig, runPieceWorkspaceCliTask } from "./workspace.js";

export const PIECE_CLI_RESULT_SCHEMA_VERSION = 1;
export const PIECE_CONFIG_FILE_NAME = "piece.config.json";

const PACKAGE_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const V1_CONFIG_KEYS = new Set([
  "schemaVersion",
  "entry",
  "sourceRoots",
  "globals",
  "packageScopeSelection",
  "sourceSetScopeSelection"
]);
const SCOPE_SELECTIONS = new Set(["current-file", "safe"]);

export class PieceCliError extends Error {
  constructor(code, message, exitCode, cause) {
    super(message, cause ? { cause } : undefined);
    this.name = "PieceCliError";
    this.code = code;
    this.exitCode = exitCode;
  }
}

class PieceCliUsageError extends PieceCliError {
  constructor(code, message, cause) {
    super(code, message, 2, cause);
    this.name = "PieceCliUsageError";
  }
}

class PieceCliAnalysisError extends PieceCliError {
  constructor(code, message, cause) {
    super(code, message, 1, cause);
    this.name = "PieceCliAnalysisError";
  }
}

class PieceCliInfrastructureError extends PieceCliError {
  constructor(code, message, cause) {
    super(code, message, 4, cause);
    this.name = "PieceCliInfrastructureError";
  }
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function isPathInside(root, candidate) {
  const pathFromRoot = relative(root, candidate);
  return pathFromRoot === "" || (!pathFromRoot.startsWith(`..${sep}`) && pathFromRoot !== ".." && !isAbsolute(pathFromRoot));
}

function assertNonEmptyString(value, name) {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new PieceCliUsageError("invalid-option-value", `${name} must be a non-empty string.`);
  }
  return value;
}

function normalizeStringList(value, name) {
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string" || item.trim().length === 0)) {
    throw new PieceCliUsageError("invalid-config-type", `${name} must be an array of non-empty strings.`);
  }
  return [...value];
}

function normalizeScopeSelection(value, name) {
  if (!SCOPE_SELECTIONS.has(value)) {
    throw new PieceCliUsageError("invalid-config-value", `${name} must be one of: ${[...SCOPE_SELECTIONS].join(", ")}.`);
  }
  return value;
}

function normalizeConfig(value) {
  if (!isPlainObject(value)) {
    throw new PieceCliUsageError("invalid-config", "piece.config.json must contain a JSON object.");
  }
  if (value.schemaVersion === 2) {
    try {
      return normalizePieceWorkspaceCliConfig(value);
    } catch (error) {
      if (error instanceof PieceWorkspaceCliConfigError) {
        throw new PieceCliUsageError(error.code, error.message, error);
      }
      throw error;
    }
  }
  for (const key of Object.keys(value)) {
    if (!V1_CONFIG_KEYS.has(key)) {
      throw new PieceCliUsageError("unknown-config-key", `piece.config.json contains unsupported key '${key}'.`);
    }
  }
  if (value.schemaVersion !== 1) {
    throw new PieceCliUsageError("unsupported-config-schema", "piece.config.json must set schemaVersion to 1.");
  }

  const config = { schemaVersion: 1 };
  if (value.entry !== undefined) config.entry = assertNonEmptyString(value.entry, "config.entry");
  if (value.sourceRoots !== undefined) config.sourceRoots = normalizeStringList(value.sourceRoots, "config.sourceRoots");
  if (value.globals !== undefined) config.globals = normalizeStringList(value.globals, "config.globals");
  if (value.packageScopeSelection !== undefined) {
    config.packageScopeSelection = normalizeScopeSelection(value.packageScopeSelection, "config.packageScopeSelection");
  }
  if (value.sourceSetScopeSelection !== undefined) {
    config.sourceSetScopeSelection = normalizeScopeSelection(value.sourceSetScopeSelection, "config.sourceSetScopeSelection");
  }
  return config;
}

function splitOption(token) {
  const equalsIndex = token.indexOf("=");
  return equalsIndex === -1 ? [token, undefined] : [token.slice(0, equalsIndex), token.slice(equalsIndex + 1)];
}

function readFlagValue(argv, index, flag, inlineValue) {
  if (inlineValue !== undefined) {
    return { value: assertNonEmptyString(inlineValue, flag), nextIndex: index };
  }
  const value = argv[index + 1];
  if (value === undefined || value.startsWith("-")) {
    throw new PieceCliUsageError("missing-option-value", `${flag} requires a value.`);
  }
  return { value, nextIndex: index + 1 };
}

export function parsePieceCliArguments(argv = []) {
  if (!Array.isArray(argv) || argv.some((value) => typeof value !== "string")) {
    throw new PieceCliUsageError("invalid-arguments", "CLI arguments must be strings.");
  }

  const options = {
    format: "human",
    formatProvenance: "default",
    noColor: false,
    noColorProvenance: "default"
  };
  const seen = new Set();
  const positionals = [];
  let positionalOnly = false;

  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (positionalOnly) {
      positionals.push(token);
      continue;
    }
    if (token === "--") {
      positionalOnly = true;
      continue;
    }
    if (token === "-h" || token === "--help") {
      if (seen.has("help")) throw new PieceCliUsageError("duplicate-option", "--help may only be specified once.");
      options.help = true;
      seen.add("help");
      continue;
    }
    if (token === "-v" || token === "--version") {
      if (seen.has("version")) throw new PieceCliUsageError("duplicate-option", "--version may only be specified once.");
      options.version = true;
      seen.add("version");
      continue;
    }
    if (token === "--no-color") {
      if (seen.has("no-color")) throw new PieceCliUsageError("duplicate-option", "--no-color may only be specified once.");
      options.noColor = true;
      options.noColorProvenance = "flag";
      seen.add("no-color");
      continue;
    }
    if (token.startsWith("--")) {
      const [flag, inlineValue] = splitOption(token);
      if (!["--workspace", "--config", "--format"].includes(flag)) {
        throw new PieceCliUsageError("unknown-option", `Unknown option '${flag}'.`);
      }
      const optionName = flag.slice(2);
      if (seen.has(optionName)) throw new PieceCliUsageError("duplicate-option", `${flag} may only be specified once.`);
      const result = readFlagValue(argv, index, flag, inlineValue);
      index = result.nextIndex;
      seen.add(optionName);
      if (flag === "--format") {
        if (!["human", "json"].includes(result.value)) {
          throw new PieceCliUsageError("invalid-option-value", "--format must be either 'human' or 'json'.");
        }
        options.format = result.value;
        options.formatProvenance = "flag";
      } else {
        options[optionName] = result.value;
      }
      continue;
    }
    if (token.startsWith("-")) {
      throw new PieceCliUsageError("unknown-option", `Unknown option '${token}'.`);
    }
    positionals.push(token);
  }

  if (options.help && options.version) {
    throw new PieceCliUsageError("conflicting-options", "--help and --version cannot be used together.");
  }
  if (options.help || options.version) {
    if (positionals.length > 1) {
      throw new PieceCliUsageError("unexpected-argument", "Help and version accept at most one command name.");
    }
    return {
      ...options,
      command: positionals[0],
      entry: undefined
    };
  }
  if (positionals.length === 0) {
    throw new PieceCliUsageError("missing-command", "A command is required. Run 'piece --help' for usage.");
  }
  const [command, ...argumentsAfterCommand] = positionals;
  if (!["analyze", "doctor", "build", "check"].includes(command)) {
    throw new PieceCliUsageError("unknown-command", `Unknown command '${command}'.`);
  }
  if (command === "doctor" && argumentsAfterCommand.length > 0) {
    throw new PieceCliUsageError("unexpected-argument", "piece doctor does not accept an entry path.");
  }
  if (command === "analyze" && argumentsAfterCommand.length > 1) {
    throw new PieceCliUsageError("unexpected-argument", "piece analyze accepts exactly one optional entry path.");
  }
  if (["build", "check"].includes(command) && argumentsAfterCommand.length > 1) {
    throw new PieceCliUsageError("unexpected-argument", `piece ${command} accepts at most one optional project id.`);
  }
  return {
    ...options,
    command,
    entry: command === "analyze" ? argumentsAfterCommand[0] : undefined,
    projectId: ["build", "check"].includes(command) ? argumentsAfterCommand[0] : undefined
  };
}

async function existingPath(path) {
  try {
    return await stat(path);
  } catch (error) {
    if (error?.code === "ENOENT") return undefined;
    throw new PieceCliInfrastructureError("path-inspection-failed", `Could not inspect '${path}': ${error?.message ?? String(error)}.`, error);
  }
}

async function resolveWorkspace(value, cwd) {
  const requested = resolve(cwd, value ?? ".");
  const info = await existingPath(requested);
  if (!info) throw new PieceCliUsageError("workspace-not-found", `Workspace '${requested}' does not exist.`);
  if (!info.isDirectory()) throw new PieceCliUsageError("workspace-not-directory", `Workspace '${requested}' is not a directory.`);
  try {
    return await realpath(requested);
  } catch (error) {
    throw new PieceCliInfrastructureError("workspace-resolution-failed", `Could not resolve workspace '${requested}': ${error?.message ?? String(error)}.`, error);
  }
}

function resolveInsideWorkspace(workspace, value, label) {
  const requested = assertNonEmptyString(value, label);
  const resolved = isAbsolute(requested) ? resolve(requested) : resolve(workspace, requested);
  if (!isPathInside(workspace, resolved)) {
    throw new PieceCliUsageError("workspace-path-escape", `${label} must stay inside workspace '${workspace}'.`);
  }
  return resolved;
}

async function resolveExistingInsideWorkspace(workspace, value, label) {
  const lexicalPath = resolveInsideWorkspace(workspace, value, label);
  const info = await existingPath(lexicalPath);
  if (!info) throw new PieceCliUsageError("path-not-found", `${label} '${lexicalPath}' does not exist.`);
  let canonicalPath;
  try {
    canonicalPath = await realpath(lexicalPath);
  } catch (error) {
    throw new PieceCliInfrastructureError("path-resolution-failed", `Could not resolve ${label} '${lexicalPath}': ${error?.message ?? String(error)}.`, error);
  }
  if (!isPathInside(workspace, canonicalPath)) {
    throw new PieceCliUsageError("workspace-path-escape", `${label} resolves outside workspace '${workspace}'.`);
  }
  return { path: canonicalPath, info };
}

async function loadConfig(workspace, configOption) {
  const provenance = configOption ? "flag" : "default";
  const candidate = resolveInsideWorkspace(workspace, configOption ?? PIECE_CONFIG_FILE_NAME, "config");
  if (basename(candidate) !== PIECE_CONFIG_FILE_NAME) {
    throw new PieceCliUsageError("invalid-config-name", `Configuration file must be named '${PIECE_CONFIG_FILE_NAME}'.`);
  }
  const info = await existingPath(candidate);
  if (!info) {
    if (configOption) throw new PieceCliUsageError("config-not-found", `Configuration file '${candidate}' does not exist.`);
    return {
      config: undefined,
      path: undefined,
      provenance: "none"
    };
  }
  if (!info.isFile()) throw new PieceCliUsageError("config-not-file", `Configuration path '${candidate}' is not a file.`);
  const resolvedConfig = await resolveExistingInsideWorkspace(workspace, candidate, "config");
  let source;
  try {
    source = await readFile(resolvedConfig.path, "utf8");
  } catch (error) {
    throw new PieceCliInfrastructureError("config-read-failed", `Could not read configuration '${resolvedConfig.path}': ${error?.message ?? String(error)}.`, error);
  }
  let parsed;
  try {
    parsed = JSON.parse(source);
  } catch (error) {
    throw new PieceCliUsageError("invalid-config-json", `Configuration '${resolvedConfig.path}' is not valid JSON: ${error?.message ?? String(error)}.`, error);
  }
  return {
    config: normalizeConfig(parsed),
    path: resolvedConfig.path,
    provenance
  };
}

async function validateConfiguredWorkspacePaths(workspace, config) {
  if (config.schemaVersion !== 1) {
    return;
  }
  const configuredPaths = [
    ...(config.entry ? [{ value: config.entry, label: "config.entry" }] : []),
    ...(config.sourceRoots ?? []).map((value) => ({ value, label: "config.sourceRoots" }))
  ];
  for (const configuredPath of configuredPaths) {
    const lexicalPath = resolveInsideWorkspace(workspace, configuredPath.value, configuredPath.label);
    const info = await existingPath(lexicalPath);
    if (!info) continue;
    let canonicalPath;
    try {
      canonicalPath = await realpath(lexicalPath);
    } catch (error) {
      throw new PieceCliInfrastructureError(
        "path-resolution-failed",
        `Could not resolve ${configuredPath.label} '${lexicalPath}': ${error?.message ?? String(error)}.`,
        error
      );
    }
    if (!isPathInside(workspace, canonicalPath)) {
      throw new PieceCliUsageError("workspace-path-escape", `${configuredPath.label} resolves outside workspace '${workspace}'.`);
    }
  }
}

function displayPath(workspace, path) {
  if (!path) return undefined;
  return relative(workspace, path) || ".";
}

async function resolveCliContext(parsed, cwd) {
  const workspace = await resolveWorkspace(parsed.workspace, cwd);
  const loadedConfig = await loadConfig(workspace, parsed.config);
  const config = loadedConfig.config ?? { schemaVersion: 1 };
  await validateConfiguredWorkspacePaths(workspace, config);
  return {
    workspace,
    workspaceProvenance: parsed.workspace ? "flag" : "default",
    config,
    configPath: loadedConfig.path,
    configProvenance: loadedConfig.provenance,
    format: parsed.format,
    formatProvenance: parsed.formatProvenance,
    noColor: parsed.noColor,
    noColorProvenance: parsed.noColorProvenance
  };
}

function contextResultFields(context, fallbackFormat = "human") {
  if (!context) {
    return {
      workspace: null,
      config: {
        path: null,
        provenance: "unknown",
        schemaVersion: null
      },
      invocation: {
        format: fallbackFormat,
        formatProvenance: "unknown",
        color: "not-emitted",
        colorProvenance: "unknown"
      }
    };
  }
  return {
    workspace: {
      path: context.workspace,
      provenance: context.workspaceProvenance
    },
    config: {
      path: context.configPath ?? null,
      provenance: context.configProvenance,
      schemaVersion: context.configPath ? context.config.schemaVersion : null
    },
    invocation: {
      format: context.format,
      formatProvenance: context.formatProvenance,
      color: context.noColor ? "disabled" : "not-emitted",
      colorProvenance: context.noColorProvenance
    }
  };
}

function normalizedDiagnostics(diagnostics = []) {
  return [...diagnostics]
    .map((diagnostic) => ({
      code: String(diagnostic?.code ?? "piece-diagnostic"),
      severity: diagnostic?.severity === "error" || diagnostic?.severity === "warning" ? diagnostic.severity : "info",
      message: String(diagnostic?.message ?? "Piece reported a diagnostic.")
    }))
    .sort((left, right) => `${left.severity}:${left.code}:${left.message}`.localeCompare(`${right.severity}:${right.code}:${right.message}`));
}

function normalizedReasons(reasons = []) {
  return [...reasons]
    .map((reason) => ({
      code: String(reason?.code ?? "piece-feedback-reason"),
      severity: reason?.severity === "error" || reason?.severity === "warning" ? reason.severity : "info",
      message: String(reason?.message ?? "Piece reported a feedback-scope reason.")
    }))
    .sort((left, right) => `${left.severity}:${left.code}:${left.message}`.localeCompare(`${right.severity}:${right.code}:${right.message}`));
}

function resultForError(error, parsed, context, format) {
  const pieceError =
    error instanceof PieceCliError
      ? error
      : new PieceCliInfrastructureError("unexpected-cli-error", error?.message ?? String(error), error);
  return {
    schemaVersion: PIECE_CLI_RESULT_SCHEMA_VERSION,
    command: parsed?.command ?? null,
    status: "failed",
    exitCode: pieceError.exitCode,
    ...contextResultFields(context, format),
    diagnostics: [
      {
        code: pieceError.code,
        severity: "error",
        message: pieceError.message
      }
    ]
  };
}

async function readEntry(context, parsed) {
  const entryValue = parsed.entry ?? context.config.entry;
  const provenance = parsed.entry ? "argument" : context.config.entry ? "config" : undefined;
  if (!entryValue) {
    throw new PieceCliUsageError("missing-entry", "piece analyze requires an entry path or config.entry.");
  }
  const entry = await resolveExistingInsideWorkspace(context.workspace, entryValue, "entry");
  if (!entry.info.isFile()) throw new PieceCliUsageError("entry-not-file", `Entry '${entry.path}' is not a file.`);
  let source;
  try {
    source = await readFile(entry.path, "utf8");
  } catch (error) {
    throw new PieceCliInfrastructureError("entry-read-failed", `Could not read entry '${entry.path}': ${error?.message ?? String(error)}.`, error);
  }
  return {
    path: entry.path,
    source,
    provenance
  };
}

async function resolveSourceRoots(context, entry) {
  const sourceRootValues = context.config.sourceRoots ?? [dirname(entry.path)];
  const provenance = context.config.sourceRoots ? "config" : "default";
  const paths = [];
  for (const sourceRoot of sourceRootValues) {
    const resolvedSourceRoot = await resolveExistingInsideWorkspace(context.workspace, sourceRoot, "source root");
    if (!resolvedSourceRoot.info.isDirectory()) {
      throw new PieceCliUsageError("source-root-not-directory", `Source root '${resolvedSourceRoot.path}' is not a directory.`);
    }
    paths.push(resolvedSourceRoot.path);
  }
  return {
    paths,
    provenance
  };
}

async function runAnalyze(parsed, context) {
  if (context.config.schemaVersion !== 1) {
    throw new PieceCliUsageError(
      "single-file-analysis-requires-config-v1",
      "piece analyze uses the schemaVersion 1 single-file configuration. Use piece build or piece check for a schemaVersion 2 workspace configuration."
    );
  }
  const entry = await readEntry(context, parsed);
  const sourceRoots = await resolveSourceRoots(context, entry);
  let analysis;
  try {
    analysis = await analyzePieceFile({
      filePath: entry.path,
      source: entry.source,
      sourceRoots: sourceRoots.paths,
      globals: context.config.globals,
      packageScopeSelection: context.config.packageScopeSelection,
      sourceSetScopeSelection: context.config.sourceSetScopeSelection,
      cwd: context.workspace
    });
  } catch (error) {
    throw new PieceCliAnalysisError("analysis-failed", `Could not analyze '${entry.path}': ${error?.message ?? String(error)}.`, error);
  }
  const diagnostics = normalizedDiagnostics(analysis.manifest?.diagnostics);
  const hasError = diagnostics.some((diagnostic) => diagnostic.severity === "error");
  const feedbackScope = analysis.feedbackScope ?? {};
  const result = {
    schemaVersion: PIECE_CLI_RESULT_SCHEMA_VERSION,
    command: "analyze",
    status: hasError ? "failed" : "success",
    exitCode: hasError ? 1 : 0,
    ...contextResultFields(context),
    input: {
      entry: {
        path: entry.path,
        workspaceRelativePath: displayPath(context.workspace, entry.path),
        provenance: entry.provenance
      },
      sourceRoots: {
        paths: sourceRoots.paths.map((path) => ({
          path,
          workspaceRelativePath: displayPath(context.workspace, path)
        })),
        provenance: sourceRoots.provenance
      }
    },
    analysis: {
      parser: analysis.manifest?.parser ?? "unknown",
      language: analysis.manifest?.language ?? "unknown",
      sliceCount: analysis.manifest?.slices?.length ?? 0,
      edgeCount: analysis.graph?.edges?.length ?? 0,
      previewTargetCount: analysis.previewTargets?.length ?? 0,
      feedbackScope: {
        level: feedbackScope.level ?? "unknown",
        fallbackRequired: feedbackScope.fallbackRequired === true,
        reasons: normalizedReasons(feedbackScope.reasons)
      },
      metrics: {
        totalMs: analysis.metrics?.totalMs ?? 0,
        extractMs: analysis.metrics?.phases?.extractMs ?? 0,
        graphMs: analysis.metrics?.phases?.graphMs ?? 0
      }
    },
    diagnostics
  };
  return result;
}

async function runWorkspaceCommand(parsed, context) {
  if (context.config.schemaVersion !== 2) {
    throw new PieceCliUsageError(
      "workspace-build-requires-config-v2",
      `piece ${parsed.command} requires a schemaVersion 2 configuration with explicit projects.`
    );
  }
  try {
    const result = await runPieceWorkspaceCliTask({
      command: parsed.command,
      workspace: context.workspace,
      config: context.config,
      projectId: parsed.projectId
    });
    return {
      ...result,
      ...contextResultFields(context)
    };
  } catch (error) {
    if (error instanceof PieceWorkspaceCliConfigError) {
      throw new PieceCliUsageError(error.code, error.message, error);
    }
    throw error;
  }
}

async function findExecutable(command) {
  const paths = String(process.env.PATH ?? "").split(delimiter).filter(Boolean);
  const suffixes = process.platform === "win32" ? [".exe", ".cmd", ".bat", ""] : [""];
  for (const directory of paths) {
    for (const suffix of suffixes) {
      const candidate = join(directory, `${command}${suffix}`);
      try {
        await access(candidate, constants.X_OK);
        return candidate;
      } catch {
        // Keep searching PATH; a later entry may be executable.
      }
    }
  }
  return undefined;
}

export function resolvePieceGradleWrapperPath({ platform = process.platform, packageRoot = PACKAGE_ROOT } = {}) {
  const path = platform === "win32" ? win32 : posix;
  return path.join(packageRoot, platform === "win32" ? "gradlew.bat" : "gradlew");
}

async function runDoctor(context) {
  const [go, java, gradle] = await Promise.all([findExecutable("go"), findExecutable("java"), findExecutable("gradle")]);
  const wrapper = resolvePieceGradleWrapperPath();
  const wrapperInfo = await existingPath(wrapper);
  return {
    schemaVersion: PIECE_CLI_RESULT_SCHEMA_VERSION,
    command: "doctor",
    status: "success",
    exitCode: 0,
    ...contextResultFields(context),
    capabilities: {
      commandSurface: ["analyze", "build", "check", "doctor"],
      build: context.config.schemaVersion === 2 ? "configured-workspace-fallback-v2" : "requires-workspace-config-v2",
      watch: "not-available",
      workspaceOrchestration: context.config.schemaVersion === 2 ? "explicit-project-graph" : "not-configured",
      scope: context.config.schemaVersion === 2 ? "declared-workspace-project-graph" : "single-file-feedback"
    },
    runtime: {
      node: {
        status: "ready",
        version: process.version,
        executable: process.execPath
      },
      tools: {
        go: go ? { status: "available", path: go } : { status: "missing" },
        java: java ? { status: "available", path: java } : { status: "missing" },
        gradle: gradle ? { status: "available", path: gradle } : { status: "missing" },
        pieceGradleWrapper: wrapperInfo?.isFile() ? { status: "available", path: wrapper } : { status: "missing" }
      }
    },
    diagnostics: []
  };
}

async function packageVersion() {
  try {
    const source = await readFile(join(PACKAGE_ROOT, "package.json"), "utf8");
    const value = JSON.parse(source);
    return String(value.version ?? "0.0.0");
  } catch (error) {
    throw new PieceCliInfrastructureError("package-version-read-failed", `Could not read Piece package version: ${error?.message ?? String(error)}.`, error);
  }
}

export function pieceCliHelpText() {
  return `Piece CLI — safe feedback analysis and declared workspace tasks\n\nUsage:\n  piece analyze <entry> [options]\n  piece build [project] [options]\n  piece check [project] [options]\n  piece doctor [options]\n\nCommands:\n  analyze <entry>  Analyze one source file with a schemaVersion 1 config.\n  build [project]  Execute a schemaVersion 2 project's native fallback build and its declared dependency closure.\n  check [project]  Execute a schemaVersion 2 project's native fallback check and its declared dependency closure.\n  doctor           Report the available local runtime and toolchain capabilities.\n\nOptions:\n  --workspace <path>       Workspace root (default: current directory).\n  --config <path>          Configuration file, named ${PIECE_CONFIG_FILE_NAME}.\n  --format <human|json>    Result format (default: human).\n  --no-color               Disable color output.\n  -h, --help               Show this help text.\n  -v, --version            Show the installed Piece version.\n\nWorkspace build/check use only explicit, allowlisted native fallback profiles.\nThey cover the declared project graph; Piece's per-file analysis is evidence,\nnot a claim that a single Piece action built an entire workspace project.\n`;
}

function humanResult(result) {
  if (result.kind === "help") return pieceCliHelpText();
  if (result.kind === "version") return `piece ${result.version}\n`;
  if (result.status === "failed") {
    const nativeFailure = result.projects
      ?.map((project) => ({ project: project.id, command: project.execution?.command }))
      .find(({ command }) => command?.stderrTail || command?.stdoutTail);
    const nativeOutput = nativeFailure?.command?.stderrTail || nativeFailure?.command?.stdoutTail;
    return `${result.command ? `piece ${result.command}` : "piece"} failed (exit ${result.exitCode})\n${result.diagnostics
      .map((diagnostic) => `${diagnostic.severity} ${diagnostic.code}: ${diagnostic.message}`)
      .join("\n")}${nativeOutput ? `\nnative output (${nativeFailure.project}):\n${nativeOutput}` : ""}\n`;
  }
  if (result.command === "analyze") {
    return `piece analyze succeeded\nentry: ${result.input.entry.workspaceRelativePath}\nparser: ${result.analysis.parser}\nslices: ${result.analysis.sliceCount}\nedges: ${result.analysis.edgeCount}\nfeedback scope: ${result.analysis.feedbackScope.level}${result.analysis.feedbackScope.fallbackRequired ? " (fallback required)" : ""}\n`;
  }
  if (result.command === "doctor") {
    return `piece doctor succeeded\nscope: ${result.capabilities.scope}\nworkspace orchestration: ${result.capabilities.workspaceOrchestration}\nnode: ${result.runtime.node.version}\n`;
  }
  if (result.command === "build" || result.command === "check") {
    const failedProjects = result.projects.filter((project) => project.execution.status !== "success").map((project) => project.id);
    return `piece ${result.command} ${result.status}\nproject: ${result.selection.projectId}\nclosure: ${result.selection.closure.join(", ")}\nprojects: ${result.projects.length}\n${failedProjects.length > 0 ? `failed projects: ${failedProjects.join(", ")}\n` : ""}`;
  }
  return `${JSON.stringify(result)}\n`;
}

function emitResult(result, format, io) {
  const text = format === "json" ? `${JSON.stringify(result)}\n` : humanResult(result);
  const stream = format === "json" ? io.stdout : io.stderr;
  stream.write(text);
}

function requestedFormat(argv) {
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === "--format" && argv[index + 1] === "json") return "json";
    if (token === "--format=json") return "json";
  }
  return "human";
}

export async function runPieceCli(argv = [], options = {}) {
  const io = {
    stdout: options.stdout ?? process.stdout,
    stderr: options.stderr ?? process.stderr
  };
  const cwd = options.cwd ?? process.cwd();
  let parsed;
  let context;
  let format = requestedFormat(argv);
  try {
    parsed = parsePieceCliArguments(argv);
    format = parsed.format;
    if (parsed.help) {
      const result = {
        schemaVersion: PIECE_CLI_RESULT_SCHEMA_VERSION,
        kind: "help",
        command: parsed.command ?? null,
        status: "success",
        exitCode: 0
      };
      emitResult(result, format, io);
      return 0;
    }
    if (parsed.version) {
      const result = {
        schemaVersion: PIECE_CLI_RESULT_SCHEMA_VERSION,
        kind: "version",
        command: parsed.command ?? null,
        status: "success",
        exitCode: 0,
        version: await packageVersion()
      };
      emitResult(result, format, io);
      return 0;
    }
    context = await resolveCliContext(parsed, cwd);
    const result =
      parsed.command === "analyze"
        ? await runAnalyze(parsed, context)
        : parsed.command === "build" || parsed.command === "check"
          ? await runWorkspaceCommand(parsed, context)
          : await runDoctor(context);
    emitResult(result, format, io);
    return result.exitCode;
  } catch (error) {
    const result = resultForError(error, parsed, context, format);
    emitResult(result, format, io);
    return result.exitCode;
  }
}
