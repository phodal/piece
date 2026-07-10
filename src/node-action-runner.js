import { spawn } from "node:child_process";
import { win32 } from "node:path";
import { performance } from "node:perf_hooks";

// Five minutes bounds a stuck tool while remaining compatible with cold Gradle
// and Kotlin actions. Callers can use a smaller per-action timeout.
export const DEFAULT_ACTION_TIMEOUT_MS = 300_000;
export const DEFAULT_ACTION_MAX_OUTPUT_BYTES = 4 * 1024 * 1024;
export const DEFAULT_ACTION_KILL_GRACE_MS = 1_000;

// Keep caller-provided limits useful for cold builds without letting one
// malformed policy retain a worker indefinitely or reserve unbounded output.
export const MAX_ACTION_TIMEOUT_MS = 30 * 60 * 1_000;
export const MAX_ACTION_MAX_OUTPUT_BYTES = 64 * 1024 * 1024;
export const MAX_ACTION_KILL_GRACE_MS = 30_000;

// `ComSpec` is user-overridable, so it is not a safe executable selection for
// an action runner. `SystemRoot` is the Windows system location used to make
// this work on installations outside C:\\Windows; use a safe absolute fallback
// when it is absent or malformed (for example in cross-platform tests).
export const WINDOWS_DEFAULT_COMMAND_PROCESSOR = "C:\\Windows\\System32\\cmd.exe";

export const NODE_ACTION_ERROR_CODES = Object.freeze({
  timeout: "ACTION_TIMEOUT",
  cancelled: "ACTION_ABORTED",
  outputLimit: "ACTION_OUTPUT_LIMIT",
  invalidInput: "ACTION_INVALID_INPUT"
});

export function isNodeActionFailure(result) {
  return result?.exitCode !== 0 || Boolean(result?.errorCode);
}

// Reports written by an action are only trustworthy when the runner itself did
// not time out, cancel, or cap that action's output.
export function canUseNodeActionOutput(result) {
  return !isNodeActionFailure(result);
}

function isWindowsBatchCommand(command) {
  // Windows ignores trailing periods and spaces in file names. Normalize them
  // before deciding whether cmd.exe quoting is required (CVE-2024-36138 class).
  return /\.(?:bat|cmd)$/i.test(String(command ?? "").replace(/[. ]+$/u, ""));
}

function safeWindowsSystemRoot() {
  const value = process.env.SystemRoot ?? process.env.SYSTEMROOT;
  if (typeof value !== "string" || value.length === 0 || /[\0\r\n"]/.test(value)) {
    return undefined;
  }
  const normalizedSeparators = value.replaceAll("/", "\\");
  if (!/^[A-Za-z]:\\/.test(normalizedSeparators) || normalizedSeparators.split("\\").includes("..")) {
    return undefined;
  }
  return normalizedSeparators.replace(/[\\/]+$/u, "");
}

/**
 * Resolve the OS command processor without honoring the user-overridable
 * ComSpec variable. The absolute fallback also keeps platform simulations
 * deterministic when no Windows environment is available.
 */
function resolveWindowsSystemExecutable(fileName) {
  const systemRoot = safeWindowsSystemRoot();
  if (systemRoot) return win32.join(systemRoot, "System32", fileName);
  return fileName === "cmd.exe"
    ? WINDOWS_DEFAULT_COMMAND_PROCESSOR
    : win32.join("C:\\Windows\\System32", fileName);
}

export function resolveWindowsCommandProcessor() {
  return resolveWindowsSystemExecutable("cmd.exe");
}

function actionInputError(message) {
  const error = new TypeError(message);
  error.code = NODE_ACTION_ERROR_CODES.invalidInput;
  return error;
}

function assertSafeWindowsBatchToken(value, label) {
  const token = String(value);
  // cmd.exe treats a line break as a new command and CreateProcessW treats NUL
  // as a terminator. Neither has a representation that preserves one argv
  // token safely through a batch file.
  if (/[\0\r\n]/u.test(token)) {
    throw actionInputError(`${label} cannot contain NUL, carriage return, or line feed when invoking a Windows batch file.`);
  }
  return token;
}

/**
 * Encode one token for cmd.exe's batch-file parser. This mirrors the guarded
 * strategy used by modern native runtimes: every token is quoted, delayed
 * expansion is disabled by the caller, embedded quotes retain their argv
 * meaning, and percent signs are neutralized before cmd can expand variables.
 */
function quoteWindowsBatchToken(value, label) {
  const token = assertSafeWindowsBatchToken(value, label);
  let encoded = '"';
  let backslashCount = 0;

  for (const character of token) {
    if (character === "\\") {
      backslashCount += 1;
    } else {
      if (character === '"') {
        // The first quote escapes the second one. Duplicate preceding
        // backslashes so they retain their literal meaning before a quote.
        encoded += "\\".repeat(backslashCount);
        encoded += '"';
      } else if (character === "%") {
        // `%%cd:~,%` expands to an empty, built-in substring expression. It
        // consumes the first percent sign so `%UNTRUSTED%` cannot become an
        // environment-variable expansion while the literal percent survives.
        encoded += "%%cd:~,";
      }
      backslashCount = 0;
    }
    encoded += character;
  }

  // A trailing backslash would otherwise escape the closing quote.
  encoded += "\\".repeat(backslashCount);
  encoded += '"';
  return encoded;
}

/**
 * Build the executable invocation without enabling a shell. Windows batch
 * files require cmd.exe, while bare commands such as `gradle` stay direct.
 * `resultCommand` remains the caller's original command for diagnostics.
 */
export function createNodeActionInvocation(command, args = [], options = {}) {
  const platform = options.platform ?? process.platform;
  const originalArgs = [...args];
  if (platform !== "win32" || !isWindowsBatchCommand(command)) {
    return {
      command,
      args: originalArgs,
      resultCommand: command,
      resultArgs: originalArgs
    };
  }
  const commandLine = [
    quoteWindowsBatchToken(command, "command"),
    ...originalArgs.map((argument, index) => quoteWindowsBatchToken(argument, `args[${index}]`))
  ].join(" ");
  return {
    command: resolveWindowsCommandProcessor(),
    // `/d` disables AutoRun, `/v:off` prevents ! expansion, and the extra
    // outer quotes let `/s /c` preserve the already-quoted batch command.
    args: ["/d", "/e:on", "/v:off", "/s", "/c", `"${commandLine}"`],
    resultCommand: command,
    resultArgs: originalArgs
  };
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

function boundedPositiveInteger(value, fallback, maximum, options = {}) {
  return Math.min(positiveInteger(value, fallback, options), maximum);
}

export function resolveNodeActionLimits(options = {}) {
  return {
    timeoutMs: boundedPositiveInteger(options.timeoutMs, DEFAULT_ACTION_TIMEOUT_MS, MAX_ACTION_TIMEOUT_MS),
    maxOutputBytes: boundedPositiveInteger(options.maxOutputBytes, DEFAULT_ACTION_MAX_OUTPUT_BYTES, MAX_ACTION_MAX_OUTPUT_BYTES, {
      allowZero: true
    }),
    killGraceMs: boundedPositiveInteger(options.killGraceMs, DEFAULT_ACTION_KILL_GRACE_MS, MAX_ACTION_KILL_GRACE_MS, {
      allowZero: true
    })
  };
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
      const killer = spawn(
        resolveWindowsSystemExecutable("taskkill.exe"),
        ["/pid", String(child.pid), "/T", "/F"],
        {
          detached: true,
          shell: false,
          stdio: "ignore",
          windowsHide: true
        }
      );
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
  const { maxOutputBytes } = resolveNodeActionLimits(options);
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
  const { timeoutMs, maxOutputBytes, killGraceMs } = resolveNodeActionLimits(options);
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
      const invocation = createNodeActionInvocation(command, args);
      child = spawn(invocation.command, invocation.args, {
        cwd: options.cwd,
        env: createNodeActionEnvironment(options),
        detached: process.platform !== "win32",
        shell: false,
        windowsHide: true
      });
    } catch (error) {
      spawnErrorMessage = error?.message ?? String(error);
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
