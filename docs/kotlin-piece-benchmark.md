# Kotlin Piece Benchmark

This benchmark verifies the Kotlin piece-analysis path, not Gradle/Kotlin compiler throughput.

## Command

```sh
npm run benchmark:kotlin-piece
```

Default parameters:

- warmup: 5 runs
- measured runs: 30
- generated declarations: 500 pairs of values/functions plus target declarations
- pass threshold: median speedup >= 2x

The script writes the full machine-readable result to `reports/kotlin-piece-benchmark.json`.

## What It Measures

The fixture is a generated single Kotlin file. Each iteration edits one string literal inside `renderTarget`, then compares:

- `pieceEditMs`: `applyPieceEdit()` using the previous analysis and changed range.
- `fullAnalyzeMs`: a full `analyzeFile()` pass over the edited source.

The benchmark fails if any measured piece run does not use the incremental path.

## Representative Run

Environment:

- Date: 2026-07-04
- Node: v26.0.0
- Platform: darwin arm64

Result:

| Metric | Piece edit | Full-file analyze |
| --- | ---: | ---: |
| Median | 21.241ms | 54.972ms |
| Average | 31.183ms | 59.981ms |
| Min | 20.085ms | 51.865ms |
| Max | 62.194ms | 79.740ms |

Median speedup: 2.588x.

The measured file contained 1,004 slices and 1,007 graph edges. Each measured edit changed `function:renderTarget` and affected `function:renderTarget` plus `class:TargetCaller`.
