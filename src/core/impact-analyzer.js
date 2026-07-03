import { reversePieceGraph } from "./slice-graph.js";

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
  const reverse = reversePieceGraph(graph);
  const affected = new Set();
  const queue = [...changedSlices];
  const previewTargetSet = new Set(previewTargets);

  while (queue.length > 0) {
    const current = queue.shift();
    if (previewTargetSet.has(current)) {
      affected.add(current);
    }
    for (const edge of reverse.get(current) ?? []) {
      queue.push(edge.from);
    }
  }

  return [...affected].sort();
}
