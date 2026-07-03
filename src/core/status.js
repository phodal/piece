import {
  PIECE_COMPILER_NAME,
  PIECE_COMPILER_VERSION,
  PIECE_PREVIEW_PROTOCOL_VERSION,
  PIECE_PREVIEW_PROTOCOLS
} from "./options.js";

function arrayFrom(value) {
  return Array.isArray(value) ? value : [];
}

function uniqueStrings(values) {
  return [...new Set(values.filter((value) => typeof value === "string" && value.length > 0))];
}

function targetFromAnalysis(analysis, targetId) {
  if (!analysis || !targetId) {
    return null;
  }
  const slice = analysis.manifest?.slices?.find((candidate) => candidate.id === targetId);
  return {
    id: targetId,
    name: slice?.name,
    exportName: slice?.exportName,
    sourcePath: slice?.filePath,
    kind: slice?.kind
  };
}

export function createPieceStatus(input, piece = {}, analysis, preview) {
  const target = piece.target ?? targetFromAnalysis(analysis, preview?.target) ?? (piece.id ? { id: piece.id, name: piece.name } : null);
  const targets = piece.targets?.length
    ? piece.targets
    : analysis?.previewTargets?.length
      ? analysis.previewTargets.map((id) => targetFromAnalysis(analysis, id) ?? { id }).filter(Boolean)
      : target
        ? [target]
        : [];
  const affectedTargets = uniqueStrings(targets.map((item) => item.id));
  const diagnostics = analysis?.manifest?.diagnostics ?? [];

  return {
    version: PIECE_COMPILER_VERSION,
    previewProtocolVersion: PIECE_PREVIEW_PROTOCOL_VERSION,
    protocols: PIECE_PREVIEW_PROTOCOLS,
    mode: piece.mode ?? "standalone",
    buildMode: piece.buildMode ?? "whole-file",
    target,
    targets,
    props: piece.props,
    metadata: piece.metadata,
    sourceRoots: arrayFrom(input.sourceRoots),
    sourceFileCount: input.sourceFileCount ?? arrayFrom(input.sourceFiles).length,
    changedPieces: [],
    affectedTargets,
    diagnostics: {
      issueCount: diagnostics.length
    }
  };
}

export function createPieceCompileStatus(input, context = {}) {
  const analysis = context.analysis;
  const preview = context.preview;
  return {
    version: 1,
    compiler: PIECE_COMPILER_NAME,
    name: input.name,
    cwd: input.cwd,
    entry: input.entry,
    filePath: input.filePath,
    sourceRoots: arrayFrom(input.sourceRoots),
    sourceFiles: arrayFrom(input.sourceFiles),
    sourceFileCount: input.sourceFileCount ?? arrayFrom(input.sourceFiles).length,
    diagnostics: {
      issueCount: analysis?.manifest?.diagnostics?.length ?? 0
    },
    piece: createPieceStatus(input, context.piece, analysis, preview),
    analysis,
    preview
  };
}
