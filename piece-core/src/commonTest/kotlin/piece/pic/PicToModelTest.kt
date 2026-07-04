package piece.pic

import kotlin.test.Test
import kotlin.test.assertEquals

class PicToModelTest {
    @Test
    fun convertsPicAstIntoPiecePackage() {
        val document = PicDocument(
            packageLabel = "//repo/src:Pricing.kt",
            language = "kotlin",
            source = "/repo/src/Pricing.kt",
            targets = listOf(
                PicTarget(PicTargetKind.Class, "User"),
                PicTarget(PicTargetKind.Class, "Greeting"),
                PicTarget(PicTargetKind.Value, "prefix"),
                PicTarget(
                    kind = PicTargetKind.Function,
                    name = "renderGreeting",
                    deps = listOf(":User", ":Greeting", ":prefix"),
                    actions = listOf(
                        PicAction(
                            kind = PicActionKind.Compile,
                            mnemonic = "PieceCompile",
                            output = "Pricing.kt__function_renderGreeting.compile.json",
                        ),
                    ),
                ),
            ),
        )

        val pkg = picDocumentToPiecePackage(document)

        assertEquals("//repo/src:Pricing.kt", pkg.label)
        assertEquals("kotlin", pkg.language)
        assertEquals(
            listOf(
                "//repo/src:Pricing.kt__class_Greeting",
                "//repo/src:Pricing.kt__class_User",
                "//repo/src:Pricing.kt__value_prefix",
            ),
            pkg.targets.first { it.name == "renderGreeting" }.deps,
        )
        assertEquals(
            "//repo/src:Pricing.kt__function_renderGreeting%compile",
            pkg.actions.single { it.kind.name == "Compile" }.id,
        )
        assertEquals("PieceCompile", pkg.actions.single { it.kind.name == "Compile" }.mnemonic)
        assertEquals(
            "Pricing.kt__function_renderGreeting.compile.json",
            pkg.artifacts.single { it.kind == "piece-compile" }.path,
        )
        assertEquals(
            "//repo/src:Pricing.kt__class_User%feedback",
            pkg.actions.single { it.target == "//repo/src:Pricing.kt__class_User" }.id,
        )
    }
}
