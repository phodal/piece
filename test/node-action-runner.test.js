import { describe, expect, it } from "vitest";
import {
  canUseNodeActionOutput,
  DEFAULT_ACTION_MAX_OUTPUT_BYTES,
  MAX_ACTION_KILL_GRACE_MS,
  MAX_ACTION_MAX_OUTPUT_BYTES,
  MAX_ACTION_TIMEOUT_MS,
  isNodeActionFailure,
  NODE_ACTION_ERROR_CODES,
  resolveNodeActionLimits,
  runNodeAction
} from "../src/node-action-runner.js";

const node = process.execPath;

describe("Node Action Runner", () => {
  it("clamps action resource requests to bounded, predictable limits", () => {
    expect(
      resolveNodeActionLimits({
        timeoutMs: Number.MAX_SAFE_INTEGER,
        maxOutputBytes: Number.MAX_SAFE_INTEGER,
        killGraceMs: Number.MAX_SAFE_INTEGER
      })
    ).toEqual({
      timeoutMs: MAX_ACTION_TIMEOUT_MS,
      maxOutputBytes: MAX_ACTION_MAX_OUTPUT_BYTES,
      killGraceMs: MAX_ACTION_KILL_GRACE_MS
    });

    expect(resolveNodeActionLimits({ timeoutMs: -1, maxOutputBytes: 0, killGraceMs: 0 })).toEqual({
      timeoutMs: 300_000,
      maxOutputBytes: 0,
      killGraceMs: 0
    });
  });

  it("returns a structured timeout without waiting for the child indefinitely", async () => {
    const result = await runNodeAction(node, ["-e", "setInterval(() => {}, 1000)"], {
      timeoutMs: 30,
      killGraceMs: 10
    });

    expect(result.errorCode).toBe(NODE_ACTION_ERROR_CODES.timeout);
    expect(result.timedOut).toBe(true);
    expect(result.cancelled).toBe(false);
    expect(result.outputLimitExceeded).toBe(false);
    expect(result.exitCode).not.toBe(0);
  });

  it("honors AbortSignal cancellation", async () => {
    const controller = new AbortController();
    const run = runNodeAction(node, ["-e", "setInterval(() => {}, 1000)"], {
      signal: controller.signal,
      timeoutMs: 5_000,
      killGraceMs: 10
    });
    setTimeout(() => controller.abort(), 20);

    const result = await run;

    expect(result.errorCode).toBe(NODE_ACTION_ERROR_CODES.cancelled);
    expect(result.cancelled).toBe(true);
    expect(result.timedOut).toBe(false);
  });

  it("uses the same output cap for an immediately cancelled action", async () => {
    const controller = new AbortController();
    controller.abort();

    const result = await runNodeAction(node, ["-e", "process.exit(0)"], {
      signal: controller.signal,
      maxOutputBytes: Number.MAX_SAFE_INTEGER
    });

    expect(result.errorCode).toBe(NODE_ACTION_ERROR_CODES.cancelled);
    expect(result.outputBytes.limit).toBe(MAX_ACTION_MAX_OUTPUT_BYTES);
  });

  it("caps total stdout and stderr then terminates the noisy child", async () => {
    const result = await runNodeAction(
      node,
      ["-e", "process.stdout.write('x'.repeat(4096)); process.stderr.write('y'.repeat(4096)); setInterval(() => {}, 1000)"],
      { maxOutputBytes: 128, timeoutMs: 5_000, killGraceMs: 10 }
    );

    expect(result.errorCode).toBe(NODE_ACTION_ERROR_CODES.outputLimit);
    expect(result.outputLimitExceeded).toBe(true);
    expect(result.outputBytes.total).toBeGreaterThan(128);
    expect(result.outputBytes.captured).toBeLessThanOrEqual(128);
    expect(result.stdout.length + result.stderr.length).toBeLessThanOrEqual(128);
  });

  it("treats an output-limit policy failure as failed even when the child exits 0 immediately", async () => {
    const result = await runNodeAction(node, ["-e", "process.stdout.write('x'.repeat(4096))"], {
      maxOutputBytes: 128,
      timeoutMs: 5_000,
      killGraceMs: 10
    });

    expect(result.errorCode).toBe(NODE_ACTION_ERROR_CODES.outputLimit);
    expect(result.exitCode).not.toBe(0);
    expect(isNodeActionFailure(result)).toBe(true);
    expect(canUseNodeActionOutput(result)).toBe(false);
    expect(canUseNodeActionOutput({ exitCode: 0 })).toBe(true);
  });

  it("inherits process.env by default but supports a controlled allowlisted environment", async () => {
    const allowedName = "PIECE_ACTION_RUNNER_ALLOWED";
    const secretName = "PIECE_ACTION_RUNNER_SECRET";
    const previousAllowed = process.env[allowedName];
    const previousSecret = process.env[secretName];
    process.env[allowedName] = "allowed";
    process.env[secretName] = "secret";
    const program = `process.stdout.write([process.env.${allowedName}, process.env.${secretName}, process.env.PIECE_ACTION_RUNNER_EXPLICIT].join(':'))`;
    try {
      const inherited = await runNodeAction(node, ["-e", program]);
      const controlled = await runNodeAction(node, ["-e", program], {
        inheritProcessEnv: false,
        envAllowlist: [allowedName],
        env: { PIECE_ACTION_RUNNER_EXPLICIT: "explicit" }
      });

      expect(inherited.stdout).toBe("allowed:secret:");
      expect(controlled.stdout).toBe("allowed::explicit");
      expect(controlled.outputBytes.limit).toBe(DEFAULT_ACTION_MAX_OUTPUT_BYTES);
    } finally {
      if (previousAllowed === undefined) delete process.env[allowedName];
      else process.env[allowedName] = previousAllowed;
      if (previousSecret === undefined) delete process.env[secretName];
      else process.env[secretName] = previousSecret;
    }
  });
});
