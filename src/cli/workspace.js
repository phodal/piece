import { lstat, realpath } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";
import { executePieceFallback } from "../node-fallback-executor.js";
import { PieceWorkspaceError, analyzePieceWorkspace, planPieceWorkspaceBuild } from "../node-workspace.js";

const CONFIG_KEYS = new Set(["schemaVersion", "defaultProject", "projects"]);
const PROJECT_KEYS = new Set(["id", "root", "sourceRoots", "dependsOn", "build", "check"]);
const TASK_KEYS = new Set(["request", "policy", "outputs"]);
const REQUEST_KEYS = new Set(["profile", "action", "task", "script"]);
const POLICY_KEYS = new Set(["profiles", "envAllowlist", "env", "timeoutMs", "maxOutputBytes", "killGraceMs"]);
const PROFILE_KEYS = Object.freeze({
  go: new Set(["root", "allowActions", "command"]),
  gradle: new Set(["root", "allowTasks", "command"]),
  typescript: new Set(["root", "allowScripts", "packageManager"])
});
const PROFILE_NAMES = new Set(Object.keys(PROFILE_KEYS));
const PROJECT_ID = /^[A-Za-z][A-Za-z0-9._-]*$/;
const ENVIRONMENT_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;
const ACTION_NAME = /^[A-Za-z][A-Za-z0-9:_-]*$/;
const GRADLE_TASK_NAME = /^:?[A-Za-z][A-Za-z0-9:_-]*$/;

export class PieceWorkspaceCliConfigError extends Error {
  constructor(code, message, cause) {
    super(message, cause ? { cause } : undefined);
    this.name = "PieceWorkspaceCliConfigError";
    this.code = code;
  }
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function configError(code, message) {
  throw new PieceWorkspaceCliConfigError(code, message);
}

function requireObject(value, label) {
  if (!isPlainObject(value)) {
    configError("invalid-workspace-config", `${label} must be an object.`);
  }
  return value;
}

function rejectUnknownKeys(value, allowed, label) {
  const unknown = Object.keys(value).filter((key) => !allowed.has(key));
  if (unknown.length > 0) {
    configError("unknown-workspace-config-key", `${label} contains unsupported key(s): ${unknown.join(", ")}.`);
  }
}

function nonEmptyString(value, label) {
  if (typeof value !== "string" || value.trim().length === 0 || value.includes("\0")) {
    configError("invalid-workspace-config", `${label} must be a non-empty string.`);
  }
  return value;
}

function relativePath(value, label) {
  const path = nonEmptyString(value, label);
  if (isAbsolute(path)) {
    configError("workspace-path-must-be-relative", `${label} must be relative to its declared workspace or project root.`);
  }
  if (path.split(/[\\/]+/).includes("..")) {
    configError("workspace-path-escape", `${label} must not contain '..' path segments.`);
  }
  return path;
}

function stringArray(value, label, { minimum = 0, pattern } = {}) {
  if (!Array.isArray(value) || value.length < minimum || value.some((entry) => typeof entry !== "string" || entry.trim().length === 0)) {
    configError("invalid-workspace-config", `${label} must be an array of ${minimum > 0 ? "one or more " : ""}non-empty strings.`);
  }
  if (pattern && value.some((entry) => !pattern.test(entry))) {
    configError("invalid-workspace-config", `${label} contains an unsupported value.`);
  }
  if (new Set(value).size !== value.length) {
    configError("duplicate-workspace-config-value", `${label} must not contain duplicate values.`);
  }
  return [...value];
}

function positiveInteger(value, label, { allowZero = false } = {}) {
  if (value === undefined) return undefined;
  if (!Number.isInteger(value) || value < (allowZero ? 0 : 1)) {
    configError("invalid-workspace-config", `${label} must be a ${allowZero ? "non-negative" : "positive"} integer.`);
  }
  return value;
}

function normalizeFallbackRequest(value, label) {
  const request = requireObject(value, `${label}.request`);
  rejectUnknownKeys(request, REQUEST_KEYS, `${label}.request`);
  const profile = nonEmptyString(request.profile, `${label}.request.profile`);
  if (!PROFILE_NAMES.has(profile)) {
    configError("invalid-workspace-config", `${label}.request.profile must be one of: ${[...PROFILE_NAMES].join(", ")}.`);
  }
  const actionFields = ["action", "task", "script"].filter((field) => request[field] !== undefined);
  const requiredField = profile === "go" ? "action" : profile === "gradle" ? "task" : "script";
  if (actionFields.length !== 1 || actionFields[0] !== requiredField) {
    configError("invalid-workspace-config", `${label}.request for '${profile}' must define only '${requiredField}'.`);
  }
  const pattern = profile === "gradle" ? GRADLE_TASK_NAME : ACTION_NAME;
  const valueForProfile = nonEmptyString(request[requiredField], `${label}.request.${requiredField}`);
  if (!pattern.test(valueForProfile)) {
    configError("invalid-workspace-config", `${label}.request.${requiredField} is not a supported name.`);
  }
  if (profile === "go" && !["build", "test"].includes(valueForProfile)) {
    configError("invalid-workspace-config", `${label}.request.action must be 'build' or 'test'.`);
  }
  return { profile, [requiredField]: valueForProfile };
}

function normalizeProfile(value, profile, label) {
  const profileValue = requireObject(value, `${label}.profiles.${profile}`);
  rejectUnknownKeys(profileValue, PROFILE_KEYS[profile], `${label}.profiles.${profile}`);
  const root = relativePath(profileValue.root, `${label}.profiles.${profile}.root`);
  if (profile === "go") {
    const allowActions = stringArray(profileValue.allowActions, `${label}.profiles.go.allowActions`, { minimum: 1, pattern: ACTION_NAME });
    if (allowActions.some((action) => !["build", "test"].includes(action))) {
      configError("invalid-workspace-config", `${label}.profiles.go.allowActions may contain only 'build' or 'test'.`);
    }
    if (profileValue.command !== undefined && profileValue.command !== "go") {
      configError("invalid-workspace-config", `${label}.profiles.go.command may only be 'go'.`);
    }
    return {
      root,
      allowActions,
      ...(profileValue.command === undefined ? {} : { command: profileValue.command })
    };
  }
  if (profile === "gradle") {
    const allowTasks = stringArray(profileValue.allowTasks, `${label}.profiles.gradle.allowTasks`, { minimum: 1, pattern: GRADLE_TASK_NAME });
    if (profileValue.command !== undefined && !["./gradlew", "./gradlew.bat"].includes(profileValue.command)) {
      configError("invalid-workspace-config", `${label}.profiles.gradle.command must be './gradlew' or './gradlew.bat'.`);
    }
    return {
      root,
      allowTasks,
      ...(profileValue.command === undefined ? {} : { command: profileValue.command })
    };
  }
  const allowScripts = stringArray(profileValue.allowScripts, `${label}.profiles.typescript.allowScripts`, { minimum: 1, pattern: ACTION_NAME });
  const packageManager = profileValue.packageManager ?? "npm";
  if (!["npm", "pnpm", "yarn"].includes(packageManager)) {
    configError("invalid-workspace-config", `${label}.profiles.typescript.packageManager must be npm, pnpm, or yarn.`);
  }
  return { root, allowScripts, packageManager };
}

function normalizeFallbackPolicy(value, label, profile) {
  const policy = requireObject(value, `${label}.policy`);
  rejectUnknownKeys(policy, POLICY_KEYS, `${label}.policy`);
  const profiles = requireObject(policy.profiles, `${label}.policy.profiles`);
  const profileNames = Object.keys(profiles);
  if (profileNames.length !== 1 || profileNames[0] !== profile) {
    configError("invalid-workspace-config", `${label}.policy.profiles must declare only the requested '${profile}' profile.`);
  }
  const envAllowlist = policy.envAllowlist === undefined ? [] : stringArray(policy.envAllowlist, `${label}.policy.envAllowlist`, { pattern: ENVIRONMENT_NAME });
  if (!envAllowlist.includes("PATH")) {
    configError("fallback-path-not-allowlisted", `${label}.policy.envAllowlist must include PATH for a controlled fallback execution.`);
  }
  const env = policy.env ?? {};
  if (!isPlainObject(env)) {
    configError("invalid-workspace-config", `${label}.policy.env must be an object of string values.`);
  }
  for (const [name, entry] of Object.entries(env)) {
    if (!envAllowlist.includes(name)) {
      configError("fallback-environment-not-allowlisted", `${label}.policy.env.${name} is not listed in envAllowlist.`);
    }
    if (typeof entry !== "string") {
      configError("invalid-workspace-config", `${label}.policy.env.${name} must be a string.`);
    }
  }
  return {
    profiles: { [profile]: normalizeProfile(profiles[profile], profile, `${label}.policy`) },
    envAllowlist,
    env: { ...env },
    ...(positiveInteger(policy.timeoutMs, `${label}.policy.timeoutMs`) === undefined ? {} : { timeoutMs: policy.timeoutMs }),
    ...(positiveInteger(policy.maxOutputBytes, `${label}.policy.maxOutputBytes`, { allowZero: true }) === undefined
      ? {}
      : { maxOutputBytes: policy.maxOutputBytes }),
    ...(positiveInteger(policy.killGraceMs, `${label}.policy.killGraceMs`, { allowZero: true }) === undefined
      ? {}
      : { killGraceMs: policy.killGraceMs })
  };
}

function normalizeTask(value, label, { build }) {
  const task = requireObject(value, label);
  rejectUnknownKeys(task, TASK_KEYS, label);
  if (!build && task.outputs !== undefined) {
    configError("invalid-workspace-config", `${label}.outputs is only supported for build tasks.`);
  }
  const request = normalizeFallbackRequest(task.request, label);
  const policy = normalizeFallbackPolicy(task.policy, label, request.profile);
  const allowed = policy.profiles[request.profile];
  const requiredField = request.profile === "go" ? "action" : request.profile === "gradle" ? "task" : "script";
  const allowedValues = request.profile === "go" ? allowed.allowActions : request.profile === "gradle" ? allowed.allowTasks : allowed.allowScripts;
  if (!allowedValues.includes(request[requiredField])) {
    configError("fallback-request-not-allowlisted", `${label}.request.${requiredField} must be listed in its strict fallback policy.`);
  }
  const outputs = build && task.outputs !== undefined
    ? stringArray(task.outputs, `${label}.outputs`, { minimum: 1 }).map((entry, index) => {
        const output = relativePath(entry, `${label}.outputs[${index}]`);
        if (resolve(".", output) === resolve(".")) {
          configError("invalid-workspace-config", `${label}.outputs[${index}] must name an artifact below the project root, not '.'.`);
        }
        return output;
      })
    : undefined;
  return {
    request,
    policy,
    ...(outputs === undefined ? {} : { outputs })
  };
}

function assertAcyclicProjects(projects) {
  const projectIds = new Set(projects.map((project) => project.id));
  for (const project of projects) {
    for (const dependency of project.dependsOn) {
      if (!projectIds.has(dependency)) {
        configError("workspace-project-dependency-missing", `Project '${project.id}' depends on undeclared project '${dependency}'.`);
      }
      if (dependency === project.id) {
        configError("workspace-project-dependency-cycle", `Project '${project.id}' must not depend on itself.`);
      }
    }
  }
  const visiting = new Set();
  const visited = new Set();
  const projectsById = new Map(projects.map((project) => [project.id, project]));
  function visit(projectId, ancestry) {
    if (visited.has(projectId)) return;
    if (visiting.has(projectId)) {
      const start = ancestry.indexOf(projectId);
      configError("workspace-project-dependency-cycle", `Declared project dependency cycle: ${[...ancestry.slice(start), projectId].join(" -> ")}.`);
    }
    visiting.add(projectId);
    const project = projectsById.get(projectId);
    for (const dependency of project.dependsOn) visit(dependency, [...ancestry, projectId]);
    visiting.delete(projectId);
    visited.add(projectId);
  }
  for (const project of projects) visit(project.id, []);
}

/** Normalize the deliberately narrow, explicit workspace CLI config schema. */
export function normalizePieceWorkspaceCliConfig(value) {
  const config = requireObject(value, "piece.config.json");
  rejectUnknownKeys(config, CONFIG_KEYS, "piece.config.json");
  if (config.schemaVersion !== 2) {
    configError("unsupported-config-schema", "Workspace build configuration must set schemaVersion to 2.");
  }
  if (!Array.isArray(config.projects) || config.projects.length === 0) {
    configError("invalid-workspace-config", "piece.config.json projects must be a non-empty array.");
  }
  const projects = config.projects.map((rawProject, index) => {
    const label = `projects[${index}]`;
    const project = requireObject(rawProject, label);
    rejectUnknownKeys(project, PROJECT_KEYS, label);
    const id = nonEmptyString(project.id, `${label}.id`);
    if (!PROJECT_ID.test(id)) {
      configError("invalid-workspace-config", `${label}.id must start with a letter and use only letters, digits, '.', '_' or '-'.`);
    }
    const root = relativePath(project.root, `${label}.root`);
    const sourceRoots = stringArray(project.sourceRoots, `${label}.sourceRoots`, { minimum: 1 }).map((entry, sourceRootIndex) =>
      relativePath(entry, `${label}.sourceRoots[${sourceRootIndex}]`)
    );
    const dependsOn = project.dependsOn === undefined ? [] : stringArray(project.dependsOn, `${label}.dependsOn`, { pattern: PROJECT_ID });
    return {
      id,
      root,
      sourceRoots,
      dependsOn,
      build: normalizeTask(project.build, `${label}.build`, { build: true }),
      check: normalizeTask(project.check, `${label}.check`, { build: false })
    };
  });
  if (new Set(projects.map((project) => project.id)).size !== projects.length) {
    configError("duplicate-workspace-project", "Every projects entry must have a unique id.");
  }
  const defaultProject = config.defaultProject === undefined ? undefined : nonEmptyString(config.defaultProject, "defaultProject");
  if (defaultProject !== undefined && !PROJECT_ID.test(defaultProject)) {
    configError("invalid-workspace-config", "defaultProject must use the same identifier format as projects[].id.");
  }
  if (defaultProject !== undefined && !projects.some((project) => project.id === defaultProject)) {
    configError("workspace-default-project-not-found", `defaultProject '${defaultProject}' is not declared in projects.`);
  }
  assertAcyclicProjects(projects);
  return {
    schemaVersion: 2,
    ...(defaultProject === undefined ? {} : { defaultProject }),
    projects
  };
}

function isPathInside(root, candidate) {
  const offset = relative(root, candidate);
  return offset === "" || (offset !== ".." && !offset.startsWith(`..${sep}`) && !isAbsolute(offset));
}

async function canonicalDirectory(root, value, label) {
  const lexicalPath = resolve(root, value);
  if (!isPathInside(root, lexicalPath)) {
    configError("workspace-path-escape", `${label} must stay inside '${root}'.`);
  }
  let canonicalPath;
  try {
    canonicalPath = await realpath(lexicalPath);
  } catch (error) {
    configError("workspace-path-not-found", `${label} '${lexicalPath}' does not exist or cannot be resolved: ${error?.message ?? String(error)}.`);
  }
  if (!isPathInside(root, canonicalPath)) {
    configError("workspace-path-escape", `${label} resolves outside '${root}'.`);
  }
  let info;
  try {
    info = await lstat(canonicalPath);
  } catch (error) {
    configError("workspace-path-inspection-failed", `Could not inspect ${label} '${canonicalPath}': ${error?.message ?? String(error)}.`);
  }
  if (!info.isDirectory()) {
    configError("workspace-path-not-directory", `${label} '${canonicalPath}' is not a directory.`);
  }
  return canonicalPath;
}

function ensureFutureContainedPath(root, value, label, { mustBeBelowRoot = false } = {}) {
  const path = resolve(root, value);
  if (!isPathInside(root, path)) {
    configError("workspace-path-escape", `${label} must stay inside '${root}'.`);
  }
  if (mustBeBelowRoot && path === resolve(root)) {
    configError("invalid-workspace-config", `${label} must name an artifact below the project root.`);
  }
  return path;
}

async function preflightWorkspaceConfig(workspaceRoot, config) {
  const canonicalWorkspace = await canonicalDirectory(workspaceRoot, ".", "workspace root");
  const roots = new Map();
  for (const project of config.projects) {
    const projectRoot = await canonicalDirectory(canonicalWorkspace, project.root, `project '${project.id}' root`);
    for (const sourceRoot of project.sourceRoots) {
      await canonicalDirectory(projectRoot, sourceRoot, `project '${project.id}' source root`);
    }
    for (const [taskName, task] of Object.entries({ build: project.build, check: project.check })) {
      const profile = task.request.profile;
      await canonicalDirectory(projectRoot, task.policy.profiles[profile].root, `project '${project.id}' ${taskName} fallback root`);
      for (const output of task.outputs ?? []) {
        ensureFutureContainedPath(projectRoot, output, `project '${project.id}' ${taskName} output`, { mustBeBelowRoot: true });
      }
    }
    roots.set(project.id, projectRoot);
  }
  return { workspaceRoot: canonicalWorkspace, roots };
}

function workspaceRelativePath(workspaceRoot, path) {
  return relative(workspaceRoot, path) || ".";
}

function normalizedDiagnostic(diagnostic, projectId) {
  return {
    code: String(diagnostic?.code ?? "workspace-diagnostic"),
    severity: diagnostic?.severity === "warning" || diagnostic?.severity === "info" ? diagnostic.severity : "error",
    message: String(diagnostic?.message ?? "Workspace task reported a diagnostic."),
    ...(projectId ? { projectId } : {})
  };
}

function projectFeedbackScope(project) {
  const reasons = project.fallbackReasons ?? [];
  return {
    level: reasons.length > 0 ? "project" : "piece",
    fallbackRequired: reasons.length > 0,
    reasons: reasons.map((reason) => ({
      code: String(reason?.code ?? "workspace-fallback-reason"),
      severity: reason?.severity === "error" ? "error" : "warning",
      message: String(reason?.message ?? "Workspace analysis requested a project fallback.")
    }))
  };
}

function projectPieceSummary(project) {
  const feedbackScope = projectFeedbackScope(project);
  return {
    status: project.metrics?.analysisErrorCount > 0 ? "analysis-warning" : feedbackScope.fallbackRequired ? "fallback-required" : "analyzed",
    sourceFileCount: project.metrics?.sourceFileCount ?? 0,
    analyzedFileCount: project.metrics?.analyzedFileCount ?? 0,
    analysisErrorCount: project.metrics?.analysisErrorCount ?? 0,
    feedbackScope: {
      level: feedbackScope.level,
      fallbackRequired: feedbackScope.fallbackRequired,
      reasonCodes: feedbackScope.reasons.map((reason) => reason.code).sort()
    }
  };
}

function fallbackExecutionSummary(result, workspaceRoot) {
  const plan = result?.plan;
  const command = result?.command;
  return {
    kind: "configured-project-fallback",
    status: result?.status ?? "blocked",
    ...(result?.profile ? { profile: result.profile } : {}),
    ...(plan
      ? {
          plan: {
            command: plan.command,
            args: [...(plan.args ?? [])],
            cwd: { workspaceRelativePath: workspaceRelativePath(workspaceRoot, plan.cwd) },
            markers: (plan.markers ?? []).map((path) => ({ workspaceRelativePath: workspaceRelativePath(workspaceRoot, path) }))
          }
        }
      : {}),
    ...(command
      ? {
          command: {
            exitCode: command.exitCode,
            ...(command.errorCode ? { errorCode: command.errorCode } : {}),
            durationMs: command.durationMs,
            outputBytes: command.outputBytes
          }
        }
      : {})
  };
}

async function verifyBuildOutputs({ workspaceRoot, projectRoot, outputs }) {
  const verified = [];
  const diagnostics = [];
  for (const output of outputs) {
    const requestedPath = ensureFutureContainedPath(projectRoot, output, `declared build output '${output}'`, { mustBeBelowRoot: true });
    let canonicalPath;
    try {
      canonicalPath = await realpath(requestedPath);
    } catch {
      diagnostics.push({
        code: "declared-build-output-missing",
        severity: "error",
        message: `The successful fallback command did not create declared build output '${output}'.`
      });
      continue;
    }
    if (!isPathInside(projectRoot, canonicalPath) || !isPathInside(workspaceRoot, canonicalPath)) {
      diagnostics.push({
        code: "declared-build-output-escape",
        severity: "error",
        message: `Declared build output '${output}' resolves outside its project root.`
      });
      continue;
    }
    try {
      const info = await lstat(canonicalPath);
      if (!info.isFile() && !info.isDirectory()) {
        diagnostics.push({
          code: "declared-build-output-invalid",
          severity: "error",
          message: `Declared build output '${output}' is not a regular file or directory.`
        });
        continue;
      }
      verified.push({
        workspaceRelativePath: workspaceRelativePath(workspaceRoot, canonicalPath),
        kind: info.isDirectory() ? "directory" : "file"
      });
    } catch (error) {
      diagnostics.push({
        code: "declared-build-output-inspection-failed",
        severity: "error",
        message: `Could not inspect declared build output '${output}': ${error?.message ?? String(error)}.`
      });
    }
  }
  return { outputs: verified, diagnostics };
}

function skippedProjectResult({ action, project, workspaceRoot, dependencyIds }) {
  const diagnostic = {
    code: "workspace-project-dependency-failed",
    severity: "error",
    message: `Project '${action.projectId}' was not executed because dependency action(s) failed: ${dependencyIds.join(", ")}.`
  };
  return {
    id: action.projectId,
    root: { workspaceRelativePath: workspaceRelativePath(workspaceRoot, project.root) },
    dependencies: [...action.dependsOn],
    piece: projectPieceSummary(project),
    execution: { kind: "configured-project-fallback", status: "skipped", reason: "dependency-failed" },
    diagnostics: [diagnostic]
  };
}

function cycleProjectResult({ action, project, workspaceRoot }) {
  const diagnostic = {
    code: "workspace-project-dependency-cycle",
    severity: "error",
    message: `Project '${action.projectId}' cannot run because the analyzed project graph contains a dependency cycle.`
  };
  return {
    id: action.projectId,
    root: { workspaceRelativePath: workspaceRelativePath(workspaceRoot, project.root) },
    dependencies: [...action.dependsOn],
    piece: projectPieceSummary(project),
    execution: { kind: "configured-project-fallback", status: "blocked", reason: "dependency-cycle" },
    diagnostics: [diagnostic]
  };
}

async function executeWorkspaceAction({ action, project, configProject, command, workspaceRoot }) {
  const task = configProject[command];
  const result = await executePieceFallback({
    workspaceRoot: project.root,
    analysis: { feedbackScope: projectFeedbackScope(project) },
    request: { ...task.request, mode: "execute", level: "project" },
    policy: task.policy
  });
  const diagnostics = (result.diagnostics ?? []).map((diagnostic) => normalizedDiagnostic(diagnostic, action.projectId));
  const projectResult = {
    id: action.projectId,
    root: { workspaceRelativePath: workspaceRelativePath(workspaceRoot, project.root) },
    dependencies: [...action.dependsOn],
    piece: projectPieceSummary(project),
    execution: fallbackExecutionSummary(result, workspaceRoot),
    ...(command === "build" ? { outputs: [] } : {}),
    diagnostics
  };
  if (result.status !== "success") {
    return projectResult;
  }
  if (command !== "build") {
    return projectResult;
  }
  if (!task.outputs || task.outputs.length === 0) {
    projectResult.execution = { ...projectResult.execution, outputVerification: "not-configured" };
    return projectResult;
  }
  const verification = await verifyBuildOutputs({ workspaceRoot, projectRoot: project.root, outputs: task.outputs });
  projectResult.outputs = verification.outputs;
  projectResult.diagnostics.push(...verification.diagnostics.map((diagnostic) => normalizedDiagnostic(diagnostic, action.projectId)));
  if (verification.diagnostics.length > 0) {
    projectResult.execution = { ...projectResult.execution, status: "error", outputVerification: "failed" };
  } else {
    projectResult.execution = { ...projectResult.execution, outputVerification: "verified" };
  }
  return projectResult;
}

function resultStatus(projects) {
  return projects.every((project) => project.execution.status === "success") ? "success" : "failed";
}

function resultDiagnostics(projects, workspace) {
  const diagnostics = [];
  for (const project of workspace.projects) {
    for (const reason of project.fallbackReasons ?? []) {
      diagnostics.push(normalizedDiagnostic(reason, project.id));
    }
    for (const file of project.files ?? []) {
      for (const diagnostic of file.diagnostics ?? []) {
        diagnostics.push(normalizedDiagnostic(diagnostic, project.id));
      }
    }
  }
  for (const project of projects) {
    diagnostics.push(...project.diagnostics.map((diagnostic) => normalizedDiagnostic(diagnostic, project.id)));
  }
  const unique = new Map();
  for (const diagnostic of diagnostics) {
    const key = `${diagnostic.projectId ?? ""}:${diagnostic.severity}:${diagnostic.code}:${diagnostic.message}`;
    unique.set(key, diagnostic);
  }
  return [...unique.values()].sort((left, right) => `${left.projectId ?? ""}:${left.severity}:${left.code}:${left.message}`.localeCompare(`${right.projectId ?? ""}:${right.severity}:${right.code}:${right.message}`));
}

/**
 * Execute an explicit project's dependency closure through configured native
 * fallback tasks. Piece analysis stays advisory: it never becomes a claim that
 * one declaration action built the whole workspace project.
 */
export async function runPieceWorkspaceCliTask({ command, workspace, config, projectId }) {
  if (!["build", "check"].includes(command)) {
    configError("invalid-workspace-command", `Unsupported workspace command '${command}'.`);
  }
  const requestedProjectId = projectId ?? config.defaultProject;
  if (!requestedProjectId) {
    configError("workspace-project-required", `piece ${command} requires a project id because this v2 configuration has no defaultProject.`);
  }
  if (!config.projects.some((project) => project.id === requestedProjectId)) {
    configError("workspace-project-not-found", `Requested project '${requestedProjectId}' is not declared.`);
  }
  const preflight = await preflightWorkspaceConfig(workspace, config);
  let analyzedWorkspace;
  try {
    analyzedWorkspace = await analyzePieceWorkspace({
      workspaceRoot: preflight.workspaceRoot,
      projects: config.projects.map((project) => ({
        id: project.id,
        root: project.root,
        sourceRoots: project.sourceRoots,
        dependsOn: project.dependsOn,
        fallback: { build: project.build, check: project.check }
      }))
    });
  } catch (error) {
    if (error instanceof PieceWorkspaceError) {
      throw new PieceWorkspaceCliConfigError(error.code, error.message, error);
    }
    throw error;
  }
  let plan;
  try {
    plan = planPieceWorkspaceBuild(analyzedWorkspace, { projectIds: [requestedProjectId] });
  } catch (error) {
    if (error instanceof PieceWorkspaceError) {
      throw new PieceWorkspaceCliConfigError(error.code, error.message, error);
    }
    throw error;
  }
  const projectById = new Map(analyzedWorkspace.projects.map((project) => [project.id, project]));
  const configById = new Map(config.projects.map((project) => [project.id, project]));
  const actionStatuses = new Map();
  const projects = [];
  for (const batch of plan.batches) {
    for (const action of batch.actions) {
      const project = projectById.get(action.projectId);
      const configProject = configById.get(action.projectId);
      const failedDependencies = action.dependsOn.filter((dependencyId) => actionStatuses.get(dependencyId) !== "success");
      let projectResult;
      if (failedDependencies.length > 0) {
        projectResult = skippedProjectResult({ action, project, workspaceRoot: preflight.workspaceRoot, dependencyIds: failedDependencies });
      } else if (action.scheduling === "cycle-fallback") {
        projectResult = cycleProjectResult({ action, project, workspaceRoot: preflight.workspaceRoot });
      } else {
        projectResult = await executeWorkspaceAction({
          action,
          project,
          configProject,
          command,
          workspaceRoot: preflight.workspaceRoot
        });
      }
      actionStatuses.set(action.id, projectResult.execution.status);
      projects.push(projectResult);
    }
  }
  const status = resultStatus(projects);
  const guarantees = [
    "execution-is-limited-to-the-explicitly-declared-project-closure",
    "native-tasks-use-strict-allowlisted-fallback-profiles",
    "failed-dependencies-block-their-downstream-projects"
  ];
  if (command === "build") {
    if (status === "success") guarantees.push("configured-native-project-builds-succeeded");
    if (status === "success" && projects.some((project) => project.execution.outputVerification === "verified")) {
      guarantees.push("declared-build-outputs-verified-on-success");
    }
  } else if (status === "success") {
    guarantees.push("configured-native-project-checks-succeeded");
  }
  return {
    schemaVersion: 1,
    command,
    status,
    exitCode: status === "success" ? 0 : 1,
    selection: {
      projectId: requestedProjectId,
      provenance: projectId ? "argument" : "config-default",
      closure: [...plan.selectedProjects]
    },
    scope: {
      kind: "declared-workspace-project-graph",
      workspaceOrchestration: "configured-native-fallback",
      guarantees,
      limitations: [
        "Only projects explicitly declared in piece.config.json are covered.",
        "Piece analysis is per-file evidence and does not replace the configured native project task."
      ]
    },
    plan: {
      executionMode: plan.executionMode,
      status: plan.status,
      batches: plan.batches.map((batch) => ({
        index: batch.index,
        kind: batch.kind,
        projects: batch.actions.map((action) => action.projectId)
      }))
    },
    projects,
    diagnostics: resultDiagnostics(projects, analyzedWorkspace)
  };
}
