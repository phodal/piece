import { sanitizeModulePart } from "./source-utils.js";

function normalizePath(value) {
  return String(value ?? "")
    .replace(/\\/g, "/")
    .replace(/\/+/g, "/");
}

function dirname(filePath) {
  const normalized = normalizePath(filePath);
  const index = normalized.lastIndexOf("/");
  if (index <= 0) {
    return ".";
  }
  return normalized.slice(0, index);
}

function basename(filePath) {
  const normalized = normalizePath(filePath);
  const index = normalized.lastIndexOf("/");
  return index >= 0 ? normalized.slice(index + 1) : normalized;
}

function bazelPackageName(filePath) {
  const directory = dirname(filePath).replace(/^\/+/, "");
  return directory.length > 0 && directory !== "." ? directory : ".";
}

function sourceLabel(filePath) {
  return `//${bazelPackageName(filePath)}:${basename(filePath)}`;
}

function targetNameForSlice(filePath, slice) {
  const sourceName = sanitizeModulePart(basename(filePath));
  const pieceName = sanitizeModulePart(slice.name ?? slice.exportName ?? slice.id.split(":").pop());
  return `${sourceName}__${slice.kind}_${pieceName}`;
}

function ruleForSlice(language, slice) {
  return `${language || "generic"}_piece_${slice.kind}`;
}

function uniqueRulesForTargets(language, slices) {
  const rules = new Map();
  for (const slice of slices) {
    const name = ruleForSlice(language, slice);
    if (!rules.has(name)) {
      rules.set(name, {
        name,
        language,
        targetKind: slice.kind,
        actionKind: "feedback",
        implementation: `${language || "generic"}.${slice.kind}.feedback`
      });
    }
  }
  return [...rules.values()].sort((left, right) => left.name.localeCompare(right.name));
}

function languageForManifest(manifest) {
  if (manifest.parser?.includes("go")) return "go";
  if (manifest.parser?.includes("kotlin")) return "kotlin";
  if (manifest.parser?.includes("typescript")) return "typescript";
  if (manifest.parser?.includes("tree-sitter")) return "tree_sitter";
  return "generic";
}

function outgoingEdges(graph) {
  const bySource = new Map();
  for (const edge of graph.edges) {
    if (!bySource.has(edge.from)) {
      bySource.set(edge.from, []);
    }
    bySource.get(edge.from).push(edge);
  }
  return bySource;
}

export function createSingleFilePiecePackage({ filePath, manifest, graph }) {
  const packageName = bazelPackageName(filePath);
  const packageLabel = sourceLabel(filePath);
  const language = languageForManifest(manifest);
  const targetLabels = new Map(
    manifest.slices.map((slice) => [slice.id, `//${packageName}:${targetNameForSlice(filePath, slice)}`])
  );
  const edges = outgoingEdges(graph);
  const targets = manifest.slices.map((slice) => {
    const sliceEdges = edges.get(slice.id) ?? [];
    const directDeps = sliceEdges.filter((edge) => targetLabels.has(edge.to)).map((edge) => targetLabels.get(edge.to));
    const label = targetLabels.get(slice.id);
    const artifactId = `${label}.piece.json`;
    return {
      id: slice.id,
      label,
      name: slice.name,
      kind: slice.kind,
      rule: ruleForSlice(language, slice),
      source: packageLabel,
      deps: [...new Set(directDeps)].sort(),
      runtimeDeps: [
        ...new Set(sliceEdges.filter((edge) => edge.kind === "runtime" && targetLabels.has(edge.to)).map((edge) => targetLabels.get(edge.to)))
      ].sort(),
      typeDeps: [
        ...new Set(sliceEdges.filter((edge) => edge.kind === "type" && targetLabels.has(edge.to)).map((edge) => targetLabels.get(edge.to)))
      ].sort(),
      externalDeps: [...new Set(sliceEdges.filter((edge) => edge.kind === "external").map((edge) => edge.to))].sort(),
      actions: [`${label}%feedback`],
      artifacts: [artifactId],
      visibility: ["//visibility:private"]
    };
  });
  const rules = uniqueRulesForTargets(language, manifest.slices);
  const actions = targets.map((target) => ({
    id: `${target.label}%feedback`,
    target: target.label,
    kind: "feedback",
    mnemonic: "PieceFeedback",
    inputs: [target.source, ...target.deps, ...target.externalDeps],
    outputs: target.artifacts
  }));
  const artifacts = targets.map((target) => ({
    id: target.artifacts[0],
    target: target.label,
    kind: "piece-feedback",
    path: `${sanitizeModulePart(target.label)}.piece.json`
  }));

  return {
    version: 1,
    kind: "single-file-package",
    language,
    packageName,
    label: packageLabel,
    filePath,
    sourceFile: packageLabel,
    rules,
    targets,
    actions,
    artifacts
  };
}
