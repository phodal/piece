import { describe, expect, it } from "vitest";
import { createNodeActionInvocation, resolveWindowsCommandProcessor } from "../src/node-action-runner.js";
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

  it("wraps only explicit Windows batch commands through the trusted cmd.exe path while preserving result identity", () => {
    const args = ["check", "--project-cache-dir", "C:\\cache with spaces"];
    const invocation = createNodeActionInvocation("C:\\Program Files\\Piece\\gradlew.bat", args, {
      platform: "win32",
      comSpec: "C:\\attacker\\cmd.exe"
    });
    expect(invocation).toEqual({
      command: resolveWindowsCommandProcessor(),
      args: [
        "/d",
        "/e:on",
        "/v:off",
        "/s",
        "/c",
        '""C:\\Program Files\\Piece\\gradlew.bat" "check" "--project-cache-dir" "C:\\cache with spaces""'
      ],
      windowsVerbatimArguments: true,
      resultCommand: "C:\\Program Files\\Piece\\gradlew.bat",
      resultArgs: args
    });
    expect(invocation.command).not.toBe("C:\\attacker\\cmd.exe");

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

  it("quotes batch paths and arguments with cmd metacharacters into one controlled command string", () => {
    const previousComSpec = process.env.ComSpec;
    const previousUpperComSpec = process.env.COMSPEC;
    process.env.ComSpec = "C:\\attacker\\cmd.exe";
    process.env.COMSPEC = "C:\\attacker-upper\\cmd.exe";
    try {
      const invocation = createNodeActionInvocation(
        "C:\\build & tools\\gradlew.bat. ",
        ["a&whoami", "a|b", "<input>", "%UNTRUSTED%", "!delayed!", 'quote"value', "trailing\\"],
        { platform: "win32" }
      );

      expect(invocation.command).toBe(resolveWindowsCommandProcessor());
      expect(invocation.command).not.toBe(process.env.ComSpec);
      expect(invocation.args).toEqual([
        "/d",
        "/e:on",
        "/v:off",
        "/s",
        "/c",
        '""C:\\build & tools\\gradlew.bat. " "a&whoami" "a|b" "<input>" "%%cd:~,%UNTRUSTED%%cd:~,%" "!delayed!" "quote""value" "trailing\\\\""'
      ]);
      expect(invocation.windowsVerbatimArguments).toBe(true);
      expect(invocation.resultCommand).toBe("C:\\build & tools\\gradlew.bat. ");
      expect(invocation.resultArgs).toEqual([
        "a&whoami",
        "a|b",
        "<input>",
        "%UNTRUSTED%",
        "!delayed!",
        'quote"value',
        "trailing\\"
      ]);
      expect(invocation.args.at(-1)).not.toContain("call ");
    } finally {
      if (previousComSpec === undefined) delete process.env.ComSpec;
      else process.env.ComSpec = previousComSpec;
      if (previousUpperComSpec === undefined) delete process.env.COMSPEC;
      else process.env.COMSPEC = previousUpperComSpec;
    }
  });

  it("rejects Windows batch tokens that cannot be represented without creating another command line", () => {
    expect(() => createNodeActionInvocation("C:\\work\\gradlew.bat", ["safe\nunsafe"], { platform: "win32" })).toThrow(
      /cannot contain NUL, carriage return, or line feed/
    );
  });
});
