import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import { createPieceCompiler } from "../src/index.js";

function numberArg(name, fallback) {
  const prefix = `--${name}=`;
  const value = process.argv.find((arg) => arg.startsWith(prefix))?.slice(prefix.length);
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

const warmup = numberArg("warmup", 5);
const runs = numberArg("runs", 30);
const declarations = numberArg("declarations", 500);
const threshold = numberArg("threshold", 1.5);

function syntheticKotlinSource(marker = "piece-0000") {
  const lines = [
    "package demo.benchmark",
    "",
    "data class User(val name: String, val score: Int)",
    "data class Greeting(val message: String)",
    ""
  ];

  for (let index = 0; index < declarations; index += 1) {
    lines.push(`private val prefix${index} = "Hello ${index}"`);
    lines.push(`fun helper${index}(user: User): String {`);
    lines.push(`  return prefix${index} + "-" + user.name + "-" + user.score`);
    lines.push("}");
    lines.push("");
  }

  const target = Math.floor(declarations / 2);
  lines.push("fun renderTarget(user: User): Greeting {");
  lines.push(`  return Greeting(prefix${target} + "-" + "${marker}" + "-" + helper${target}(user))`);
  lines.push("}");
  lines.push("");
  lines.push("class TargetCaller {");
  lines.push("  fun render(user: User): Greeting = renderTarget(user)");
  lines.push("}");
  lines.push("");
  return `${lines.join("\n")}\n`;
}

function changedRange(previousSource, nextSource) {
  let startByte = 0;
  while (startByte < previousSource.length && startByte < nextSource.length && previousSource[startByte] === nextSource[startByte]) {
    startByte += 1;
  }

  let previousEnd = previousSource.length;
  let nextEnd = nextSource.length;
  while (previousEnd > startByte && nextEnd > startByte && previousSource[previousEnd - 1] === nextSource[nextEnd - 1]) {
    previousEnd -= 1;
    nextEnd -= 1;
  }

  return {
    startByte,
    endByte: Math.max(startByte + 1, nextEnd),
    startLine: previousSource.slice(0, startByte).split("\n").length,
    endLine: nextSource.slice(0, nextEnd).split("\n").length
  };
}

function round(value) {
  return Math.round(value * 1000) / 1000;
}

function stats(values) {
  const sorted = [...values].sort((left, right) => left - right);
  const sum = sorted.reduce((total, value) => total + value, 0);
  return {
    minMs: round(sorted[0] ?? 0),
    medianMs: round(sorted[Math.floor(sorted.length / 2)] ?? 0),
    averageMs: round(sum / Math.max(sorted.length, 1)),
    maxMs: round(sorted.at(-1) ?? 0)
  };
}

async function measure(fn) {
  const startedAt = performance.now();
  const value = await fn();
  return {
    value,
    ms: performance.now() - startedAt
  };
}

const compiler = createPieceCompiler();
let previousSource = syntheticKotlinSource();
let previousAnalysis = await compiler.analyzeFile({
  filePath: "/repo/src/Benchmark.kt",
  source: previousSource
});

const measurements = [];
for (let iteration = 1; iteration <= warmup + runs; iteration += 1) {
  const marker = `piece-${String(iteration).padStart(4, "0")}`;
  const nextSource = syntheticKotlinSource(marker);
  const range = changedRange(previousSource, nextSource);
  const piece = await measure(() =>
    compiler.applyEdit({
      filePath: "/repo/src/Benchmark.kt",
      source: nextSource,
      previousAnalysis,
      changedRanges: [range]
    })
  );
  if (piece.value.analysis.metrics.incremental !== true) {
    throw new Error(`Kotlin piece benchmark did not use the incremental path on iteration ${iteration}.`);
  }

  const full = await measure(() =>
    compiler.analyzeFile({
      filePath: "/repo/src/Benchmark.kt",
      source: nextSource
    })
  );

  if (iteration > warmup) {
    measurements.push({
      iteration: iteration - warmup,
      pieceEditMs: round(piece.ms),
      fullAnalyzeMs: round(full.ms),
      speedup: round(full.ms / Math.max(piece.ms, 0.001)),
      changedSlices: piece.value.edit.changedSlices.map((id) => id.split("#")[1] ?? id),
      affectedTargets: piece.value.affectedTargets.map((id) => id.split("#")[1] ?? id),
      sliceCount: piece.value.analysis.metrics.sliceCount,
      edgeCount: piece.value.analysis.metrics.edgeCount
    });
  }

  previousSource = nextSource;
  previousAnalysis = piece.value.analysis;
}

const pieceStats = stats(measurements.map((item) => item.pieceEditMs));
const fullStats = stats(measurements.map((item) => item.fullAnalyzeMs));
const medianSpeedup = round(fullStats.medianMs / Math.max(pieceStats.medianMs, 0.001));
const result = {
  version: 1,
  benchmark: "kotlin-piece-vs-full-analysis",
  generatedAt: new Date().toISOString(),
  parameters: {
    warmup,
    runs,
    declarations,
    threshold
  },
  environment: {
    node: process.version,
    platform: process.platform,
    arch: process.arch
  },
  piece: pieceStats,
  full: fullStats,
  medianSpeedup,
  passed: medianSpeedup >= threshold,
  measurements
};

await mkdir("reports", { recursive: true });
await writeFile(join("reports", "kotlin-piece-benchmark.json"), `${JSON.stringify(result, null, 2)}\n`, "utf8");

console.log(`Kotlin piece median: ${pieceStats.medianMs}ms`);
console.log(`Full-file median: ${fullStats.medianMs}ms`);
console.log(`Median speedup: ${medianSpeedup}x`);
console.log("Report: reports/kotlin-piece-benchmark.json");

if (!result.passed) {
  throw new Error(`Expected Kotlin piece speedup >= ${threshold}x, got ${medianSpeedup}x.`);
}
