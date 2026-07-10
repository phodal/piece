import { describe, expect, it } from "vitest";
import { resolvePieceGradleWrapperPath } from "../src/cli/index.js";
import { createGradleInvocation, resolveGradleWrapperPath } from "../scripts/run-gradle.mjs";

describe("Gradle launcher", () => {
  it("selects the checked-in wrapper for each platform", () => {
    expect(resolveGradleWrapperPath({ platform: "darwin", packageRoot: "/opt/piece" })).toBe("/opt/piece/gradlew");
    expect(resolveGradleWrapperPath({ platform: "win32", packageRoot: "C:\\Program Files\\Piece" })).toBe(
      "C:\\Program Files\\Piece\\gradlew.bat"
    );
    expect(resolvePieceGradleWrapperPath({ platform: "win32", packageRoot: "C:\\Program Files\\Piece" })).toBe(
      "C:\\Program Files\\Piece\\gradlew.bat"
    );
  });

  it("routes only Windows batch wrappers through the shared controlled cmd.exe invocation", () => {
    expect(
      createGradleInvocation(["check", "--project-cache-dir", "C:\\cache with spaces"], {
        platform: "win32",
        packageRoot: "C:\\Program Files\\Piece",
        comSpec: "C:\\attacker\\cmd.exe"
      })
    ).toEqual({
      command: "C:\\Windows\\System32\\cmd.exe",
      args: [
        "/d",
        "/e:on",
        "/v:off",
        "/s",
        "/c",
        '""C:\\Program Files\\Piece\\gradlew.bat" "check" "--project-cache-dir" "C:\\cache with spaces""'
      ],
      cwd: "C:\\Program Files\\Piece"
    });

    expect(createGradleInvocation(["check"], { platform: "linux", packageRoot: "/opt/piece" })).toEqual({
      command: "/opt/piece/gradlew",
      args: ["check"],
      cwd: "/opt/piece"
    });
  });
});
