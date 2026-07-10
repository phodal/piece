import { PIECE_FINGERPRINT_VERSION, hashParts, stableTextHash } from "./hash.js";
import { indexPieceGraphEdges } from "./slice-graph.js";
import { explainPieceFeedbackScope } from "./feedback-scope.js";
import { createPieceActionCacheMetadata } from "./action-cache.js";

function sortStrings(values) {
  return [...new Set(values.filter(Boolean))].sort();
}

function byId(items) {
  return new Map(items.map((item) => [item.id, item]));
}

function objectFromEntries(entries) {
  return Object.fromEntries([...entries].sort(([left], [right]) => left.localeCompare(right)));
}

function slicePublicShapeSource(slice) {
  const source = slice.source.trim();
  if (slice.kind === "type") {
    return source;
  }

  if (slice.kind === "function" || slice.kind === "class") {
    const bodyStart = source.indexOf("{");
    return bodyStart === -1 ? source : source.slice(0, bodyStart).trim();
  }

  if (slice.kind === "value") {
    const assignmentStart = source.indexOf("=");
    return assignmentStart === -1 ? source : source.slice(0, assignmentStart).trim();
  }

  return source;
}

function publicShapeHashForSlice(slice, previousDeclaration) {
  // The public shape hash is a pure function of the slice's own text (kind, name, export
  // metadata, and the signature-only source below). If the slice body hash is unchanged from
  // the previous declaration, the shape hash cannot have changed either, so reuse it instead of
  // re-hashing the (trimmed) source on every reconcile.
  const canReusePublicShapeHash = previousDeclaration && previousDeclaration.textHash === slice.hashes.bodyHash;
  return canReusePublicShapeHash
    ? previousDeclaration.publicShapeHash
    : stableTextHash(
        [
          slice.kind,
          slice.name ?? "",
          slice.exportName ?? "",
          slice.isDefaultExport ? "default" : "",
          slice.preview.previewable ? "previewable" : "",
          slicePublicShapeSource(slice)
        ].join("\u001f")
      );
}

function sourceRangesMatch(left, right) {
  return left.startByte === right.startByte && left.endByte === right.endByte && left.startLine === right.startLine && left.endLine === right.endLine;
}

function outgoingEdgesMatchIds(outgoingEdges, expectedIds, kind) {
  if (outgoingEdges.length === 0) {
    return expectedIds.length === 0;
  }
  const currentIds = new Set();
  for (const edge of outgoingEdges) {
    if (!kind || edge.kind === kind) {
      currentIds.add(edge.to);
    }
  }
  return currentIds.size === expectedIds.length && expectedIds.every((id) => currentIds.has(id));
}

function declarationMatchesSlice(previousDeclaration, slice, publicShapeHash, outgoingEdges) {
  return (
    previousDeclaration &&
    previousDeclaration.id === slice.id &&
    previousDeclaration.filePath === slice.filePath &&
    previousDeclaration.kind === slice.kind &&
    previousDeclaration.name === slice.name &&
    previousDeclaration.exportName === slice.exportName &&
    previousDeclaration.textHash === slice.hashes.bodyHash &&
    previousDeclaration.publicShapeHash === publicShapeHash &&
    sourceRangesMatch(previousDeclaration.range, slice.range) &&
    outgoingEdgesMatchIds(outgoingEdges, previousDeclaration.dependencyIds) &&
    outgoingEdgesMatchIds(outgoingEdges, previousDeclaration.directRuntimeDependencyIds, "runtime") &&
    outgoingEdgesMatchIds(outgoingEdges, previousDeclaration.directTypeDependencyIds, "type")
  );
}

function dependencyHashForIds(dependencyIds, publicShapeHashes) {
  return hashParts(
    dependencyIds.map((id) => {
      const publicShapeHash = publicShapeHashes.get(id);
      return publicShapeHash ? `${id}:${publicShapeHash}` : id;
    })
  );
}

function createDeclarationRecord(slice, publicShapeHash, dependencyIds, runtimeDependencyIds, typeDependencyIds, dependencyHash, artifactCacheKey, deps = dependencyIds) {

  return {
    id: slice.id,
    filePath: slice.filePath,
    kind: slice.kind,
    name: slice.name,
    exportName: slice.exportName,
    range: slice.range,
    textHash: slice.hashes.bodyHash,
    publicShapeHash,
    deps,
    dependencyIds,
    directRuntimeDependencyIds: runtimeDependencyIds,
    directTypeDependencyIds: typeDependencyIds,
    dependencyHash,
    artifactCacheKey
  };
}

function createDeclarationRecords(slices, edgesBySource, previousDeclarations, cacheKeySalt) {
  const publicShapeHashes = new Map();
  for (const slice of slices) {
    publicShapeHashes.set(slice.id, publicShapeHashForSlice(slice, previousDeclarations?.[slice.id]));
  }

  return slices.map((slice) => {
    const previousDeclaration = previousDeclarations?.[slice.id];
    const outgoingEdges = edgesBySource.get(slice.id) ?? [];
    const publicShapeHash = publicShapeHashes.get(slice.id);
    const canReuseDependencyFields = declarationMatchesSlice(previousDeclaration, slice, publicShapeHash, outgoingEdges);
    const dependencyIds = canReuseDependencyFields ? previousDeclaration.dependencyIds : sortStrings(outgoingEdges.map((edge) => edge.to));
    const runtimeDependencyIds = canReuseDependencyFields
      ? previousDeclaration.directRuntimeDependencyIds
      : sortStrings(outgoingEdges.filter((edge) => edge.kind === "runtime").map((edge) => edge.to));
    const typeDependencyIds = canReuseDependencyFields
      ? previousDeclaration.directTypeDependencyIds
      : sortStrings(outgoingEdges.filter((edge) => edge.kind === "type").map((edge) => edge.to));
    const dependencyHash = dependencyHashForIds(dependencyIds, publicShapeHashes);
    const artifactCacheKey = hashParts([hashParts([slice.id, slice.hashes.bodyHash, dependencyHash]), ...cacheKeySalt]);

    if (canReuseDependencyFields && previousDeclaration.dependencyHash === dependencyHash && previousDeclaration.artifactCacheKey === artifactCacheKey) {
      return previousDeclaration;
    }

    return createDeclarationRecord(
      slice,
      publicShapeHash,
      dependencyIds,
      runtimeDependencyIds,
      typeDependencyIds,
      dependencyHash,
      artifactCacheKey,
      canReuseDependencyFields ? previousDeclaration.deps : [...dependencyIds]
    );
  });
}

function createDefaultArtifacts(declarations) {
  return objectFromEntries(
    declarations.map((declaration) => [
      declaration.id,
      {
        version: 1,
        id: declaration.id,
        pieceId: declaration.id,
        kind: "piece",
        cacheKey: declaration.artifactCacheKey
      }
    ])
  );
}

function normalizeArtifacts(artifacts) {
  if (!artifacts) {
    return {};
  }
  const entries = artifacts instanceof Map ? [...artifacts.entries()] : Array.isArray(artifacts) ? artifacts.map((artifact) => [artifact.id, artifact]) : Object.entries(artifacts);
  return objectFromEntries(
    entries.map(([key, artifact]) => {
      const id = artifact?.id ?? key;
      return [
        id,
        {
          version: 1,
          id,
          pieceId: artifact?.pieceId ?? id,
          kind: artifact?.kind ?? "piece",
          cacheKey: artifact?.cacheKey ?? artifact?.hash ?? "",
          metadata: artifact?.metadata
        }
      ];
    })
  );
}

function rangesOverlap(left, right) {
  return left.startByte < right.endByte && left.endByte > right.startByte;
}

function declarationOverlapsRanges(declaration, ranges) {
  return declaration && ranges.some((range) => rangesOverlap(declaration.range, range));
}

function reverseDependents(reverseGraph, seedIds) {
  const affected = new Set();
  const queue = [...seedIds];
  for (let index = 0; index < queue.length; index += 1) {
    const current = queue[index];
    for (const edge of reverseGraph.get(current) ?? []) {
      if (!affected.has(edge.from)) {
        affected.add(edge.from);
        queue.push(edge.from);
      }
    }
  }
  return affected;
}

function changedHeaderHash(manifest) {
  return hashParts(manifest.importBindings.map((binding) => `${binding.local}:${binding.imported}:${binding.source}:${binding.kind}:${binding.isTypeOnly}:${binding.signature ?? ""}`));
}

function changedEffectHash(manifest) {
  return hashParts(manifest.effects.map((effect) => `${effect.id}:${effect.hashes.bodyHash}`));
}

function previewTargetsAffectedByDirtyPieces(reverseGraph, previewTargets, dirtyPieces) {
  const dependents = reverseDependents(reverseGraph, dirtyPieces);
  const candidates = new Set([...dirtyPieces, ...dependents]);
  return previewTargets.filter((target) => candidates.has(target)).sort();
}

export function createPieceSnapshot({ analysis, artifacts, version = 1, compilerOptionsHash = "", compilerOptions, dependencyArtifacts, actionCache, previousDeclarations, graphIndexes }) {
  const projectModelHash = analysis.manifest.projectModel?.analysisScope?.hashes?.scopeHash ?? analysis.manifest.projectModel?.hashes?.modelHash ?? "";
  const feedbackScope = analysis.feedbackScope ?? explainPieceFeedbackScope({ manifest: analysis.manifest, graph: analysis.graph });
  const suppliedActionCache = actionCache ?? analysis.actionCache;
  const resolvedActionCache =
    suppliedActionCache?.fingerprintVersion === PIECE_FINGERPRINT_VERSION
      ? suppliedActionCache
      : createPieceActionCacheMetadata({ compilerOptionsHash, compilerOptions, dependencyArtifacts });
  const cacheKeySalt = [
    resolvedActionCache.compilerOptionsHash,
    resolvedActionCache.dependencyArtifactsHash,
    resolvedActionCache.toolchainInputsHash,
    projectModelHash,
    feedbackScope.hashes.fallbackScopeHash
  ];
  const indexes = graphIndexes ?? indexPieceGraphEdges(analysis.graph);
  const declarations = createDeclarationRecords(analysis.manifest.slices, indexes.edgesBySource, previousDeclarations, cacheKeySalt);
  const declarationRecord = objectFromEntries(declarations.map((declaration) => [declaration.id, declaration]));
  return {
    version: 1,
    fingerprintVersion: PIECE_FINGERPRINT_VERSION,
    revision: version,
    filePath: analysis.filePath,
    sourceHash: stableTextHash(analysis.manifest.source),
    headerHash: changedHeaderHash(analysis.manifest),
    effectHash: changedEffectHash(analysis.manifest),
    projectModelHash,
    feedbackScope,
    actionCache: resolvedActionCache,
    declarations: declarationRecord,
    graph: analysis.graph,
    previewTargets: [...analysis.previewTargets],
    ...(analysis.actionPackage ? { actionPackage: analysis.actionPackage } : {}),
    artifacts: {
      ...createDefaultArtifacts(declarations),
      ...normalizeArtifacts(artifacts)
    }
  };
}

export function reconcilePieceSnapshot({ previousSnapshot, analysis, changedRanges = [], artifacts, compilerOptionsHash = "", compilerOptions, dependencyArtifacts, actionCache }) {
  const previous = previousSnapshot;
  const fingerprintChanged = previous && previous.fingerprintVersion !== PIECE_FINGERPRINT_VERSION;
  const previousDeclarations = fingerprintChanged ? {} : previous?.declarations ?? {};
  const graphIndexes = indexPieceGraphEdges(analysis.graph);
  const nextSnapshot = createPieceSnapshot({
    analysis,
    artifacts,
    version: (previous?.revision ?? 0) + 1,
    compilerOptionsHash,
    compilerOptions,
    dependencyArtifacts,
    actionCache,
    previousDeclarations,
    graphIndexes
  });

  if (!previous) {
    const changedPieces = Object.keys(nextSnapshot.declarations).sort();
    return {
      version: 1,
      previousRevision: 0,
      nextRevision: nextSnapshot.revision,
      snapshot: nextSnapshot,
      touchedPieces: changedPieces,
      changedPieces,
      publicShapeChangedPieces: changedPieces,
      dirtyPieces: changedPieces,
      affectedTargets: [...analysis.previewTargets],
      reusedArtifactIds: [],
      invalidatedArtifactIds: Object.keys(nextSnapshot.artifacts).sort(),
      changedHeaders: true,
      changedEffects: analysis.manifest.effects.length > 0
    };
  }

  const nextDeclarations = nextSnapshot.declarations;
  const allDeclarationIds = sortStrings([...Object.keys(previousDeclarations), ...Object.keys(nextDeclarations)]);
  const touchedPieces = [];
  const changedPieces = new Set();
  const publicShapeChangedPieces = new Set();

  for (const id of allDeclarationIds) {
    const before = previousDeclarations[id];
    const after = nextDeclarations[id];
    // Declarations can move or disappear after an insertion/deletion, so check both
    // coordinate spaces while traversing the union that is already needed for the diff.
    if (declarationOverlapsRanges(before, changedRanges) || declarationOverlapsRanges(after, changedRanges)) {
      touchedPieces.push(id);
    }
    if (!before || !after || before.textHash !== after.textHash) {
      changedPieces.add(id);
    }
    if (!before || !after || before.publicShapeHash !== after.publicShapeHash) {
      publicShapeChangedPieces.add(id);
    }
  }

  const changedHeaders = fingerprintChanged || previous.headerHash !== nextSnapshot.headerHash;
  const changedEffects = fingerprintChanged || previous.effectHash !== nextSnapshot.effectHash;
  // Build the reverse dependency graph once and reuse it for both the public-shape dirty
  // propagation below and the preview-target lookup further down, instead of rebuilding it twice.
  const reverseGraph = graphIndexes.edgesByTarget;
  const dirtyPieces = new Set(changedPieces);
  for (const id of reverseDependents(reverseGraph, publicShapeChangedPieces)) {
    dirtyPieces.add(id);
  }
  if (changedHeaders || changedEffects) {
    for (const id of Object.keys(nextDeclarations)) {
      dirtyPieces.add(id);
    }
  }

  const previousArtifacts = previous.artifacts ?? {};
  const reusedArtifactIds = [];
  const invalidatedArtifactIds = [];
  for (const [id, artifact] of Object.entries(nextSnapshot.artifacts)) {
    const previousArtifact = previousArtifacts[id];
    if (previousArtifact && previousArtifact.cacheKey === artifact.cacheKey && !dirtyPieces.has(artifact.pieceId)) {
      reusedArtifactIds.push(id);
    } else {
      invalidatedArtifactIds.push(id);
    }
  }

  return {
    version: 1,
    previousRevision: previous.revision,
    nextRevision: nextSnapshot.revision,
    snapshot: nextSnapshot,
    touchedPieces,
    changedPieces: [...changedPieces].sort(),
    publicShapeChangedPieces: [...publicShapeChangedPieces].sort(),
    dirtyPieces: [...dirtyPieces].sort(),
    affectedTargets: changedHeaders || changedEffects ? [...analysis.previewTargets] : previewTargetsAffectedByDirtyPieces(reverseGraph, analysis.previewTargets, dirtyPieces),
    reusedArtifactIds: reusedArtifactIds.sort(),
    invalidatedArtifactIds: invalidatedArtifactIds.sort(),
    changedHeaders,
    changedEffects
  };
}
