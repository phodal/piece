import { hashParts, stableTextHash } from "./hash.js";

function sortStrings(values) {
  return [...new Set(values.filter(Boolean))].sort();
}

function edgeIdentity(edge) {
  return [
    edge.from,
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

function projectModelHash(projectModel) {
  return projectModel?.analysisScope?.hashes?.scopeHash ?? projectModel?.hashes?.modelHash ?? "";
}

function projectDependencyInputs(projectModel) {
  const scope = projectModel?.analysisScope;
  return [
    ...(scope?.dependencyCoordinates ?? []),
    ...(scope?.projectDependencies ?? []).map((dependency) =>
      [
        dependency.projectPath,
        dependency.configuration,
        dependency.dependencyProjectPath,
        dependency.dependencyProjectDir
      ].join(":")
    ),
    ...(scope?.targetVariants ?? []).map((variant) =>
      [
        variant.projectPath,
        variant.sourceSet,
        variant.targetName,
        variant.compilationName,
        variant.compileTask,
        variant.classpathConfiguration
      ].join(":")
    )
  ];
}

function manifestToolchains(manifest) {
  const toolchains = [
    ...(manifest?.toolchain ? [manifest.toolchain] : []),
    ...(Array.isArray(manifest?.toolchains) ? manifest.toolchains : [])
  ];
  const seen = new Set();
  return toolchains.filter((toolchain) => {
    const key = [
      toolchain?.kind,
      toolchain?.status,
      toolchain?.hash,
      toolchain?.packageScope?.status,
      toolchain?.packageScope?.hash,
      toolchain?.packageScope?.targetPolicy?.kind,
      toolchain?.packageScope?.targetPolicy?.targetScope,
      toolchain?.packageScope?.targetPolicy?.companionTargetMode
    ].join(":");
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function toolchainScopeInputs(manifest) {
  return manifestToolchains(manifest)
    .map((toolchain) => {
      const scope = toolchain?.packageScope;
      if (!scope?.hash) return undefined;
      const policy = scope.targetPolicy;
      return [
        toolchain.kind,
        scope.status,
        scope.input,
        scope.hash,
        policy?.kind,
        policy?.targetScope,
        policy?.companionTargetMode,
        policy?.companionTargets === undefined ? undefined : `companion-targets:${policy.companionTargets}`,
        policy?.fastPath === undefined ? undefined : `fast-path:${policy.fastPath}`
      ]
        .filter(Boolean)
        .join(":");
    })
    .filter(Boolean);
}

function compareStableText(left, right) {
  return JSON.stringify(left).localeCompare(JSON.stringify(right));
}

function selectedSourceSetScope(projectModel) {
  const scope = projectModel?.analysisScope;
  if (scope?.status !== "selected") {
    return undefined;
  }

  return {
    kind: projectModel.kind,
    projectRoot: projectModel.projectRoot,
    projectPath: scope.projectPath,
    projectPaths: sortStrings(scope.projectPaths ?? []),
    sourceSet: scope.sourceSet,
    requiredSourceSets: sortStrings(scope.requiredSourceSets ?? []),
    sourceRoots: sortStrings(scope.sourceRoots ?? []),
    classpath: sortStrings(scope.classpath ?? []),
    classpathConfigurations: sortStrings(scope.classpathConfigurations ?? []),
    dependencyCoordinates: sortStrings(scope.dependencyCoordinates ?? []),
    projectDependencies: [...(scope.projectDependencies ?? [])].sort(compareStableText),
    targetVariants: [...(scope.targetVariants ?? [])].sort(compareStableText),
    hashes: scope.hashes
  };
}

function createReason(code, severity, message, details = {}) {
  return {
    code,
    severity,
    message,
    ...details
  };
}

function projectModelReasons(projectModel) {
  const reasons = [];
  if (!projectModel) {
    return reasons;
  }

  if (projectModel.status === "fallback") {
    reasons.push(
      createReason(
        "project-model-discovery-fallback",
        "warning",
        "Gradle project model discovery did not return a successful model, so Piece must treat the project as the safe fallback boundary.",
        { projectRoot: projectModel.projectRoot }
      )
    );
  }

  if (projectModel.analysisScope?.status === "fallback") {
    reasons.push(
      createReason(
        "project-model-scope-fallback",
        "warning",
        projectModel.analysisScope.fallbackReason ??
          "Gradle project model discovery did not prove a source-set-scoped analysis boundary.",
        {
          projectRoot: projectModel.projectRoot,
          projectPath: projectModel.analysisScope.projectPath,
          sourceSet: projectModel.analysisScope.sourceSet
        }
      )
    );
  }

  if (projectModel.analysisScope?.status === "selected") {
    reasons.push(
      createReason(
        "source-set-scope-selected",
        "info",
        "Gradle project model discovery selected a source-set-scoped feedback boundary.",
        {
          projectRoot: projectModel.projectRoot,
          projectPath: projectModel.analysisScope.projectPath,
          sourceSet: projectModel.analysisScope.sourceSet,
          projectPaths: projectModel.analysisScope.projectPaths,
          requiredSourceSets: projectModel.analysisScope.requiredSourceSets
        }
      )
    );
  }

  return reasons;
}

function toolchainScopeReasons(manifest) {
  const reasons = [];
  for (const toolchain of manifestToolchains(manifest)) {
    const packageScope = toolchain?.packageScope;
    const policy = packageScope?.targetPolicy;
    if (toolchain?.kind === "go-list" && packageScope?.status === "selected" && policy?.fastPath) {
      reasons.push(
        createReason(
          "go-package-scope-fast-path",
          "info",
          "Go package scope contributes toolchain and source identity, while current-file targets remain the default fast path.",
          {
            toolchain: toolchain.kind,
            packageScopeStatus: packageScope.status,
            packageScopeHash: packageScope.hash,
            packageScopeInput: packageScope.input,
            fileCount: packageScope.files?.length ?? 0,
            targetPolicy: policy.kind,
            targetScope: policy.targetScope,
            companionTargetMode: policy.companionTargetMode,
            companionTargets: policy.companionTargets,
            fastPath: policy.fastPath
          }
        )
      );
    }
  }
  return reasons;
}

function safetyReasons(manifest, graph) {
  const reasons = [];
  const unknownEdges = graph.edges.filter((edge) => edge.kind === "unknown");
  if (unknownEdges.length > 0) {
    reasons.push(
      createReason(
        "unknown-edge-fallback",
        "warning",
        "The slice graph contains unresolved references, so Piece cannot prove piece-level feedback is safe.",
        {
          edgeCount: unknownEdges.length,
          symbols: sortStrings(unknownEdges.flatMap((edge) => edge.symbols ?? []))
        }
      )
    );
  }

  if (manifest.hasTopLevelEffect) {
    reasons.push(
      createReason(
        "top-level-effect-fallback",
        "warning",
        "The file has top-level effects, so Piece must include the file-level effect boundary.",
        { effectCount: manifest.effects.length }
      )
    );
  }

  const unsafeSlices = manifest.slices.filter((slice) => slice.safety?.fallbackRequired);
  if (unsafeSlices.length > 0) {
    reasons.push(
      createReason(
        "slice-safety-fallback",
        "warning",
        "One or more slices require fallback because the extractor reported unsafe local feedback.",
        {
          sliceIds: unsafeSlices.map((slice) => slice.id).sort()
        }
      )
    );
  }

  return reasons;
}

function feedbackLevel({ safety, project }) {
  if (project.some((reason) => reason.code === "project-model-discovery-fallback" || reason.code === "project-model-scope-fallback")) {
    return "project";
  }
  if (safety.length > 0) {
    return "file";
  }
  if (project.some((reason) => reason.code === "source-set-scope-selected")) {
    return "source-set";
  }
  return "piece";
}

export function explainPieceFeedbackScope({ manifest, graph }) {
  const safety = safetyReasons(manifest, graph);
  const project = projectModelReasons(manifest.projectModel);
  const toolchain = toolchainScopeReasons(manifest);
  const sourceSet = selectedSourceSetScope(manifest.projectModel);
  const level = feedbackLevel({ safety, project });
  const fallbackRequired = level === "file" || level === "project";
  const reasons =
    safety.length > 0 || project.length > 0 || toolchain.length > 0
      ? [...safety, ...project, ...toolchain]
      : [
          createReason(
            "piece-scope-clean",
            "info",
            "All slice graph references resolve locally or through declared external bindings, so piece-level feedback is safe."
          )
        ];
  const sourceHash = stableTextHash(manifest.source);
  const dependencyHash = hashParts([
    ...graph.edges.map(edgeIdentity).sort(),
    ...projectDependencyInputs(manifest.projectModel).sort(),
    ...toolchainScopeInputs(manifest).sort()
  ]);
  const modelHash = projectModelHash(manifest.projectModel);
  const fallbackScopeHash = hashParts([
    "feedback-scope:v1",
    level,
    fallbackRequired ? "fallback" : "ready",
    dependencyHash,
    modelHash,
    ...reasons.map((reason) =>
      [
        reason.code,
        reason.severity,
        reason.projectPath,
        reason.sourceSet,
        reason.packageScopeHash,
        reason.packageScopeInput,
        reason.targetPolicy,
        reason.targetScope,
        reason.companionTargetMode,
        reason.companionTargets === undefined ? undefined : `companion-targets:${reason.companionTargets}`,
        reason.fastPath === undefined ? undefined : `fast-path:${reason.fastPath}`,
        ...(reason.symbols ?? []),
        ...(reason.sliceIds ?? []),
        ...(reason.requiredSourceSets ?? []),
        ...(reason.projectPaths ?? [])
      ]
        .filter(Boolean)
        .join(":")
    )
  ]);

  return {
    version: 1,
    level,
    fallbackRequired,
    reasons,
    ...(sourceSet ? { sourceSet } : {}),
    hashes: {
      sourceHash,
      dependencyHash,
      projectModelHash: modelHash,
      fallbackScopeHash
    }
  };
}

export function pieceFeedbackScopeInput(feedbackScope) {
  return feedbackScope?.hashes?.fallbackScopeHash ? `feedback-scope:${feedbackScope.hashes.fallbackScopeHash}` : undefined;
}

export function pieceFeedbackSourceSetInput(feedbackScope) {
  return feedbackScope?.sourceSet?.hashes?.scopeHash ? `source-set:${feedbackScope.sourceSet.hashes.scopeHash}` : undefined;
}

function fallbackReasonIdentity(reason) {
  return [
    reason.code,
    reason.severity,
    reason.projectRoot,
    reason.projectPath,
    reason.sourceSet,
    reason.packageScopeHash,
    reason.packageScopeInput,
    reason.targetPolicy,
    reason.targetScope,
    reason.companionTargetMode,
    reason.companionTargets === undefined ? undefined : `companion-targets:${reason.companionTargets}`,
    reason.fastPath === undefined ? undefined : `fast-path:${reason.fastPath}`,
    reason.edgeCount === undefined ? undefined : `edges:${reason.edgeCount}`,
    reason.effectCount === undefined ? undefined : `effects:${reason.effectCount}`,
    ...(reason.symbols ?? []),
    ...(reason.sliceIds ?? []),
    ...(reason.requiredSourceSets ?? []),
    ...(reason.projectPaths ?? [])
  ]
    .filter(Boolean)
    .join(":");
}

export function pieceFeedbackFallbackInputs(feedbackScope) {
  if (!feedbackScope?.fallbackRequired) {
    return [];
  }
  return (feedbackScope.reasons ?? [])
    .filter((reason) => reason.severity !== "info")
    .map((reason) => `fallback-reason:${reason.code}:${hashParts([fallbackReasonIdentity(reason)])}`)
    .sort();
}
