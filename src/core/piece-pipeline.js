import { resolveDefaultDeclarationExtractor } from "./extractor-registry.js";
import { createSingleFilePiecePackage } from "./piece-package.js";
import { buildPieceClosure } from "./closure-builder.js";
import { buildPiecePreviewBundle } from "./build-orchestrator.js";
import { createPieceVirtualModules } from "./virtual-modules.js";
import { findAffectedPiecePreviewTargets } from "./impact-analyzer.js";
import { buildPieceSliceGraph, updatePieceSliceGraph } from "./slice-graph.js";
import { createPieceSnapshot, reconcilePieceSnapshot } from "./reconciler.js";
import { byteLength, measureAsync, measureSync, nowMs, roundMs } from "./metrics.js";
import { stableTextHash } from "./hash.js";
import { collectIdentifierReferences, createSourceRange } from "./source-utils.js";

export async function analyzePieceFile(options) {
  const startedAt = nowMs();
  const extractor = options.declarationExtractor ?? (await resolveDefaultDeclarationExtractor(options.filePath));
  const manifestResult = await measureAsync(() =>
    extractor.extract({
      filePath: options.filePath,
      source: options.source,
      previousTree: options.previousTree
    })
  );
  const graphResult = measureSync(() => buildPieceSliceGraph(manifestResult.value, { globals: options.globals }));
  const previewTargets = manifestResult.value.slices.filter((slice) => slice.preview.previewable).map((slice) => slice.id);
  const piecePackage = createSingleFilePiecePackage({
    filePath: options.filePath,
    manifest: manifestResult.value,
    graph: graphResult.value
  });

  const analysis = {
    version: 1,
    filePath: options.filePath,
    manifest: manifestResult.value,
    graph: graphResult.value,
    piecePackage,
    previewTargets,
    metrics: {
      totalMs: roundMs(nowMs() - startedAt),
      phases: {
        extractMs: manifestResult.ms,
        graphMs: graphResult.ms
      },
      sourceBytes: byteLength(options.source),
      sliceCount: manifestResult.value.slices.length,
      edgeCount: graphResult.value.edges.length,
      previewTargetCount: previewTargets.length
    }
  };
  return {
    ...analysis,
    snapshot: createPieceSnapshot({ analysis })
  };
}

function changedSliceForRanges(manifest, changedRanges, delta) {
  const affected = new Set();
  for (const range of changedRanges) {
    const slice = manifest.slices.find((candidate) => range.startByte >= candidate.range.startByte && range.startByte <= candidate.range.endByte);
    if (!slice || range.endByte < slice.range.startByte || range.endByte > slice.range.endByte + Math.max(delta, 0)) {
      return undefined;
    }
    affected.add(slice);
  }
  return affected.size === 1 ? [...affected][0] : undefined;
}

function shiftRange(source, range, delta, boundary) {
  if (range.startByte > boundary) {
    return createSourceRange(source, range.startByte + delta, range.endByte + delta);
  }
  return createSourceRange(source, range.startByte, range.endByte);
}

function updateSliceForSource(previousSlice, source, startByte, endByte) {
  const sliceSource = source.slice(startByte, endByte);
  const references = collectIdentifierReferences(sliceSource, { excluded: previousSlice.name ? [previousSlice.name] : [] });
  const jsxReferences = [...new Set([...sliceSource.matchAll(/<([A-Z][A-Za-z0-9_$]*)/g)].map((match) => match[1]))].sort();
  const hasDynamicImport = /import\s*\(|require\s*\(/.test(sliceSource);

  return {
    ...previousSlice,
    range: createSourceRange(source, startByte, endByte),
    source: sliceSource,
    symbols: {
      ...previousSlice.symbols,
      references,
      jsxReferences
    },
    hashes: {
      bodyHash: stableTextHash(sliceSource),
      signatureHash: stableTextHash(sliceSource.slice(0, Math.min(sliceSource.length, 240))),
      typeHash: previousSlice.kind === "type" ? stableTextHash(sliceSource) : undefined
    },
    safety: {
      ...previousSlice.safety,
      hasDynamicImport,
      fallbackRequired: previousSlice.safety.fallbackRequired || hasDynamicImport
    }
  };
}

function updatePieceAnalysisFromSingleSliceEdit(options) {
  if (!options.previousAnalysis || !options.changedRanges?.length) {
    return undefined;
  }
  if (options.previousAnalysis.manifest.parser !== "typescript-declaration-extractor") {
    return undefined;
  }

  const previousManifest = options.previousAnalysis.manifest;
  const delta = options.source.length - previousManifest.source.length;
  const changedSlice = changedSliceForRanges(previousManifest, options.changedRanges, delta);
  if (!changedSlice) {
    return undefined;
  }

  const nextSliceEndByte = changedSlice.range.endByte + delta;
  if (nextSliceEndByte < changedSlice.range.startByte || nextSliceEndByte > options.source.length) {
    return undefined;
  }

  const nextSliceSource = options.source.slice(changedSlice.range.startByte, nextSliceEndByte);
  if (changedSlice.name && !new RegExp(`\\b${changedSlice.name}\\b`).test(nextSliceSource)) {
    return undefined;
  }

  const shiftBoundary = changedSlice.range.endByte;
  const slices = previousManifest.slices.map((slice) => {
    if (slice.id === changedSlice.id) {
      return updateSliceForSource(slice, options.source, slice.range.startByte, nextSliceEndByte);
    }
    const range = shiftRange(options.source, slice.range, delta, shiftBoundary);
    return {
      ...slice,
      range,
      source: options.source.slice(range.startByte, range.endByte)
    };
  });
  const headers = previousManifest.headers.map((header) => {
    const range = shiftRange(options.source, header.range, delta, shiftBoundary);
    return {
      ...header,
      range,
      source: options.source.slice(range.startByte, range.endByte)
    };
  });
  const effects = previousManifest.effects.map((effect) => {
    const range = shiftRange(options.source, effect.range, delta, shiftBoundary);
    const effectSource = options.source.slice(range.startByte, range.endByte);
    return {
      ...effect,
      range,
      source: effectSource,
      hashes: {
        bodyHash: stableTextHash(effectSource)
      }
    };
  });
  const manifest = {
    ...previousManifest,
    source: options.source,
    slices,
    headers,
    effects,
    hasTopLevelEffect: effects.length > 0
  };
  const graphResult = measureSync(() => updatePieceSliceGraph(options.previousAnalysis.graph, manifest, [changedSlice.id], { globals: options.globals }));
  const previewTargets = manifest.slices.filter((slice) => slice.preview.previewable).map((slice) => slice.id);
  const piecePackage = createSingleFilePiecePackage({
    filePath: options.filePath,
    manifest,
    graph: graphResult.value
  });

  const analysis = {
    version: 1,
    filePath: options.filePath,
    manifest,
    graph: graphResult.value,
    piecePackage,
    previewTargets,
    metrics: {
      totalMs: graphResult.ms,
      phases: {
        extractMs: 0,
        graphMs: graphResult.ms
      },
      sourceBytes: byteLength(options.source),
      sliceCount: manifest.slices.length,
      edgeCount: graphResult.value.edges.length,
      previewTargetCount: previewTargets.length,
      incremental: true,
      graphUpdate: "incremental"
    }
  };
  return {
    ...analysis,
    snapshot: createPieceSnapshot({ analysis })
  };
}

export function selectPiecePreviewTarget(analysis, options = {}) {
  if (options.target) {
    return analysis.manifest.slices.find((slice) => slice.id === options.target || slice.name === options.target || slice.exportName === options.target)?.id;
  }
  if (options.cursorByte !== undefined) {
    const containing = analysis.manifest.slices.find(
      (slice) => slice.preview.previewable && options.cursorByte >= slice.range.startByte && options.cursorByte <= slice.range.endByte
    );
    if (containing) {
      return containing.id;
    }
  }
  const defaultExport = analysis.manifest.slices.find((slice) => slice.preview.previewable && slice.isDefaultExport);
  if (defaultExport) {
    return defaultExport.id;
  }
  return analysis.previewTargets[0];
}

function previousPreviewForTarget(previousPreviews, target) {
  if (!previousPreviews) {
    return undefined;
  }
  if (previousPreviews instanceof Map) {
    return previousPreviews.get(target);
  }
  if (Array.isArray(previousPreviews)) {
    return previousPreviews.find((preview) => preview?.target === target);
  }
  return previousPreviews[target];
}

function createPreviewMetrics({ startedAt, analyzeMs, targetMs, closureMs, virtualModulesMs, bundleMs, source, closure, virtualModules, bundle, cache }) {
  const closureSource = virtualModules.files[virtualModules.closurePath] ?? "";
  return {
    totalMs: roundMs(nowMs() - startedAt),
    phases: {
      analyzeMs,
      targetMs,
      closureMs,
      virtualModulesMs,
      bundleMs
    },
    sourceBytes: byteLength(source),
    closureBytes: byteLength(closureSource),
    entryBytes: byteLength(virtualModules.files[virtualModules.entryPath] ?? ""),
    bundleBytes: byteLength(bundle?.code ?? ""),
    runtimeSliceCount: closure.runtimeSlices.length,
    typeSliceCount: closure.typeSlices.length,
    valueSliceCount: closure.valueSlices.length,
    externalImportCount: closure.externalImports.length,
    cache
  };
}

export async function buildPiecePreview(options) {
  const startedAt = nowMs();
  let analysis = options.analysis;
  let analyzeMs = 0;
  if (!analysis) {
    const analysisResult = await measureAsync(() => analyzePieceFile(options));
    analysis = analysisResult.value;
    analyzeMs = analysisResult.ms;
  }

  const targetResult = measureSync(() => selectPiecePreviewTarget(analysis, options));
  const target = targetResult.value;
  if (!target) {
    throw new Error(`No previewable piece target found for ${analysis.filePath}.`);
  }

  const closureResult = measureSync(() => buildPieceClosure({ target, manifest: analysis.manifest, graph: analysis.graph }));
  const closure = closureResult.value;
  const virtualModulesResult = measureSync(() =>
    createPieceVirtualModules({
      manifest: analysis.manifest,
      closure,
      preview: options.preview
    })
  );
  const virtualModules = virtualModulesResult.value;
  const cacheHit = Boolean(
    options.previousPreview?.bundle &&
      options.reuseRuntimeBundle !== false &&
      options.previousPreview.closure?.hashes?.runtimeClosureHash === closure.hashes.runtimeClosureHash
  );
  let bundle = cacheHit ? options.previousPreview.bundle : undefined;
  let bundleMs = 0;

  if (!cacheHit && options.buildEngine) {
    const bundleResult = await measureAsync(() =>
      buildPiecePreviewBundle({
        buildEngine: options.buildEngine,
        virtualModules,
        target: options.targetEnvironment ?? "es2022",
        external: options.external ?? ["react", "react-dom/client", "react/jsx-runtime"],
        plugins: options.plugins,
        compileStrategy: options.compileStrategy
      })
    );
    bundle = bundleResult.value;
    bundleMs = bundleResult.ms;
  }

  return {
    version: 1,
    target,
    analysis,
    closure,
    virtualModules,
    bundle,
    metrics: createPreviewMetrics({
      startedAt,
      analyzeMs,
      targetMs: targetResult.ms,
      closureMs: closureResult.ms,
      virtualModulesMs: virtualModulesResult.ms,
      bundleMs,
      source: options.source ?? analysis.manifest.source,
      closure,
      virtualModules,
      bundle,
      cache: {
        status: cacheHit ? "hit" : "miss",
        runtimeBundleReused: cacheHit,
        previousRuntimeClosureHash: options.previousPreview?.closure?.hashes?.runtimeClosureHash,
        runtimeClosureHash: closure.hashes.runtimeClosureHash
      }
    })
  };
}

export async function applyPieceEdit(options) {
  const startedAt = nowMs();
  const analysisResult = await measureAsync(async () => updatePieceAnalysisFromSingleSliceEdit(options) ?? (await analyzePieceFile(options)));
  const nextAnalysis = analysisResult.value;
  const reconciliationResult = measureSync(() =>
    reconcilePieceSnapshot({
      previousSnapshot: options.previousAnalysis?.snapshot ?? (options.previousAnalysis ? createPieceSnapshot({ analysis: options.previousAnalysis }) : undefined),
      analysis: nextAnalysis,
      changedRanges: options.changedRanges
    })
  );
  const reconciliation = reconciliationResult.value;
  const edit = {
    changedRanges: options.changedRanges ?? [],
    changedSlices: reconciliation.changedPieces,
    changedHeaders: reconciliation.changedHeaders,
    changedEffects: reconciliation.changedEffects
  };
  const affectedResult = measureSync(() =>
    reconciliation.affectedTargets.length > 0
      ? reconciliation.affectedTargets
      : edit.changedHeaders || edit.changedEffects
        ? nextAnalysis.previewTargets
        : findAffectedPiecePreviewTargets({
            changedSlices: edit.changedSlices,
            graph: nextAnalysis.graph,
            previewTargets: nextAnalysis.previewTargets
          })
  );
  const affectedTargets = affectedResult.value;

  return {
    version: 1,
    analysis: {
      ...nextAnalysis,
      snapshot: reconciliation.snapshot
    },
    edit,
    reconciliation,
    affectedTargets,
    metrics: {
      totalMs: roundMs(nowMs() - startedAt),
      phases: {
        analyzeMs: analysisResult.ms,
        diffMs: reconciliationResult.ms,
        affectedMs: affectedResult.ms
      },
      changedSliceCount: edit.changedSlices.length,
      affectedTargetCount: affectedTargets.length
    }
  };
}

export async function rebuildAffectedPiecePreviews(options) {
  const startedAt = nowMs();
  const editResult = options.editResult ?? (await applyPieceEdit(options));
  const updates = [];
  for (const target of editResult.affectedTargets) {
    try {
      const preview = await buildPiecePreview({
        ...options,
        analysis: editResult.analysis,
        target,
        previousPreview: previousPreviewForTarget(options.previousPreviews, target)
      });
      updates.push({
        version: 1,
        target,
        status: preview.metrics.cache.status === "hit" ? "runtime-skipped" : "built",
        reason: preview.metrics.cache.status === "hit" ? "runtime-closure-cache-hit" : undefined,
        preview
      });
    } catch (error) {
      updates.push({
        version: 1,
        target,
        status: "error",
        keepLastGood: true,
        diagnostics: [{ code: "preview-build-error", severity: "error", message: error.message }]
      });
    }
  }

  return {
    version: 1,
    editResult,
    updates,
    metrics: {
      totalMs: roundMs(nowMs() - startedAt),
      affectedTargetCount: editResult.affectedTargets.length,
      builtCount: updates.filter((update) => update.status === "built").length,
      skippedCount: updates.filter((update) => update.status === "runtime-skipped").length,
      errorCount: updates.filter((update) => update.status === "error").length
    }
  };
}
