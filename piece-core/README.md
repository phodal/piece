# Piece Core

This is the Kotlin Multiplatform core for Piece.

The first npm package remains the runnable host for editors and React preview. This module owns the language-neutral model, generated DSL, graph utilities, and reconciliation primitives that should eventually be shared by Kotlin/JVM and JavaScript adapters.

Current scope:

- `commonMain`: model, DSL, graph, snapshot/reconcile contracts.
- `jvmMain`: placeholder for the real Kotlin PSI / Analysis API extractor.
- `jsMain`: bridge boundary for npm-facing integration.

This module is scaffolded without a checked-in Gradle wrapper. Use a local Gradle installation or add a wrapper in a dedicated build-tooling slice before treating it as a release gate.
