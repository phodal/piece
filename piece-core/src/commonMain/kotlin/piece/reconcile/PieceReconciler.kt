package piece.reconcile

import piece.graph.toGraph
import piece.graph.transitiveDependentsOf
import piece.model.PiecePackage
import piece.model.PieceReconcileResult
import piece.model.PieceSnapshot
import piece.model.PieceSnapshotTarget

fun PiecePackage.toSnapshot(
    sourceHash: String,
    publicShapeHashes: Map<String, String> = emptyMap(),
    implementationHashes: Map<String, String> = emptyMap(),
): PieceSnapshot {
    val targetsByLabel = targets.associate { target ->
        target.label to PieceSnapshotTarget(
            label = target.label,
            rule = target.rule,
            depsHash = target.deps.joinToString("|"),
            publicShapeHash = publicShapeHashes[target.label].orEmpty(),
            implementationHash = implementationHashes[target.label].orEmpty(),
        )
    }
    return PieceSnapshot(
        packageLabel = label,
        sourceHash = sourceHash,
        targets = targetsByLabel,
        artifacts = artifacts.associateBy { it.id },
    )
}

fun reconcilePiecePackage(previous: PieceSnapshot?, nextPackage: PiecePackage, nextSnapshot: PieceSnapshot): PieceReconcileResult {
    if (previous == null) {
        return PieceReconcileResult(
            changedTargets = nextPackage.targets.map { it.label }.sorted(),
            dirtyTargets = nextPackage.targets.map { it.label }.sorted(),
            reusedArtifacts = emptyList(),
            invalidatedArtifacts = nextPackage.artifacts.map { it.id }.sorted(),
        )
    }

    val changedTargets = nextSnapshot.targets.values
        .filter { next ->
            val old = previous.targets[next.label]
            old == null ||
                old.rule != next.rule ||
                old.depsHash != next.depsHash ||
                old.publicShapeHash != next.publicShapeHash ||
                old.implementationHash != next.implementationHash
        }
        .map { it.label }
        .sorted()

    val dirtyTargets = (changedTargets + nextPackage.toGraph().transitiveDependentsOf(changedTargets)).distinct().sorted()
    val dirtySet = dirtyTargets.toSet()
    val reusedArtifacts = nextPackage.artifacts.filter { it.target !in dirtySet }.map { it.id }.sorted()
    val invalidatedArtifacts = nextPackage.artifacts.filter { it.target in dirtySet }.map { it.id }.sorted()

    return PieceReconcileResult(
        changedTargets = changedTargets,
        dirtyTargets = dirtyTargets,
        reusedArtifacts = reusedArtifacts,
        invalidatedArtifacts = invalidatedArtifacts,
    )
}
