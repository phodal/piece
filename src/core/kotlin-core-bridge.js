function normalizeKotlinCoreModule(kotlinCoreModule) {
  const candidates = [
    kotlinCoreModule,
    kotlinCoreModule?.default,
    kotlinCoreModule?.piece?.bridge,
    kotlinCoreModule?.default?.piece?.bridge,
    kotlinCoreModule?.["cc.phodal.piece:piece-core"],
    kotlinCoreModule?.["cc.phodal.piece:piece-core"]?.piece?.bridge
  ];
  const bridge = candidates.find(
    (candidate) =>
      typeof candidate?.createPiecePackageJson === "function" &&
      typeof candidate?.createPieceGraphJson === "function"
  );
  if (!bridge) {
    throw new TypeError("Kotlin core module must export createPiecePackageJson() and createPieceGraphJson().");
  }
  return bridge;
}

function targetSpecLine(target) {
  if (!target?.kind || !target?.name) {
    throw new TypeError("Kotlin core bridge targets require kind and name.");
  }
  const deps = [...(target.deps ?? [])].join(",");
  const actionKind = target.actionKind ?? (target.action === "compile" ? "compile" : "feedback");
  const actionName = target.action ?? (actionKind === "compile" ? "compile" : "analysis");
  return [target.kind, target.name, deps, actionName, actionKind].join("\t");
}

function targetSpecsText(targets) {
  return [...targets].map(targetSpecLine).join("\n");
}

function parsePackageJson(value) {
  const parsed = JSON.parse(value);
  if (parsed?.kind !== "single-file-package") {
    throw new TypeError("Kotlin core did not return a single-file package.");
  }
  return parsed;
}

export function createKotlinCoreBridge(kotlinCoreModule) {
  const bridge = normalizeKotlinCoreModule(kotlinCoreModule);
  return {
    createPackageFromTargets({ filePath, language = "kotlin", targets }) {
      return parsePackageJson(bridge.createPiecePackageJson(filePath, language, targetSpecsText(targets)));
    },
    createGraphFromTargets({ filePath, language = "kotlin", targets }) {
      return JSON.parse(bridge.createPieceGraphJson(filePath, language, targetSpecsText(targets)));
    },
    sampleKotlinPackage(options = {}) {
      return parsePackageJson(bridge.sampleKotlinPackageJson(options.filePath ?? "/repo/src/Pricing.kt"));
    }
  };
}
