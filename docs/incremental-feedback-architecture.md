# Incremental Feedback Architecture

Piece is faster than a whole-file build only when the requested outcome is
smaller than the file. The relevant comparison is therefore a *safe,
piece-targeted feedback update* versus a full `esbuild-wasm` build of the same
source. It is not a claim that Piece should beat esbuild at cold, whole-program
bundling.

## Performance contract

For a single declaration edit in a browser preview session, the system must:

1. preserve the from-scratch result for the selected preview target;
2. update only the changed declaration, its graph edges, and the reverse
   transitive closure that is actually demanded by the preview;
3. reuse a previous runtime bundle when its closure fingerprint is unchanged;
4. fall back to file or project scope whenever the graph or safety boundary
   cannot prove the smaller result is sound; and
5. report the full-build baseline only when the user explicitly asks to compare
   it, so that the baseline does not delay normal editing.

The browser workbench has 50, 420, and 2,000 order fixtures. Its `Sample Edit`
changes the selected target; `Run 10 Cached Edits` changes an unrelated slice;
and `Run Benchmark` measures the whole-file baseline separately.

## Query-shaped model

The current implementation is deliberately small, but it follows a
query-oriented layout:

```text
Source revision
  -> declaration(file, stable piece id)
  -> outgoing edges(piece)
  -> feedback scope(file, graph)
  -> closure(target, graph, scope)
  -> virtual modules(target, closure)
  -> runtime bundle(target, closure fingerprint)
```

Each layer has a stable identity or fingerprint. A revision changes only the
input declaration when the changed range remains inside one declaration. The
snapshot reconciler then compares fingerprints, propagates public-shape changes
through reverse edges, and retains declaration records whose content,
dependencies, and source range did not change.

The browser-safe fallback extractor participates in this path too. It is not
allowed to perform an incremental update if an edit crosses a declaration
boundary, removes the declaration name, or changes headers/effects; those cases
take the normal whole-file analysis path.

## Research basis and implementation choices

| Research | Principle used here | Concrete Piece consequence |
| --- | --- | --- |
| [Acar et al., *A Library for Self-Adjusting Computation* (2006)](https://www.cs.cmu.edu/~guyb/papers/ABBHT06.pdf) | Dynamic dependency graphs plus memoization reuse affected work instead of re-running everything. | Slice graph + snapshot reconciliation + artifact identity. |
| [Acar et al., *An Experimental Analysis of Self-Adjusting Computation* (2009)](https://www.cs.cmu.edu/~blelloch/papers/ABBHT09.pdf) | Reuse is valuable only when change propagation is bounded and stable. | Keep fallback gates; never turn an unsafe file into a piece cache hit. |
| [Hammer et al., *ADAPTON* (2014)](https://www.cs.umd.edu/~mwh/papers/adapton-submit.pdf) | Evaluate only demanded outputs and retain a demanded computation graph. | Build only the selected preview closure; unrelated edit sequences reuse its runtime bundle. |
| [Hammer et al., *Incremental Computation with Names* (2015)](https://arxiv.org/abs/1503.07792) | Stable names let work survive across revisions. | `filePath#kind:name` is the first-level piece key; record reuse requires matching content, dependencies, and range. |
| [Mokhov, Mitchell, Peyton Jones, *Build Systems à la Carte* (2018)](https://doi.org/10.1145/3236774) | Separate dependency scheduling, rebuild policy, early cutoff, and persistence. | The package/action model stays separate from preview demand and local artifact reuse. |
| [rustc incremental query design](https://rustc-dev-guide.rust-lang.org/queries/incremental-compilation-in-detail.html) | Pure query results need stable fingerprints; expensive values should be persisted selectively. | Closure and artifact cache keys are fingerprints, while raw source and unsafe scope force invalidation. |

## Next architecture steps

1. Promote the internal stages above into a revisioned `PieceQueryStore`, so
   callers do not have to manually thread `previousAnalysis` and preview cache
   state.
2. Split source identity into a chunked/Merkle fingerprint for large files,
   preserving exact full-source identity without hashing the entire text at each
   local edit.
3. Persist only immutable artifacts and verified query fingerprints; use
   red/green validation before reusing them across process boundaries.
4. Schedule independent affected preview targets in parallel, while deduplicating
   the shared closure and action work.

These are architectural follow-ups, not shortcuts around correctness: every
optimized path must stay observationally equivalent to a clean analysis for the
same selected target.
