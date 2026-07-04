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

function appendDeps(lines, name, values = []) {
  const unique = [...new Set(values)].sort();
  if (unique.length > 0) {
    lines.push(`    ${name} ${unique.map(picString).join(", ")}`);
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
    const defaultMnemonic = `Piece${kind[0].toUpperCase()}${kind.slice(1)}`;
    const defaultPath = defaultPathForArtifactId(artifactId);
    const mnemonic = action?.mnemonic && action.mnemonic !== defaultMnemonic ? action.mnemonic : undefined;
    const output = action?.outputs?.length === 1 && action.outputs[0] !== artifactId ? action.outputs[0] : undefined;
    const path = artifact?.path && artifact.path !== defaultPath && artifact.path !== output ? artifact.path : undefined;

    if (!mnemonic && !output && !path) {
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
