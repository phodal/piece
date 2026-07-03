package piece.dsl

import kotlin.test.Test
import kotlin.test.assertEquals
import piece.graph.toGraph
import piece.reconcile.reconcilePiecePackage
import piece.reconcile.toSnapshot

class PieceDslTest {
    @Test
    fun createsSingleFileBazelLikePackage() {
        val pkg = pieceFile("/repo/src/Pricing.kt") {
            language = kotlin()
            target("User") {
                rule = klass()
            }
            target("Greeting") {
                rule = klass()
            }
            target("prefix") {
                rule = value()
            }
            target("renderGreeting") {
                rule = function()
                deps(":User", ":Greeting", ":prefix")
                action(feedback("analysis"))
            }
        }

        assertEquals("//repo/src:Pricing.kt", pkg.label)
        assertEquals(
            "//repo/src:Pricing.kt__function_renderGreeting",
            pkg.targets.first { it.name == "renderGreeting" }.label,
        )
        assertEquals(
            listOf(
                "//repo/src:Pricing.kt__class_Greeting",
                "//repo/src:Pricing.kt__class_User",
                "//repo/src:Pricing.kt__value_prefix",
            ),
            pkg.targets.first { it.name == "renderGreeting" }.deps,
        )
    }

    @Test
    fun reconcilesDirtyTargetsThroughGraphDependents() {
        val previous = pieceFile("/repo/src/Pricing.kt") {
            language = kotlin()
            target("prefix") {
                rule = value()
            }
            target("renderGreeting") {
                rule = function()
                deps(":prefix")
            }
        }
        val next = previous
        val previousSnapshot = previous.toSnapshot(
            sourceHash = "before",
            implementationHashes = mapOf("//repo/src:Pricing.kt__value_prefix" to "a"),
        )
        val nextSnapshot = next.toSnapshot(
            sourceHash = "after",
            implementationHashes = mapOf("//repo/src:Pricing.kt__value_prefix" to "b"),
        )

        val result = reconcilePiecePackage(previousSnapshot, next, nextSnapshot)
        val graph = next.toGraph()

        assertEquals(
            listOf("//repo/src:Pricing.kt__value_prefix"),
            result.changedTargets,
        )
        assertEquals(
            listOf("//repo/src:Pricing.kt__function_renderGreeting", "//repo/src:Pricing.kt__value_prefix"),
            result.dirtyTargets,
        )
        assertEquals(1, graph.edges.size)
    }
}
