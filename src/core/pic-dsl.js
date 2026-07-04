import { sanitizeModulePart } from "./source-utils.js";

const DEFAULT_VISIBILITY = ["//visibility:private"];

function picString(value) {
  return JSON.stringify(String(value ?? ""));
}

function validatePicIdentifier(value, label) {
  if (!/^[A-Za-z_][A-Za-z0-9_.-]*$/.test(String(value ?? ""))) {
    throw new TypeError(`${label} must be a valid .pic identifier: ${value}`);
  }
}

function actionKindFromId(actionId) {
  const name = String(actionId ?? "").split("%").pop();
  switch (name) {
    case "compile":
      return "compile";
    case "preview":
      return "preview";
    case "test":
      return "test";
    case "typecheck":
      return "typecheck";
    case "documentation":
      return "documentation";
    default:
      return "feedback";
  }
}

function defaultArtifactId(label, kind) {
  switch (kind) {
    case "compile":
      return `${label}.compile.json`;
    case "preview":
      return `${label}.preview.json`;
    case "test":
      return `${label}.test.json`;
    case "typecheck":
      return `${label}.typecheck.json`;
    case "documentation":
      return `${label}.documentation.json`;
    default:
      return `${label}.piece.json`;
  }
}

function defaultPathForArtifactId(artifactId) {
  return String(artifactId ?? "").replace("//", "").replace(":", "__");
}

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

function defaultTargetLabel(piecePackage, target) {
  const sourceName = sanitizeModulePart(basename(piecePackage?.filePath));
  const pieceName = sanitizeModulePart(target?.name ?? target?.id ?? target?.label);
  return `//${bazelPackageName(piecePackage?.filePath)}:${sourceName}__${targetKindToken(target?.kind)}_${pieceName}`;
}

function defaultMnemonic(kind) {
  return `Piece${kind[0].toUpperCase()}${kind.slice(1)}`;
}

function defaultArtifactKind(kind) {
  return `piece-${kind}`;
}

function actionId(label, kind) {
  return `${label}%${kind}`;
}

function uniqueSorted(values = []) {
  return [...new Set(values)].sort();
}

function uniquePreserveOrder(values = []) {
  return [...new Set(values.filter((value) => value !== undefined && value !== null))];
}

function sameStringList(left = [], right = []) {
  if (left.length !== right.length) return false;
  return left.every((value, index) => value === right[index]);
}

function appendDeps(lines, name, values = []) {
  const unique = uniqueSorted(values);
  if (unique.length > 0) {
    lines.push(`    ${name} ${unique.map(picString).join(", ")}`);
  }
}

function appendActionInputs(lines, values = []) {
  const unique = uniqueSorted(values);
  if (unique.length > 0) {
    lines.push(`      inputs ${unique.map(picString).join(", ")}`);
  }
}

function appendLabel(lines, piecePackage, target) {
  if (target.label && target.label !== defaultTargetLabel(piecePackage, target)) {
    lines.push(`    label ${picString(target.label)}`);
  }
}

function appendVisibility(lines, visibility = []) {
  const unique = uniqueSorted(visibility);
  if (unique.length > 0 && !sameStringList(unique, DEFAULT_VISIBILITY)) {
    lines.push(`    visibility ${unique.map(picString).join(", ")}`);
  }
}

function targetKindToken(kind) {
  switch (kind) {
    case "type":
    case "class":
    case "function":
    case "value":
    case "effect":
    case "header":
      return kind;
    default:
      throw new TypeError(`Unsupported .pic target kind: ${kind}`);
  }
}

function actionKindToken(kind) {
  switch (kind) {
    case "feedback":
    case "compile":
    case "preview":
    case "test":
    case "typecheck":
    case "documentation":
      return kind;
    default:
      throw new TypeError(`Unsupported .pic action kind: ${kind}`);
  }
}

function unclassifiedDeps(target) {
  const classified = new Set([...(target.runtimeDeps ?? []), ...(target.typeDeps ?? [])]);
  return (target.deps ?? []).filter((dep) => !classified.has(dep));
}

function appendActions(lines, target, actionsById, artifactsById) {
  const actionIds = target.actions?.length > 0 ? target.actions : [`${target.label}%feedback`];
  for (const actionId of actionIds) {
    const action = actionsById.get(actionId);
    const kind = actionKindToken(action?.kind ?? actionKindFromId(actionId));
    const artifactId = defaultArtifactId(target.label, kind);
    const artifact = artifactsById.get(artifactId);
    const defaultPath = defaultPathForArtifactId(artifactId);
    const defaultInputs = new Set([target.source, ...(target.deps ?? []), ...(target.externalDeps ?? [])]);
    const mnemonic = action?.mnemonic && action.mnemonic !== defaultMnemonic(kind) ? action.mnemonic : undefined;
    const output = action?.outputs?.length === 1 && action.outputs[0] !== artifactId ? action.outputs[0] : undefined;
    const path = artifact?.path && artifact.path !== defaultPath && artifact.path !== output ? artifact.path : undefined;
    const inputs = (action?.inputs ?? []).filter((input) => !defaultInputs.has(input));

    if (!mnemonic && !output && !path && inputs.length === 0) {
      lines.push(`    action ${kind} {}`);
      continue;
    }

    lines.push(`    action ${kind} {`);
    if (mnemonic) {
      lines.push(`      mnemonic ${picString(mnemonic)}`);
    }
    if (output) {
      lines.push(`      output ${picString(output)}`);
    }
    if (path) {
      lines.push(`      path ${picString(path)}`);
    }
    appendActionInputs(lines, inputs);
    lines.push("    }");
  }
}

export function piecePackageToPicDsl(piecePackage) {
  validatePicIdentifier(piecePackage?.language, "language");
  const actionsById = new Map((piecePackage.actions ?? []).map((action) => [action.id, action]));
  const artifactsById = new Map((piecePackage.artifacts ?? []).map((artifact) => [artifact.id, artifact]));
  const lines = [
    `package ${picString(piecePackage.label)} {`,
    `  language ${piecePackage.language}`,
    `  source ${picString(piecePackage.filePath)}`
  ];

  for (const target of piecePackage.targets ?? []) {
    lines.push("");
    lines.push(`  target ${targetKindToken(target.kind)} ${picString(target.name ?? target.id ?? target.label)} {`);
    appendLabel(lines, piecePackage, target);
    appendVisibility(lines, target.visibility);
    appendDeps(lines, "deps", unclassifiedDeps(target));
    appendDeps(lines, "runtimeDeps", target.runtimeDeps);
    appendDeps(lines, "typeDeps", target.typeDeps);
    appendDeps(lines, "externalDeps", target.externalDeps);
    appendActions(lines, target, actionsById, artifactsById);
    lines.push("  }");
  }

  lines.push("}");
  return `${lines.join("\n")}\n`;
}

function createMergeDiagnostic(code, severity, message) {
  return { code, severity, message };
}

function targetIdentity(target) {
  return target?.id ?? `${target?.kind}:${target?.name}`;
}

function targetNameKey(target) {
  return `${targetKindToken(target?.kind)}:${target?.name ?? ""}`;
}

function isExplicitTargetLabel(piecePackage, target) {
  return Boolean(target?.label) && target.label !== defaultTargetLabel(piecePackage, target);
}

function isExplicitVisibility(target) {
  const visibility = uniqueSorted(target?.visibility ?? []);
  return visibility.length > 0 && !sameStringList(visibility, DEFAULT_VISIBILITY);
}

function remapLabelValue(value, labelRemaps) {
  if (typeof value !== "string" || labelRemaps.size === 0) {
    return value;
  }
  for (const [from, to] of labelRemaps) {
    if (value === from) return to;
    if (value.startsWith(`${from}%`) || value.startsWith(`${from}.`)) {
      return `${to}${value.slice(from.length)}`;
    }
  }
  return value;
}

function remapStringList(values = [], labelRemaps) {
  return values.map((value) => remapLabelValue(value, labelRemaps));
}

function remapAction(action, labelRemaps) {
  return {
    ...action,
    id: remapLabelValue(action.id, labelRemaps),
    target: remapLabelValue(action.target, labelRemaps),
    inputs: remapStringList(action.inputs ?? [], labelRemaps),
    outputs: remapStringList(action.outputs ?? [], labelRemaps)
  };
}

function remapArtifact(artifact, labelRemaps) {
  return {
    ...artifact,
    id: remapLabelValue(artifact.id, labelRemaps),
    target: remapLabelValue(artifact.target, labelRemaps)
  };
}

function remapTarget(target, labelRemaps) {
  return {
    ...target,
    label: remapLabelValue(target.label, labelRemaps),
    deps: remapStringList(target.deps ?? [], labelRemaps),
    runtimeDeps: remapStringList(target.runtimeDeps ?? [], labelRemaps),
    typeDeps: remapStringList(target.typeDeps ?? [], labelRemaps),
    actions: remapStringList(target.actions ?? [], labelRemaps),
    artifacts: remapStringList(target.artifacts ?? [], labelRemaps)
  };
}

function actionKindForId(id) {
  return actionKindToken(actionKindFromId(id));
}

function defaultActionForTarget(target, kind) {
  const output = defaultArtifactId(target.label, kind);
  return {
    id: actionId(target.label, kind),
    target: target.label,
    kind,
    mnemonic: defaultMnemonic(kind),
    inputs: [target.source, ...(target.deps ?? []), ...(target.externalDeps ?? [])],
    outputs: [output]
  };
}

function defaultArtifactForTarget(target, kind) {
  const id = defaultArtifactId(target.label, kind);
  return {
    id,
    target: target.label,
    kind: defaultArtifactKind(kind),
    path: defaultPathForArtifactId(id)
  };
}

function actionKindsForTarget(target) {
  return uniquePreserveOrder((target.actions ?? []).map(actionKindForId));
}

function patchTargetAction({ target, kind, patchTarget, patchActionsById, patchArtifactsById, actionsById, artifactsById }) {
  const id = actionId(target.label, kind);
  const artifactId = defaultArtifactId(target.label, kind);
  const patchActionId = actionId(patchTarget.label, kind);
  const patchArtifactId = defaultArtifactId(patchTarget.label, kind);
  const patchAction = patchActionsById.get(patchActionId);
  const patchArtifact = patchArtifactsById.get(patchArtifactId);
  const baseAction = actionsById.get(id) ?? defaultActionForTarget(target, kind);
  const baseArtifact = artifactsById.get(artifactId) ?? defaultArtifactForTarget(target, kind);
  const nextAction = { ...baseAction };
  const nextArtifact = { ...baseArtifact };

  if (patchAction) {
    if (patchAction.mnemonic && patchAction.mnemonic !== defaultMnemonic(kind)) {
      nextAction.mnemonic = patchAction.mnemonic;
    }
    const patchDefaultOutput = defaultArtifactId(patchTarget.label, kind);
    const patchOutput = patchAction.outputs?.length === 1 && patchAction.outputs[0] !== patchDefaultOutput ? patchAction.outputs[0] : undefined;
    if (patchOutput) {
      nextAction.outputs = [patchOutput];
    }

    const patchDefaultInputs = new Set([patchTarget.source, ...(patchTarget.deps ?? []), ...(patchTarget.externalDeps ?? [])]);
    const extraInputs = (patchAction.inputs ?? []).filter((input) => !patchDefaultInputs.has(input));
    nextAction.inputs = uniquePreserveOrder([...(nextAction.inputs ?? []), ...extraInputs]);

    if (patchArtifact) {
      const patchDefaultPath = defaultPathForArtifactId(patchArtifactId);
      if (patchOutput && patchArtifact.path === patchOutput) {
        nextArtifact.path = patchOutput;
      } else if (patchArtifact.path && patchArtifact.path !== patchDefaultPath) {
        nextArtifact.path = patchArtifact.path;
      }
    }
  }

  actionsById.set(id, nextAction);
  artifactsById.set(artifactId, nextArtifact);
}

function orderedPackageActions(targets, actionsById) {
  const ids = uniquePreserveOrder(targets.flatMap((target) => target.actions ?? []));
  return ids.map((id) => actionsById.get(id)).filter(Boolean);
}

function orderedPackageArtifacts(targets, artifactsById) {
  const ids = uniquePreserveOrder(targets.flatMap((target) => target.artifacts ?? []));
  return ids.map((id) => artifactsById.get(id)).filter(Boolean);
}

export function mergePiecePackages(generatedPackage, overridePackage) {
  if (!generatedPackage?.targets) {
    return {
      version: 1,
      merger: "piece-package-merge",
      piecePackage: null,
      diagnostics: [createMergeDiagnostic("pic-merge-missing-generated", "error", "Generated Piece package is required.")]
    };
  }

  const diagnostics = [];
  if (!overridePackage?.targets) {
    return {
      version: 1,
      merger: "piece-package-merge",
      piecePackage: generatedPackage,
      diagnostics
    };
  }

  if (generatedPackage.label !== overridePackage.label) {
    diagnostics.push(createMergeDiagnostic("pic-merge-package-label-mismatch", "warning", `Override package label ${overridePackage.label} does not match generated package ${generatedPackage.label}.`));
  }
  if (generatedPackage.language !== overridePackage.language) {
    diagnostics.push(createMergeDiagnostic("pic-merge-language-mismatch", "warning", `Override language ${overridePackage.language} does not match generated language ${generatedPackage.language}.`));
  }
  if (generatedPackage.filePath !== overridePackage.filePath) {
    diagnostics.push(createMergeDiagnostic("pic-merge-source-mismatch", "warning", `Override source ${overridePackage.filePath} does not match generated source ${generatedPackage.filePath}.`));
  }

  const generatedTargets = generatedPackage.targets ?? [];
  const overrideTargets = overridePackage.targets ?? [];
  const overrideById = new Map(overrideTargets.map((target) => [targetIdentity(target), target]));
  const overrideByName = new Map(overrideTargets.map((target) => [targetNameKey(target), target]));
  const usedOverrideIds = new Set();
  const labelRemaps = new Map();

  for (const target of generatedTargets) {
    const patchTarget = overrideById.get(targetIdentity(target)) ?? overrideByName.get(targetNameKey(target));
    if (patchTarget) {
      usedOverrideIds.add(targetIdentity(patchTarget));
      if (isExplicitTargetLabel(overridePackage, patchTarget) && patchTarget.label !== target.label) {
        labelRemaps.set(target.label, patchTarget.label);
      }
    }
  }

  const actionsById = new Map((generatedPackage.actions ?? []).map((action) => {
    const remapped = remapAction(action, labelRemaps);
    return [remapped.id, remapped];
  }));
  const artifactsById = new Map((generatedPackage.artifacts ?? []).map((artifact) => {
    const remapped = remapArtifact(artifact, labelRemaps);
    return [remapped.id, remapped];
  }));
  const patchActionsById = new Map((overridePackage.actions ?? []).map((action) => [action.id, action]));
  const patchArtifactsById = new Map((overridePackage.artifacts ?? []).map((artifact) => [artifact.id, artifact]));

  const mergedTargets = generatedTargets.map((baseTarget) => {
    const patchTarget = overrideById.get(targetIdentity(baseTarget)) ?? overrideByName.get(targetNameKey(baseTarget));
    const target = remapTarget(baseTarget, labelRemaps);
    if (!patchTarget) {
      return target;
    }

    if (isExplicitVisibility(patchTarget)) {
      target.visibility = uniqueSorted(patchTarget.visibility);
    }

    const nextActionKinds = uniquePreserveOrder([...actionKindsForTarget(target), ...actionKindsForTarget(patchTarget)]);
    target.actions = nextActionKinds.map((kind) => actionId(target.label, kind));
    target.artifacts = nextActionKinds.map((kind) => defaultArtifactId(target.label, kind));

    for (const kind of nextActionKinds) {
      patchTargetAction({
        target,
        kind,
        patchTarget,
        patchActionsById,
        patchArtifactsById,
        actionsById,
        artifactsById
      });
    }

    return target;
  });

  for (const target of overrideTargets) {
    if (!usedOverrideIds.has(targetIdentity(target))) {
      diagnostics.push(createMergeDiagnostic("pic-merge-unknown-target", "warning", `Override target ${target.kind}:${target.name} did not match a generated target and was ignored.`));
    }
  }

  return {
    version: 1,
    merger: "piece-package-merge",
    piecePackage: {
      ...generatedPackage,
      targets: mergedTargets,
      actions: orderedPackageActions(mergedTargets, actionsById),
      artifacts: orderedPackageArtifacts(mergedTargets, artifactsById)
    },
    diagnostics
  };
}
