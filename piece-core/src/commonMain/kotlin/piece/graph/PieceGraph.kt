package piece.graph

import piece.model.PieceEdgeKind
import piece.model.PieceGraph
import piece.model.PieceGraphEdge
import piece.model.PiecePackage

fun PiecePackage.toGraph(): PieceGraph {
    val edges = targets.flatMap { target ->
        target.runtimeDeps.map { dep ->
            PieceGraphEdge(from = target.label, to = dep, kind = PieceEdgeKind.Runtime)
        } + target.typeDeps.map { dep ->
            PieceGraphEdge(from = target.label, to = dep, kind = PieceEdgeKind.Type)
        } + target.externalDeps.map { dep ->
            PieceGraphEdge(from = target.label, to = dep, kind = PieceEdgeKind.External)
        }
    }.distinct().sortedWith(compareBy({ it.from }, { it.kind.name }, { it.to }))

    return PieceGraph(
        packageLabel = label,
        targets = targets,
        edges = edges,
    )
}

fun PieceGraph.reverseEdges(): Map<String, List<PieceGraphEdge>> {
    return edges.groupBy { it.to }
}

fun PieceGraph.transitiveDependentsOf(labels: Iterable<String>): List<String> {
    val reverse = reverseEdges()
    val queue = ArrayDeque(labels.toList())
    val visited = linkedSetOf<String>()
    while (queue.isNotEmpty()) {
        val current = queue.removeFirst()
        for (edge in reverse[current].orEmpty()) {
            if (visited.add(edge.from)) {
                queue.add(edge.from)
            }
        }
    }
    return visited.sorted()
}
