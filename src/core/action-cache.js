import { hashParts, stableTextHash } from "./hash.js";

function stableStringify(value) {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map(stableStringify).join(",")}]`;
  }
  return `{${Object.keys(value)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`)
    .join(",")}}`;
}

function normalizeDependencyArtifacts(value) {
  if (!value) {
    return [];
  }
  const entries =
    value instanceof Map
      ? [...value.entries()].map(([key, artifact]) => ({ key, artifact }))
      : Array.isArray(value)
        ? value.map((artifact, index) => ({ key: String(index), artifact }))
        : Object.entries(value).map(([key, artifact]) => ({ key, artifact }));

  return entries
    .map(({ key, artifact }) => {
      if (typeof artifact === "string") {
        return {
          id: key,
          path: artifact,
          hash: "",
          cacheKey: ""
        };
      }
      return {
        id: artifact?.id ?? key,
        path: artifact?.path ?? "",
        kind: artifact?.kind,
        hash: artifact?.hash ?? "",
        cacheKey: artifact?.cacheKey ?? ""
      };
    })
    .sort((left, right) => dependencyArtifactIdentity(left).localeCompare(dependencyArtifactIdentity(right)));
}

function dependencyArtifactIdentity(artifact) {
  return [artifact.id, artifact.path, artifact.kind, artifact.hash, artifact.cacheKey].filter(Boolean).join(":");
}

export function createPieceActionCacheMetadata(options = {}) {
  const compilerOptionsHash =
    options.compilerOptionsHash ??
    (options.compilerOptions === undefined ? "" : stableTextHash(stableStringify(options.compilerOptions)));
  const dependencyArtifacts = normalizeDependencyArtifacts(options.dependencyArtifacts);
  const dependencyArtifactsHash = dependencyArtifacts.length > 0 ? hashParts(dependencyArtifacts.map(dependencyArtifactIdentity)) : "";
  const inputs = [
    compilerOptionsHash ? `compiler-options:${compilerOptionsHash}` : undefined,
    dependencyArtifactsHash ? `dependency-artifacts:${dependencyArtifactsHash}` : undefined
  ].filter(Boolean);

  return {
    version: 1,
    compilerOptionsHash,
    dependencyArtifactsHash,
    dependencyArtifacts,
    inputs
  };
}

export function pieceActionCacheInputs(actionCache) {
  return actionCache?.inputs ?? [];
}
