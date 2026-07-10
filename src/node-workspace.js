import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { realpath, readdir, readFile, stat } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { analyzePieceFile } from "./node.js";
import { analyzeKotlinPieceFiles, prepareNodeGoWorkspaceManifests } from "./node-language-compilers.js";

const SOURCE_FILE_PATTERN = /\.(?:[cm]?[jt]sx?|go|kts?)$/i;
const SOURCE_EXTENSIONS = [".ts", ".tsx", ".mts", ".cts", ".js", ".jsx", ".mjs", ".cjs", ".go", ".kt", ".kts"];
const IGNORED_DIRECTORIES = new Set([".git", "node_modules", "dist", "build", "coverage", ".piece"]);
// Project ids become action ids and SCC component keys, so keep them in a
// compact label alphabet rather than embedding arbitrary config strings in
// delimiter-based identities.
const WORKSPACE_PROJECT_ID = /^[A-Za-z][A-Za-z0-9._-]*$/;
const WORKSPACE_ANALYSIS_OPTION_FIELDS = new Set(["compilerOptions", "globals", "packageScopeSelection", "sourceSetScopeSelection"]);
const WORKSPACE_SCOPE_SELECTIONS = new Set(["current-file", "safe"]);
const MAX_WORKSPACE_ANALYSIS_OPTION_DEPTH = 32;
const MAX_WORKSPACE_ANALYSIS_OPTION_ENTRIES = 10_000;
const DEFAULT_WORKSPACE_ANALYSIS_CONCURRENCY = 8;
const MAX_WORKSPACE_ANALYSIS_CONCURRENCY = 64;

/** A configuration or containment error raised before workspace analysis begins. */
export class PieceWorkspaceError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "PieceWorkspaceError";
    this.code = code;
  }
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function isPathInside(root, candidate) {
  const pathFromRoot = relative(root, candidate);
  return pathFromRoot === "" || (!pathFromRoot.startsWith(`..${sep}`) && pathFromRoot !== ".." && !isAbsolute(pathFromRoot));
}

function nonEmptyString(value, label) {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new PieceWorkspaceError("invalid-workspace-config", `${label} must be a non-empty string.`);
  }
  return value;
}

function stringList(value, label) {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== "string" || entry.trim().length === 0)) {
    throw new PieceWorkspaceError("invalid-workspace-config", `${label} must be an array of non-empty strings.`);
  }
  return [...value];
}

function workspaceAnalysisOptionsError(index, message) {
  throw new PieceWorkspaceError("invalid-workspace-analysis-options", `projects[${index}].analysisOptions ${message}`);
}

function ownEnumerableDataProperties(value, index, label) {
  let keys;
  let descriptors;
  try {
    keys = Object.keys(value);
    descriptors = Object.getOwnPropertyDescriptors(value);
  } catch {
    workspaceAnalysisOptionsError(index, `${label} must be plain data without proxy or accessor behavior.`);
  }
  if (keys.length > MAX_WORKSPACE_ANALYSIS_OPTION_ENTRIES) {
    workspaceAnalysisOptionsError(index, `${label} exceeds the maximum of ${MAX_WORKSPACE_ANALYSIS_OPTION_ENTRIES} entries.`);
  }
  for (const key of keys) {
    if (!Object.prototype.hasOwnProperty.call(descriptors[key] ?? {}, "value")) {
      workspaceAnalysisOptionsError(index, `${label}.${key} must not be an accessor property.`);
    }
  }
  return { keys, descriptors };
}

function isPlainDataObject(value) {
  if (!isPlainObject(value)) return false;
  try {
    const prototype = Object.getPrototypeOf(value);
    return prototype === Object.prototype || prototype === null;
  } catch {
    return false;
  }
}

function cloneWorkspaceAnalysisData(value, index, label, ancestors = new Set(), budget = { entries: 0 }, depth = 0) {
  budget.entries += 1;
  if (budget.entries > MAX_WORKSPACE_ANALYSIS_OPTION_ENTRIES) {
    workspaceAnalysisOptionsError(index, `${label} exceeds the maximum of ${MAX_WORKSPACE_ANALYSIS_OPTION_ENTRIES} total values.`);
  }
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value !== "object" || depth >= MAX_WORKSPACE_ANALYSIS_OPTION_DEPTH) {
    workspaceAnalysisOptionsError(
      index,
      `${label} must contain only finite JSON-compatible values no deeper than ${MAX_WORKSPACE_ANALYSIS_OPTION_DEPTH} levels.`
    );
  }
  if (ancestors.has(value)) {
    workspaceAnalysisOptionsError(index, `${label} must not contain circular data.`);
  }
  ancestors.add(value);
  try {
    if (Array.isArray(value)) {
      if (value.length > MAX_WORKSPACE_ANALYSIS_OPTION_ENTRIES) {
        workspaceAnalysisOptionsError(index, `${label} exceeds the maximum of ${MAX_WORKSPACE_ANALYSIS_OPTION_ENTRIES} entries.`);
      }
      const { keys, descriptors } = ownEnumerableDataProperties(value, index, label);
      if (keys.some((key) => !/^(?:0|[1-9]\d*)$/.test(key))) {
        workspaceAnalysisOptionsError(index, `${label} arrays must not define named properties.`);
      }
      const copy = [];
      for (let position = 0; position < value.length; position += 1) {
        const descriptor = descriptors[String(position)];
        if (!Object.prototype.hasOwnProperty.call(descriptor ?? {}, "value")) {
          workspaceAnalysisOptionsError(index, `${label} arrays must not be sparse or use accessors.`);
        }
        copy.push(cloneWorkspaceAnalysisData(descriptor.value, index, `${label}[${position}]`, ancestors, budget, depth + 1));
      }
      return copy;
    }
    if (!isPlainDataObject(value)) {
      workspaceAnalysisOptionsError(index, `${label} must be a plain JSON object.`);
    }
    const { keys, descriptors } = ownEnumerableDataProperties(value, index, label);
    const copy = {};
    for (const key of keys) {
      if (key === "__proto__" || key === "constructor" || key === "prototype") {
        workspaceAnalysisOptionsError(index, `${label}.${key} is not allowed.`);
      }
      copy[key] = cloneWorkspaceAnalysisData(descriptors[key].value, index, `${label}.${key}`, ancestors, budget, depth + 1);
    }
    return copy;
  } finally {
    ancestors.delete(value);
  }
}

function normalizeWorkspaceAnalysisOptions(value, index) {
  if (value === undefined) return {};
  if (!isPlainDataObject(value)) {
    workspaceAnalysisOptionsError(index, "must be a plain object when provided.");
  }
  const { keys, descriptors } = ownEnumerableDataProperties(value, index, "analysisOptions");
  const extras = keys.filter((key) => !WORKSPACE_ANALYSIS_OPTION_FIELDS.has(key));
  if (extras.length > 0) {
    workspaceAnalysisOptionsError(index, `contains unsupported field(s): ${extras.join(", ")}.`);
  }
  const normalized = {};
  const dataBudget = { entries: 0 };
  if (Object.prototype.hasOwnProperty.call(descriptors, "globals")) {
    const globals = cloneWorkspaceAnalysisData(descriptors.globals.value, index, "globals", new Set(), dataBudget);
    if (!Array.isArray(globals) || globals.some((entry) => typeof entry !== "string" || entry.length === 0)) {
      workspaceAnalysisOptionsError(index, "globals must be an array of non-empty strings.");
    }
    normalized.globals = globals;
  }
  for (const field of ["packageScopeSelection", "sourceSetScopeSelection"]) {
    if (!Object.prototype.hasOwnProperty.call(descriptors, field)) continue;
    const selection = descriptors[field].value;
    if (typeof selection !== "string" || !WORKSPACE_SCOPE_SELECTIONS.has(selection)) {
      workspaceAnalysisOptionsError(index, `${field} must be 'current-file' or 'safe'.`);
    }
    normalized[field] = selection;
  }
  if (Object.prototype.hasOwnProperty.call(descriptors, "compilerOptions")) {
    const compilerOptions = cloneWorkspaceAnalysisData(descriptors.compilerOptions.value, index, "compilerOptions", new Set(), dataBudget);
    if (!isPlainDataObject(compilerOptions)) {
      workspaceAnalysisOptionsError(index, "compilerOptions must be a plain JSON object.");
    }
    normalized.compilerOptions = compilerOptions;
  }
  return normalized;
}

function sortedUnique(values) {
  return [...new Set(values)].sort((left, right) => String(left).localeCompare(String(right)));
}

function tupleKey(values) {
  return JSON.stringify(values);
}

function languageForFile(filePath) {
  if (/\.go$/i.test(filePath)) return "go";
  if (/\.(?:kt|kts)$/i.test(filePath)) return "kotlin";
  if (/\.(?:ts|tsx|mts|cts)$/i.test(filePath)) return "typescript";
  return "javascript";
}

function sourceTextHash(source) {
  return createHash("sha256").update(source, "utf8").digest("hex");
}

async function existingPath(path, label) {
  try {
    return await stat(path);
  } catch (error) {
    if (error?.code === "ENOENT") {
      throw new PieceWorkspaceError("workspace-path-not-found", `${label} '${path}' does not exist.`);
    }
    throw new PieceWorkspaceError("workspace-path-inspection-failed", `Could not inspect ${label} '${path}': ${error?.message ?? String(error)}.`);
  }
}

async function resolveContainedDirectory(root, value, label) {
  const requested = resolve(root, value);
  if (!isPathInside(root, requested)) {
    throw new PieceWorkspaceError("workspace-path-escape", `${label} must stay inside '${root}'.`);
  }
  const info = await existingPath(requested, label);
  if (!info.isDirectory()) {
    throw new PieceWorkspaceError("workspace-path-not-directory", `${label} '${requested}' is not a directory.`);
  }
  let canonical;
  try {
    canonical = await realpath(requested);
  } catch (error) {
    throw new PieceWorkspaceError("workspace-path-resolution-failed", `Could not resolve ${label} '${requested}': ${error?.message ?? String(error)}.`);
  }
  if (!isPathInside(root, canonical)) {
    throw new PieceWorkspaceError("workspace-path-escape", `${label} resolves outside '${root}'.`);
  }
  return canonical;
}

async function resolveContainedFile(root, value, label) {
  const requested = resolve(root, value);
  if (!isPathInside(root, requested)) {
    throw new PieceWorkspaceError("workspace-path-escape", `${label} must stay inside '${root}'.`);
  }
  const info = await existingPath(requested, label);
  if (!info.isFile()) {
    throw new PieceWorkspaceError("workspace-path-not-file", `${label} '${requested}' is not a file.`);
  }
  let canonical;
  try {
    canonical = await realpath(requested);
  } catch (error) {
    throw new PieceWorkspaceError("workspace-path-resolution-failed", `Could not resolve ${label} '${requested}': ${error?.message ?? String(error)}.`);
  }
  if (!isPathInside(root, canonical)) {
    throw new PieceWorkspaceError("workspace-path-escape", `${label} resolves outside '${root}'.`);
  }
  return canonical;
}

async function collectSourceFiles(root) {
  const files = [];
  async function visit(directory) {
    let entries;
    try {
      entries = await readdir(directory, { withFileTypes: true });
    } catch (error) {
      throw new PieceWorkspaceError("workspace-source-scan-failed", `Could not scan '${directory}': ${error?.message ?? String(error)}.`);
    }
    for (const entry of entries) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) {
        if (!IGNORED_DIRECTORIES.has(entry.name)) {
          await visit(path);
        }
      } else if (entry.isFile() && SOURCE_FILE_PATTERN.test(entry.name)) {
        files.push(path);
      }
    }
  }
  await visit(root);
  return files;
}

function normalizeProject(project, index) {
  if (!isPlainObject(project)) {
    throw new PieceWorkspaceError("invalid-workspace-config", `projects[${index}] must be an object.`);
  }
  const id = nonEmptyString(project.id, `projects[${index}].id`);
  if (!WORKSPACE_PROJECT_ID.test(id)) {
    throw new PieceWorkspaceError(
      "invalid-workspace-project-id",
      `projects[${index}].id must match ${WORKSPACE_PROJECT_ID.toString()}.`
    );
  }
  const root = project.root ?? ".";
  nonEmptyString(root, `projects[${index}].root`);
  const sourceRoots = project.sourceRoots === undefined ? ["."] : stringList(project.sourceRoots, `projects[${index}].sourceRoots`);
  const files = stringList(project.files, `projects[${index}].files`);
  const dependsOn = stringList(project.dependsOn, `projects[${index}].dependsOn`);
  if (project.fallback !== undefined && !isPlainObject(project.fallback)) {
    throw new PieceWorkspaceError("invalid-workspace-config", `projects[${index}].fallback must be an object when provided.`);
  }
  const analysisOptions = normalizeWorkspaceAnalysisOptions(
    Object.prototype.hasOwnProperty.call(project, "analysisOptions") ? project.analysisOptions : undefined,
    index
  );
  return {
    id,
    root,
    sourceRoots,
    files,
    dependsOn: sortedUnique(dependsOn),
    fallback: project.fallback,
    analysisOptions,
    language: project.language ?? "auto"
  };
}

async function resolveProject(project, workspaceRoot) {
  const root = await resolveContainedDirectory(workspaceRoot, project.root, `project '${project.id}' root`);
  const sourceRoots = [];
  for (const sourceRoot of project.sourceRoots) {
    const path = await resolveContainedDirectory(root, sourceRoot, `project '${project.id}' source root`);
    if (!isPathInside(workspaceRoot, path)) {
      throw new PieceWorkspaceError("workspace-path-escape", `project '${project.id}' source root resolves outside '${workspaceRoot}'.`);
    }
    sourceRoots.push(path);
  }
  const explicitFiles = [];
  for (const file of project.files) {
    const path = await resolveContainedFile(root, file, `project '${project.id}' file`);
    if (!isPathInside(workspaceRoot, path)) {
      throw new PieceWorkspaceError("workspace-path-escape", `project '${project.id}' file resolves outside '${workspaceRoot}'.`);
    }
    if (!SOURCE_FILE_PATTERN.test(path)) {
      throw new PieceWorkspaceError("unsupported-workspace-source-file", `project '${project.id}' file '${path}' is not a supported source file.`);
    }
    explicitFiles.push(path);
  }
  return {
    ...project,
    root,
    sourceRoots: sortedUnique(sourceRoots),
    explicitFiles: sortedUnique(explicitFiles)
  };
}

async function projectSourceFiles(project) {
  const discovered = (await Promise.all(project.sourceRoots.map((sourceRoot) => collectSourceFiles(sourceRoot)))).flat();
  return sortedUnique([...discovered, ...project.explicitFiles]);
}

function analysisDiagnostic(error, filePath) {
  return {
    code: "workspace-file-analysis-failed",
    severity: "warning",
    filePath,
    message: error?.message ?? String(error)
  };
}

function fallbackReason(code, message, details = {}) {
  return { code, severity: "warning", message, ...details };
}

function sourceFromExternalEdge(edge) {
  if (typeof edge?.import?.source === "string") return edge.import.source;
  if (typeof edge?.to !== "string") return undefined;
  const separator = edge.to.lastIndexOf("#");
  return separator > 0 ? edge.to.slice(0, separator) : undefined;
}

function resolveRelativeWorkspaceSource(sourceFiles, fromFile, specifier, workspaceRoot) {
  const base = resolve(dirname(fromFile), specifier);
  const candidates = [base, ...SOURCE_EXTENSIONS.map((extension) => `${base}${extension}`), ...SOURCE_EXTENSIONS.map((extension) => join(base, `index${extension}`))];
  for (const candidate of candidates) {
    if (isPathInside(workspaceRoot, candidate) && sourceFiles.has(candidate)) {
      return candidate;
    }
  }
  return undefined;
}

function appendReason(reasonsByProject, projectId, reason) {
  const reasons = reasonsByProject.get(projectId) ?? [];
  if (!reasons.some((candidate) => `${candidate.code}:${candidate.filePath ?? ""}:${candidate.target ?? ""}` === `${reason.code}:${reason.filePath ?? ""}:${reason.target ?? ""}`)) {
    reasons.push(reason);
  }
  reasonsByProject.set(projectId, reasons);
}

function buildWorkspaceProjectGraph(workspaceRoot, projects) {
  const ownerByFile = new Map();
  const sourceFiles = new Set();
  const reasonsByProject = new Map(projects.map((project) => [project.id, [...project.fallbackReasons]]));
  const edges = [];
  const edgeKeys = new Set();

  for (const project of projects) {
    for (const file of project.sourceFiles) {
      const existing = ownerByFile.get(file);
      if (existing && existing !== project.id) {
        throw new PieceWorkspaceError("workspace-source-file-owned-by-multiple-projects", `Source file '${file}' belongs to both '${existing}' and '${project.id}'.`);
      }
      ownerByFile.set(file, project.id);
      sourceFiles.add(file);
    }
  }

  function addEdge(edge) {
    const key = tupleKey([edge.from, edge.to, edge.kind, edge.sourceFile ?? null, edge.targetFile ?? null]);
    if (!edgeKeys.has(key)) {
      edgeKeys.add(key);
      edges.push(edge);
    }
  }

  for (const project of projects) {
    for (const dependency of project.dependsOn) {
      addEdge({ from: project.id, to: dependency, kind: "declared" });
    }
    for (const file of project.files) {
      if (file.status !== "analyzed") continue;
      if (file.analysis.feedbackScope?.fallbackRequired) {
        appendReason(
          reasonsByProject,
          project.id,
          fallbackReason("workspace-piece-feedback-fallback", "A file analysis already requires a wider feedback boundary.", {
            filePath: file.filePath,
            feedbackLevel: file.analysis.feedbackScope.level,
            reasonCodes: (file.analysis.feedbackScope.reasons ?? []).map((reason) => reason.code).filter(Boolean)
          })
        );
      }
      for (const edge of file.analysis.graph?.edges ?? []) {
        if (edge.kind === "unknown") {
          appendReason(
            reasonsByProject,
            project.id,
            fallbackReason("workspace-unknown-reference", "An unresolved semantic reference requires project fallback.", {
              filePath: file.filePath,
              target: edge.to,
              symbols: edge.symbols ?? []
            })
          );
          continue;
        }
        if (edge.kind !== "external") continue;
        const source = sourceFromExternalEdge(edge);
        if (!source) continue;
        let targetFile;
        if (isAbsolute(source)) {
          targetFile = sourceFiles.has(source) ? source : undefined;
          if (!targetFile && isPathInside(workspaceRoot, source)) {
            appendReason(
              reasonsByProject,
              project.id,
              fallbackReason("workspace-source-import-unresolved", "A source-backed external dependency was not part of any declared project.", {
                filePath: file.filePath,
                target: edge.to
              })
            );
          }
        } else if (source.startsWith(".")) {
          targetFile = resolveRelativeWorkspaceSource(sourceFiles, file.filePath, source, workspaceRoot);
          if (!targetFile) {
            appendReason(
              reasonsByProject,
              project.id,
              fallbackReason("workspace-relative-import-unresolved", "A relative import could not be resolved to a declared workspace source file.", {
                filePath: file.filePath,
                target: edge.to,
                specifier: source
              })
            );
          }
        }
        const targetProject = targetFile ? ownerByFile.get(targetFile) : undefined;
        if (targetProject && targetProject !== project.id) {
          addEdge({
            from: project.id,
            to: targetProject,
            kind: "resolved-source",
            sourceFile: file.filePath,
            targetFile,
            symbols: edge.symbols ?? []
          });
        }
      }
    }
  }

  return {
    version: 1,
    kind: "piece-workspace-project-graph",
    nodes: projects.map((project) => ({ id: project.id, root: project.root, language: project.language })).sort((left, right) => left.id.localeCompare(right.id)),
    edges: edges.sort((left, right) => `${left.from}:${left.to}:${left.kind}:${left.sourceFile ?? ""}`.localeCompare(`${right.from}:${right.to}:${right.kind}:${right.sourceFile ?? ""}`)),
    sourceOwners: [...ownerByFile.entries()]
      .map(([filePath, projectId]) => ({ filePath, projectId }))
      .sort((left, right) => left.filePath.localeCompare(right.filePath)),
    fallbackReasons: Object.fromEntries(
      [...reasonsByProject.entries()]
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([projectId, reasons]) => [projectId, reasons])
    )
  };
}

function workspaceAnalysisConcurrency(value) {
  if (value === undefined) return DEFAULT_WORKSPACE_ANALYSIS_CONCURRENCY;
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new PieceWorkspaceError("invalid-workspace-analysis-concurrency", "analysisConcurrency must be a positive safe integer.");
  }
  return Math.min(value, MAX_WORKSPACE_ANALYSIS_CONCURRENCY);
}

async function mapWithConcurrency(entries, concurrency, mapper) {
  const results = new Array(entries.length);
  let nextIndex = 0;
  const workerCount = Math.min(Math.max(1, concurrency), entries.length);
  await Promise.all(
    Array.from({ length: workerCount }, async () => {
      while (nextIndex < entries.length) {
        const index = nextIndex;
        nextIndex += 1;
        results[index] = await mapper(entries[index], index);
      }
    })
  );
  return results;
}

function canonicalWorkspaceData(value) {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map((entry) => canonicalWorkspaceData(entry)).join(",")}]`;
  return `{${Object.keys(value)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalWorkspaceData(value[key])}`)
    .join(",")}}`;
}

function workspaceFingerprint(parts) {
  const hash = createHash("sha256");
  for (const part of parts) {
    const value = String(part ?? "");
    hash.update(String(Buffer.byteLength(value, "utf8")), "utf8");
    hash.update(":", "utf8");
    hash.update(value, "utf8");
  }
  return hash.digest("hex");
}

function projectSourceFingerprint(project, sourceEntries) {
  return workspaceFingerprint([
    "piece-workspace-project-source-v1",
    project.id,
    project.root,
    project.language,
    canonicalWorkspaceData(project.analysisOptions),
    ...project.sourceRoots,
    ...sourceEntries.flatMap((entry) => [entry.filePath, entry.sourceHash ?? `read-error:${entry.error?.code ?? "unknown"}`])
  ]);
}

function goPackageGroupKey(entry) {
  const packageName = String(entry?.source ?? "").match(/^\s*package\s+([A-Za-z_][A-Za-z0-9_]*)/m)?.[1];
  // A malformed package declaration must not accidentally share an analysis
  // group with another source. The normal extractor will retain its diagnostic.
  return packageName ? `${dirname(entry.filePath)}:${packageName}` : `${dirname(entry.filePath)}:invalid:${entry.filePath}`;
}

function kotlinSourceSetGroupKey(entry, project) {
  const sourceRoot = (project.sourceRoots ?? [])
    .filter((candidate) => isPathInside(candidate, entry.filePath))
    .sort((left, right) => right.length - left.length)[0];
  // A configured source root is the explicit source-set boundary available to
  // workspace analysis. If a manually listed source sits outside it, isolate
  // that file instead of accidentally sharing a Kotlin host batch.
  return sourceRoot ?? `unmatched:${entry.filePath}`;
}

function nativeGroupKey(entry, project) {
  const language = languageForFile(entry.filePath);
  if (language === "go") return `go:${goPackageGroupKey(entry)}`;
  if (language === "kotlin") return `kotlin:${kotlinSourceSetGroupKey(entry, project)}`;
  return undefined;
}

function nativeGroupSourceHashes(project, sourceEntries) {
  const groups = new Map();
  for (const entry of sourceEntries) {
    if (entry.error) continue;
    const group = nativeGroupKey(entry, project);
    if (!group) continue;
    const entries = groups.get(group) ?? [];
    entries.push(entry);
    groups.set(group, entries);
  }
  const hashes = new Map();
  for (const [group, entries] of groups) {
    const hash = workspaceFingerprint([
      "piece-workspace-native-group-v1",
      project.id,
      project.root,
      group,
      ...entries
        .slice()
        .sort((left, right) => left.filePath.localeCompare(right.filePath))
        .flatMap((entry) => [entry.filePath, entry.sourceHash])
    ]);
    for (const entry of entries) hashes.set(entry.filePath, hash);
  }
  return hashes;
}

function fileAnalysisFingerprint({ workspaceRoot, project, filePath, language, sourceHash, projectSourceHash, nativeGroupHash, nativeScope = "project" }) {
  const native = language === "go" || language === "kotlin";
  const companionScopeHash = native && nativeScope === "group" ? nativeGroupHash ?? projectSourceHash : native ? projectSourceHash : "current-file";
  return workspaceFingerprint([
    "piece-workspace-file-analysis-v2",
    workspaceRoot,
    project.id,
    project.root,
    canonicalWorkspaceData(project.analysisOptions),
    filePath,
    language,
    sourceHash,
    // A record made by a successful native batch may reuse only its package or
    // configured source-set group. A per-file fallback keeps the conservative
    // project fingerprint, so it can never be reused with stale companions.
    nativeScope,
    companionScopeHash
  ]);
}

async function readWorkspaceSource(filePath) {
  try {
    const source = await readFile(filePath, "utf8");
    return { filePath, source, sourceHash: sourceTextHash(source) };
  } catch (error) {
    return { filePath, error };
  }
}

async function analyzeWorkspaceProject({ project, workspaceRoot, analyzeFile, cache, concurrency, fileAnalysisConcurrency }) {
  const sourceFiles = await projectSourceFiles(project);
  const sourceEntries = await mapWithConcurrency(sourceFiles, concurrency, (filePath) => readWorkspaceSource(filePath));
  const sourceFingerprint = projectSourceFingerprint(project, sourceEntries);
  const nativeScopeHashes = nativeGroupSourceHashes(project, sourceEntries);
  const files = new Array(sourceEntries.length);
  const fileFallbackReasons = new Array(sourceEntries.length);
  let reusedFileCount = 0;
  let freshFileAnalysisCount = 0;
  let nativeBatchCount = 0;
  let nativeBatchFileCount = 0;

  const cacheKeysForEntry = (entry) => {
    const language = languageForFile(entry.filePath);
    const common = {
      workspaceRoot,
      project,
      filePath: entry.filePath,
      language,
      sourceHash: entry.sourceHash,
      projectSourceHash: sourceFingerprint,
      nativeGroupHash: nativeScopeHashes.get(entry.filePath)
    };
    const projectKey = fileAnalysisFingerprint({ ...common, nativeScope: "project" });
    const groupKey = ["go", "kotlin"].includes(language) ? fileAnalysisFingerprint({ ...common, nativeScope: "group" }) : projectKey;
    return { project: projectKey, group: groupKey };
  };

  const cachedAnalysisForEntry = (entry) => {
    const cached = cache?.get(entry.filePath);
    if (!cached) return undefined;
    const keys = cacheKeysForEntry(entry);
    if (cached.key === keys.project) return { cached, key: keys.project, scope: "project" };
    if (cached.scope === "native-group" && cached.key === keys.group) return { cached, key: keys.group, scope: "native-group" };
    return undefined;
  };

  const nativeBatchManifests = {
    go: new Map(),
    kotlin: new Map()
  };
  if (analyzeFile === analyzePieceFile) {
    const nativeGroups = new Map();
    for (const entry of sourceEntries) {
      if (entry.error || !["go", "kotlin"].includes(languageForFile(entry.filePath))) continue;
      const group = nativeGroupKey(entry, project);
      const entries = nativeGroups.get(group) ?? [];
      entries.push(entry);
      nativeGroups.set(group, entries);
    }
    for (const entries of nativeGroups.values()) {
      if (entries.every((entry) => cachedAnalysisForEntry(entry))) continue;
      const language = languageForFile(entries[0].filePath);
      let batch;
      try {
        batch =
          language === "go"
            ? await prepareNodeGoWorkspaceManifests({ files: entries, cwd: workspaceRoot })
            : await analyzeKotlinPieceFiles({ files: entries, cwd: workspaceRoot });
      } catch {
        // Preserve the established per-file extractors as the fail-closed
        // fallback when a native package/source-set host cannot be prepared.
        batch = undefined;
      }
      if (!batch?.manifests || batch.manifests.size !== entries.length) continue;
      for (const [filePath, manifest] of batch.manifests) nativeBatchManifests[language].set(filePath, manifest);
      nativeBatchCount += batch.batchCount ?? 1;
      nativeBatchFileCount += batch.sourceFileCount ?? entries.length;
    }
  }

  const analyzeEntry = async (entry, index) => {
    const language = languageForFile(entry.filePath);
    if (entry.error) {
      const diagnostic = analysisDiagnostic(entry.error, entry.filePath);
      fileFallbackReasons[index] = fallbackReason("workspace-file-read-failed", diagnostic.message, { filePath: entry.filePath });
      files[index] = { filePath: entry.filePath, language, status: "error", diagnostics: [diagnostic] };
      return;
    }
    const cachedEntry = cachedAnalysisForEntry(entry);
    if (cachedEntry) {
      files[index] = {
        filePath: entry.filePath,
        language,
        sourceHash: entry.sourceHash,
        status: "analyzed",
        analysis: cachedEntry.cached.analysis,
        diagnostics: []
      };
      reusedFileCount += 1;
      return;
    }
    const languageInputs = language === "go" || language === "kotlin" ? { sourceFiles, sourceRoots: project.sourceRoots } : {};
    const batchManifest = nativeBatchManifests[language]?.get(entry.filePath);
    const cacheKeys = cacheKeysForEntry(entry);
    const cacheKey = batchManifest ? cacheKeys.group : cacheKeys.project;
    const cacheScope = batchManifest && ["go", "kotlin"].includes(language) ? "native-group" : "project";
    const declarationExtractor = batchManifest
      ? {
          name: `${language}-workspace-batch-declaration-extractor`,
          extract({ filePath }) {
            if (filePath !== entry.filePath) {
              throw new Error(`${language} workspace batch manifest does not match '${filePath}'.`);
            }
            return batchManifest;
          }
        }
      : undefined;
    try {
      const analysis = await analyzeFile({
        ...project.analysisOptions,
        ...languageInputs,
        ...(declarationExtractor ? { declarationExtractor } : {}),
        cwd: workspaceRoot,
        filePath: entry.filePath,
        source: entry.source
      });
      files[index] = { filePath: entry.filePath, language, sourceHash: entry.sourceHash, status: "analyzed", analysis, diagnostics: [] };
      freshFileAnalysisCount += 1;
      cache?.set(entry.filePath, { key: cacheKey, scope: cacheScope, analysis });
    } catch (error) {
      const diagnostic = analysisDiagnostic(error, entry.filePath);
      fileFallbackReasons[index] = fallbackReason("workspace-file-analysis-failed", diagnostic.message, { filePath: entry.filePath });
      files[index] = { filePath: entry.filePath, language, sourceHash: entry.sourceHash, status: "error", diagnostics: [diagnostic] };
    }
  };

  // TypeScript/JavaScript extraction is file-local, so safely parallelize it
  // with a bounded pool. Prepared native manifests and cache hits no longer
  // launch a host and can use that pool too; only a batch fallback keeps the
  // legacy serialized native path.
  const fileLocalEntries = sourceEntries
    .map((entry, index) => ({ entry, index }))
    .filter(({ entry }) => !entry.error && !["go", "kotlin"].includes(languageForFile(entry.filePath)));
  await mapWithConcurrency(fileLocalEntries, fileAnalysisConcurrency, ({ entry, index }) => analyzeEntry(entry, index));
  const nativeEntries = sourceEntries
    .map((entry, index) => ({ entry, index }))
    .filter(({ entry }) => !entry.error && ["go", "kotlin"].includes(languageForFile(entry.filePath)));
  const preparedOrCachedNativeEntries = nativeEntries.filter(({ entry }) => {
    const language = languageForFile(entry.filePath);
    return nativeBatchManifests[language]?.has(entry.filePath) || Boolean(cachedAnalysisForEntry(entry));
  });
  await mapWithConcurrency(preparedOrCachedNativeEntries, fileAnalysisConcurrency, ({ entry, index }) => analyzeEntry(entry, index));
  const unpreparedNativeEntries = nativeEntries.filter(({ entry }) => !preparedOrCachedNativeEntries.some((candidate) => candidate.entry === entry));
  for (const { index, entry } of unpreparedNativeEntries) {
    await analyzeEntry(entry, index);
  }
  // Read failures were deliberately excluded from the bounded analysis pool.
  for (const [index, entry] of sourceEntries.entries()) {
    if (entry.error) await analyzeEntry(entry, index);
  }

  return {
    id: project.id,
    root: project.root,
    sourceRoots: project.sourceRoots,
    sourceFiles,
    language: project.language,
    dependsOn: project.dependsOn,
    fallback: project.fallback,
    files,
    fallbackReasons: fileFallbackReasons.filter(Boolean),
    metrics: {
      sourceFileCount: sourceFiles.length,
      analyzedFileCount: files.filter((file) => file.status === "analyzed").length,
      freshFileAnalysisCount,
      reusedFileCount,
      nativeBatchCount,
      nativeBatchFileCount,
      analysisErrorCount: files.filter((file) => file.status === "error").length,
      sliceCount: files.reduce((total, file) => total + (file.analysis?.manifest?.slices?.length ?? 0), 0)
    }
  };
}

async function analyzePieceWorkspaceWithCache(options, cache) {
  const workspaceRootOption = nonEmptyString(options.workspaceRoot, "workspaceRoot");
  const requestedRoot = resolve(options.cwd ?? process.cwd(), workspaceRootOption);
  const rootInfo = await existingPath(requestedRoot, "workspace root");
  if (!rootInfo.isDirectory()) {
    throw new PieceWorkspaceError("workspace-root-not-directory", `Workspace root '${requestedRoot}' is not a directory.`);
  }
  let workspaceRoot;
  try {
    workspaceRoot = await realpath(requestedRoot);
  } catch (error) {
    throw new PieceWorkspaceError("workspace-root-resolution-failed", `Could not resolve workspace root '${requestedRoot}': ${error?.message ?? String(error)}.`);
  }
  if (!Array.isArray(options.projects) || options.projects.length === 0) {
    throw new PieceWorkspaceError("invalid-workspace-config", "projects must be a non-empty array; Piece does not infer workspace projects.");
  }
  const rawProjects = options.projects.map(normalizeProject);
  const ids = rawProjects.map((project) => project.id);
  if (new Set(ids).size !== ids.length) {
    throw new PieceWorkspaceError("duplicate-workspace-project", "Every workspace project id must be unique.");
  }
  const resolvedProjects = [];
  for (const project of rawProjects) {
    resolvedProjects.push(await resolveProject(project, workspaceRoot));
  }
  const analyzeFile = options.analyzeFile ?? analyzePieceFile;
  if (typeof analyzeFile !== "function") {
    throw new PieceWorkspaceError("invalid-workspace-analyzer", "analyzeFile must be a function.");
  }
  const concurrency = workspaceAnalysisConcurrency(options.analysisConcurrency);
  // A caller-supplied analyzer may have stateful host behavior. Preserve the
  // historical sequential default for it unless the caller explicitly opts
  // into a concurrency limit; the built-in file-local analyzer is parallel by
  // default.
  const fileAnalysisConcurrency = analyzeFile === analyzePieceFile || options.analysisConcurrency !== undefined ? concurrency : 1;
  const projects = [];
  for (const project of resolvedProjects.sort((left, right) => left.id.localeCompare(right.id))) {
    projects.push(await analyzeWorkspaceProject({ project, workspaceRoot, analyzeFile, cache, concurrency, fileAnalysisConcurrency }));
  }
  const projectGraph = buildWorkspaceProjectGraph(workspaceRoot, projects);
  const reasonsByProject = projectGraph.fallbackReasons;
  const projectsWithGraphReasons = projects.map((project) => ({
    ...project,
    fallbackReasons: reasonsByProject[project.id] ?? project.fallbackReasons
  }));
  return {
    version: 1,
    kind: "piece-workspace",
    workspaceRoot,
    workspaceRootAliases: sortedUnique([requestedRoot, workspaceRoot]),
    projects: projectsWithGraphReasons,
    projectGraph,
    metrics: {
      projectCount: projects.length,
      sourceFileCount: projects.reduce((total, project) => total + project.metrics.sourceFileCount, 0),
      analyzedFileCount: projects.reduce((total, project) => total + project.metrics.analyzedFileCount, 0),
      freshFileAnalysisCount: projects.reduce((total, project) => total + project.metrics.freshFileAnalysisCount, 0),
      reusedFileCount: projects.reduce((total, project) => total + project.metrics.reusedFileCount, 0),
      nativeBatchCount: projects.reduce((total, project) => total + (project.metrics.nativeBatchCount ?? 0), 0),
      nativeBatchFileCount: projects.reduce((total, project) => total + (project.metrics.nativeBatchFileCount ?? 0), 0),
      analysisErrorCount: projects.reduce((total, project) => total + project.metrics.analysisErrorCount, 0)
    }
  };
}

/**
 * Analyze only explicitly configured projects. It never discovers a monorepo,
 * and it never turns a semantic Piece target into a workspace compiler action.
 */
export async function analyzePieceWorkspace(options = {}) {
  return analyzePieceWorkspaceWithCache(options);
}

function projectMap(workspace) {
  return new Map((workspace.projects ?? []).map((project) => [project.id, project]));
}

function validProjectEdges(workspace, selected, reasonsByProject) {
  const projects = projectMap(workspace);
  const edges = [];
  for (const edge of workspace.projectGraph?.edges ?? []) {
    if (!selected.has(edge.from)) continue;
    if (!projects.has(edge.to)) {
      appendReason(
        reasonsByProject,
        edge.from,
        fallbackReason("workspace-project-dependency-missing", `Project '${edge.from}' depends on undeclared project '${edge.to}'.`, { target: edge.to })
      );
      continue;
    }
    if (!selected.has(edge.to)) continue;
    edges.push(edge);
  }
  return edges;
}

function dependencyClosure(projectIds, edges) {
  const dependencies = new Map();
  for (const edge of edges) {
    if (!dependencies.has(edge.from)) dependencies.set(edge.from, new Set());
    dependencies.get(edge.from).add(edge.to);
  }
  const selected = new Set(projectIds);
  const queue = [...selected];
  while (queue.length > 0) {
    const current = queue.shift();
    for (const dependency of dependencies.get(current) ?? []) {
      if (!selected.has(dependency)) {
        selected.add(dependency);
        queue.push(dependency);
      }
    }
  }
  return selected;
}

function reverseDependencyClosure(projectIds, edges) {
  const dependents = new Map();
  for (const edge of edges) {
    if (!dependents.has(edge.to)) dependents.set(edge.to, new Set());
    dependents.get(edge.to).add(edge.from);
  }
  const selected = new Set(projectIds);
  const queue = [...selected];
  while (queue.length > 0) {
    const current = queue.shift();
    for (const dependent of dependents.get(current) ?? []) {
      if (!selected.has(dependent)) {
        selected.add(dependent);
        queue.push(dependent);
      }
    }
  }
  return selected;
}

function stronglyConnectedComponents(nodes, edges) {
  const adjacency = new Map(nodes.map((node) => [node, []]));
  for (const edge of edges) {
    adjacency.get(edge.from)?.push(edge.to);
  }
  for (const values of adjacency.values()) values.sort();
  let index = 0;
  const stack = [];
  const stackMembers = new Set();
  const indexes = new Map();
  const lowLinks = new Map();
  const components = [];

  function visit(node) {
    indexes.set(node, index);
    lowLinks.set(node, index);
    index += 1;
    stack.push(node);
    stackMembers.add(node);
    for (const next of adjacency.get(node) ?? []) {
      if (!indexes.has(next)) {
        visit(next);
        lowLinks.set(node, Math.min(lowLinks.get(node), lowLinks.get(next)));
      } else if (stackMembers.has(next)) {
        lowLinks.set(node, Math.min(lowLinks.get(node), indexes.get(next)));
      }
    }
    if (lowLinks.get(node) === indexes.get(node)) {
      const members = [];
      while (stack.length > 0) {
        const member = stack.pop();
        stackMembers.delete(member);
        members.push(member);
        if (member === node) break;
      }
      components.push(members.sort());
    }
  }

  for (const node of [...nodes].sort()) {
    if (!indexes.has(node)) visit(node);
  }
  return components.sort((left, right) => left[0].localeCompare(right[0]));
}

function scheduleComponentBatches(projectIds, edges) {
  const components = stronglyConnectedComponents(projectIds, edges);
  const componentByProject = new Map();
  const metadata = new Map();
  for (const members of components) {
    const id = tupleKey(members);
    const selfCycle = members.length === 1 && edges.some((edge) => edge.from === members[0] && edge.to === members[0]);
    metadata.set(id, { id, members, cycle: members.length > 1 || selfCycle, dependencies: new Set(), dependents: new Set() });
    for (const projectId of members) componentByProject.set(projectId, id);
  }
  for (const edge of edges) {
    const from = componentByProject.get(edge.from);
    const to = componentByProject.get(edge.to);
    if (!from || !to || from === to) continue;
    metadata.get(from).dependencies.add(to);
    metadata.get(to).dependents.add(from);
  }
  const remaining = new Map([...metadata.values()].map((component) => [component.id, component.dependencies.size]));
  let ready = [...metadata.values()].filter((component) => remaining.get(component.id) === 0).sort((left, right) => left.members[0].localeCompare(right.members[0]));
  const batches = [];
  while (ready.length > 0) {
    const batch = ready;
    batches.push(batch);
    const nextReady = [];
    for (const component of batch) {
      for (const dependentId of component.dependents) {
        const next = remaining.get(dependentId) - 1;
        remaining.set(dependentId, next);
        if (next === 0) nextReady.push(metadata.get(dependentId));
      }
    }
    ready = nextReady.sort((left, right) => left.members[0].localeCompare(right.members[0]));
  }
  return batches;
}

function actionIdForProject(projectId) {
  return `//workspace:${projectId}%project-fallback`;
}

function changedWorkspaceSource(workspace, changedFile, ownerByFile) {
  if (typeof changedFile !== "string" || changedFile.trim().length === 0) {
    return { filePath: "", reason: "invalid-changed-file" };
  }
  let path;
  try {
    path = resolve(workspace.workspaceRoot, changedFile);
  } catch {
    return { filePath: changedFile, reason: "invalid-changed-file" };
  }
  const directOwner = ownerByFile.get(path);
  if (directOwner) {
    return { filePath: path, sourceFilePath: path, projectId: directOwner };
  }
  for (const rootAlias of workspace.workspaceRootAliases ?? [workspace.workspaceRoot]) {
    if (!isPathInside(rootAlias, path)) continue;
    const sourceFilePath = resolve(workspace.workspaceRoot, relative(rootAlias, path));
    const projectId = ownerByFile.get(sourceFilePath);
    if (projectId) {
      return { filePath: path, sourceFilePath, projectId };
    }
  }
  return { filePath: path, reason: "not-owned" };
}

function sourceHashesByFile(workspace) {
  const hashes = new Map();
  for (const project of workspace.projects ?? []) {
    for (const file of project.files ?? []) {
      if (typeof file?.filePath !== "string" || typeof file?.sourceHash !== "string") continue;
      hashes.set(file.filePath, file.sourceHash);
    }
  }
  return hashes;
}

function markWorkspaceSnapshotStale(reasonsByProject, projects, filePath, snapshotState) {
  for (const project of projects.values()) {
    appendReason(
      reasonsByProject,
      project.id,
      fallbackReason("workspace-snapshot-stale", "A changed file no longer matches the workspace analysis snapshot, so every project requires fallback planning.", {
        filePath,
        snapshotState
      })
    );
  }
}

function changedFilesMatchWorkspaceSnapshot(workspace, changedFiles, projects, reasonsByProject) {
  if (!Array.isArray(changedFiles) || changedFiles.length === 0) return true;
  const ownerByFile = new Map((workspace.projectGraph?.sourceOwners ?? []).map((entry) => [entry.filePath, entry.projectId]));
  const hashes = sourceHashesByFile(workspace);
  for (const changedFile of changedFiles) {
    const resolved = changedWorkspaceSource(workspace, changedFile, ownerByFile);
    if (!resolved.projectId || !resolved.sourceFilePath) {
      markWorkspaceSnapshotStale(reasonsByProject, projects, resolved.filePath, resolved.reason ?? "not-owned");
      return false;
    }
    const sourceHash = hashes.get(resolved.sourceFilePath);
    if (!sourceHash) {
      markWorkspaceSnapshotStale(reasonsByProject, projects, resolved.filePath, "source-hash-missing");
      return false;
    }
    let source;
    try {
      source = readFileSync(resolved.sourceFilePath, "utf8");
    } catch {
      markWorkspaceSnapshotStale(reasonsByProject, projects, resolved.filePath, "source-unreadable");
      return false;
    }
    if (sourceTextHash(source) !== sourceHash) {
      markWorkspaceSnapshotStale(reasonsByProject, projects, resolved.filePath, "content-changed");
      return false;
    }
  }
  return true;
}

function selectPlannedProjects(workspace, options, graphEdges, reasonsByProject) {
  const projects = projectMap(workspace);
  const all = new Set(projects.keys());
  if (Array.isArray(options.projectIds) && options.projectIds.length > 0) {
    const requested = new Set();
    for (const projectId of options.projectIds) {
      if (!projects.has(projectId)) {
        throw new PieceWorkspaceError("workspace-project-not-found", `Requested project '${projectId}' is not declared.`);
      }
      requested.add(projectId);
    }
    return dependencyClosure(requested, graphEdges);
  }
  if (!Array.isArray(options.changedFiles) || options.changedFiles.length === 0) {
    return all;
  }
  const ownerByFile = new Map((workspace.projectGraph?.sourceOwners ?? []).map((entry) => [entry.filePath, entry.projectId]));
  const changedProjects = new Set();
  for (const changedFile of options.changedFiles) {
    const resolved = changedWorkspaceSource(workspace, changedFile, ownerByFile);
    if (!resolved.projectId) {
      for (const project of projects.values()) {
        appendReason(
          reasonsByProject,
          project.id,
          fallbackReason("workspace-change-not-owned", "A changed file is not owned by an analyzed project, so the workspace must use fallback planning.", {
            filePath: resolved.filePath
          })
        );
      }
      return all;
    }
    changedProjects.add(resolved.projectId);
  }
  return dependencyClosure(reverseDependencyClosure(changedProjects, graphEdges), graphEdges);
}

/**
 * Produce a deterministic project-level fallback plan. Existing language
 * backends compile whole files/modules/projects, so this deliberately does not
 * pretend that every semantic Piece target is independently executable.
 */
export function planPieceWorkspaceBuild(workspace, options = {}) {
  if (!workspace || workspace.kind !== "piece-workspace" || !Array.isArray(workspace.projects)) {
    throw new PieceWorkspaceError("invalid-workspace-analysis", "planPieceWorkspaceBuild() requires analyzePieceWorkspace() output.");
  }
  const projects = projectMap(workspace);
  const reasonsByProject = new Map(
    workspace.projects.map((project) => [project.id, [...(workspace.projectGraph?.fallbackReasons?.[project.id] ?? project.fallbackReasons ?? [])]])
  );
  let selected = new Set(projects.keys());
  let graphEdges = validProjectEdges(workspace, selected, reasonsByProject);
  selected = changedFilesMatchWorkspaceSnapshot(workspace, options.changedFiles, projects, reasonsByProject)
    ? selectPlannedProjects(workspace, options, graphEdges, reasonsByProject)
    : new Set(projects.keys());
  graphEdges = validProjectEdges(workspace, selected, reasonsByProject);
  selected = dependencyClosure(selected, graphEdges);
  graphEdges = validProjectEdges(workspace, selected, reasonsByProject);
  const selectedIds = [...selected].sort();
  const batches = scheduleComponentBatches(selectedIds, graphEdges);
  const actions = [];
  const plannedBatches = batches.map((components, index) => {
    const batchActions = [];
    for (const component of components) {
      if (component.cycle) {
        for (const projectId of component.members) {
          appendReason(
            reasonsByProject,
            projectId,
            fallbackReason("workspace-project-dependency-cycle", "A project dependency cycle cannot be topologically ordered and requires project fallback.", {
              projects: component.members
            })
          );
        }
      }
      for (const projectId of component.members) {
        const project = projects.get(projectId);
        const dependencies = graphEdges.filter((edge) => edge.from === projectId).map((edge) => actionIdForProject(edge.to)).sort();
        const action = {
          id: actionIdForProject(projectId),
          kind: "project-fallback",
          projectId,
          projectRoot: project.root,
          language: project.language,
          dependsOn: dependencies,
          fallback: project.fallback,
          cache: {
            status: "bypass",
            reason: "workspace-project-fallback-cache-not-enabled"
          },
          reasons: reasonsByProject.get(projectId) ?? [],
          ...(component.cycle ? { scheduling: "cycle-fallback" } : { scheduling: "topological" })
        };
        actions.push(action);
        batchActions.push(action);
      }
    }
    return {
      index,
      kind: components.some((component) => component.cycle) ? "cycle-fallback" : "topological",
      parallelSafe: !components.some((component) => component.cycle),
      actions: batchActions.sort((left, right) => left.projectId.localeCompare(right.projectId))
    };
  });
  const allReasons = selectedIds.flatMap((projectId) => (reasonsByProject.get(projectId) ?? []).map((reason) => ({ projectId, ...reason })));
  return {
    version: 1,
    kind: "piece-workspace-build-plan",
    workspaceRoot: workspace.workspaceRoot,
    executionMode: "project-fallback",
    status: allReasons.length > 0 ? "fallback" : "ready",
    selectedProjects: selectedIds,
    projectEdges: graphEdges,
    actions: actions.sort((left, right) => left.projectId.localeCompare(right.projectId)),
    batches: plannedBatches,
    diagnostics: allReasons
  };
}

/**
 * Keep a revision-local workspace analysis cache for editor, watch, and daemon
 * callers. Cache entries are keyed by source SHA-256 plus all relevant analysis
 * inputs, so every returned workspace remains equivalent to a clean analysis.
 */
export function createPieceWorkspaceSession(defaultOptions = {}) {
  const cache = new Map();
  let analyzeFile;
  return {
    async analyze(options = {}) {
      const mergedOptions = { ...defaultOptions, ...options };
      const nextAnalyzeFile = mergedOptions.analyzeFile ?? analyzePieceFile;
      if (analyzeFile && analyzeFile !== nextAnalyzeFile) cache.clear();
      analyzeFile = nextAnalyzeFile;
      const workspace = await analyzePieceWorkspaceWithCache(mergedOptions, cache);
      const liveFiles = new Set(workspace.projects.flatMap((project) => project.sourceFiles));
      for (const filePath of cache.keys()) {
        if (!liveFiles.has(filePath)) cache.delete(filePath);
      }
      return workspace;
    },
    clear() {
      cache.clear();
    }
  };
}

export function createPieceWorkspaceCompiler(defaultOptions = {}) {
  const session = createPieceWorkspaceSession(defaultOptions);
  return {
    analyze(options = {}) {
      return session.analyze(options);
    },
    plan(workspace, options = {}) {
      return planPieceWorkspaceBuild(workspace, options);
    }
  };
}
