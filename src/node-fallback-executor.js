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
const ARRAY_INDEX = /^(?:0|[1-9]\d*)$/;
const MAX_POLICY_LIST_ENTRIES = 1_000;
// Fallback execution remains bounded even when callers use the Node API
// directly instead of going through parsed JSON configuration.
const MAX_FALLBACK_TIMEOUT_MS = 30 * 60 * 1_000;
const MAX_FALLBACK_OUTPUT_BYTES = 32 * 1024 * 1024;
const MAX_FALLBACK_KILL_GRACE_MS = 60 * 1_000;
const RESERVED_OBJECT_PROPERTY_NAMES = new Set(["__proto__", "constructor", "prototype"]);

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

function hasOwn(value, key) {
  return Object.prototype.hasOwnProperty.call(value, key);
}

/**
 * Read only own data descriptors from JSON-shaped configuration. This avoids
 * evaluating getters or inherited values before the strict policy is checked.
 * A null prototype is accepted because it is a common safe JSON container.
 */
function inspectPlainDataObject(value, code, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return { diagnostic: diagnostic(code, `${label} must be a plain own-data object.`) };
  }
  try {
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) {
      return { diagnostic: diagnostic(code, `${label} must not have inherited or custom prototype properties.`) };
    }
    const descriptors = Object.getOwnPropertyDescriptors(value);
    if (Object.getOwnPropertySymbols(value).length > 0) {
      return { diagnostic: diagnostic(code, `${label} must not contain symbol properties.`) };
    }
    const keys = Object.keys(descriptors);
    for (const key of keys) {
      const descriptor = descriptors[key];
      if (!hasOwn(descriptor, "value") || descriptor.enumerable !== true) {
        return { diagnostic: diagnostic(code, `${label}.${key} must be an enumerable data property.`) };
      }
    }
    return { value: { descriptors, keys } };
  } catch {
    return { diagnostic: diagnostic(code, `${label} must be a readable plain own-data object.`) };
  }
}

function ownValue(inspected, key) {
  return hasOwn(inspected.descriptors, key) ? inspected.descriptors[key].value : undefined;
}

function inspectStringArray(value, code, label, { allowEmpty = false, pattern = undefined } = {}) {
  if (!Array.isArray(value)) {
    return { diagnostic: diagnostic(code, `${label} must be an array of simple command names.`) };
  }
  try {
    if (Object.getPrototypeOf(value) !== Array.prototype) {
      return { diagnostic: diagnostic(code, `${label} must not have inherited or custom prototype properties.`) };
    }
    const descriptors = Object.getOwnPropertyDescriptors(value);
    if (Object.getOwnPropertySymbols(value).length > 0) {
      return { diagnostic: diagnostic(code, `${label} must not contain symbol properties.`) };
    }
    const lengthDescriptor = descriptors.length;
    if (!hasOwn(lengthDescriptor ?? {}, "value") || !Number.isSafeInteger(lengthDescriptor.value) || lengthDescriptor.value < 0) {
      return { diagnostic: diagnostic(code, `${label} must be a regular array.`) };
    }
    const length = lengthDescriptor.value;
    if (length > MAX_POLICY_LIST_ENTRIES) {
      return { diagnostic: diagnostic(code, `${label} exceeds the maximum of ${MAX_POLICY_LIST_ENTRIES} entries.`) };
    }
    for (const key of Object.keys(descriptors)) {
      if (key === "length") continue;
      const descriptor = descriptors[key];
      if (!ARRAY_INDEX.test(key) || !hasOwn(descriptor, "value") || descriptor.enumerable !== true) {
        return { diagnostic: diagnostic(code, `${label} must contain only enumerable data entries.`) };
      }
    }
    const entries = [];
    for (let index = 0; index < length; index += 1) {
      const descriptor = descriptors[String(index)];
      if (!hasOwn(descriptor ?? {}, "value")) {
        return { diagnostic: diagnostic(code, `${label} must not be sparse or use accessors.`) };
      }
      const entry = descriptor.value;
      if (typeof entry !== "string" || (pattern && !pattern.test(entry))) {
        return { diagnostic: diagnostic(code, `${label} must be an array of simple command names.`) };
      }
      entries.push(entry);
    }
    if (!allowEmpty && entries.length === 0) {
      return { diagnostic: diagnostic(code, `${label} must be a non-empty array of simple command names.`) };
    }
    return { value: entries };
  } catch {
    return { diagnostic: diagnostic(code, `${label} must be a readable array of simple command names.`) };
  }
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

function unknownFields(keys, allowed) {
  return keys.filter((key) => !allowed.has(key));
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

function positiveInteger(value, field, { allowZero = false, maximum } = {}) {
  if (value === undefined) return { value: undefined };
  if (!Number.isInteger(value) || value < (allowZero ? 0 : 1)) {
    return {
      diagnostic: diagnostic("fallback-policy-invalid", `policy.${field} must be a ${allowZero ? "non-negative" : "positive"} integer.`)
    };
  }
  if (maximum !== undefined && value > maximum) {
    return {
      diagnostic: diagnostic("fallback-policy-invalid", `policy.${field} must not exceed ${maximum}.`, { field, maximum })
    };
  }
  return { value };
}

function stringAllowlist(value, field, pattern = ACTION_NAME) {
  const inspected = inspectStringArray(value, "fallback-policy-invalid", field, { pattern });
  if (inspected.diagnostic) return inspected;
  return { value: [...new Set(inspected.value)] };
}

function normalizeEnvironment(policy) {
  const namesValue = ownValue(policy, "envAllowlist");
  const namesResult = inspectStringArray(
    namesValue === undefined ? [] : namesValue,
    "fallback-policy-invalid",
    "policy.envAllowlist",
    { allowEmpty: true, pattern: ENVIRONMENT_NAME }
  );
  if (namesResult.diagnostic) {
    return {
      diagnostic: diagnostic("fallback-policy-invalid", "policy.envAllowlist must contain valid environment variable names.")
    };
  }
  const reservedAllowlistName = namesResult.value.find((name) => RESERVED_OBJECT_PROPERTY_NAMES.has(name));
  if (reservedAllowlistName) {
    return {
      diagnostic: diagnostic("fallback-policy-invalid", `policy.envAllowlist must not contain reserved object property '${reservedAllowlistName}'.`, {
        name: reservedAllowlistName
      })
    };
  }
  const envAllowlist = [...new Set(namesResult.value)];
  const suppliedValue = ownValue(policy, "env");
  const suppliedResult = inspectPlainDataObject(
    suppliedValue === undefined ? {} : suppliedValue,
    "fallback-policy-invalid",
    "policy.env"
  );
  if (suppliedResult.diagnostic) return suppliedResult;
  const reservedEnvironmentName = suppliedResult.value.keys.find((name) => RESERVED_OBJECT_PROPERTY_NAMES.has(name));
  if (reservedEnvironmentName) {
    return {
      diagnostic: diagnostic("fallback-policy-invalid", `policy.env.${reservedEnvironmentName} is not allowed.`, { name: reservedEnvironmentName })
    };
  }
  const supplied = Object.create(null);
  for (const name of suppliedResult.value.keys) {
    const value = ownValue(suppliedResult.value, name);
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
    supplied[name] = value;
  }
  const timeout = positiveInteger(ownValue(policy, "timeoutMs"), "timeoutMs", { maximum: MAX_FALLBACK_TIMEOUT_MS });
  const output = positiveInteger(ownValue(policy, "maxOutputBytes"), "maxOutputBytes", {
    allowZero: true,
    maximum: MAX_FALLBACK_OUTPUT_BYTES
  });
  const grace = positiveInteger(ownValue(policy, "killGraceMs"), "killGraceMs", {
    allowZero: true,
    maximum: MAX_FALLBACK_KILL_GRACE_MS
  });
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
  const requestResult = inspectPlainDataObject(value === undefined ? {} : value, "fallback-request-invalid", "request");
  if (requestResult.diagnostic) return requestResult;
  const request = requestResult.value;
  const extras = unknownFields(request.keys, REQUEST_FIELDS);
  if (extras.length > 0) {
    return {
      diagnostic: diagnostic("fallback-request-field-not-allowed", `request contains unsupported field(s): ${extras.join(", ")}.`, { fields: extras })
    };
  }
  for (const field of REQUEST_FIELDS) {
    const fieldValue = ownValue(request, field);
    if (fieldValue !== undefined && typeof fieldValue !== "string") {
      return { diagnostic: diagnostic("fallback-request-invalid", `request.${field} must be a string when provided.`, { field }) };
    }
  }
  const mode = ownValue(request, "mode") ?? "plan";
  if (!PIECE_FALLBACK_MODES.includes(mode)) {
    return { diagnostic: diagnostic("fallback-mode-invalid", "request.mode must be 'plan' or 'execute'.") };
  }
  const level = ownValue(request, "level") ?? "auto";
  if (!["auto", "project"].includes(level)) {
    return { diagnostic: diagnostic("fallback-level-invalid", "request.level must be 'auto' or 'project'.") };
  }
  const profile = ownValue(request, "profile");
  if (!PIECE_FALLBACK_PROFILES.includes(profile)) {
    return {
      diagnostic: diagnostic("fallback-profile-required", `request.profile must be one of: ${PIECE_FALLBACK_PROFILES.join(", ")}.`)
    };
  }
  const requestValue = { mode, level, profile };
  for (const field of ["action", "task", "script"]) {
    const fieldValue = ownValue(request, field);
    if (fieldValue !== undefined) requestValue[field] = fieldValue;
  }
  return { value: requestValue };
}

function normalizeProfilePolicy(profile, inspected) {
  const profilePolicy = {};
  for (const field of PROFILE_FIELDS[profile]) {
    const fieldValue = ownValue(inspected, field);
    if (fieldValue !== undefined) profilePolicy[field] = fieldValue;
  }
  if (typeof profilePolicy.root !== "string" || !profilePolicy.root.trim() || profilePolicy.root.includes("\0")) {
    return {
      diagnostic: diagnostic("fallback-policy-invalid", `policy.profiles.${profile}.root must be a non-empty path string.`, { profile })
    };
  }
  const allowlistField = profile === "go" ? "allowActions" : profile === "gradle" ? "allowTasks" : "allowScripts";
  const allowlist = stringAllowlist(profilePolicy[allowlistField], `policy.profiles.${profile}.${allowlistField}`, profile === "gradle" ? GRADLE_TASK_NAME : ACTION_NAME);
  if (allowlist.diagnostic) return allowlist;
  profilePolicy[allowlistField] = allowlist.value;
  for (const field of ["command", "packageManager"]) {
    if (profilePolicy[field] !== undefined && typeof profilePolicy[field] !== "string") {
      return {
        diagnostic: diagnostic("fallback-policy-invalid", `policy.profiles.${profile}.${field} must be a string when provided.`, { profile, field })
      };
    }
  }
  return { value: profilePolicy };
}

function selectedProfile(policy, profile) {
  const policyResult = inspectPlainDataObject(policy, "fallback-policy-required", "policy");
  if (policyResult.diagnostic) return policyResult;
  const policyValue = policyResult.value;
  const extras = unknownFields(policyValue.keys, POLICY_FIELDS);
  if (extras.length > 0) {
    return {
      diagnostic: diagnostic("fallback-policy-field-not-allowed", `policy contains unsupported field(s): ${extras.join(", ")}.`, { fields: extras })
    };
  }
  const profilesValue = ownValue(policyValue, "profiles");
  if (profilesValue === undefined) {
    return {
      diagnostic: diagnostic("fallback-profile-not-declared", `policy.profiles.${profile} must explicitly declare the requested fallback profile.`, { profile })
    };
  }
  const profilesResult = inspectPlainDataObject(profilesValue, "fallback-policy-invalid", "policy.profiles");
  if (profilesResult.diagnostic) return profilesResult;
  const unsupportedProfiles = profilesResult.value.keys.filter((name) => !PIECE_FALLBACK_PROFILES.includes(name));
  if (unsupportedProfiles.length > 0) {
    return {
      diagnostic: diagnostic("fallback-profile-field-not-allowed", `policy.profiles contains unsupported profile(s): ${unsupportedProfiles.join(", ")}.`, {
        fields: unsupportedProfiles
      })
    };
  }
  const profileValue = ownValue(profilesResult.value, profile);
  if (profileValue === undefined) {
    return {
      diagnostic: diagnostic("fallback-profile-not-declared", `policy.profiles.${profile} must explicitly declare the requested fallback profile.`, { profile })
    };
  }
  const profileResult = inspectPlainDataObject(profileValue, "fallback-policy-invalid", `policy.profiles.${profile}`);
  if (profileResult.diagnostic) return profileResult;
  const profileExtras = unknownFields(profileResult.value.keys, PROFILE_FIELDS[profile]);
  if (profileExtras.length > 0) {
    return {
      diagnostic: diagnostic(
        "fallback-profile-field-not-allowed",
        `policy.profiles.${profile} contains unsupported field(s): ${profileExtras.join(", ")}.`,
        { profile, fields: profileExtras }
      )
    };
  }
  const profilePolicy = normalizeProfilePolicy(profile, profileResult.value);
  if (profilePolicy.diagnostic) return profilePolicy;
  const environment = normalizeEnvironment(policyValue);
  if (environment.diagnostic) return environment;
  return {
    value: {
      profilePolicy: profilePolicy.value,
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
  } catch (error) {
    // A missing marker is an expected fallback condition. Permission errors,
    // symlink loops, I/O failures, and similar inspection faults are not: do
    // not disguise them as a marker miss and potentially select another path.
    if (error?.code === "ENOENT" || error?.code === "ENOTDIR") {
      return { missing: true };
    }
    return {
      diagnostic: diagnostic("fallback-marker-inspection-failed", `Could not inspect ${label} marker '${relativePath}'.`, {
        path: relativePath,
        ...(typeof error?.code === "string" ? { errorCode: error.code } : {})
      })
    };
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
