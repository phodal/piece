export const PIECE_COMPILER_NAME = "piece-compiler";
export const PIECE_COMPILER_VERSION = 1;
export const PIECE_PREVIEW_PROTOCOL_VERSION = 1;
export const PIECE_PREVIEW_PROTOCOLS = Object.freeze(["PreviewBuild", "PreviewUpdate"]);

const PIECE_CONTROL_OPTION_KEYS = ["piece", "preview"];

function isPlainObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function definedOptions(options = {}) {
  return Object.fromEntries(Object.entries(options).filter(([, value]) => value !== undefined));
}

function mergePlainOptions(left, right) {
  return {
    ...(isPlainObject(left) ? definedOptions(left) : {}),
    ...(isPlainObject(right) ? definedOptions(right) : {})
  };
}

export function mergePieceCompilerOptions(defaultOptions = {}, options = {}) {
  const merged = {
    ...definedOptions(defaultOptions),
    ...definedOptions(options)
  };

  for (const key of PIECE_CONTROL_OPTION_KEYS) {
    const value = mergePlainOptions(defaultOptions[key], options[key]);
    if (key === "piece") {
      const preview = mergePlainOptions(defaultOptions.piece?.preview, options.piece?.preview);
      if (Object.keys(preview).length > 0) {
        value.preview = preview;
      }
    }
    if (Object.keys(value).length > 0) {
      merged[key] = value;
    } else {
      delete merged[key];
    }
  }

  return merged;
}

export function normalizePieceTarget(value, fallbackId) {
  if (typeof value === "string" && value.length > 0) {
    return { id: value };
  }

  if (isPlainObject(value)) {
    const id = typeof value.id === "string" && value.id.length > 0 ? value.id : fallbackId;
    return {
      ...definedOptions(value),
      id
    };
  }

  return fallbackId ? { id: fallbackId } : null;
}

export function normalizePieceCompilerMetadata(piece = {}, preview = {}) {
  const effectivePreview = {
    ...(isPlainObject(piece.preview) ? definedOptions(piece.preview) : {}),
    ...definedOptions(preview)
  };
  const previewTarget = effectivePreview.target ?? piece.target;
  const target = normalizePieceTarget(previewTarget, piece.id ?? piece.name);
  const explicitTargets = effectivePreview.targets ?? piece.targets;
  const targets = Array.isArray(explicitTargets)
    ? explicitTargets.map((item, index) => normalizePieceTarget(item, `${target?.id ?? "piece"}-${index + 1}`)).filter(Boolean)
    : target
      ? [target]
      : [];

  return {
    id: piece.id ?? target?.id,
    name: piece.name ?? target?.name,
    mode: piece.mode ?? "standalone",
    buildMode: piece.buildMode ?? "whole-file",
    target,
    targets,
    props: effectivePreview.props ?? piece.props,
    metadata: piece.metadata
  };
}

export function splitPieceCompilerOptions(options = {}) {
  const { piece, preview, ...compileOptions } = options;
  return {
    compileOptions,
    piece: normalizePieceCompilerMetadata(piece, preview)
  };
}
