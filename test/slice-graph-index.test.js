import { describe, expect, it } from "vitest";
import { indexPieceGraphEdges, reversePieceGraph } from "../src/core/slice-graph.js";

describe("piece graph edge indexes", () => {
  it("builds forward and reverse indexes in one stable edge traversal", () => {
    const first = { from: "a", to: "b", kind: "runtime" };
    const second = { from: "a", to: "c", kind: "type" };
    const third = { from: "d", to: "b", kind: "runtime" };
    const graph = { edges: [first, second, third] };

    const indexes = indexPieceGraphEdges(graph);

    expect(indexes.edgesBySource.get("a")).toEqual([first, second]);
    expect(indexes.edgesByTarget.get("b")).toEqual([first, third]);
    expect(reversePieceGraph(graph).get("b")).toEqual([first, third]);
  });
});
