import { sanitizeModulePart } from "./source-utils.js";
import { hashParts } from "./hash.js";
import {
  explainPieceFeedbackScope,
  pieceFeedbackFallbackInputs,
  pieceFeedbackScopeInput,
  pieceFeedbackSourceSetInput
} from "./feedback-scope.js";
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

function targetNameForDeclaration(filePath, declaration) {
  const sourceName = sanitizeModulePart(basename(filePath));
  const pieceName = sanitizeModulePart(declaration.name ?? declaration.imported ?? declaration.id?.split("#").pop() ?? "target");
  return `${sourceName}__${declaration.kind}_${pieceName}`;
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

function externalSourceIdentity(edge) {
  return edge.import?.source ?? String(edge.to ?? "").split("#")[0];
}

function externalImportedName(edge) {
  return edge.import?.imported ?? String(edge.to ?? "").split("#").pop();
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
    ...pieceFeedbackFallbackInputs(feedbackScope),
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

function packageScopeFromManifest(manifest) {
  const toolchains = [
    ...(manifest?.toolchain ? [manifest.toolchain] : []),
    ...(Array.isArray(manifest?.toolchains) ? manifest.toolchains : [])
  ];
  return toolchains.map((toolchain) => toolchain?.packageScope).find((scope) => scope?.status === "selected" || scope?.targetPolicy);
}

function sourceFilesForPackageScope(packageScope, primaryFilePath) {
  const normalizedPrimary = normalizePath(primaryFilePath);
  return (packageScope?.files ?? []).map((file) => {
    const filePath = file.filePath;
    return {
      filePath,
      label: sourceLabel(filePath),
      hash: file.hash,
      role: normalizePath(filePath) === normalizedPrimary ? "primary" : "companion"
    };
  });
}

function declarationByExternalIdentity(packageScope) {
  const declarations = new Map();
  for (const declaration of packageScope?.declarations ?? []) {
    declarations.set(`${normalizePath(declaration.filePath)}#${declaration.name}`, declaration);
  }
  return declarations;
}

function inferredDeclarationForEdge(edge) {
  const source = externalSourceIdentity(edge);
  const name = externalImportedName(edge);
  return {
    id: `${source}#${edge.import?.isTypeOnly ? "type" : "value"}:${name}`,
    filePath: source,
    name,
    kind: edge.import?.isTypeOnly ? "type" : "value"
  };
}

function compareByLabel(left, right) {
  return left.label.localeCompare(right.label);
}

function actionKindForLanguage(language) {
  return supportsCompileAction(language) ? ["feedback", "compile"] : ["feedback"];
}

function defaultArtifactKind(kind) {
  return kind === "compile" ? "piece-compile" : "piece-feedback";
}

function promotedPackageTarget(target, language) {
  const actionKinds = actionKindForLanguage(language);
  return {
    id: target.id,
    label: target.label,
    name: target.name,
    kind: target.kind,
    rule: target.rule,
    source: target.source,
    deps: [],
    runtimeDeps: [],
    typeDeps: [],
    externalDeps: [],
    actions: actionKinds.map((kind) => `${target.label}%${kind}`),
    artifacts: actionKinds.map((kind) => `${target.label}.${kind === "compile" ? "compile" : "piece"}.json`),
    visibility: ["//visibility:private"]
  };
}

function promotedActionsForTarget(target, packageScopeInput) {
  return target.actions.map((id) => {
    const kind = id.endsWith("%compile") ? "compile" : "feedback";
    return {
      id,
      target: target.label,
      kind,
      mnemonic: kind === "compile" ? "PieceCompile" : "PieceFeedback",
      inputs: uniquePreserveOrder([target.source, packageScopeInput]),
      outputs: [`${target.label}.${kind === "compile" ? "compile" : "piece"}.json`]
    };
  });
}

function promotedArtifactsForTarget(target) {
  return target.actions.map((id) => {
    const kind = id.endsWith("%compile") ? "compile" : "feedback";
    const artifactId = `${target.label}.${kind === "compile" ? "compile" : "piece"}.json`;
    return {
      id: artifactId,
      target: target.label,
      kind: defaultArtifactKind(kind),
      path: `${sanitizeModulePart(artifactId)}`
    };
  });
}

function isTypeLikeTarget(target) {
  return ["type", "class", "header"].includes(target?.kind);
}

function applyPromotedDepsToTarget(target, promotedEdges, promotedTargetsByLabel) {
  if (promotedEdges.length === 0) {
    return target;
  }
  const promotedByExternal = new Map(promotedEdges.map((edge) => [edge.externalIdentity, edge.to]));
  const promotedTypeDeps = promotedEdges
    .filter((edge) => isTypeLikeTarget(promotedTargetsByLabel.get(edge.to)))
    .map((edge) => edge.to);
  const promotedRuntimeDeps = promotedEdges
    .filter((edge) => !isTypeLikeTarget(promotedTargetsByLabel.get(edge.to)))
    .map((edge) => edge.to);
  return {
    ...target,
    deps: uniqueSorted([...target.deps, ...promotedEdges.map((edge) => edge.to)]),
    runtimeDeps: uniqueSorted([...target.runtimeDeps, ...promotedRuntimeDeps]),
    typeDeps: uniqueSorted([...target.typeDeps, ...promotedTypeDeps]),
    externalDeps: target.externalDeps.filter((dep) => !promotedByExternal.has(dep))
  };
}

function applyPromotedDepsToAction(action, promotedEdgesByTarget) {
  const promotedEdges = promotedEdgesByTarget.get(action.target) ?? [];
  if (promotedEdges.length === 0) {
    return action;
  }
  const promotedByExternal = new Map(promotedEdges.map((edge) => [edge.externalIdentity, edge.to]));
  return {
    ...action,
    inputs: uniquePreserveOrder(action.inputs.map((input) => promotedByExternal.get(input) ?? input))
  };
}

function packageViewRules(piecePackage, promotedTargets) {
  const rules = new Map((piecePackage.rules ?? []).map((rule) => [rule.name, rule]));
  for (const target of promotedTargets) {
    if (!rules.has(target.rule)) {
      rules.set(target.rule, {
        name: target.rule,
        language: piecePackage.language,
        targetKind: target.kind,
        actionKind: supportsCompileAction(piecePackage.language) ? "compile" : "feedback",
        implementation: `${piecePackage.language || "generic"}.${target.kind}.${supportsCompileAction(piecePackage.language) ? "compile" : "feedback"}`
      });
    }
  }
  return [...rules.values()].sort((left, right) => left.name.localeCompare(right.name));
}

function createSelectedPackageView(piecePackage, model) {
  const promotedEdgesByTarget = new Map();
  for (const edge of model.promotedEdges) {
    if (!promotedEdgesByTarget.has(edge.from)) {
      promotedEdgesByTarget.set(edge.from, []);
    }
    promotedEdgesByTarget.get(edge.from).push(edge);
  }
  const promotedTargets = model.promotedTargets.map((target) => promotedPackageTarget(target, model.language));
  const promotedTargetsByLabel = new Map(promotedTargets.map((target) => [target.label, target]));
  return {
    ...piecePackage,
    rules: packageViewRules(piecePackage, promotedTargets),
    targets: [
      ...piecePackage.targets.map((target) =>
        applyPromotedDepsToTarget(target, promotedEdgesByTarget.get(target.label) ?? [], promotedTargetsByLabel)
      ),
      ...promotedTargets
    ],
    actions: [
      ...piecePackage.actions.map((action) => applyPromotedDepsToAction(action, promotedEdgesByTarget)),
      ...promotedTargets.flatMap((target) => promotedActionsForTarget(target, model.packageScopeInput))
    ],
    artifacts: [...piecePackage.artifacts, ...promotedTargets.flatMap(promotedArtifactsForTarget)]
  };
}

function packageScopeSelectionStatus({ selection, feedbackScope, targets, promotedEdges, currentTargets, packageScope }) {
  const requested = selection ?? "current-file";
  const blockedReasons = [];
  const currentLabels = new Set(currentTargets.map((target) => target.label));
  const promotedLabels = new Set();

  for (const target of targets) {
    if (currentLabels.has(target.label)) {
      blockedReasons.push({
        code: "package-scope-target-label-conflict",
        severity: "warning",
        message: `Package-scope target ${target.label} conflicts with an existing current-file target.`
      });
    }
    if (promotedLabels.has(target.label)) {
      blockedReasons.push({
        code: "package-scope-target-duplicate",
        severity: "warning",
        message: `Package-scope target ${target.label} was produced more than once.`
      });
    }
    promotedLabels.add(target.label);
  }

  for (const edge of promotedEdges) {
    if (edge.fromResolved === false) {
      blockedReasons.push({
        code: "package-scope-edge-unmapped-source",
        severity: "warning",
        message: `Package-scope edge from ${edge.from} could not be mapped back to a generated current-file target.`
      });
    }
  }

  if (targets.length === 0) {
    blockedReasons.push({
      code: "package-scope-no-promoted-targets",
      severity: "info",
      message: "No package-scope companion targets are available for selection."
    });
  }

  if (feedbackScope?.fallbackRequired) {
    blockedReasons.push({
      code: "package-scope-feedback-fallback",
      severity: "warning",
      message: "Package-scope selection is disabled while feedback scope already requires file or project fallback."
    });
  }

  if (packageScope?.status !== "selected") {
    blockedReasons.push({
      code: "package-scope-not-selected",
      severity: "warning",
      message: "Package-scope selection requires a selected toolchain package scope."
    });
  }

  const canSelect = requested === "safe" && targets.length > 0 && blockedReasons.every((reason) => reason.severity === "info");
  return {
    requested,
    status: canSelect ? "selected" : targets.length > 0 ? "candidate" : "file",
    appliedToDefaultPackage: false,
    appliedToPackageView: canSelect,
    blockedReasons,
    reason: canSelect
      ? "Package-scope targets passed the safe selection gate and are available in packageView."
      : targets.length > 0
        ? "Package-scope targets are available as a candidate model while the default feedback package keeps the current-file fast path."
        : "No package-scope companion targets are available for promotion."
  };
}

export function createPackageScopeTargetModel({ filePath, manifest, graph, piecePackage, feedbackScope, selection }) {
  const packageScope = packageScopeFromManifest(manifest);
  if (!packageScope) {
    return undefined;
  }

  const companionFileSet = new Set(
    sourceFilesForPackageScope(packageScope, filePath)
      .filter((file) => file.role === "companion")
      .map((file) => normalizePath(file.filePath))
  );
  const declarations = declarationByExternalIdentity(packageScope);
  const currentPackage = piecePackage ?? createSingleFilePiecePackage({ filePath, manifest, graph });
  const currentTargets = currentPackage.targets.map((target) => ({
    id: target.id,
    label: target.label,
    name: target.name,
    kind: target.kind,
    sourceFile: manifest.filePath,
    source: target.source,
    rule: target.rule
  }));
  const currentTargetsBySliceId = new Map(currentPackage.targets.map((target) => [target.id, target]));
  const promotedTargets = new Map();
  const promotedEdges = [];

  for (const edge of graph.edges ?? []) {
    if (edge.kind !== "external") continue;
    const source = externalSourceIdentity(edge);
    if (!companionFileSet.has(normalizePath(source))) continue;
    const imported = externalImportedName(edge);
    const declaration = declarations.get(`${normalizePath(source)}#${imported}`) ?? inferredDeclarationForEdge(edge);
    const label = `//${bazelPackageName(source)}:${targetNameForDeclaration(source, declaration)}`;
    if (!promotedTargets.has(label)) {
      promotedTargets.set(label, {
        id: declaration.id,
        label,
        name: declaration.name,
        kind: declaration.kind,
        sourceFile: source,
        source: sourceLabel(source),
        rule: ruleForSlice(languageForManifest(manifest), declaration),
        externalIdentity: externalDependencyId(edge),
        hash: declaration.hash
      });
    }
    promotedEdges.push({
      from: currentTargetsBySliceId.get(edge.from)?.label ?? edge.from,
      to: label,
      kind: edge.kind,
      symbols: edge.symbols ?? [],
      externalIdentity: externalDependencyId(edge),
      fromResolved: currentTargetsBySliceId.has(edge.from)
    });
  }

  const targets = [...promotedTargets.values()].sort(compareByLabel);
  const promotion = packageScopeSelectionStatus({
    selection,
    feedbackScope,
    targets,
    promotedEdges,
    currentTargets,
    packageScope
  });
  const model = {
    version: 1,
    kind: "package-scope-target-model",
    status: promotion.status,
    language: languageForManifest(manifest),
    packageName: bazelPackageName(filePath),
    label: `//${bazelPackageName(filePath)}:__package_scope`,
    filePath,
    sourceFile: sourceLabel(filePath),
    packageScopeHash: packageScope.hash,
    packageScopeInput: packageScope.input,
    targetPolicy: packageScope.targetPolicy,
    promotion,
    sourceFiles: sourceFilesForPackageScope(packageScope, filePath),
    currentTargets,
    promotedTargets: targets,
    promotedEdges: promotedEdges.sort((left, right) =>
      `${left.from}:${left.to}:${left.kind}:${left.symbols.join(",")}`.localeCompare(`${right.from}:${right.to}:${right.kind}:${right.symbols.join(",")}`)
    )
  };
  return promotion.appliedToPackageView
    ? {
        ...model,
        packageView: createSelectedPackageView(currentPackage, model)
      }
    : model;
}
