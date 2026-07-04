import { spawn } from "node:child_process";
import { constants } from "node:fs";
import { access, mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import { performance } from "node:perf_hooks";
import { fileURLToPath } from "node:url";
import { hashParts } from "./core/hash.js";
import { mergePiecePackages, piecePackageToPicDsl } from "./core/pic-dsl.js";

const PACKAGE_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

function durationSince(startedAt) {
  return Math.round((performance.now() - startedAt) * 100) / 100;
}

function sanitizeProjectName(value) {
  return String(value ?? "piece")
    .replace(/[^A-Za-z0-9_-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48) || "piece";
}

function sourceBasename(filePath, fallback) {
  const name = basename(String(filePath ?? ""));
  return name && name.includes(".") ? name : fallback;
}

function packageNameFromGo(source) {
  return source.match(/^\s*package\s+([A-Za-z_][A-Za-z0-9_]*)/m)?.[1] ?? "main";
}

function parseConcatenatedJsonObjects(source) {
  const decoder = new TextDecoder();
  const bytes = new TextEncoder().encode(String(source ?? ""));
  const values = [];
  let offset = 0;

  while (offset < bytes.length) {
    while (offset < bytes.length && /\s/.test(decoder.decode(bytes.slice(offset, offset + 1)))) {
      offset += 1;
    }
    if (offset >= bytes.length) break;

    let depth = 0;
    let inString = false;
    let escaped = false;
    let end = offset;
    for (; end < bytes.length; end += 1) {
      const char = decoder.decode(bytes.slice(end, end + 1));
      if (inString) {
        if (escaped) {
          escaped = false;
        } else if (char === "\\") {
          escaped = true;
        } else if (char === "\"") {
          inString = false;
        }
        continue;
      }
      if (char === "\"") {
        inString = true;
        continue;
      }
      if (char === "{") depth += 1;
      if (char === "}") {
        depth -= 1;
        if (depth === 0) {
          end += 1;
          break;
        }
      }
    }
    values.push(JSON.parse(decoder.decode(bytes.slice(offset, end))));
    offset = end;
  }

  return values;
}

function normalizeGoListPackage(pkg, workspace) {
  return {
    importPath: pkg.ImportPath ?? "",
    name: pkg.Name ?? "",
    dir: pkg.Dir ? relative(workspace, pkg.Dir) || "." : "",
    module: pkg.Module
      ? {
          path: pkg.Module.Path ?? "",
          version: pkg.Module.Version ?? "",
          main: Boolean(pkg.Module.Main)
        }
      : undefined,
    goFiles: [...(pkg.GoFiles ?? [])].sort(),
    imports: [...(pkg.Imports ?? [])].sort(),
    deps: [...(pkg.Deps ?? [])].sort(),
    testGoFiles: [...(pkg.TestGoFiles ?? [])].sort(),
    testImports: [...(pkg.TestImports ?? [])].sort()
  };
}

function goListHash(packages) {
  if (packages.length === 0) return "";
  return hashParts(
    packages.flatMap((pkg) => [
      pkg.importPath,
      pkg.name,
      pkg.module?.path,
      pkg.module?.version,
      pkg.module?.main ? "main" : "",
      ...pkg.goFiles,
      ...pkg.imports,
      ...pkg.deps,
      ...pkg.testGoFiles,
      ...pkg.testImports
    ])
  );
}

function createGoListReport(commandResult, workspace) {
  if (commandResult.exitCode !== 0) {
    return {
      version: 1,
      status: "error",
      packageHash: "",
      packages: []
    };
  }
  const packages = parseConcatenatedJsonObjects(commandResult.stdout).map((pkg) => normalizeGoListPackage(pkg, workspace));
  return {
    version: 1,
    status: "success",
    packageHash: goListHash(packages),
    packages
  };
}

function isKotlinSourcePath(path) {
  return /\.(?:kt|kts)$/i.test(String(path ?? ""));
}

function resolveHostPath(path, cwd) {
  return isAbsolute(path) ? path : resolve(cwd, path);
}

function sameSourceIdentity(left, right, cwd) {
  if (!left || !right) return false;
  if (left === right) return true;
  return resolveHostPath(String(left), cwd) === resolveHostPath(String(right), cwd);
}

function uniqueResolvedPaths(entries, cwd) {
  return [
    ...new Set(
      entries
        .filter(Boolean)
        .map((entry) => resolveHostPath(String(entry), cwd))
    )
  ];
}

async function runCommand(command, args, options = {}) {
  const startedAt = performance.now();
  return new Promise((resolveResult) => {
    let stdout = "";
    let stderr = "";
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: { ...process.env, ...options.env },
      shell: false
    });

    child.stdout?.on("data", (chunk) => {
      stdout += chunk.toString();
    });
    child.stderr?.on("data", (chunk) => {
      stderr += chunk.toString();
    });
    child.on("error", (error) => {
      resolveResult({
        command,
        args,
        cwd: options.cwd,
        exitCode: null,
        signal: null,
        stdout,
        stderr: stderr || error.message,
        errorCode: error.code,
        durationMs: durationSince(startedAt)
      });
    });
    child.on("close", (exitCode, signal) => {
      resolveResult({
        command,
        args,
        cwd: options.cwd,
        exitCode,
        signal,
        stdout,
        stderr,
        durationMs: durationSince(startedAt)
      });
    });
  });
}

async function prepareWorkspace(prefix, workspace) {
  if (workspace) {
    const resolved = resolve(workspace);
    await mkdir(resolved, { recursive: true });
    return { path: resolved, temporary: false };
  }
  return { path: await mkdtemp(join(tmpdir(), prefix)), temporary: true };
}

async function pathExists(path) {
  try {
    await access(path, constants.F_OK);
    return true;
  } catch {
    return false;
  }
}

async function collectFiles(root) {
  if (!(await pathExists(root))) return [];
  const files = [];
  async function visit(directory) {
    const entries = await readdir(directory, { withFileTypes: true });
    for (const entry of entries) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) {
        await visit(path);
      } else if (entry.isFile()) {
        const info = await stat(path);
        files.push({ path, sizeBytes: info.size });
      }
    }
  }
  await visit(root);
  return files.sort((left, right) => left.path.localeCompare(right.path));
}

async function collectKotlinCompanionSources(options, primaryFilePath) {
  const cwd = resolve(options.cwd ?? process.cwd());
  const companions = [];
  const seen = new Set();

  function addCompanion(filePath, source) {
    if (!filePath || !isKotlinSourcePath(filePath) || sameSourceIdentity(filePath, primaryFilePath, cwd)) {
      return;
    }
    const key = resolveHostPath(String(filePath), cwd);
    if (seen.has(key)) return;
    seen.add(key);
    companions.push({ filePath: String(filePath), source: source ?? "" });
  }

  for (const sourceFile of Array.isArray(options.sourceFiles) ? options.sourceFiles : []) {
    if (typeof sourceFile === "string") {
      const actualPath = resolveHostPath(sourceFile, cwd);
      if (isKotlinSourcePath(sourceFile) && !sameSourceIdentity(sourceFile, primaryFilePath, cwd)) {
        addCompanion(sourceFile, await readFile(actualPath, "utf8"));
      }
      continue;
    }
    addCompanion(sourceFile?.filePath, sourceFile?.source);
  }

  for (const sourceRoot of Array.isArray(options.sourceRoots) ? options.sourceRoots : []) {
    const sourceRootPath = String(sourceRoot);
    const root = resolveHostPath(sourceRootPath, cwd);
    const files = await collectFiles(root);
    for (const file of files) {
      const filePath = isAbsolute(sourceRootPath) ? file.path : relative(cwd, file.path);
      if (isKotlinSourcePath(filePath) && !sameSourceIdentity(filePath, primaryFilePath, cwd)) {
        addCompanion(filePath, await readFile(file.path, "utf8"));
      }
    }
  }

  return companions;
}

function collectKotlinClasspath(options) {
  const cwd = resolve(options.cwd ?? process.cwd());
  return uniqueResolvedPaths(Array.isArray(options.classpath) ? options.classpath : [], cwd);
}

async function resolveProjectGradleCommand(command, projectRoot) {
  if (!command) {
    const projectWrapper = projectRoot ? join(projectRoot, "gradlew") : undefined;
    if (projectWrapper && (await pathExists(projectWrapper))) return projectWrapper;
    return defaultGradleCommand();
  }
  if (!command.includes("/") && !command.includes("\\")) return command;
  return isAbsolute(command) ? command : resolve(projectRoot ?? PACKAGE_ROOT, command);
}

function diagnosticsFromCommands(commands) {
  return commands
    .filter((command) => command.exitCode !== 0)
    .map((command) => ({
      code: command.errorCode === "ENOENT" ? "tool-not-found" : "compiler-error",
      severity: "error",
      message: command.stderr.trim() || command.stdout.trim() || `${command.command} exited with code ${command.exitCode}`,
      command: [command.command, ...command.args].join(" ")
    }));
}

function compileStatus(commands) {
  return commands.every((command) => command.exitCode === 0) ? "success" : "error";
}

async function cleanupWorkspace(workspace, keepWorkspace) {
  if (!keepWorkspace) {
    await rm(workspace, { recursive: true, force: true });
  }
}

function defaultGradleCommand() {
  return join(PACKAGE_ROOT, "gradlew");
}

function resolveGradleCommand(command) {
  if (!command) return defaultGradleCommand();
  if (!command.includes("/") && !command.includes("\\")) return command;
  return isAbsolute(command) ? command : resolve(PACKAGE_ROOT, command);
}

async function readJsonFile(path) {
  return JSON.parse(await readFile(path, "utf8"));
}

function inferKotlinSourceSetFromProjectFile(projectRoot, filePath, cwd) {
  if (!projectRoot || !filePath) return undefined;
  const sourcePath = resolveHostPath(String(filePath), cwd);
  const root = resolveHostPath(String(projectRoot), cwd);
  if (!isPathInside(root, sourcePath)) return undefined;
  const relativePath = relative(root, sourcePath);
  const parts = relativePath.split(/[\\/]+/);
  const sourceIndex = parts.indexOf("src");
  if (sourceIndex < 0 || parts[sourceIndex + 2] !== "kotlin") return undefined;
  return parts[sourceIndex + 1];
}

async function collectKotlinGradleProjectModel(options = {}) {
  const projectRootOption = options.gradleProjectRoot ?? options.projectRoot;
  if (!projectRootOption) return null;

  const cwd = resolve(options.cwd ?? process.cwd());
  const projectRoot = resolveHostPath(String(projectRootOption), cwd);
  const sourceSet = options.sourceSet ?? inferKotlinSourceSetFromProjectFile(projectRoot, options.filePath, cwd);
  const hostWorkspaceInfo = await prepareWorkspace("piece-kotlin-gradle-model-host-");
  const hostWorkspace = hostWorkspaceInfo.path;
  const outputReport = join(hostWorkspace, "gradle-project-model.json");

  try {
    const gradleCommand = await resolveProjectGradleCommand(options.gradleCommand, projectRoot);
    const args = [
      "-p",
      join(PACKAGE_ROOT, "piece-core"),
      "runKotlinGradleProjectModelBackend",
      "--quiet",
      `-PpieceGradleProjectModel.projectRoot=${projectRoot}`,
      `-PpieceGradleProjectModel.outputReport=${outputReport}`,
      `-PpieceGradleProjectModel.gradleCommand=${gradleCommand}`,
      `-PpieceGradleProjectModel.gradleVersion=${options.gradleVersion ?? ""}`,
      `-PpieceGradleProjectModel.sourceSet=${sourceSet ?? ""}`
    ];
    const backendCommand = await runCommand(defaultGradleCommand(), args, { cwd: PACKAGE_ROOT, env: options.env });
    if (await pathExists(outputReport)) {
      return readJsonFile(outputReport);
    }
    return withKotlinProjectModelHashes({
      version: 1,
      projectRoot,
      status: "fallback",
      sourceSets: [],
      classpaths: [],
      dependencies: [],
      projectDependencies: [],
      targetVariants: [],
      sourceRoots: [],
      classpath: [],
      commands: [backendCommand],
      diagnostics: [
        {
          code: backendCommand.errorCode === "ENOENT" ? "tool-not-found" : "kotlin-gradle-project-model-error",
          severity: "warning",
          message:
            backendCommand.stderr.trim() ||
            backendCommand.stdout.trim() ||
            `${backendCommand.command} exited with code ${backendCommand.exitCode}`,
          command: [backendCommand.command, ...backendCommand.args].join(" ")
        }
      ]
    });
  } finally {
    await cleanupWorkspace(hostWorkspace, false);
  }
}

function kotlinProjectModelHashes(projectModel) {
  const sourceRoots = [...new Set(projectModel?.sourceRoots ?? [])].sort();
  const classpath = [...new Set(projectModel?.classpath ?? [])].sort();
  const sourceSets = [...(projectModel?.sourceSets ?? [])]
    .map((sourceSet) => ({
      projectPath: sourceSet.projectPath ?? "",
      projectDir: sourceSet.projectDir ?? "",
      name: sourceSet.name ?? "",
      sourceRoots: [...(sourceSet.sourceRoots ?? [])].sort(),
      targetNames: [...(sourceSet.targetNames ?? [])].sort()
    }))
    .sort((left, right) => `${left.projectPath}:${left.name}`.localeCompare(`${right.projectPath}:${right.name}`));
  const classpaths = [...(projectModel?.classpaths ?? [])]
    .map((classpathEntry) => ({
      projectPath: classpathEntry.projectPath ?? "",
      name: classpathEntry.name ?? "",
      files: [...(classpathEntry.files ?? [])].sort()
    }))
    .sort((left, right) => `${left.projectPath}:${left.name}`.localeCompare(`${right.projectPath}:${right.name}`));
  const dependencies = [...(projectModel?.dependencies ?? [])]
    .map((dependency) => ({
      projectPath: dependency.projectPath ?? "",
      configuration: dependency.configuration ?? "",
      coordinates: dependency.coordinates ?? ""
    }))
    .sort((left, right) => `${left.projectPath}:${left.configuration}:${left.coordinates}`.localeCompare(`${right.projectPath}:${right.configuration}:${right.coordinates}`));
  const projectDependencies = [...(projectModel?.projectDependencies ?? [])]
    .map((dependency) => ({
      projectPath: dependency.projectPath ?? "",
      configuration: dependency.configuration ?? "",
      dependencyProjectPath: dependency.dependencyProjectPath ?? "",
      dependencyProjectDir: dependency.dependencyProjectDir ?? ""
    }))
    .sort((left, right) =>
      `${left.projectPath}:${left.configuration}:${left.dependencyProjectPath}`.localeCompare(
        `${right.projectPath}:${right.configuration}:${right.dependencyProjectPath}`
      )
    );
  const targetVariants = [...(projectModel?.targetVariants ?? [])]
    .map((variant) => ({
      projectPath: variant.projectPath ?? "",
      sourceSet: variant.sourceSet ?? "",
      targetName: variant.targetName ?? "",
      compilationName: variant.compilationName ?? "",
      compileTask: variant.compileTask ?? "",
      classpathConfiguration: variant.classpathConfiguration ?? ""
    }))
    .sort((left, right) => `${left.projectPath}:${left.sourceSet}:${left.targetName}`.localeCompare(`${right.projectPath}:${right.sourceSet}:${right.targetName}`));
  const sourceRootsHash = hashParts(sourceRoots);
  const classpathHash = hashParts(classpath);
  const modelHash = hashParts([
    "v1",
    projectModel?.projectRoot ?? "",
    projectModel?.status ?? "",
    sourceRootsHash,
    classpathHash,
    ...sourceSets.flatMap((sourceSet) => [
      "sourceSet",
      sourceSet.projectPath,
      sourceSet.projectDir,
      sourceSet.name,
      sourceSet.sourceRoots.join("\u001e"),
      sourceSet.targetNames.join("\u001e")
    ]),
    ...classpaths.flatMap((classpathEntry) => [
      "classpath",
      classpathEntry.projectPath,
      classpathEntry.name,
      classpathEntry.files.join("\u001e")
    ]),
    ...dependencies.flatMap((dependency) => [
      "dependency",
      dependency.projectPath,
      dependency.configuration,
      dependency.coordinates
    ]),
    ...projectDependencies.flatMap((dependency) => [
      "projectDependency",
      dependency.projectPath,
      dependency.configuration,
      dependency.dependencyProjectPath,
      dependency.dependencyProjectDir
    ]),
    ...targetVariants.flatMap((variant) => [
      "targetVariant",
      variant.projectPath,
      variant.sourceSet,
      variant.targetName,
      variant.compilationName,
      variant.compileTask,
      variant.classpathConfiguration
    ])
  ]);
  return {
    sourceRootsHash,
    classpathHash,
    modelHash
  };
}

function withKotlinProjectModelHashes(projectModel) {
  if (!projectModel) return projectModel;
  return {
    ...projectModel,
    hashes: projectModel.hashes ?? kotlinProjectModelHashes(projectModel)
  };
}

function isPathInside(root, child) {
  const relativePath = relative(root, child);
  return relativePath === "" || (!relativePath.startsWith("..") && !isAbsolute(relativePath));
}

function sourceSetForKotlinProjectFile(projectModel, filePath, cwd) {
  if (!filePath) return undefined;
  const sourcePath = resolveHostPath(filePath, cwd);
  let bestMatch;
  for (const sourceSet of projectModel?.sourceSets ?? []) {
    for (const sourceRoot of sourceSet.sourceRoots ?? []) {
      const root = resolveHostPath(sourceRoot, cwd);
      if (!isPathInside(root, sourcePath)) continue;
      const score = root.length;
      if (!bestMatch || score > bestMatch.score) {
        bestMatch = { sourceSet, score };
      }
    }
  }
  return bestMatch?.sourceSet;
}

function requiredKotlinSourceSetNames(sourceSetName) {
  if (!sourceSetName) return [];
  const names = new Set([sourceSetName]);
  if (sourceSetName !== "commonMain" && sourceSetName.endsWith("Main")) {
    names.add("commonMain");
  }
  if (sourceSetName.endsWith("Test")) {
    names.add("commonMain");
    names.add("commonTest");
    names.add(sourceSetName.replace(/Test$/, "Main"));
  }
  return [...names].sort();
}

function kotlinTargetPrefix(sourceSetName) {
  if (!sourceSetName || sourceSetName.startsWith("common")) return undefined;
  return sourceSetName.replace(/(?:Main|Test)$/, "");
}

function classpathMatchesKotlinSourceSet(classpathEntry, sourceSetName) {
  const prefix = kotlinTargetPrefix(sourceSetName);
  if (!prefix) return false;
  const lowerName = String(classpathEntry?.name ?? "").toLowerCase();
  const lowerPrefix = prefix.toLowerCase();
  if (!lowerName.includes(lowerPrefix) || !lowerName.includes("compileclasspath")) {
    return false;
  }
  return sourceSetName.endsWith("Test") || !lowerName.includes("test");
}

function projectDependencyMatchesKotlinSourceSet(projectDependency, sourceSetName) {
  return classpathMatchesKotlinSourceSet({ name: projectDependency?.configuration }, sourceSetName);
}

function reachableKotlinProjectPaths(projectModel, selectedProjectPath, sourceSetName) {
  if (!selectedProjectPath) return [];
  const reachable = new Set([selectedProjectPath]);
  let changed = true;
  while (changed) {
    changed = false;
    for (const dependency of projectModel?.projectDependencies ?? []) {
      if (!reachable.has(dependency.projectPath)) continue;
      if (!projectDependencyMatchesKotlinSourceSet(dependency, sourceSetName)) continue;
      if (!dependency.dependencyProjectPath || reachable.has(dependency.dependencyProjectPath)) continue;
      reachable.add(dependency.dependencyProjectPath);
      changed = true;
    }
  }
  return [...reachable].sort();
}

function kotlinProjectModelScopeDiagnostic(code, message, details = {}) {
  return {
    code,
    severity: "warning",
    message,
    ...details
  };
}

function kotlinProjectModelScopeHashes(scope) {
  const sourceRoots = [...new Set(scope.sourceRoots ?? [])].sort();
  const classpath = [...new Set(scope.classpath ?? [])].sort();
  const projectPaths = [...new Set(scope.projectPaths ?? [])].sort();
  const sourceRootsHash = hashParts(sourceRoots);
  const classpathHash = hashParts(classpath);
  const scopeHash = hashParts([
    "v1",
    scope.projectPath ?? "",
    scope.sourceSet ?? "",
    ...projectPaths,
    ...(scope.requiredSourceSets ?? []),
    sourceRootsHash,
    classpathHash,
    ...(scope.classpathConfigurations ?? []),
    ...(scope.dependencyCoordinates ?? []),
    ...(scope.projectDependencies ?? []).flatMap((dependency) => [
      dependency.projectPath,
      dependency.configuration,
      dependency.dependencyProjectPath,
      dependency.dependencyProjectDir
    ]),
    ...(scope.targetVariants ?? []).flatMap((variant) => [
      variant.projectPath,
      variant.sourceSet,
      variant.targetName,
      variant.compilationName,
      variant.compileTask,
      variant.classpathConfiguration
    ])
  ]);
  return {
    sourceRootsHash,
    classpathHash,
    scopeHash
  };
}

function focusKotlinProjectModel(projectModel, options = {}) {
  if (!projectModel) return projectModel;
  const cwd = resolve(options.cwd ?? process.cwd());
  const modelWithHashes = withKotlinProjectModelHashes(projectModel);
  const selectedSourceSet = sourceSetForKotlinProjectFile(modelWithHashes, options.filePath, cwd);
  const requiredSourceSets = requiredKotlinSourceSetNames(selectedSourceSet?.name);
  const requiredNames = new Set(requiredSourceSets);
  const projectPaths = reachableKotlinProjectPaths(modelWithHashes, selectedSourceSet?.projectPath, selectedSourceSet?.name);
  const projectPathSet = new Set(projectPaths);
  const selectedSourceRoots =
    selectedSourceSet?.name
      ? [
          ...new Set(
            (modelWithHashes.sourceSets ?? [])
              .filter((sourceSet) => projectPathSet.has(sourceSet.projectPath) && requiredNames.has(sourceSet.name))
              .flatMap((sourceSet) => sourceSet.sourceRoots ?? [])
          )
        ].sort()
      : [];
  const matchingClasspaths =
    selectedSourceSet?.name
      ? (modelWithHashes.classpaths ?? []).filter(
          (classpathEntry) => projectPathSet.has(classpathEntry.projectPath) && classpathMatchesKotlinSourceSet(classpathEntry, selectedSourceSet.name)
        )
      : [];
  const matchingClasspathNames = new Set(matchingClasspaths.map((entry) => `${entry.projectPath}:${entry.name}`));
  const matchingDependencies = (modelWithHashes.dependencies ?? []).filter((dependency) =>
    matchingClasspathNames.has(`${dependency.projectPath}:${dependency.configuration}`)
  );
  const matchingProjectDependencies = (modelWithHashes.projectDependencies ?? []).filter(
    (dependency) =>
      projectPathSet.has(dependency.projectPath) &&
      projectPathSet.has(dependency.dependencyProjectPath) &&
      projectDependencyMatchesKotlinSourceSet(dependency, selectedSourceSet?.name)
  );
  const matchingTargetVariants = selectedSourceSet?.name
    ? (modelWithHashes.targetVariants ?? []).filter((variant) => projectPathSet.has(variant.projectPath) && variant.sourceSet === selectedSourceSet.name)
    : [];
  const selectedClasspath = matchingClasspaths.length > 0 ? [...new Set(matchingClasspaths.flatMap((entry) => entry.files ?? []))].sort() : [];
  const diagnostics = [];
  if (modelWithHashes.status !== "success") {
    diagnostics.push(
      kotlinProjectModelScopeDiagnostic(
        "kotlin-project-model-discovery-fallback",
        "Gradle project model discovery did not return a successful model; Piece cannot prove a source-set-scoped Kotlin analysis boundary.",
        { projectRoot: modelWithHashes.projectRoot }
      )
    );
  }
  if (!selectedSourceSet) {
    diagnostics.push(
      kotlinProjectModelScopeDiagnostic(
        "kotlin-project-model-source-set-unmatched",
        "Gradle project model discovery did not map the edited Kotlin file to a discovered source set; Piece is falling back to file-level Kotlin analysis unless manual sourceRoots or classpath overrides are provided.",
        {
          filePath: options.filePath,
          projectRoot: modelWithHashes.projectRoot
        }
      )
    );
  } else {
    if (selectedSourceRoots.length === 0) {
      diagnostics.push(
        kotlinProjectModelScopeDiagnostic(
          "kotlin-project-model-source-roots-empty",
          "The selected Gradle source set did not expose Kotlin source roots; Piece cannot prove the source-set input boundary.",
          {
            projectPath: selectedSourceSet.projectPath,
            sourceSet: selectedSourceSet.name
          }
        )
      );
    }
    if (!selectedSourceSet.name.startsWith("common") && matchingClasspaths.length === 0) {
      diagnostics.push(
        kotlinProjectModelScopeDiagnostic(
          "kotlin-project-model-classpath-unmatched",
          "Gradle project model discovery did not expose a matching compile classpath for the selected Kotlin source set; Piece is falling back instead of reusing the full project classpath.",
          {
            projectPath: selectedSourceSet.projectPath,
            sourceSet: selectedSourceSet.name
          }
        )
      );
    }
  }
  const fallbackReason = diagnostics[0]?.message;
  const scope = {
    status: diagnostics.length === 0 ? "selected" : "fallback",
    ...(fallbackReason ? { fallbackReason } : {}),
    projectPath: selectedSourceSet?.projectPath,
    projectPaths,
    sourceSet: selectedSourceSet?.name,
    requiredSourceSets,
    sourceRoots: selectedSourceRoots,
    classpath: selectedClasspath,
    classpathConfigurations: matchingClasspaths.map((entry) => `${entry.projectPath}:${entry.name}`).sort(),
    dependencyCoordinates: [...new Set(matchingDependencies.map((dependency) => dependency.coordinates).filter(Boolean))].sort(),
    projectDependencies: matchingProjectDependencies,
    targetVariants: matchingTargetVariants,
    diagnostics
  };
  return {
    ...modelWithHashes,
    diagnostics: [...(modelWithHashes.diagnostics ?? []), ...diagnostics],
    analysisScope: {
      ...scope,
      hashes: kotlinProjectModelScopeHashes(scope)
    }
  };
}

function mergeKotlinProjectModelOptions(options, projectModel) {
  if (!projectModel) return options;

  const cwd = resolve(options.cwd ?? process.cwd());
  const modelSourceRoots = projectModel.analysisScope?.sourceRoots ?? projectModel.sourceRoots ?? [];
  const modelClasspath = projectModel.analysisScope?.classpath ?? projectModel.classpath ?? [];
  return {
    ...options,
    sourceRoots: uniqueResolvedPaths([...modelSourceRoots, ...(Array.isArray(options.sourceRoots) ? options.sourceRoots : [])], cwd),
    classpath: uniqueResolvedPaths([...modelClasspath, ...(Array.isArray(options.classpath) ? options.classpath : [])], cwd)
  };
}

function attachKotlinProjectModel(manifest, projectModel) {
  if (!projectModel) return manifest;
  const modelWithHashes = withKotlinProjectModelHashes(projectModel);
  return {
    ...manifest,
    projectModel: {
      kind: "gradle-kmp",
      projectRoot: modelWithHashes.projectRoot,
      status: modelWithHashes.status,
      sourceRoots: modelWithHashes.sourceRoots ?? [],
      classpath: modelWithHashes.classpath ?? [],
      sourceSets: modelWithHashes.sourceSets ?? [],
      classpaths: modelWithHashes.classpaths ?? [],
      dependencies: modelWithHashes.dependencies ?? [],
      projectDependencies: modelWithHashes.projectDependencies ?? [],
      targetVariants: modelWithHashes.targetVariants ?? [],
      hashes: modelWithHashes.hashes,
      analysisScope: modelWithHashes.analysisScope
    },
    diagnostics: [...(manifest.diagnostics ?? []), ...(modelWithHashes.diagnostics ?? [])]
  };
}

function normalizeKotlinAnalysisBackend(value) {
  if (value === undefined || value === null || value === "") return undefined;
  if (value === "psi" || value === "fe10-binding-context" || value === "analysis-api") {
    return value;
  }
  throw new TypeError(`Unsupported Kotlin analysis backend: ${value}`);
}

function kotlinAnalysisBackendMetadata({ backend, semanticDiagnostics = false, semanticSymbols = false, analysisApiEnabled = false, analysisApiVersion } = {}) {
  const requested = backend ?? (semanticSymbols ? "fe10-binding-context" : "psi");
  const actual = requested === "analysis-api" ? "fe10-binding-context" : requested;
  const fallbackReason =
    requested === "analysis-api"
      ? analysisApiEnabled
        ? "Kotlin Analysis API runtime is gated on, but the isolated Analysis API runner did not return a usable report; using explicit FE10 BindingContext fallback."
        : "Kotlin Analysis API Gradle gate is disabled; enable -PpieceAnalysisApi.enabled=true before using the analysis-api backend."
      : undefined;
  return {
    requested,
    actual,
    declarations: "psi",
    symbols: actual === "fe10-binding-context" ? "fe10-binding-context" : "psi",
    diagnostics: semanticDiagnostics ? "kotlin-compiler-diagnostics" : "none",
    status: fallbackReason ? "fallback" : "ready",
    ...(fallbackReason ? { fallbackReason } : {}),
    ...(requested === "analysis-api" ? { analysisApiEnabled } : {}),
    ...(requested === "analysis-api" && analysisApiVersion ? { analysisApiVersion } : {})
  };
}

function errorKotlinPsiManifest({ filePath, source, parserName, backend, semanticDiagnostics, semanticSymbols, analysisApiEnabled, analysisApiVersion, commands }) {
  return {
    version: 1,
    filePath,
    source,
    parser: parserName,
    slices: [],
    headers: [],
    effects: [],
    importBindings: [],
    hasTopLevelEffect: false,
    analysisBackend: kotlinAnalysisBackendMetadata({ backend, semanticDiagnostics, semanticSymbols, analysisApiEnabled, analysisApiVersion }),
    diagnostics: diagnosticsFromCommands(commands)
  };
}

function errorPicDslReport({ filePath, source, commands }) {
  return {
    version: 1,
    parser: "antlr-pic-parser",
    filePath,
    source,
    piecePackage: null,
    diagnostics: diagnosticsFromCommands(commands)
  };
}

function errorKotlinPicGenerationReport({ filePath, source, commands }) {
  return {
    version: 1,
    generator: "kotlin-psi-pic-generator",
    filePath,
    source,
    pic: "",
    piecePackage: null,
    diagnostics: diagnosticsFromCommands(commands)
  };
}

function hasErrorDiagnostics(diagnostics = []) {
  return diagnostics.some((diagnostic) => diagnostic.severity === "error");
}

export async function parsePieceDslFile(options = {}) {
  const filePath = options.filePath ?? "package.pic";
  const source = options.source ?? await readFile(resolveHostPath(filePath, options.cwd ?? process.cwd()), "utf8");
  const hostWorkspaceInfo = await prepareWorkspace("piece-pic-dsl-host-");
  const hostWorkspace = hostWorkspaceInfo.path;
  const sourceFile = join(hostWorkspace, sourceBasename(filePath, "package.pic"));
  const outputReport = join(hostWorkspace, "pic-report.json");

  try {
    await writeFile(sourceFile, source, "utf8");
    const args = [
      "-p",
      join(PACKAGE_ROOT, "piece-core"),
      "runPicParserBackend",
      "--quiet",
      `-PpieceDsl.filePath=${filePath}`,
      `-PpieceDsl.sourceFile=${sourceFile}`,
      `-PpieceDsl.outputReport=${outputReport}`
    ];

    const backendCommand = await runCommand(defaultGradleCommand(), args, { cwd: PACKAGE_ROOT, env: options.env });
    if (await pathExists(outputReport)) {
      return readJsonFile(outputReport);
    }
    return errorPicDslReport({ filePath, source, commands: [backendCommand] });
  } finally {
    await cleanupWorkspace(hostWorkspace, false);
  }
}

export async function mergePieceDslFiles(options = {}) {
  const generatedFilePath = options.generatedFilePath ?? "generated.pic";
  const overrideFilePath = options.overrideFilePath ?? "override.pic";
  const generated = await parsePieceDslFile({
    filePath: generatedFilePath,
    source: options.generatedSource,
    cwd: options.cwd,
    env: options.env
  });
  const override = await parsePieceDslFile({
    filePath: overrideFilePath,
    source: options.overrideSource,
    cwd: options.cwd,
    env: options.env
  });
  const parseDiagnostics = [...(generated.diagnostics ?? []), ...(override.diagnostics ?? [])];

  if (hasErrorDiagnostics(parseDiagnostics) || !generated.piecePackage || !override.piecePackage) {
    return {
      version: 1,
      merger: "piece-dsl-merge",
      generatedFilePath,
      overrideFilePath,
      pieceDsl: "",
      piecePackage: null,
      diagnostics: parseDiagnostics
    };
  }

  const merged = mergePiecePackages(generated.piecePackage, override.piecePackage);
  const pieceDsl = merged.piecePackage ? piecePackageToPicDsl(merged.piecePackage) : "";
  return {
    version: 1,
    merger: "piece-dsl-merge",
    generatedFilePath,
    overrideFilePath,
    pieceDsl,
    piecePackage: merged.piecePackage,
    diagnostics: [...parseDiagnostics, ...(merged.diagnostics ?? [])]
  };
}

export async function generateKotlinPieceDslFile(options = {}) {
  const filePath = options.filePath ?? "Main.kt";
  const source = options.source ?? "";
  const backend = normalizeKotlinAnalysisBackend(options.backend);
  const analysisApiEnabled = options.analysisApiEnabled === true || options.kotlinAnalysisApiEnabled === true;
  const analysisApiVersion = options.analysisApiVersion ?? options.kotlinAnalysisApiVersion;
  const hostWorkspaceInfo = await prepareWorkspace("piece-kotlin-pic-host-");
  const hostWorkspace = hostWorkspaceInfo.path;
  const sourceFile = join(hostWorkspace, sourceBasename(filePath, "Main.kt"));
  const outputReport = join(hostWorkspace, "kotlin-pic-report.json");

  try {
    await writeFile(sourceFile, source, "utf8");
    const args = [
      "-p",
      join(PACKAGE_ROOT, "piece-core"),
      "runKotlinPicGeneratorBackend",
      "--quiet",
      `-PpieceAnalysisApi.enabled=${analysisApiEnabled ? "true" : "false"}`,
      ...(analysisApiVersion ? [`-PpieceAnalysisApi.version=${analysisApiVersion}`] : []),
      `-PpiecePic.filePath=${filePath}`,
      `-PpiecePic.sourceFile=${sourceFile}`,
      `-PpiecePic.outputReport=${outputReport}`,
      `-PpiecePic.backend=${backend ?? ""}`
    ];

    const backendCommand = await runCommand(defaultGradleCommand(), args, { cwd: PACKAGE_ROOT, env: options.env });
    if (await pathExists(outputReport)) {
      return readJsonFile(outputReport);
    }
    return errorKotlinPicGenerationReport({ filePath, source, commands: [backendCommand] });
  } finally {
    await cleanupWorkspace(hostWorkspace, false);
  }
}

export async function compileGoPieceFile(options = {}) {
  const filePath = options.filePath ?? "Main.go";
  const source = options.source ?? "";
  const workspaceInfo = await prepareWorkspace("piece-go-", options.workspace);
  const workspace = workspaceInfo.path;
  const outputDir = resolve(options.outDir ?? join(workspace, "piece-out"));
  const sourceName = sourceBasename(filePath, "Main.go");
  const packageName = packageNameFromGo(source);
  const goCommand = options.goCommand ?? "go";
  const modulePath = options.modulePath ?? `piece.local/${sanitizeProjectName(sourceName.replace(/\.go$/, ""))}`;
  const commands = [];

  try {
    await mkdir(outputDir, { recursive: true });
    await writeFile(join(workspace, sourceName), source, "utf8");
    await writeFile(join(workspace, "go.mod"), `module ${modulePath}\n\ngo 1.22\n`, "utf8");

    const goListCommand = await runCommand(goCommand, ["list", "-json", "./..."], { cwd: workspace, env: options.env });
    commands.push(goListCommand);
    const goList = createGoListReport(goListCommand, workspace);
    const buildArgs = packageName === "main" ? ["build", "-o", join(outputDir, sanitizeProjectName(sourceName.replace(/\.go$/, ""))), "."] : ["build", "./..."];
    commands.push(await runCommand(goCommand, buildArgs, { cwd: workspace, env: options.env }));
    if ((options.runTests ?? true) && commands.at(-1)?.exitCode === 0) {
      commands.push(await runCommand(goCommand, ["test", "./..."], { cwd: workspace, env: options.env }));
    }

    const outputFiles = await collectFiles(outputDir);
    const result = {
      version: 1,
      language: "go",
      filePath,
      target: packageName === "main" ? "binary" : "package",
      status: compileStatus(commands),
      goList,
      workspace: options.keepWorkspace ? workspace : undefined,
      outputFiles,
      commands,
      diagnostics: diagnosticsFromCommands(commands)
    };
    await writeFile(join(outputDir, "compile-report.json"), `${JSON.stringify(result, null, 2)}\n`, "utf8");
    result.outputFiles = await collectFiles(outputDir);
    return result;
  } finally {
    if (workspaceInfo.temporary) {
      await cleanupWorkspace(workspace, options.keepWorkspace);
    }
  }
}

export async function compileKotlinPieceFile(options = {}) {
  const filePath = options.filePath ?? "Main.kt";
  const cwd = resolve(options.cwd ?? process.cwd());
  const sourcePath = resolveHostPath(filePath, cwd);
  const source = options.source ?? ((await pathExists(sourcePath)) ? await readFile(sourcePath, "utf8") : "");
  const target = options.target ?? "jvm";
  const pieceAction = options.pieceAction;
  const projectRootOption = options.gradleProjectRoot ?? options.projectRoot;
  const projectRoot = projectRootOption ? resolveHostPath(String(projectRootOption), cwd) : undefined;
  const companionSources = await collectKotlinCompanionSources(options, filePath);
  if (!["jvm", "js", "wasmJs", "all"].includes(target)) {
    throw new TypeError(`Unsupported Kotlin compile target: ${target}`);
  }
  const gradleCommand = projectRoot ? await resolveProjectGradleCommand(options.gradleCommand, projectRoot) : resolveGradleCommand(options.gradleCommand);

  const hostWorkspaceInfo = await prepareWorkspace("piece-kotlin-host-");
  const hostWorkspace = hostWorkspaceInfo.path;
  const sourceFile = join(hostWorkspace, sourceBasename(filePath, "Main.kt"));
  const companionDir = join(hostWorkspace, "compile-companions");
  const companionSourcesFile = join(hostWorkspace, "compile-companion-sources.tsv");
  const outputReport = join(hostWorkspace, "compile-report.json");

  try {
    await writeFile(sourceFile, source, "utf8");
    const companionLines = [];
    if (companionSources.length > 0) {
      await mkdir(companionDir, { recursive: true });
      for (const [index, companion] of companionSources.entries()) {
        const companionFilePath = companion?.filePath;
        if (!companionFilePath || companionFilePath === filePath) continue;
        const companionSourceFile = join(companionDir, `${index}-${sourceBasename(companionFilePath, "Companion.kt")}`);
        await writeFile(companionSourceFile, companion.source ?? "", "utf8");
        companionLines.push(`${companionFilePath}\t${companionSourceFile}`);
      }
      if (companionLines.length > 0) {
        await writeFile(companionSourcesFile, `${companionLines.join("\n")}\n`, "utf8");
      }
    }
    const args = [
      "-p",
      join(PACKAGE_ROOT, "piece-core"),
      "runKotlinCompileBackend",
      "--quiet",
      `-PpieceCompile.filePath=${filePath}`,
      `-PpieceCompile.sourceFile=${sourceFile}`,
      `-PpieceCompile.outputReport=${outputReport}`,
      `-PpieceCompile.target=${target}`,
      `-PpieceCompile.sourceSet=${options.sourceSet ?? ""}`,
      `-PpieceCompile.projectRoot=${projectRoot ?? ""}`,
      `-PpieceCompile.gradleCommand=${gradleCommand}`,
      `-PpieceCompile.gradleVersion=${options.gradleVersion ?? ""}`,
      `-PpieceCompile.kotlinPluginVersion=${options.kotlinPluginVersion ?? ""}`,
      `-PpieceCompile.tasks=${options.tasks?.join(",") ?? ""}`,
      `-PpieceCompile.keepWorkspace=${options.keepWorkspace ? "true" : "false"}`,
      `-PpieceCompile.companionSources=${companionLines.length > 0 ? companionSourcesFile : ""}`,
      `-PpieceCompile.pieceTargetLabel=${pieceAction?.targetLabel ?? ""}`,
      `-PpieceCompile.pieceActionId=${pieceAction?.actionId ?? ""}`,
      `-PpieceCompile.pieceArtifactId=${pieceAction?.artifactId ?? ""}`,
      `-PpieceCompile.pieceActionKind=${pieceAction?.kind ?? "compile"}`,
      `-PpieceCompile.pieceTarget=${options.pieceTarget ?? ""}`,
      `-PpieceCompile.pieceActionName=${options.pieceActionName ?? ""}`
    ];
    if (options.workspace) {
      args.push(`-PpieceCompile.workspace=${resolve(options.workspace)}`);
    }

    const backendCommand = await runCommand(defaultGradleCommand(), args, { cwd: PACKAGE_ROOT, env: options.env });
    if (await pathExists(outputReport)) {
      return readJsonFile(outputReport);
    }
    const commands = [backendCommand];
    return {
      version: 1,
      language: "kotlin",
      backend: "kotlin-jvm",
      filePath,
      target,
      sourceSet: options.sourceSet ?? "",
      ...(projectRoot ? { projectRoot } : {}),
      ...(pieceAction ? { pieceAction } : {}),
      status: "error",
      outputFiles: [],
      commands,
      diagnostics: diagnosticsFromCommands(commands)
    };
  } finally {
    await cleanupWorkspace(hostWorkspace, false);
  }
}

export async function analyzeKotlinPieceFile(options = {}) {
  const filePath = options.filePath ?? "Main.kt";
  const source = options.source ?? "";
  const parserName = options.parserName ?? "kotlin-psi-declaration-extractor";
  const backend = normalizeKotlinAnalysisBackend(options.backend ?? options.kotlinAnalysisBackend);
  const analysisApiEnabled = options.analysisApiEnabled === true || options.kotlinAnalysisApiEnabled === true;
  const analysisApiVersion = options.analysisApiVersion ?? options.kotlinAnalysisApiVersion;
  const semanticDiagnostics = options.semanticDiagnostics === true;
  const semanticSymbols = options.semanticSymbols === true;
  const projectModel = focusKotlinProjectModel(await collectKotlinGradleProjectModel(options), { ...options, filePath });
  const analysisOptions = mergeKotlinProjectModelOptions(options, projectModel);
  const companionSources = await collectKotlinCompanionSources(analysisOptions, filePath);
  const hostWorkspaceInfo = await prepareWorkspace("piece-kotlin-analysis-host-");
  const hostWorkspace = hostWorkspaceInfo.path;
  const sourceFile = join(hostWorkspace, sourceBasename(filePath, "Main.kt"));
  const companionDir = join(hostWorkspace, "companions");
  const companionSourcesFile = join(hostWorkspace, "companion-sources.tsv");
  const classpathFile = join(hostWorkspace, "analysis-classpath.txt");
  const outputReport = join(hostWorkspace, "analysis-report.json");

  try {
    await writeFile(sourceFile, source, "utf8");
    const companionLines = [];
    if (companionSources.length > 0) {
      await mkdir(companionDir, { recursive: true });
      for (const [index, companion] of companionSources.entries()) {
        const companionFilePath = companion?.filePath;
        if (!companionFilePath || companionFilePath === filePath) continue;
        const companionSourceFile = join(companionDir, `${index}-${sourceBasename(companionFilePath, "Companion.kt")}`);
        await writeFile(companionSourceFile, companion.source ?? "", "utf8");
        companionLines.push(`${companionFilePath}\t${companionSourceFile}`);
      }
      if (companionLines.length > 0) {
        await writeFile(companionSourcesFile, `${companionLines.join("\n")}\n`, "utf8");
      }
    }
    const classpath = collectKotlinClasspath(analysisOptions);
    if (classpath.length > 0) {
      await writeFile(classpathFile, `${classpath.join("\n")}\n`, "utf8");
    }
    const args = [
      "-p",
      join(PACKAGE_ROOT, "piece-core"),
      "runKotlinPsiAnalysisBackend",
      "--quiet",
      `-PpieceAnalysisApi.enabled=${analysisApiEnabled ? "true" : "false"}`,
      ...(analysisApiVersion ? [`-PpieceAnalysisApi.version=${analysisApiVersion}`] : []),
      `-PpieceAnalysis.filePath=${filePath}`,
      `-PpieceAnalysis.sourceFile=${sourceFile}`,
      `-PpieceAnalysis.outputReport=${outputReport}`,
      `-PpieceAnalysis.parserName=${parserName}`,
      `-PpieceAnalysis.backend=${backend ?? ""}`,
      `-PpieceAnalysis.semanticDiagnostics=${semanticDiagnostics ? "true" : "false"}`,
      `-PpieceAnalysis.semanticSymbols=${semanticSymbols ? "true" : "false"}`,
      `-PpieceAnalysis.companionSources=${companionLines.length > 0 ? companionSourcesFile : ""}`,
      `-PpieceAnalysis.classpathFile=${classpath.length > 0 ? classpathFile : ""}`
    ];

    const backendCommand = await runCommand(defaultGradleCommand(), args, { cwd: PACKAGE_ROOT, env: options.env });
    if (await pathExists(outputReport)) {
      return attachKotlinProjectModel(await readJsonFile(outputReport), projectModel);
    }
    return attachKotlinProjectModel(
      errorKotlinPsiManifest({
        filePath,
        source,
        parserName,
        backend,
        semanticDiagnostics,
        semanticSymbols,
        analysisApiEnabled,
        analysisApiVersion,
        commands: [backendCommand]
      }),
      projectModel
    );
  } finally {
    await cleanupWorkspace(hostWorkspace, false);
  }
}

export function createNodeKotlinPsiDeclarationExtractor(options = {}) {
  const name = options.name ?? "kotlin-psi-declaration-extractor";
  return {
    name,
    extract({ filePath, source }) {
      return analyzeKotlinPieceFile({
        filePath,
        source,
        parserName: name,
        backend: options.backend,
        analysisApiEnabled: options.analysisApiEnabled === true || options.kotlinAnalysisApiEnabled === true,
        analysisApiVersion: options.analysisApiVersion ?? options.kotlinAnalysisApiVersion,
        semanticDiagnostics: options.semanticDiagnostics === true,
        semanticSymbols: options.semanticSymbols === true,
        sourceFiles: options.sourceFiles,
        sourceRoots: options.sourceRoots,
        classpath: options.classpath,
        projectRoot: options.projectRoot,
        gradleProjectRoot: options.gradleProjectRoot,
        gradleCommand: options.gradleCommand,
        gradleVersion: options.gradleVersion,
        cwd: options.cwd,
        env: options.env
      });
    }
  };
}
