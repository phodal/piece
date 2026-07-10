import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { performance } from "node:perf_hooks";
import { analyzePieceWorkspace, createPieceWorkspaceSession } from "../src/node-workspace.js";

function positiveInteger(value, description) {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1) {
    throw new Error(`${description} must be a positive safe integer.`);
  }
  return parsed;
}

function positiveIntegerList(name, fallback) {
  const prefix = `--${name}=`;
  const value = process.argv.find((argument) => argument.startsWith(prefix))?.slice(prefix.length);
  if (value === undefined) return fallback;
  const values = value.split(",").map((part) => positiveInteger(part.trim(), `--${name}`));
  if (values.length === 0) throw new Error(`--${name} must contain at least one value.`);
  return [...new Set(values)];
}

function commaList(name, fallback) {
  const prefix = `--${name}=`;
  const value = process.argv.find((argument) => argument.startsWith(prefix))?.slice(prefix.length);
  return value === undefined ? fallback : [...new Set(value.split(",").map((part) => part.trim()).filter(Boolean))];
}

function stringArg(name, fallback) {
  const prefix = `--${name}=`;
  return process.argv.find((argument) => argument.startsWith(prefix))?.slice(prefix.length) ?? fallback;
}

const fileCounts = positiveIntegerList("files", [1, 10]);
const sliceCounts = positiveIntegerList("slices", [10, 50]);
const edits = positiveInteger(stringArg("edits", "5"), "--edits");
const concurrency = positiveInteger(stringArg("concurrency", "4"), "--concurrency");
const positions = commaList("positions", ["head", "middle", "tail"]);
const outputPath = stringArg("output", "reports/workspace-session-benchmark.json");
const POSITION_NAMES = new Set(["head", "middle", "tail"]);

if (positions.length === 0) {
  throw new Error("--positions must contain at least one position.");
}
if (!outputPath.trim()) {
  throw new Error("--output must not be empty.");
}
for (const position of positions) {
  if (!POSITION_NAMES.has(position)) {
    throw new Error(`--positions must contain only ${[...POSITION_NAMES].join(", ")}.`);
  }
}

function rounded(value) {
  return Math.round(value * 1000) / 1000;
}

function stats(values) {
  const sorted = [...values].sort((left, right) => left - right);
  const total = sorted.reduce((sum, value) => sum + value, 0);
  return {
    minMs: rounded(sorted[0] ?? 0),
    medianMs: rounded(sorted[Math.floor(sorted.length / 2)] ?? 0),
    averageMs: rounded(total / Math.max(sorted.length, 1)),
    maxMs: rounded(sorted.at(-1) ?? 0)
  };
}

async function measure(operation) {
  const startedAt = performance.now();
  const value = await operation();
  return { value, ms: performance.now() - startedAt };
}

function marker(sliceIndex, revision) {
  return `m${String(sliceIndex).padStart(4, "0")}-${String(revision).padStart(4, "0")}`;
}

function sourceForFile(fileIndex, sliceCount, revisions) {
  const declarations = [];
  for (let sliceIndex = 0; sliceIndex < sliceCount; sliceIndex += 1) {
    declarations.push(`export function file${fileIndex}Piece${sliceIndex}(input: number): string {`);
    declarations.push(`  const marker = "${marker(sliceIndex, revisions[sliceIndex])}";`);
    declarations.push(`  return \`${fileIndex}:${sliceIndex}:\${input}:\${marker}\`;`);
    declarations.push("}");
    declarations.push("");
  }
  return `${declarations.join("\n")}\n`;
}

function targetSliceIndex(position, sliceCount) {
  if (position === "head") return 0;
  if (position === "middle") return Math.floor(sliceCount / 2);
  return sliceCount - 1;
}

function totalSlices(workspace) {
  return workspace.projects.reduce((total, project) => total + (project.metrics.sliceCount ?? 0), 0);
}

function assertMetrics(workspace, { fileCount, fresh, reused, sliceCount, label }) {
  if (workspace.metrics.sourceFileCount !== fileCount) {
    throw new Error(`${label}: expected ${fileCount} source files, got ${workspace.metrics.sourceFileCount}.`);
  }
  if (workspace.metrics.freshFileAnalysisCount !== fresh || workspace.metrics.reusedFileCount !== reused) {
    throw new Error(
      `${label}: expected ${fresh} fresh / ${reused} reused analyses, got ${workspace.metrics.freshFileAnalysisCount} fresh / ${workspace.metrics.reusedFileCount} reused.`
    );
  }
  if (totalSlices(workspace) !== sliceCount) {
    throw new Error(`${label}: expected ${sliceCount} slices, got ${totalSlices(workspace)}.`);
  }
}

async function writeFixture(root, fileCount, sliceCount) {
  const sourceRoot = join(root, "app", "src");
  await mkdir(sourceRoot, { recursive: true });
  const files = [];
  const revisionsByFile = [];
  for (let fileIndex = 0; fileIndex < fileCount; fileIndex += 1) {
    const filePath = join(sourceRoot, `File${String(fileIndex).padStart(3, "0")}.ts`);
    const revisions = Array.from({ length: sliceCount }, () => 0);
    await writeFile(filePath, sourceForFile(fileIndex, sliceCount, revisions), "utf8");
    files.push(filePath);
    revisionsByFile.push(revisions);
  }
  return { files, revisionsByFile };
}

async function runCase({ fileCount, sliceCount, position }) {
  const root = await mkdtemp(join(tmpdir(), "piece-workspace-benchmark-"));
  try {
    const { files, revisionsByFile } = await writeFixture(root, fileCount, sliceCount);
    const options = {
      workspaceRoot: root,
      projects: [{ id: "app", root: "app", sourceRoots: ["src"] }],
      analysisConcurrency: concurrency
    };
    const session = createPieceWorkspaceSession(options);
    const initial = await measure(() => session.analyze());
    const expectedSlices = fileCount * sliceCount;
    assertMetrics(initial.value, { fileCount, fresh: fileCount, reused: 0, sliceCount: expectedSlices, label: "initial session" });

    const editedFileIndex = Math.floor(fileCount / 2);
    const editedSliceIndex = targetSliceIndex(position, sliceCount);
    const measurements = [];
    for (let revision = 1; revision <= edits; revision += 1) {
      revisionsByFile[editedFileIndex][editedSliceIndex] = revision;
      await writeFile(
        files[editedFileIndex],
        sourceForFile(editedFileIndex, sliceCount, revisionsByFile[editedFileIndex]),
        "utf8"
      );
      const sessionRun = await measure(() => session.analyze());
      const coldRun = await measure(() => analyzePieceWorkspace(options));
      assertMetrics(sessionRun.value, {
        fileCount,
        fresh: 1,
        reused: fileCount - 1,
        sliceCount: expectedSlices,
        label: `session revision ${revision}`
      });
      assertMetrics(coldRun.value, {
        fileCount,
        fresh: fileCount,
        reused: 0,
        sliceCount: expectedSlices,
        label: `cold revision ${revision}`
      });
      measurements.push({
        revision,
        sessionMs: rounded(sessionRun.ms),
        coldMs: rounded(coldRun.ms),
        speedup: rounded(coldRun.ms / Math.max(sessionRun.ms, 0.001)),
        freshFileAnalysisCount: sessionRun.value.metrics.freshFileAnalysisCount,
        reusedFileCount: sessionRun.value.metrics.reusedFileCount
      });
    }

    const sessionStats = stats(measurements.map((measurement) => measurement.sessionMs));
    const coldStats = stats(measurements.map((measurement) => measurement.coldMs));
    return {
      files: fileCount,
      slicesPerFile: sliceCount,
      totalSlices: expectedSlices,
      editPosition: position,
      editedFile: `File${String(editedFileIndex).padStart(3, "0")}.ts`,
      editedSliceIndex,
      initialSessionMs: rounded(initial.ms),
      session: sessionStats,
      cold: coldStats,
      medianSpeedup: rounded(coldStats.medianMs / Math.max(sessionStats.medianMs, 0.001)),
      measurements
    };
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

const cases = [];
for (const fileCount of fileCounts) {
  for (const sliceCount of sliceCounts) {
    for (const position of positions) {
      const result = await runCase({ fileCount, sliceCount, position });
      cases.push(result);
      console.log(
        `${fileCount} files × ${sliceCount} slices (${position}): session ${result.session.medianMs}ms, cold ${result.cold.medianMs}ms, ${result.medianSpeedup}x median`
      );
    }
  }
}

const report = {
  version: 1,
  benchmark: "piece-workspace-session",
  generatedAt: new Date().toISOString(),
  parameters: {
    files: fileCounts,
    slices: sliceCounts,
    positions,
    edits,
    concurrency
  },
  environment: {
    node: process.version,
    platform: process.platform,
    arch: process.arch
  },
  cases
};

await mkdir(dirname(outputPath), { recursive: true });
await writeFile(outputPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
console.log(`Report: ${outputPath}`);
