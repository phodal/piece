import { indexPieceGraphEdges } from "./slice-graph.js";

function sliceContainingRange(manifest, range) {
  return manifest.slices.find((slice) => range.startByte < slice.range.endByte && range.endByte > slice.range.startByte);
}

export function diffPieceManifest(previousManifest, nextManifest) {
  if (!previousManifest) {
    return {
      changedSlices: nextManifest.slices.map((slice) => slice.id),
      changedHeaders: true,
      changedEffects: nextManifest.effects.length > 0
    };
  }

  const previousById = new Map(previousManifest.slices.map((slice) => [slice.id, slice]));
  const changedSlices = [];
  for (const slice of nextManifest.slices) {
    const previous = previousById.get(slice.id);
    if (!previous || previous.hashes.bodyHash !== slice.hashes.bodyHash || previous.hashes.signatureHash !== slice.hashes.signatureHash || previous.hashes.typeHash !== slice.hashes.typeHash) {
      changedSlices.push(slice.id);
    }
  }

  return {
    changedSlices,
    changedHeaders: JSON.stringify(previousManifest.importBindings) !== JSON.stringify(nextManifest.importBindings),
    changedEffects: JSON.stringify(previousManifest.effects.map((effect) => effect.hashes.bodyHash)) !== JSON.stringify(nextManifest.effects.map((effect) => effect.hashes.bodyHash))
  };
}

export function analyzePieceEdit({ previousManifest, nextManifest, changedRanges = [] }) {
  const changedSlices = new Set(diffPieceManifest(previousManifest, nextManifest).changedSlices);
  for (const range of changedRanges) {
    const slice = sliceContainingRange(nextManifest, range);
    if (slice) {
      changedSlices.add(slice.id);
    }
  }

  const diff = diffPieceManifest(previousManifest, nextManifest);
  return {
    changedRanges,
    changedSlices: [...changedSlices].sort(),
    changedHeaders: diff.changedHeaders,
    changedEffects: diff.changedEffects
  };
}

export function findAffectedPiecePreviewTargets({ changedSlices, graph, previewTargets }) {
  const reverse = indexPieceGraphEdges(graph).edgesByTarget;
  const affected = new Set();
  // A reverse graph can contain cycles (for example mutually recursive
  // declarations). Mark a node as queued before appending it so each node is
  // processed at most once and a cycle cannot keep extending the work list.
  const queue = [...new Set(changedSlices)];
  const queued = new Set(queue);
  const visited = new Set();
  const previewTargetSet = new Set(previewTargets);

  for (let index = 0; index < queue.length; index += 1) {
    const current = queue[index];
    if (visited.has(current)) continue;
    visited.add(current);
    if (previewTargetSet.has(current)) {
      affected.add(current);
    }
    for (const edge of reverse.get(current) ?? []) {
      if (!queued.has(edge.from)) {
        queued.add(edge.from);
        queue.push(edge.from);
      }
    }
  }

  return [...affected].sort();
}
