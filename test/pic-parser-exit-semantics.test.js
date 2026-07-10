import { describe, expect, it } from "vitest";
import { parsePieceDslFile } from "../src/node.js";

describe(".pic parser diagnostic exit semantics", () => {
  // This starts the JVM/ANTLR backend. Keep the semantic assertion strict but
  // allow a cold Gradle worker under the full parallel Vitest suite.
  it("returns the JVM parser's validated syntax report when the backend exits 1", async () => {
    const source = `package "//repo/src:Broken.kt" {
  language kotlin
  source "/repo/src/Broken.kt"
  target function "broken" {
}`;

    const result = await parsePieceDslFile({ filePath: "/repo/src/Broken.pic", source });

    expect(result).toMatchObject({
      version: 1,
      parser: "antlr-pic-parser",
      filePath: "/repo/src/Broken.pic",
      source,
      piecePackage: null
    });
    expect(result.diagnostics).toEqual(
      expect.arrayContaining([expect.objectContaining({ code: "pic-syntax-error", severity: "error" })])
    );
    expect(result.diagnostics.some((diagnostic) => diagnostic.code === "compiler-error")).toBe(false);
  }, 180_000);
});
