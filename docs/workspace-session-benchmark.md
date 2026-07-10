# Workspace Session Benchmark

This benchmark measures the editor/watch-session reuse path against a fresh
workspace analysis after every edit. It generates TypeScript workspaces, so it
does not depend on Go, Gradle, or Kotlin tooling.

## Command

```sh
npm run benchmark:workspace-session
```

The default matrix has 1 and 10 files, 10 and 50 declarations per file, head,
middle, and tail edits, and five consecutive edits per case. The full result is
written to `reports/workspace-session-benchmark.json`.

Use options to raise the scale without changing the script:

```sh
npm run benchmark:workspace-session -- --files=1,10,50 --slices=10,100,500 --edits=20 --concurrency=4
```

## What it verifies

For every edit, the script checks that the session analyzes exactly the changed
file and reuses every other file, while a fresh workspace analysis processes
every configured file. It records wall-clock distributions for both paths and
the median speedup, but deliberately has no fixed performance threshold:
hardware, Node versions, and filesystem caching materially affect timing.

The matrix exposes the cases the browser demo cannot show on its own: file
count, declarations per file, edit location, and repeated edits over a shared
workspace session.
