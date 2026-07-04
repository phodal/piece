# Piece Core

This is the Kotlin Multiplatform core for Piece.

The first npm package remains the runnable host for editors and React preview. This module owns the language-neutral model, generated DSL, graph utilities, and reconciliation primitives that should eventually be shared by Kotlin/JVM and JavaScript adapters.

Current scope:

- `commonMain`: model, DSL, graph, snapshot/reconcile contracts.
- `jvmMain`: Kotlin compiler PSI extractor that maps a single `.kt` file into a `PiecePackage`, plus the Kotlin/JVM compile backend used by the npm host.
- `jsMain`: bridge boundary for npm-facing integration.

Use the checked-in Gradle wrapper for local validation:

```sh
./gradlew check wasmJsBrowserDistribution
```

From the repository root, the same Gradle project is available through the
delegating `./gradlew` script.

The current JVM extractor is syntax-oriented. The compile backend already runs on the JVM side and uses Gradle/Kotlin MPP as the actual toolchain. A later semantic slice should add Kotlin Analysis API resolution for overloads, imports, and cross-file symbols.
