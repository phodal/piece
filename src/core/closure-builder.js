import { hashParts } from "./hash.js";

function byId(slices) {
  return new Map(slices.map((slice) => [slice.id, slice]));
}

function sourceOrder(left, right) {
  return left.range.startByte - right.range.startByte || left.id.localeCompare(right.id);
}

function outgoingEdges(graph) {
  const outgoing = new Map();
  for (const edge of graph.edges) {
    if (!outgoing.has(edge.from)) {
      outgoing.set(edge.from, []);
    }
    outgoing.get(edge.from).push(edge);
  }
  return outgoing;
}

export function buildPieceClosure({ target, manifest, graph }) {
  const slices = byId(manifest.slices);
  const targetSlice = slices.get(target) ?? manifest.slices.find((slice) => slice.name === target || slice.exportName === target);
  if (!targetSlice) {
    throw new Error(`Unknown preview target: ${target}`);
  }

  const outgoing = outgoingEdges(graph);
  const runtimeSliceIds = new Set([targetSlice.id]);
  const typeSliceIds = new Set();
  const valueSliceIds = new Set();
  const externalImports = new Map();
  const diagnostics = [];
  let fallbackMode = manifest.hasTopLevelEffect ? "whole-file" : "none";
  const visited = new Set();

  function visit(sliceId, reason = "runtime") {
    const visitKey = `${reason}:${sliceId}`;
    if (visited.has(visitKey)) {
      return;
    }
    visited.add(visitKey);
    const slice = slices.get(sliceId);
    if (!slice) {
      return;
    }
    if (slice.kind === "type" || reason === "type") {
      typeSliceIds.add(sliceId);
    } else {
      runtimeSliceIds.add(sliceId);
      if (slice.kind === "value") {
        valueSliceIds.add(sliceId);
      }
    }

    for (const edge of outgoing.get(sliceId) ?? []) {
      if (edge.kind === "external") {
        if (edge.import) {
          externalImports.set(`${edge.import.source}:${edge.import.local}`, edge.import);
        }
        continue;
      }
      if (edge.kind === "type") {
        typeSliceIds.add(edge.to);
        visit(edge.to, "type");
        continue;
      }
      if (edge.kind === "runtime") {
        visit(edge.to, "runtime");
        continue;
      }
      if (edge.kind === "unknown") {
        fallbackMode = "whole-file";
        diagnostics.push({
          code: "unknown-closure-edge",
          severity: "warning",
          message: `Closure for ${targetSlice.name ?? targetSlice.id} includes unknown reference ${edge.symbols.join(", ")}.`,
          edge
        });
      }
    }
  }

  visit(targetSlice.id);

  const runtimeSlices = [...runtimeSliceIds].map((id) => slices.get(id)).filter(Boolean).sort(sourceOrder);
  const typeSlices = [...typeSliceIds].map((id) => slices.get(id)).filter(Boolean).sort(sourceOrder);
  const valueSlices = [...valueSliceIds].map((id) => slices.get(id)).filter(Boolean).sort(sourceOrder);
  const runtimeClosureHash = hashParts([targetSlice.id, ...runtimeSlices.map((slice) => slice.hashes.bodyHash), ...manifest.importBindings.map((binding) => `${binding.local}:${binding.source}:${binding.imported}:${binding.signature ?? ""}`)]);
  const typeClosureHash = hashParts([...typeSlices.map((slice) => slice.hashes.typeHash ?? slice.hashes.signatureHash)]);

  return {
    version: 1,
    target: targetSlice.id,
    targetName: targetSlice.name ?? targetSlice.exportName ?? "default",
    runtimeSlices: runtimeSlices.map((slice) => slice.id),
    typeSlices: typeSlices.map((slice) => slice.id),
    valueSlices: valueSlices.map((slice) => slice.id),
    externalImports: [...externalImports.values()].sort((left, right) => `${left.source}:${left.local}`.localeCompare(`${right.source}:${right.local}`)),
    diagnostics,
    fallbackMode,
    hashes: {
      runtimeClosureHash,
      typeClosureHash,
      fixtureHash: hashParts([targetSlice.id, typeClosureHash])
    }
  };
}
