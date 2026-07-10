import { spawn } from "node:child_process";
import { performance } from "node:perf_hooks";

// Five minutes bounds a stuck tool while remaining compatible with cold Gradle
// and Kotlin actions. Callers can use a smaller per-action timeout.
export const DEFAULT_ACTION_TIMEOUT_MS = 300_000;
export const DEFAULT_ACTION_MAX_OUTPUT_BYTES = 4 * 1024 * 1024;
export const DEFAULT_ACTION_KILL_GRACE_MS = 1_000;

export const NODE_ACTION_ERROR_CODES = Object.freeze({
  timeout: "ACTION_TIMEOUT",
  cancelled: "ACTION_ABORTED",
  outputLimit: "ACTION_OUTPUT_LIMIT"
});

export function isNodeActionFailure(result) {
  return result?.exitCode !== 0 || Boolean(result?.errorCode);
}

// Reports written by an action are only trustworthy when the runner itself did
// not time out, cancel, or cap that action's output.
export function canUseNodeActionOutput(result) {
  return !isNodeActionFailure(result);
}

function roundedDuration(startedAt) {
  return Math.round((performance.now() - startedAt) * 100) / 100;
}

function positiveInteger(value, fallback, { allowZero = false } = {}) {
  if (value === undefined || value === null) return fallback;
  const number = Number(value);
  if (!Number.isFinite(number) || number < (allowZero ? 0 : 1)) return fallback;
  return Math.floor(number);
}

function uniqueEnvironmentNames(names) {
  return [...new Set(Array.isArray(names) ? names.map((name) => String(name ?? "")).filter(Boolean) : [])];
}

export function createNodeActionEnvironment(options = {}) {
  const allowlist = uniqueEnvironmentNames(options.envAllowlist);
  const includeAllProcessEnvironment = options.inheritProcessEnv !== false && allowlist.length === 0;
  const inheritedNames = includeAllProcessEnvironment ? Object.keys(process.env) : allowlist;
  const environment = {};
  for (const name of inheritedNames) {
    if (process.env[name] !== undefined) {
      environment[name] = process.env[name];
    }
  }
  for (const [name, value] of Object.entries(options.env ?? {})) {
    if (value === undefined) {
      delete environment[name];
    } else {
      environment[name] = String(value);
    }
  }
  return environment;
}

function signalProcessTree(child, signal) {
  if (!child?.pid) return;
  if (process.platform !== "win32") {
    try {
      process.kill(-child.pid, signal);
      return;
    } catch {
      // The process can exit between the check and the group signal.
    }
  }
  try {
    child.kill(signal);
  } catch {
    // Termination is best-effort; the completion watchdog below prevents a hung promise.
  }
}

function forceTerminateProcessTree(child) {
  if (!child?.pid) return;
  if (process.platform === "win32") {
    try {
      const killer = spawn("taskkill", ["/pid", String(child.pid), "/T", "/F"], {
        detached: true,
        shell: false,
        stdio: "ignore",
        windowsHide: true
      });
      killer.on("error", () => {
        try {
          child.kill("SIGKILL");
        } catch {
          // The child may have exited while taskkill was starting.
        }
      });
      killer.unref();
      return;
    } catch {
      // Fall through to child.kill below when taskkill is unavailable.
    }
  }
  signalProcessTree(child, "SIGKILL");
}

function outputText(chunks) {
  return Buffer.concat(chunks).toString("utf8");
}

function immediateCancellationResult(command, args, options, startedAt) {
  const maxOutputBytes = positiveInteger(options.maxOutputBytes, DEFAULT_ACTION_MAX_OUTPUT_BYTES, { allowZero: true });
  return {
    command,
    args,
    cwd: options.cwd,
    exitCode: null,
    signal: null,
    stdout: "",
    stderr: "",
    errorCode: NODE_ACTION_ERROR_CODES.cancelled,
    timedOut: false,
    cancelled: true,
    outputLimitExceeded: false,
    outputBytes: { stdout: 0, stderr: 0, total: 0, captured: 0, limit: maxOutputBytes },
    durationMs: roundedDuration(startedAt)
  };
}

/**
 * Execute one external build action with bounded lifetime and output.
 *
 * The compatibility default inherits process.env. To run an action with a
 * controlled environment, set inheritProcessEnv: false and optionally provide
 * envAllowlist for the small set of process variables it may inherit.
 */
export async function runNodeAction(command, args = [], options = {}) {
  const startedAt = performance.now();
  const timeoutMs = positiveInteger(options.timeoutMs, DEFAULT_ACTION_TIMEOUT_MS);
  const maxOutputBytes = positiveInteger(options.maxOutputBytes, DEFAULT_ACTION_MAX_OUTPUT_BYTES, { allowZero: true });
  const killGraceMs = positiveInteger(options.killGraceMs, DEFAULT_ACTION_KILL_GRACE_MS, { allowZero: true });
  if (options.signal?.aborted) {
    return immediateCancellationResult(command, args, options, startedAt);
  }

  return new Promise((resolveResult) => {
    const stdoutChunks = [];
    const stderrChunks = [];
    const outputBytes = { stdout: 0, stderr: 0, total: 0, captured: 0, limit: maxOutputBytes };
    let child;
    let finished = false;
    let termination;
    let spawnErrorMessage = "";
    let timeoutTimer;
    let forceKillTimer;
    let completionTimer;

    const clearTimers = () => {
      clearTimeout(timeoutTimer);
      clearTimeout(forceKillTimer);
      clearTimeout(completionTimer);
    };

    const finish = ({ exitCode = null, signal = null, errorCode } = {}) => {
      if (finished) return;
      finished = true;
      clearTimers();
      options.signal?.removeEventListener("abort", onAbort);
      const finalErrorCode = termination?.errorCode ?? errorCode;
      const policyFailure = Object.values(NODE_ACTION_ERROR_CODES).includes(finalErrorCode);
      const effectiveExitCode = policyFailure && exitCode === 0 ? null : exitCode;
      resolveResult({
        command,
        args,
        cwd: options.cwd,
        exitCode: effectiveExitCode,
        signal,
        stdout: outputText(stdoutChunks),
        stderr: outputText(stderrChunks) || spawnErrorMessage,
        ...(finalErrorCode ? { errorCode: finalErrorCode } : {}),
        timedOut: finalErrorCode === NODE_ACTION_ERROR_CODES.timeout,
        cancelled: finalErrorCode === NODE_ACTION_ERROR_CODES.cancelled,
        outputLimitExceeded: finalErrorCode === NODE_ACTION_ERROR_CODES.outputLimit,
        outputBytes,
        durationMs: roundedDuration(startedAt)
      });
    };

    const requestTermination = (errorCode) => {
      if (termination || finished) return;
      termination = { errorCode };
      if (process.platform === "win32") {
        // child.kill() cannot reliably include grandchildren on Windows, so use
        // taskkill /T /F immediately for timeout/cancel/output-limit actions.
        forceTerminateProcessTree(child);
      } else {
        signalProcessTree(child, "SIGTERM");
        forceKillTimer = setTimeout(() => forceTerminateProcessTree(child), killGraceMs);
      }
      // A misbehaving tool must not indefinitely retain the caller's promise.
      completionTimer = setTimeout(() => finish(), killGraceMs + 1_000);
    };

    const onAbort = () => requestTermination(NODE_ACTION_ERROR_CODES.cancelled);

    const appendOutput = (channel, chunk) => {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk));
      outputBytes[channel] += buffer.byteLength;
      outputBytes.total += buffer.byteLength;
      const remaining = Math.max(0, maxOutputBytes - outputBytes.captured);
      if (remaining > 0) {
        const captured = buffer.subarray(0, Math.min(remaining, buffer.byteLength));
        if (captured.byteLength > 0) {
          (channel === "stdout" ? stdoutChunks : stderrChunks).push(captured);
          outputBytes.captured += captured.byteLength;
        }
      }
      if (outputBytes.total > maxOutputBytes) {
        requestTermination(NODE_ACTION_ERROR_CODES.outputLimit);
      }
    };

    try {
      child = spawn(command, args, {
        cwd: options.cwd,
        env: createNodeActionEnvironment(options),
        detached: process.platform !== "win32",
        shell: false,
        windowsHide: true
      });
    } catch (error) {
      finish({ errorCode: error?.code ?? "ACTION_SPAWN_FAILED" });
      return;
    }

    child.stdout?.on("data", (chunk) => appendOutput("stdout", chunk));
    child.stderr?.on("data", (chunk) => appendOutput("stderr", chunk));
    child.once("error", (error) => {
      spawnErrorMessage = error?.message ?? String(error);
      finish({ errorCode: error?.code ?? "ACTION_SPAWN_FAILED" });
    });
    child.once("close", (exitCode, signal) => finish({ exitCode, signal }));
    options.signal?.addEventListener("abort", onAbort, { once: true });
    if (options.signal?.aborted) {
      onAbort();
      return;
    }
    if (!finished && !termination) {
      timeoutTimer = setTimeout(() => requestTermination(NODE_ACTION_ERROR_CODES.timeout), timeoutMs);
    }
  });
}
