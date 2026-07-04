import { sanitizeModulePart } from "./source-utils.js";
import { hashParts } from "./hash.js";
import { explainPieceFeedbackScope, pieceFeedbackScopeInput, pieceFeedbackSourceSetInput } from "./feedback-scope.js";
import { createPieceActionCacheMetadata, pieceActionCacheInputs } from "./action-cache.js";

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
    const actionKind = supportsCompileAction(language) ? "compile" : "feedback";
    if (!rules.has(name)) {
      rules.set(name, {
        name,
        language,
        targetKind: slice.kind,
        actionKind,
        implementation: `${language || "generic"}.${slice.kind}.${actionKind}`
      });
    }
  }
  return [...rules.values()].sort((left, right) => left.name.localeCompare(right.name));
}

function supportsCompileAction(language) {
  return language === "go" || language === "kotlin";
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

function projectModelActionInput(manifest) {
  const modelHash = manifest?.projectModel?.analysisScope?.hashes?.scopeHash ?? manifest?.projectModel?.hashes?.modelHash;
  return modelHash ? `project-model:${modelHash}` : undefined;
}

function externalDependencyId(edge) {
  return edge.import?.signature ? `${edge.to}${edge.import.signature}` : edge.to;
}

function uniqueSorted(values) {
  return [...new Set(values.filter(Boolean))].sort();
}

function uniquePreserveOrder(values) {
  return [...new Set(values.filter(Boolean))];
}

function edgeDependencyInput(edge) {
  return [
    edge.kind,
    edge.to,
    ...(edge.symbols ?? []),
    edge.import?.source,
    edge.import?.local,
    edge.import?.imported,
    edge.import?.signature
  ]
    .filter(Boolean)
    .join(":");
}

function targetActionCacheInputs(slice, sliceEdges, feedbackScope, actionCache) {
  return [
    `source-hash:${slice.hashes.bodyHash}`,
    `signature-hash:${slice.hashes.signatureHash}`,
    slice.hashes.typeHash ? `type-hash:${slice.hashes.typeHash}` : undefined,
    `deps-hash:${hashParts(sliceEdges.map(edgeDependencyInput).sort())}`,
    pieceFeedbackScopeInput(feedbackScope),
    pieceFeedbackSourceSetInput(feedbackScope),
    ...pieceActionCacheInputs(actionCache)
  ].filter(Boolean);
}

function targetActionInputs(target, projectModelInput, cacheInputs) {
  return uniquePreserveOrder([
    target.source,
    ...target.deps,
    ...target.externalDeps,
    ...uniqueSorted([projectModelInput, ...cacheInputs])
  ]);
}

export function createSingleFilePiecePackage({
  filePath,
  manifest,
  graph,
  feedbackScope = explainPieceFeedbackScope({ manifest, graph }),
  actionCache = createPieceActionCacheMetadata()
}) {
  const packageName = bazelPackageName(filePath);
  const packageLabel = sourceLabel(filePath);
  const language = languageForManifest(manifest);
  const targetLabels = new Map(
    manifest.slices.map((slice) => [slice.id, `//${packageName}:${targetNameForSlice(filePath, slice)}`])
  );
  const edges = outgoingEdges(graph);
  const projectModelInput = projectModelActionInput(manifest);
  const actionCacheInputsByTarget = new Map();
  const targets = manifest.slices.map((slice) => {
    const sliceEdges = edges.get(slice.id) ?? [];
    const actionCacheInputs = targetActionCacheInputs(slice, sliceEdges, feedbackScope, actionCache);
    const directDeps = sliceEdges.filter((edge) => targetLabels.has(edge.to)).map((edge) => targetLabels.get(edge.to));
    const label = targetLabels.get(slice.id);
    actionCacheInputsByTarget.set(label, actionCacheInputs);
    const feedbackArtifactId = `${label}.piece.json`;
    const compileArtifactId = `${label}.compile.json`;
    const targetActions = [`${label}%feedback`];
    const targetArtifacts = [feedbackArtifactId];
    if (supportsCompileAction(language)) {
      targetActions.push(`${label}%compile`);
      targetArtifacts.push(compileArtifactId);
    }
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
      externalDeps: [...new Set(sliceEdges.filter((edge) => edge.kind === "external").map(externalDependencyId))].sort(),
      actions: targetActions,
      artifacts: targetArtifacts,
      visibility: ["//visibility:private"]
    };
  });
  const rules = uniqueRulesForTargets(language, manifest.slices);
  const actions = targets.flatMap((target) => [
    {
      id: `${target.label}%feedback`,
      target: target.label,
      kind: "feedback",
      mnemonic: "PieceFeedback",
      inputs: targetActionInputs(target, projectModelInput, actionCacheInputsByTarget.get(target.label) ?? []),
      outputs: [`${target.label}.piece.json`]
    },
    ...(supportsCompileAction(language)
      ? [
          {
            id: `${target.label}%compile`,
            target: target.label,
            kind: "compile",
            mnemonic: "PieceCompile",
            inputs: targetActionInputs(target, projectModelInput, actionCacheInputsByTarget.get(target.label) ?? []),
            outputs: [`${target.label}.compile.json`]
          }
        ]
      : [])
  ]);
  const artifacts = targets.flatMap((target) => [
    {
      id: `${target.label}.piece.json`,
      target: target.label,
      kind: "piece-feedback",
      path: `${sanitizeModulePart(target.label)}.piece.json`
    },
    ...(supportsCompileAction(language)
      ? [
          {
            id: `${target.label}.compile.json`,
            target: target.label,
            kind: "piece-compile",
            path: `${sanitizeModulePart(target.label)}.compile.json`
          }
        ]
      : [])
  ]);

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
