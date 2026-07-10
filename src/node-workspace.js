import { realpath, readdir, readFile, stat } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { analyzePieceFile } from "./node.js";

const SOURCE_FILE_PATTERN = /\.(?:[cm]?[jt]sx?|go|kts?)$/i;
const SOURCE_EXTENSIONS = [".ts", ".tsx", ".mts", ".cts", ".js", ".jsx", ".mjs", ".cjs", ".go", ".kt", ".kts"];
const IGNORED_DIRECTORIES = new Set([".git", "node_modules", "dist", "build", "coverage", ".piece"]);

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

function sortedUnique(values) {
  return [...new Set(values)].sort((left, right) => String(left).localeCompare(String(right)));
}

function languageForFile(filePath) {
  if (/\.go$/i.test(filePath)) return "go";
  if (/\.(?:kt|kts)$/i.test(filePath)) return "kotlin";
  if (/\.(?:ts|tsx|mts|cts)$/i.test(filePath)) return "typescript";
  return "javascript";
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
  const root = project.root ?? ".";
  nonEmptyString(root, `projects[${index}].root`);
  const sourceRoots = project.sourceRoots === undefined ? ["."] : stringList(project.sourceRoots, `projects[${index}].sourceRoots`);
  const files = stringList(project.files, `projects[${index}].files`);
  const dependsOn = stringList(project.dependsOn, `projects[${index}].dependsOn`);
  if (project.fallback !== undefined && !isPlainObject(project.fallback)) {
    throw new PieceWorkspaceError("invalid-workspace-config", `projects[${index}].fallback must be an object when provided.`);
  }
  if (project.analysisOptions !== undefined && !isPlainObject(project.analysisOptions)) {
    throw new PieceWorkspaceError("invalid-workspace-config", `projects[${index}].analysisOptions must be an object when provided.`);
  }
  return {
    id,
    root,
    sourceRoots,
    files,
    dependsOn: sortedUnique(dependsOn),
    fallback: project.fallback,
    analysisOptions: project.analysisOptions ?? {},
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
  const discovered = [];
  for (const sourceRoot of project.sourceRoots) {
    discovered.push(...(await collectSourceFiles(sourceRoot)));
  }
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
    const key = [edge.from, edge.to, edge.kind, edge.sourceFile ?? "", edge.targetFile ?? ""].join("\u001f");
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

/**
 * Analyze only explicitly configured projects. It never discovers a monorepo,
 * and it never turns a semantic Piece target into a workspace compiler action.
 */
export async function analyzePieceWorkspace(options = {}) {
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
  const projects = [];
  for (const project of resolvedProjects.sort((left, right) => left.id.localeCompare(right.id))) {
    const sourceFiles = await projectSourceFiles(project);
    const files = [];
    const fallbackReasons = [];
    for (const filePath of sourceFiles) {
      let source;
      try {
        source = await readFile(filePath, "utf8");
      } catch (error) {
        const diagnostic = analysisDiagnostic(error, filePath);
        files.push({ filePath, language: languageForFile(filePath), status: "error", diagnostics: [diagnostic] });
        fallbackReasons.push(fallbackReason("workspace-file-read-failed", diagnostic.message, { filePath }));
        continue;
      }
      const language = languageForFile(filePath);
      const languageInputs = language === "go" || language === "kotlin" ? { sourceFiles, sourceRoots: project.sourceRoots } : {};
      try {
        const analysis = await analyzeFile({
          ...project.analysisOptions,
          ...languageInputs,
          cwd: workspaceRoot,
          filePath,
          source
        });
        files.push({ filePath, language, status: "analyzed", analysis, diagnostics: [] });
      } catch (error) {
        const diagnostic = analysisDiagnostic(error, filePath);
        files.push({ filePath, language, status: "error", diagnostics: [diagnostic] });
        fallbackReasons.push(fallbackReason("workspace-file-analysis-failed", diagnostic.message, { filePath }));
      }
    }
    projects.push({
      id: project.id,
      root: project.root,
      sourceRoots: project.sourceRoots,
      sourceFiles,
      language: project.language,
      dependsOn: project.dependsOn,
      fallback: project.fallback,
      files,
      fallbackReasons,
      metrics: {
        sourceFileCount: sourceFiles.length,
        analyzedFileCount: files.filter((file) => file.status === "analyzed").length,
        analysisErrorCount: files.filter((file) => file.status === "error").length,
        sliceCount: files.reduce((total, file) => total + (file.analysis?.manifest?.slices?.length ?? 0), 0)
      }
    });
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
      analysisErrorCount: projects.reduce((total, project) => total + project.metrics.analysisErrorCount, 0)
    }
  };
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
    const id = members.join("\u001f");
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
    const path = resolve(workspace.workspaceRoot, nonEmptyString(changedFile, "changedFiles entry"));
    let owner = ownerByFile.get(path);
    if (!owner) {
      for (const rootAlias of workspace.workspaceRootAliases ?? [workspace.workspaceRoot]) {
        if (!isPathInside(rootAlias, path)) continue;
        const canonicalPath = resolve(workspace.workspaceRoot, relative(rootAlias, path));
        owner = ownerByFile.get(canonicalPath);
        if (owner) break;
      }
    }
    if (!owner) {
      for (const project of projects.values()) {
        appendReason(
          reasonsByProject,
          project.id,
          fallbackReason("workspace-change-not-owned", "A changed file is not owned by an analyzed project, so the workspace must use fallback planning.", { filePath: path })
        );
      }
      return all;
    }
    changedProjects.add(owner);
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
  selected = selectPlannedProjects(workspace, options, graphEdges, reasonsByProject);
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

export function createPieceWorkspaceCompiler(defaultOptions = {}) {
  return {
    analyze(options = {}) {
      return analyzePieceWorkspace({ ...defaultOptions, ...options });
    },
    plan(workspace, options = {}) {
      return planPieceWorkspaceBuild(workspace, options);
    }
  };
}
