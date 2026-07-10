import { PIECE_FINGERPRINT_VERSION, hashParts, stableTextHash } from "./hash.js";

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

function normalizeToolchainInputs(value) {
  return [...new Set(Array.isArray(value) ? value.map((input) => String(input ?? "")).filter(Boolean) : [])].sort();
}

export function pieceToolchainInputsFromManifest(manifest) {
  const toolchains = [
    ...(manifest?.toolchain ? [manifest.toolchain] : []),
    ...(Array.isArray(manifest?.toolchains) ? manifest.toolchains : [])
  ];
  return normalizeToolchainInputs(toolchains.flatMap((toolchain) => toolchain?.inputs ?? []));
}

export function createPieceActionCacheMetadata(options = {}) {
  const compilerOptionsHash =
    options.compilerOptionsHash ??
    (options.compilerOptions === undefined ? "" : stableTextHash(stableStringify(options.compilerOptions)));
  const dependencyArtifacts = normalizeDependencyArtifacts(options.dependencyArtifacts);
  const dependencyArtifactsHash = dependencyArtifacts.length > 0 ? hashParts(dependencyArtifacts.map(dependencyArtifactIdentity)) : "";
  const toolchainInputs = normalizeToolchainInputs(options.toolchainInputs);
  const toolchainInputsHash = toolchainInputs.length > 0 ? hashParts(toolchainInputs) : "";
  const inputs = [
    compilerOptionsHash ? `compiler-options:${compilerOptionsHash}` : undefined,
    dependencyArtifactsHash ? `dependency-artifacts:${dependencyArtifactsHash}` : undefined,
    ...toolchainInputs
  ].filter(Boolean);

  return {
    version: 1,
    fingerprintVersion: PIECE_FINGERPRINT_VERSION,
    compilerOptionsHash,
    dependencyArtifactsHash,
    toolchainInputsHash,
    dependencyArtifacts,
    toolchainInputs,
    inputs
  };
}

export function pieceActionCacheInputs(actionCache) {
  return actionCache?.inputs ?? [];
}

function uniqueSorted(values = []) {
  return [...new Set(values.filter((value) => value !== undefined && value !== null && value !== ""))].map(String).sort();
}

function normalizeActionCacheRecords(records) {
  if (!records) {
    return [];
  }
  if (records instanceof Map) {
    return [...records.entries()]
      .map(([key, record]) => ({ key: String(key), record }))
      .map(({ key, record }) => (record?.key ? record : { ...record, key }))
      .filter((record) => record?.key);
  }
  if (Array.isArray(records)) {
    return records.filter((record) => record?.key);
  }
  return Object.entries(records)
    .map(([key, record]) => (record?.key ? record : { ...record, key }))
    .filter((record) => record?.key);
}

function actionCacheReason(code, severity, message, extra = {}) {
  return {
    code,
    severity,
    message,
    ...extra
  };
}

function projectModelHashForAnalysis(analysis) {
  return analysis?.manifest?.projectModel?.analysisScope?.hashes?.scopeHash ?? analysis?.manifest?.projectModel?.hashes?.modelHash ?? analysis?.snapshot?.projectModelHash ?? "";
}

function sourceHashForAction(options = {}) {
  if (options.source !== undefined) {
    return stableTextHash(options.source);
  }
  return options.analysis?.snapshot?.sourceHash ?? "";
}

function feedbackScopeHashForAnalysis(analysis) {
  return analysis?.feedbackScope?.hashes?.fallbackScopeHash ?? analysis?.snapshot?.feedbackScope?.hashes?.fallbackScopeHash ?? "";
}

function actionCacheMetadataForRecord(options = {}) {
  return options.actionCache ?? options.analysis?.actionCache ?? createPieceActionCacheMetadata();
}

export function createPieceActionCacheRecord(options = {}) {
  const actionCache = actionCacheMetadataForRecord(options);
  const actionInputs = uniqueSorted(options.action?.inputs ?? []);
  const outputs = uniqueSorted(options.action?.outputs ?? []);
  const artifact = options.artifact;
  const identity = {
    language: options.language ?? options.actionPackage?.language ?? "",
    filePath: options.filePath ?? options.actionPackage?.filePath ?? "",
    packageLabel: options.actionPackage?.label ?? "",
    packageFilePath: options.actionPackage?.filePath ?? "",
    targetLabel: options.target?.label ?? options.action?.target ?? "",
    targetSource: options.target?.source ?? "",
    actionId: options.action?.id ?? "",
    actionKind: options.action?.kind ?? "",
    actionInputsHash: hashParts(actionInputs),
    outputsHash: hashParts(outputs),
    artifactId: artifact?.id ?? outputs[0] ?? "",
    artifactKind: artifact?.kind ?? "",
    artifactPath: artifact?.path ?? "",
    artifactCacheKey: artifact?.cacheKey ?? "",
    sourceHash: sourceHashForAction(options),
    projectModelHash: projectModelHashForAnalysis(options.analysis),
    feedbackScopeHash: feedbackScopeHashForAnalysis(options.analysis),
    compilerOptionsHash: actionCache.compilerOptionsHash ?? "",
    dependencyArtifactsHash: actionCache.dependencyArtifactsHash ?? "",
    toolchainInputsHash: actionCache.toolchainInputsHash ?? ""
  };
  const key = hashParts([
    "piece-action-cache-record",
    identity.language,
    identity.filePath,
    identity.packageLabel,
    identity.packageFilePath,
    identity.targetLabel,
    identity.targetSource,
    identity.actionId,
    identity.actionKind,
    identity.actionInputsHash,
    identity.outputsHash,
    identity.artifactId,
    identity.artifactKind,
    identity.artifactPath,
    identity.artifactCacheKey,
    identity.sourceHash,
    identity.projectModelHash,
    identity.feedbackScopeHash,
    identity.compilerOptionsHash,
    identity.dependencyArtifactsHash,
    identity.toolchainInputsHash
  ]);

  return {
    version: 1,
    fingerprintVersion: PIECE_FINGERPRINT_VERSION,
    kind: "piece-action-cache-record",
    key,
    action: {
      packageLabel: identity.packageLabel,
      targetLabel: identity.targetLabel,
      actionId: identity.actionId,
      kind: identity.actionKind
    },
    artifact: {
      id: identity.artifactId,
      kind: identity.artifactKind,
      path: identity.artifactPath,
      cacheKey: identity.artifactCacheKey
    },
    identity,
    inputs: actionInputs,
    outputs
  };
}

function unsafeActionCacheReasons(options = {}) {
  const analysis = options.analysis;
  const reasons = [];
  if (analysis?.feedbackScope?.fallbackRequired) {
    reasons.push(
      actionCacheReason("feedback-scope-fallback", "warning", "Feedback scope requires fallback, so cached compile artifacts cannot be reused safely.", {
        feedbackLevel: analysis.feedbackScope.level,
        fallbackReasonCodes: (analysis.feedbackScope.reasons ?? []).map((reason) => reason.code).filter(Boolean)
      })
    );
  }
  const projectScope = analysis?.manifest?.projectModel?.analysisScope;
  if (projectScope?.status === "fallback") {
    reasons.push(
      actionCacheReason("project-model-fallback", "warning", "Gradle/KMP project-model discovery fell back, so action cache reuse is unsafe.", {
        fallbackReason: projectScope.fallbackReason,
        sourceSet: projectScope.sourceSet
      })
    );
  }
  for (const [name, scope] of [
    ["package-scope", analysis?.packageScope],
    ["source-set-scope", analysis?.sourceSetScope]
  ]) {
    if (scope?.promotion?.requested === "safe" && scope.promotion.appliedToPackageView !== true && scope.status !== "selected") {
      reasons.push(
        actionCacheReason(`${name}-not-selected`, "warning", `${name} selection did not produce a safe package view, so action cache reuse is unsafe.`, {
          status: scope.status,
          reason: scope.promotion.reason
        })
      );
    }
  }
  return reasons;
}

export function explainPieceActionCacheStatus(options = {}) {
  const mode = options.mode ?? "status-only";
  const record = options.record;
  const base = {
    version: 1,
    mode,
    record,
    execution: {
      skipped: false,
      reason: "status-only"
    }
  };
  if (mode === "bypass" || options.records === false) {
    return {
      ...base,
      status: "bypass",
      reasons: [actionCacheReason("action-cache-bypass", "info", "Action cache lookup was bypassed.")]
    };
  }

  const unsafeReasons = unsafeActionCacheReasons(options);
  if (unsafeReasons.length > 0) {
    return {
      ...base,
      status: "unsafe",
      reasons: unsafeReasons
    };
  }
  if (!record) {
    return {
      ...base,
      status: "miss",
      reasons: [actionCacheReason("action-cache-record-missing", "warning", "No action-cache record could be created for this compile action.")]
    };
  }

  const missReasons = [];
  if (!record.artifact?.id) {
    missReasons.push(actionCacheReason("artifact-id-missing", "warning", "The selected compile action does not expose a stable artifact id."));
  }
  if (!record.artifact?.cacheKey) {
    missReasons.push(actionCacheReason("artifact-cache-key-missing", "warning", "The selected compile artifact does not expose a cacheKey."));
  }

  const localRecords = normalizeActionCacheRecords(options.records);
  if (localRecords.length === 0) {
    return {
      ...base,
      status: "miss",
      reasons: [
        ...missReasons,
        actionCacheReason("local-records-missing", "info", "No local action-cache records were provided for lookup.")
      ]
    };
  }
  const matchedRecord = localRecords.find(
    (candidate) => candidate.key === record.key && candidate.fingerprintVersion === PIECE_FINGERPRINT_VERSION
  );
  if (matchedRecord && missReasons.length === 0) {
    return {
      ...base,
      status: "hit",
      matchedRecordKey: matchedRecord.key,
      reasons: [actionCacheReason("local-record-match", "info", "A local action-cache record matched this compile action identity.")]
    };
  }
  return {
    ...base,
    status: "miss",
    reasons: [
      ...missReasons,
      actionCacheReason(
        localRecords.some((candidate) => candidate.key === record.key) ? "local-record-fingerprint-version-miss" : "local-record-not-found",
        "info",
        localRecords.some((candidate) => candidate.key === record.key)
          ? "A local action-cache record used an older fingerprint version and was invalidated."
          : "No local action-cache record matched this compile action identity."
      )
    ]
  };
}
