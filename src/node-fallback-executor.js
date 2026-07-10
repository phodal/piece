import { lstat, readFile, realpath } from "node:fs/promises";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { NODE_ACTION_ERROR_CODES, isNodeActionFailure, runNodeAction } from "./node-action-runner.js";

/**
 * A deliberately narrow host-side fallback boundary. Piece analysis may say
 * that a file or project fallback is necessary, but it must never turn that
 * conclusion into an arbitrary shell command. Callers supply one explicit,
 * allowlisted profile and this module constructs every executable argument.
 */
export const PIECE_FALLBACK_EXECUTOR_VERSION = 1;
export const PIECE_FALLBACK_PROFILES = Object.freeze(["go", "gradle", "typescript"]);
export const PIECE_FALLBACK_MODES = Object.freeze(["plan", "execute"]);

const POLICY_FIELDS = new Set(["profiles", "envAllowlist", "env", "timeoutMs", "maxOutputBytes", "killGraceMs"]);
const REQUEST_FIELDS = new Set(["mode", "level", "profile", "action", "task", "script"]);
const PROFILE_FIELDS = Object.freeze({
  go: new Set(["root", "allowActions", "command"]),
  gradle: new Set(["root", "allowTasks", "command"]),
  typescript: new Set(["root", "allowScripts", "packageManager"])
});
const ENVIRONMENT_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;
const ACTION_NAME = /^[A-Za-z][A-Za-z0-9:_-]*$/;
const GRADLE_TASK_NAME = /^:?[A-Za-z][A-Za-z0-9:_-]*$/;

function isRecord(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function diagnostic(code, message, details = {}) {
  return {
    code,
    severity: "error",
    message,
    ...details
  };
}

function blocked({ mode = "plan", profile, scope, diagnostics }) {
  return {
    version: PIECE_FALLBACK_EXECUTOR_VERSION,
    status: "blocked",
    mode,
    ...(profile ? { profile } : {}),
    scope,
    diagnostics
  };
}

function inside(root, candidate) {
  const offset = relative(root, candidate);
  return offset === "" || (offset !== ".." && !offset.startsWith(`..${sep}`) && !isAbsolute(offset));
}

function unknownFields(value, allowed) {
  return Object.keys(value).filter((key) => !allowed.has(key));
}

function normalizedFeedbackScope(analysis) {
  const feedbackScope = analysis?.feedbackScope;
  if (!isRecord(feedbackScope)) {
    return {
      level: "unknown",
      fallbackRequired: false,
      reasons: []
    };
  }
  return {
    level: typeof feedbackScope.level === "string" && feedbackScope.level ? feedbackScope.level : "unknown",
    fallbackRequired: feedbackScope.fallbackRequired === true,
    reasons: Array.isArray(feedbackScope.reasons)
      ? feedbackScope.reasons.map((reason) => ({
          code: String(reason?.code ?? "piece-feedback-reason"),
          severity: String(reason?.severity ?? "warning"),
          message: String(reason?.message ?? "Piece reported a fallback reason.")
        }))
      : []
  };
}

function positiveInteger(value, field, { allowZero = false } = {}) {
  if (value === undefined) return { value: undefined };
  if (!Number.isInteger(value) || value < (allowZero ? 0 : 1)) {
    return {
      diagnostic: diagnostic("fallback-policy-invalid", `policy.${field} must be a ${allowZero ? "non-negative" : "positive"} integer.`)
    };
  }
  return { value };
}

function stringAllowlist(value, field, pattern = ACTION_NAME) {
  if (!Array.isArray(value) || value.length === 0 || value.some((entry) => typeof entry !== "string" || !pattern.test(entry))) {
    return {
      diagnostic: diagnostic("fallback-policy-invalid", `${field} must be a non-empty array of simple command names.`)
    };
  }
  return { value: [...new Set(value)] };
}

function normalizeEnvironment(policy) {
  const names = policy.envAllowlist ?? [];
  if (!Array.isArray(names) || names.some((name) => typeof name !== "string" || !ENVIRONMENT_NAME.test(name))) {
    return {
      diagnostic: diagnostic("fallback-policy-invalid", "policy.envAllowlist must contain valid environment variable names.")
    };
  }
  const envAllowlist = [...new Set(names)];
  const supplied = policy.env ?? {};
  if (!isRecord(supplied)) {
    return {
      diagnostic: diagnostic("fallback-policy-invalid", "policy.env must be an object of string values.")
    };
  }
  for (const [name, value] of Object.entries(supplied)) {
    if (!envAllowlist.includes(name)) {
      return {
        diagnostic: diagnostic("fallback-environment-not-allowlisted", `policy.env.${name} is not in policy.envAllowlist.`, { name })
      };
    }
    if (typeof value !== "string") {
      return {
        diagnostic: diagnostic("fallback-policy-invalid", `policy.env.${name} must be a string.`, { name })
      };
    }
  }
  const timeout = positiveInteger(policy.timeoutMs, "timeoutMs");
  const output = positiveInteger(policy.maxOutputBytes, "maxOutputBytes", { allowZero: true });
  const grace = positiveInteger(policy.killGraceMs, "killGraceMs", { allowZero: true });
  const policyDiagnostic = timeout.diagnostic ?? output.diagnostic ?? grace.diagnostic;
  if (policyDiagnostic) return { diagnostic: policyDiagnostic };
  return {
    value: {
      envAllowlist,
      env: { ...supplied },
      ...(timeout.value === undefined ? {} : { timeoutMs: timeout.value }),
      ...(output.value === undefined ? {} : { maxOutputBytes: output.value }),
      ...(grace.value === undefined ? {} : { killGraceMs: grace.value })
    }
  };
}

function validateRequest(value) {
  if (value !== undefined && !isRecord(value)) {
    return { diagnostic: diagnostic("fallback-request-invalid", "request must be an object.") };
  }
  const request = value ?? {};
  const extras = unknownFields(request, REQUEST_FIELDS);
  if (extras.length > 0) {
    return {
      diagnostic: diagnostic("fallback-request-field-not-allowed", `request contains unsupported field(s): ${extras.join(", ")}.`, { fields: extras })
    };
  }
  const mode = request.mode ?? "plan";
  if (!PIECE_FALLBACK_MODES.includes(mode)) {
    return { diagnostic: diagnostic("fallback-mode-invalid", "request.mode must be 'plan' or 'execute'.") };
  }
  const level = request.level ?? "auto";
  if (!["auto", "project"].includes(level)) {
    return { diagnostic: diagnostic("fallback-level-invalid", "request.level must be 'auto' or 'project'.") };
  }
  if (!PIECE_FALLBACK_PROFILES.includes(request.profile)) {
    return {
      diagnostic: diagnostic("fallback-profile-required", `request.profile must be one of: ${PIECE_FALLBACK_PROFILES.join(", ")}.`)
    };
  }
  return { value: { ...request, mode, level, profile: request.profile } };
}

function selectedProfile(policy, profile) {
  if (!isRecord(policy)) {
    return { diagnostic: diagnostic("fallback-policy-required", "A strict fallback policy object is required.") };
  }
  const extras = unknownFields(policy, POLICY_FIELDS);
  if (extras.length > 0) {
    return {
      diagnostic: diagnostic("fallback-policy-field-not-allowed", `policy contains unsupported field(s): ${extras.join(", ")}.`, { fields: extras })
    };
  }
  if (!isRecord(policy.profiles) || !isRecord(policy.profiles[profile])) {
    return {
      diagnostic: diagnostic("fallback-profile-not-declared", `policy.profiles.${profile} must explicitly declare the requested fallback profile.`, { profile })
    };
  }
  const profilePolicy = policy.profiles[profile];
  const profileExtras = unknownFields(profilePolicy, PROFILE_FIELDS[profile]);
  if (profileExtras.length > 0) {
    return {
      diagnostic: diagnostic(
        "fallback-profile-field-not-allowed",
        `policy.profiles.${profile} contains unsupported field(s): ${profileExtras.join(", ")}.`,
        { profile, fields: profileExtras }
      )
    };
  }
  if (typeof profilePolicy.root !== "string" || !profilePolicy.root.trim() || profilePolicy.root.includes("\0")) {
    return {
      diagnostic: diagnostic("fallback-policy-invalid", `policy.profiles.${profile}.root must be a non-empty path string.`, { profile })
    };
  }
  const environment = normalizeEnvironment(policy);
  if (environment.diagnostic) return environment;
  return {
    value: {
      profilePolicy,
      actionRunner: environment.value
    }
  };
}

async function resolveWorkspace(workspaceRoot) {
  if (typeof workspaceRoot !== "string" || !workspaceRoot.trim()) {
    return { diagnostic: diagnostic("fallback-workspace-required", "workspaceRoot must name an existing workspace directory.") };
  }
  const path = resolve(workspaceRoot);
  try {
    const canonicalPath = await realpath(path);
    const info = await lstat(canonicalPath);
    if (!info.isDirectory()) {
      return { diagnostic: diagnostic("fallback-workspace-not-directory", `workspaceRoot '${path}' is not a directory.`, { path }) };
    }
    return { value: { path, canonicalPath } };
  } catch (error) {
    return {
      diagnostic: diagnostic("fallback-workspace-unreadable", `Could not resolve workspaceRoot '${path}': ${error?.message ?? String(error)}.`, { path })
    };
  }
}

async function resolveProfileRoot(workspace, rootValue) {
  const lexicalPath = resolve(workspace.path, rootValue);
  if (!inside(workspace.path, lexicalPath)) {
    return {
      diagnostic: diagnostic("fallback-workspace-path-escape", `Profile root '${rootValue}' escapes workspace '${workspace.canonicalPath}'.`, { root: rootValue })
    };
  }
  try {
    const canonicalPath = await realpath(lexicalPath);
    if (!inside(workspace.canonicalPath, canonicalPath)) {
      return {
        diagnostic: diagnostic("fallback-workspace-path-escape", `Profile root '${rootValue}' resolves outside workspace '${workspace.canonicalPath}'.`, {
          root: rootValue,
          resolvedPath: canonicalPath
        })
      };
    }
    const info = await lstat(canonicalPath);
    if (!info.isDirectory()) {
      return { diagnostic: diagnostic("fallback-profile-root-not-directory", `Profile root '${rootValue}' is not a directory.`, { root: rootValue }) };
    }
    return { value: { path: lexicalPath, canonicalPath } };
  } catch (error) {
    return {
      diagnostic: diagnostic("fallback-profile-root-unreadable", `Could not resolve profile root '${rootValue}': ${error?.message ?? String(error)}.`, {
        root: rootValue
      })
    };
  }
}

async function containedExistingPath(root, relativePath, label) {
  const lexicalPath = resolve(root.path, relativePath);
  if (!inside(root.path, lexicalPath)) {
    return {
      diagnostic: diagnostic("fallback-workspace-path-escape", `${label} path '${relativePath}' escapes the selected fallback root.`, { path: relativePath })
    };
  }
  try {
    const canonicalPath = await realpath(lexicalPath);
    if (!inside(root.canonicalPath, canonicalPath)) {
      return {
        diagnostic: diagnostic("fallback-workspace-path-escape", `${label} path '${relativePath}' resolves outside the selected fallback root.`, {
          path: relativePath,
          resolvedPath: canonicalPath
        })
      };
    }
    const info = await lstat(canonicalPath);
    if (!info.isFile()) {
      return {
        diagnostic: diagnostic("fallback-marker-not-file", `${label} marker '${relativePath}' is not a regular file.`, {
          path: relativePath,
          resolvedPath: canonicalPath
        })
      };
    }
    return { value: { path: lexicalPath, canonicalPath } };
  } catch {
    return { missing: true };
  }
}

async function requiredMarker(root, relativePath, label) {
  const result = await containedExistingPath(root, relativePath, label);
  if (result.value || result.diagnostic) return result;
  return {
    diagnostic: diagnostic("fallback-marker-missing", `Required ${label} marker '${relativePath}' was not found under '${root.canonicalPath}'.`, {
      marker: relativePath,
      root: root.canonicalPath
    })
  };
}

async function oneOfRequiredMarkers(root, markers, label) {
  for (const marker of markers) {
    const result = await containedExistingPath(root, marker, label);
    if (result.value || result.diagnostic) return result;
  }
  return {
    diagnostic: diagnostic("fallback-marker-missing", `Required ${label} marker was not found under '${root.canonicalPath}'.`, {
      markers,
      root: root.canonicalPath
    })
  };
}

function planForGo(request, profilePolicy, root, marker) {
  if (request.task !== undefined || request.script !== undefined) {
    return { diagnostic: diagnostic("fallback-request-field-not-allowed", "Go fallback accepts only request.action.") };
  }
  if (profilePolicy.command !== undefined && profilePolicy.command !== "go") {
    return { diagnostic: diagnostic("fallback-command-not-allowed", "Go fallback only permits the built-in 'go' command.") };
  }
  const actions = stringAllowlist(profilePolicy.allowActions, "policy.profiles.go.allowActions");
  if (actions.diagnostic) return actions;
  const action = request.action ?? "test";
  if (!["test", "build"].includes(action) || !actions.value.includes(action)) {
    return {
      diagnostic: diagnostic("fallback-action-not-allowed", `Go action '${action}' is not allowlisted by policy.profiles.go.allowActions.`, { action })
    };
  }
  return {
    value: {
      command: "go",
      args: [action, "./..."],
      cwd: root.canonicalPath,
      markers: [marker.canonicalPath],
      action
    }
  };
}

function expectedGradleWrapper() {
  return process.platform === "win32" ? "gradlew.bat" : "gradlew";
}

function planForGradle(request, profilePolicy, root, wrapper) {
  if (request.action !== undefined || request.script !== undefined) {
    return { diagnostic: diagnostic("fallback-request-field-not-allowed", "Gradle fallback accepts only request.task.") };
  }
  const expected = `./${expectedGradleWrapper()}`;
  if (profilePolicy.command !== undefined && profilePolicy.command !== expected) {
    return {
      diagnostic: diagnostic("fallback-command-not-allowed", `Gradle fallback only permits the canonical wrapper '${expected}'.`)
    };
  }
  const tasks = stringAllowlist(profilePolicy.allowTasks, "policy.profiles.gradle.allowTasks", GRADLE_TASK_NAME);
  if (tasks.diagnostic) return tasks;
  const task = request.task;
  if (typeof task !== "string" || !GRADLE_TASK_NAME.test(task) || !tasks.value.includes(task)) {
    return {
      diagnostic: diagnostic("fallback-task-not-allowed", `Gradle task '${task ?? ""}' is not allowlisted by policy.profiles.gradle.allowTasks.`, {
        task: task ?? ""
      })
    };
  }
  return {
    value: {
      command: wrapper.canonicalPath,
      args: ["--no-daemon", task],
      cwd: root.canonicalPath,
      markers: [wrapper.canonicalPath],
      task
    }
  };
}

function planForTypeScript(request, profilePolicy, root, packageJson) {
  if (request.action !== undefined || request.task !== undefined) {
    return { diagnostic: diagnostic("fallback-request-field-not-allowed", "TypeScript fallback accepts only request.script.") };
  }
  const scripts = stringAllowlist(profilePolicy.allowScripts, "policy.profiles.typescript.allowScripts");
  if (scripts.diagnostic) return scripts;
  const packageManager = profilePolicy.packageManager ?? "npm";
  if (!["npm", "pnpm", "yarn"].includes(packageManager)) {
    return {
      diagnostic: diagnostic("fallback-command-not-allowed", "TypeScript fallback packageManager must be npm, pnpm, or yarn.")
    };
  }
  const script = request.script;
  if (typeof script !== "string" || !ACTION_NAME.test(script) || !scripts.value.includes(script)) {
    return {
      diagnostic: diagnostic("fallback-script-not-allowed", `Package script '${script ?? ""}' is not allowlisted by policy.profiles.typescript.allowScripts.`, {
        script: script ?? ""
      })
    };
  }
  if (!isRecord(packageJson.scripts) || typeof packageJson.scripts[script] !== "string" || !packageJson.scripts[script].trim()) {
    return {
      diagnostic: diagnostic("fallback-package-script-missing", `package.json does not define the requested '${script}' script.`, { script })
    };
  }
  return {
    value: {
      command: packageManager,
      args: ["run", script],
      cwd: root.canonicalPath,
      markers: [join(root.canonicalPath, "package.json")],
      script,
      packageManager
    }
  };
}

async function resolveExecutionPlan(options = {}) {
  const scope = normalizedFeedbackScope(options.analysis);
  const requestResult = validateRequest(options.request);
  if (requestResult.diagnostic) {
    return { result: blocked({ scope, diagnostics: [requestResult.diagnostic] }) };
  }
  const request = requestResult.value;
  // A normal fallback stays tied to Piece's safety finding. A workspace caller
  // can nevertheless request a native project action explicitly (for example
  // `check`) even when Piece's local feedback path is currently safe.
  if (!scope.fallbackRequired && request.level !== "project") {
    return {
      result: blocked({
        mode: request.mode,
        profile: request.profile,
        scope,
        diagnostics: [
          diagnostic("fallback-not-required", "Piece analysis did not require a file-level or project-level fallback.", { level: scope.level })
        ]
      })
    };
  }
  const policyResult = selectedProfile(options.policy, request.profile);
  if (policyResult.diagnostic) {
    return { result: blocked({ mode: request.mode, profile: request.profile, scope, diagnostics: [policyResult.diagnostic] }) };
  }
  const workspaceResult = await resolveWorkspace(options.workspaceRoot);
  if (workspaceResult.diagnostic) {
    return { result: blocked({ mode: request.mode, profile: request.profile, scope, diagnostics: [workspaceResult.diagnostic] }) };
  }
  const rootResult = await resolveProfileRoot(workspaceResult.value, policyResult.value.profilePolicy.root);
  if (rootResult.diagnostic) {
    return { result: blocked({ mode: request.mode, profile: request.profile, scope, diagnostics: [rootResult.diagnostic] }) };
  }
  const root = rootResult.value;
  let candidate;
  if (request.profile === "go") {
    const marker = await oneOfRequiredMarkers(root, ["go.mod", "go.work"], "Go module/workspace");
    if (marker.diagnostic) return { result: blocked({ mode: request.mode, profile: request.profile, scope, diagnostics: [marker.diagnostic] }) };
    candidate = planForGo(request, policyResult.value.profilePolicy, root, marker.value);
  } else if (request.profile === "gradle") {
    const settings = await oneOfRequiredMarkers(root, ["settings.gradle.kts", "settings.gradle"], "Gradle settings");
    if (settings.diagnostic) return { result: blocked({ mode: request.mode, profile: request.profile, scope, diagnostics: [settings.diagnostic] }) };
    const wrapper = await requiredMarker(root, expectedGradleWrapper(), "Gradle wrapper");
    if (wrapper.diagnostic) return { result: blocked({ mode: request.mode, profile: request.profile, scope, diagnostics: [wrapper.diagnostic] }) };
    candidate = planForGradle(request, policyResult.value.profilePolicy, root, wrapper.value);
    if (candidate.value) candidate.value.markers = [settings.value.canonicalPath, wrapper.value.canonicalPath];
  } else {
    const marker = await requiredMarker(root, "package.json", "package.json");
    if (marker.diagnostic) return { result: blocked({ mode: request.mode, profile: request.profile, scope, diagnostics: [marker.diagnostic] }) };
    let packageJson;
    try {
      packageJson = JSON.parse(await readFile(marker.value.canonicalPath, "utf8"));
    } catch (error) {
      return {
        result: blocked({
          mode: request.mode,
          profile: request.profile,
          scope,
          diagnostics: [
            diagnostic("fallback-package-json-invalid", `Could not parse package.json: ${error?.message ?? String(error)}.`, {
              path: marker.value.canonicalPath
            })
          ]
        })
      };
    }
    candidate = planForTypeScript(request, policyResult.value.profilePolicy, root, packageJson);
  }
  if (candidate.diagnostic) {
    return { result: blocked({ mode: request.mode, profile: request.profile, scope, diagnostics: [candidate.diagnostic] }) };
  }
  const plan = candidate.value;
  const result = {
    version: PIECE_FALLBACK_EXECUTOR_VERSION,
    status: "planned",
    mode: request.mode,
    profile: request.profile,
    scope,
    plan: {
      profile: request.profile,
      level: request.level,
      command: plan.command,
      args: [...plan.args],
      cwd: plan.cwd,
      markers: [...plan.markers],
      environment: {
        inheritProcessEnv: false,
        envAllowlist: [...policyResult.value.actionRunner.envAllowlist]
      }
    },
    diagnostics: []
  };
  return {
    result,
    execution: {
      ...plan,
      actionRunner: policyResult.value.actionRunner
    }
  };
}

function executionDiagnostic(command) {
  const code =
    command.errorCode === NODE_ACTION_ERROR_CODES.timeout
      ? "fallback-action-timeout"
      : command.errorCode === NODE_ACTION_ERROR_CODES.cancelled
        ? "fallback-action-cancelled"
        : command.errorCode === NODE_ACTION_ERROR_CODES.outputLimit
          ? "fallback-action-output-limit"
          : command.errorCode === "ENOENT"
            ? "fallback-tool-not-found"
            : "fallback-command-failed";
  const message =
    code === "fallback-action-timeout"
      ? "The fallback command exceeded its configured timeout."
      : code === "fallback-action-cancelled"
        ? "The fallback command was cancelled."
        : code === "fallback-action-output-limit"
          ? "The fallback command exceeded its configured output limit."
          : code === "fallback-tool-not-found"
            ? "The allowlisted fallback executable could not be started."
            : `The fallback command exited with code ${command.exitCode ?? "unknown"}.`;
  return diagnostic(code, message, {
    command: command.command,
    args: [...(command.args ?? [])],
    ...(command.errorCode ? { errorCode: command.errorCode } : {})
  });
}

/**
 * Produce a validated, non-mutating fallback plan. This is safe to call for
 * untrusted workspaces because it never invokes a project build tool.
 */
export async function planPieceFallback(options = {}) {
  try {
    return (await resolveExecutionPlan(options)).result;
  } catch (error) {
    return blocked({
      scope: normalizedFeedbackScope(options.analysis),
      diagnostics: [diagnostic("fallback-plan-failed", error?.message ?? String(error))]
    });
  }
}

/**
 * Execute only an explicit, fully allowlisted fallback profile. Calling this
 * with the default request mode returns the plan instead of running a tool.
 */
export async function executePieceFallback(options = {}) {
  try {
    const resolved = await resolveExecutionPlan(options);
    if (resolved.result.status !== "planned" || resolved.result.mode !== "execute") {
      return resolved.result;
    }
    if (!resolved.execution.actionRunner.envAllowlist.includes("PATH")) {
      return blocked({
        mode: resolved.result.mode,
        profile: resolved.result.profile,
        scope: resolved.result.scope,
        diagnostics: [
          diagnostic("fallback-path-not-allowlisted", "Executing a fallback profile requires PATH in policy.envAllowlist.")
        ]
      });
    }
    const command = await runNodeAction(resolved.execution.command, resolved.execution.args, {
      cwd: resolved.execution.cwd,
      inheritProcessEnv: false,
      envAllowlist: resolved.execution.actionRunner.envAllowlist,
      env: resolved.execution.actionRunner.env,
      timeoutMs: resolved.execution.actionRunner.timeoutMs,
      maxOutputBytes: resolved.execution.actionRunner.maxOutputBytes,
      killGraceMs: resolved.execution.actionRunner.killGraceMs,
      signal: options.signal
    });
    if (isNodeActionFailure(command)) {
      return {
        ...resolved.result,
        status: "error",
        command,
        diagnostics: [executionDiagnostic(command)]
      };
    }
    return {
      ...resolved.result,
      status: "success",
      command,
      diagnostics: []
    };
  } catch (error) {
    return blocked({
      scope: normalizedFeedbackScope(options.analysis),
      diagnostics: [diagnostic("fallback-execution-failed", error?.message ?? String(error))]
    });
  }
}
