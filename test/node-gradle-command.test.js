import { describe, expect, it } from "vitest";
import { createNodeActionInvocation } from "../src/node-action-runner.js";
import { resolveNodeGradleCommand, resolveNodeGradleWrapperPath } from "../src/node-gradle-command.js";

describe("Node Gradle command resolution", () => {
  it("selects the platform wrapper for default and project-root commands", () => {
    expect(resolveNodeGradleWrapperPath({ platform: "linux", packageRoot: "/opt/piece" })).toBe("/opt/piece/gradlew");
    expect(resolveNodeGradleWrapperPath({ platform: "win32", packageRoot: "C:\\Program Files\\Piece" })).toBe(
      "C:\\Program Files\\Piece\\gradlew.bat"
    );
  });

  it("keeps a bare custom gradle command direct while resolving explicit wrapper paths", () => {
    expect(resolveNodeGradleCommand("gradle", { platform: "win32", baseDirectory: "C:\\work\\app" })).toBe("gradle");
    expect(resolveNodeGradleCommand(".\\tools\\gradlew.bat", { platform: "win32", baseDirectory: "C:\\work\\app" })).toBe(
      "C:\\work\\app\\tools\\gradlew.bat"
    );
    expect(resolveNodeGradleCommand("./tools/gradlew", { platform: "linux", baseDirectory: "/work/app" })).toBe("/work/app/tools/gradlew");
  });

  it("wraps only explicit Windows batch commands through cmd.exe while preserving result identity", () => {
    const args = ["check", "--project-cache-dir", "C:\\cache with spaces"];
    expect(
      createNodeActionInvocation("C:\\Program Files\\Piece\\gradlew.bat", args, {
        platform: "win32",
        comSpec: "C:\\Windows\\System32\\cmd.exe"
      })
    ).toEqual({
      command: "C:\\Windows\\System32\\cmd.exe",
      args: ["/d", "/s", "/c", "call", "C:\\Program Files\\Piece\\gradlew.bat", ...args],
      resultCommand: "C:\\Program Files\\Piece\\gradlew.bat",
      resultArgs: args
    });

    expect(createNodeActionInvocation("gradle", ["check"], { platform: "win32" })).toEqual({
      command: "gradle",
      args: ["check"],
      resultCommand: "gradle",
      resultArgs: ["check"]
    });
    expect(createNodeActionInvocation("/opt/piece/gradlew", ["check"], { platform: "linux" })).toEqual({
      command: "/opt/piece/gradlew",
      args: ["check"],
      resultCommand: "/opt/piece/gradlew",
      resultArgs: ["check"]
    });
  });
});
