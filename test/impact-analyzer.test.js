import { describe, expect, it } from "vitest";
import { findAffectedPiecePreviewTargets } from "../src/core/impact-analyzer.js";

describe("impact analyzer", () => {
  it("terminates and returns the reverse preview closure for mutually recursive pieces", () => {
    const graph = {
      edges: [
        { from: "file#function:a", to: "file#function:b", kind: "runtime" },
        { from: "file#function:b", to: "file#function:a", kind: "runtime" },
        { from: "file#function:Preview", to: "file#function:a", kind: "runtime" }
      ]
    };

    expect(
      findAffectedPiecePreviewTargets({
        changedSlices: ["file#function:a"],
        graph,
        previewTargets: ["file#function:a", "file#function:b", "file#function:Preview"]
      })
    ).toEqual(["file#function:Preview", "file#function:a", "file#function:b"]);
  });
});
