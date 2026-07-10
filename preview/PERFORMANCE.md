# Piece Compiler Preview Performance

Measured against the preview workbench served by:

```sh
npm run preview
```

> **Note:** the demo fixture was replaced with a more realistic "orders dashboard" (types,
> a 420-row mock dataset, utility functions, and several UI components) instead of the
> original 620 mechanically-duplicated `DetailBlock` components. The numbers below predate
> that change and are kept as a historical record; they no longer reflect the current
> fixture (which is ~687 lines / ~71KB / 38 slices / 61 edges). Re-run `npm run preview` and
> click `Run Benchmark` / `Sample Edit` for current numbers.

## Current browser feedback contract — July 10, 2026

The current workbench exposes 50, 420, and 2,000-order fixtures. The large
fixture is 313,440 source bytes, 2,267 lines, 38 slices, and 61 graph edges.
These measurements came from the in-app browser after the browser-safe fallback
extractor was moved onto the single-declaration incremental path.

| Scenario | Piece total | Piece e2e | Full `esbuild-wasm` | Comparable speedup | Cache |
| --- | ---: | ---: | ---: | ---: | --- |
| `UserCard` edit, 2,000 orders | 2.7ms | 5.3ms | 69.0ms | 25.6x compile / 13.0x e2e | miss |
| Unrelated `cacheProbe` edit, same fixture | 0.4ms | 2.1ms | 69.0ms baseline | 172.5x compile / 32.9x e2e | hit |

`Run Benchmark` intentionally measures the full build only on demand. Normal
editing never waits for that baseline. The comparison is valid for the
piece-targeted feedback boundary, not a claim that Piece is faster than esbuild
for cold, whole-file production bundles. See
[`docs/incremental-feedback-architecture.md`](../docs/incremental-feedback-architecture.md)
for the architecture and research basis.

The fixture is a 3,154-line TSX file with 124,267 source bytes and 628 declaration slices. After JSX intrinsic/text filtering, the selected `UserCard` closure graph has 11 target-relevant edges. The right pane is an iframe running the compiled HTML output. The comparison baseline is a full `esbuild-wasm` browser build of the same source file and preview entry.

## July 2, 2026 Chrome Run

| Scenario | Piece total | Piece e2e | Full esbuild-wasm | Speedup | E2E speedup | Cache | Closure bytes | Result |
| --- | ---: | ---: | ---: | ---: | ---: | --- | ---: | --- |
| Initial cold load | 1187.3ms | 1512.8ms | 637.3ms | 0.54x | 0.42x | miss | 910 | iframe rendered `Ada Lovelace / Active account / Score: 94.0` |
| Button edit across value + function slices | 122.7ms | 285.0ms | 175.9ms | 1.43x | 0.62x | miss | 936 | iframe rendered `Active account - browser edited / Live score: 95.0` |
| Runtime closure cache benchmark | 0.7ms | 0.7ms | 253.2ms | 361.71x | 361.71x | hit | 936 | iframe kept last good edited preview |
| Single function edit 1 | 13.3ms | 131.0ms | 175.5ms | 13.20x | 1.34x | miss | 936 | iframe rendered `Live score: 96.0` |
| Single function edit 2 | 17.5ms | 127.3ms | 246.5ms | 14.09x | 1.94x | miss | 936 | iframe rendered `Live score: 97.0` |
| Single function edit 3 | 30.8ms | 209.1ms | 415.0ms | 13.47x | 1.98x | miss | 936 | iframe rendered `Live score: 98.0` |

Single-function edit compile average: 20.5ms piece vs 279.0ms full `esbuild-wasm`, a 13.6x compile-only speedup. Single-function edit E2E average: 155.8ms piece vs 279.0ms full `esbuild-wasm`, a 1.8x end-to-end speedup.

## July 2, 2026 In-App Browser Check

The in-app Browser opened the same preview page, clicked `Sample Edit`, and read the iframe plus metrics from the DOM:

| Scenario | Piece total | Piece e2e | Full esbuild-wasm | Speedup | E2E speedup | Closure bytes | Result |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | --- |
| Initial load | 1134.6ms | 1515.4ms | 1251.3ms | 1.10x | 0.83x | 910 | iframe rendered `Ada Lovelace / Active account / Score: 94.0` |
| Browser button edit | 205.7ms | 353.5ms | 291.1ms | 1.42x | 0.82x | 936 | iframe rendered `Active account - browser edited / Live score: 95.0` |
