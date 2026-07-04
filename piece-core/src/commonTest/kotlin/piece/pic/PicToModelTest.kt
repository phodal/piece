package piece.pic

import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertTrue
import piece.model.PieceAction
import piece.model.PieceActionKind
import piece.model.PieceArtifact
import piece.model.PiecePackage
import piece.model.PieceRule
import piece.model.PieceTarget
import piece.model.PieceTargetKind

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

    @Test
    fun rendersPiecePackageIntoDeterministicPicDsl() {
        val pkg = PiecePackage(
            language = "kotlin",
            packageName = "repo/src",
            label = "//repo/src:Pricing.kt",
            filePath = "/repo/src/Pricing.kt",
            sourceFile = "//repo/src:Pricing.kt",
            rules = listOf(
                PieceRule(
                    name = "kotlin_piece_function",
                    language = "kotlin",
                    targetKind = PieceTargetKind.Function,
                    actionKind = PieceActionKind.Compile,
                    implementation = "kotlin.function.compile",
                ),
            ),
            targets = listOf(
                PieceTarget(
                    id = "/repo/src/Pricing.kt#function:renderGreeting",
                    label = "//repo/src:Pricing.kt__function_renderGreeting",
                    name = "renderGreeting",
                    kind = PieceTargetKind.Function,
                    rule = "kotlin_piece_function",
                    source = "//repo/src:Pricing.kt",
                    deps = listOf(
                        "//repo/src:Pricing.kt__class_Greeting",
                        "//repo/src:Pricing.kt__class_User",
                        "//repo/src:Pricing.kt__value_prefix",
                    ),
                    runtimeDeps = listOf("//repo/src:Pricing.kt__value_prefix"),
                    typeDeps = listOf(
                        "//repo/src:Pricing.kt__class_Greeting",
                        "//repo/src:Pricing.kt__class_User",
                    ),
                    externalDeps = listOf("demo.External"),
                    actions = listOf(
                        "//repo/src:Pricing.kt__function_renderGreeting%feedback",
                        "//repo/src:Pricing.kt__function_renderGreeting%compile",
                    ),
                    artifacts = listOf(
                        "//repo/src:Pricing.kt__function_renderGreeting.piece.json",
                        "//repo/src:Pricing.kt__function_renderGreeting.compile.json",
                    ),
                ),
            ),
            actions = listOf(
                PieceAction(
                    id = "//repo/src:Pricing.kt__function_renderGreeting%feedback",
                    target = "//repo/src:Pricing.kt__function_renderGreeting",
                    kind = PieceActionKind.Feedback,
                    inputs = listOf("//repo/src:Pricing.kt"),
                    outputs = listOf("//repo/src:Pricing.kt__function_renderGreeting.piece.json"),
                ),
                PieceAction(
                    id = "//repo/src:Pricing.kt__function_renderGreeting%compile",
                    target = "//repo/src:Pricing.kt__function_renderGreeting",
                    kind = PieceActionKind.Compile,
                    inputs = listOf("//repo/src:Pricing.kt"),
                    outputs = listOf("//repo/src:Pricing.kt__function_renderGreeting.compile.json"),
                ),
            ),
            artifacts = listOf(
                PieceArtifact(
                    id = "//repo/src:Pricing.kt__function_renderGreeting.piece.json",
                    target = "//repo/src:Pricing.kt__function_renderGreeting",
                    kind = "piece-feedback",
                    path = "repo/src__Pricing.kt__function_renderGreeting.piece.json",
                ),
                PieceArtifact(
                    id = "//repo/src:Pricing.kt__function_renderGreeting.compile.json",
                    target = "//repo/src:Pricing.kt__function_renderGreeting",
                    kind = "piece-compile",
                    path = "repo/src__Pricing.kt__function_renderGreeting.compile.json",
                ),
            ),
        )

        assertEquals(
            """
                package "//repo/src:Pricing.kt" {
                  language kotlin
                  source "/repo/src/Pricing.kt"

                  target function "renderGreeting" {
                    runtimeDeps "//repo/src:Pricing.kt__value_prefix"
                    typeDeps "//repo/src:Pricing.kt__class_Greeting", "//repo/src:Pricing.kt__class_User"
                    externalDeps "demo.External"
                    action feedback {}
                    action compile {}
                  }
                }
            """.trimIndent() + "\n",
            piecePackageToPicDsl(pkg),
        )
    }

    @Test
    fun appliesOverrideFieldsIntoPiecePackageAndPicDsl() {
        val document = PicDocument(
            packageLabel = "//repo/src:DashboardPage.tsx",
            language = "typescript",
            source = "/repo/src/DashboardPage.tsx",
            targets = listOf(
                PicTarget(PicTargetKind.Type, "UserCardProps"),
                PicTarget(
                    kind = PicTargetKind.Function,
                    name = "UserCard",
                    label = "//repo/src:dashboard_user_card",
                    visibility = listOf("//visibility:public"),
                    typeDeps = listOf(":UserCardProps"),
                    externalDeps = listOf("antd#Tag"),
                    actions = listOf(
                        PicAction(
                            kind = PicActionKind.Feedback,
                            mnemonic = "UserCardFixture",
                            path = "artifacts/user-card.fixture.json",
                            inputs = listOf("fixtures/user-card.json"),
                        ),
                    ),
                ),
            ),
        )

        val pkg = picDocumentToPiecePackage(document)
        val target = pkg.targets.single { it.name == "UserCard" }
        val action = pkg.actions.single { it.target == "//repo/src:dashboard_user_card" }
        val artifact = pkg.artifacts.single { it.target == "//repo/src:dashboard_user_card" }

        assertEquals("//repo/src:dashboard_user_card", target.label)
        assertEquals(listOf("//visibility:public"), target.visibility)
        assertEquals(
            listOf("//repo/src:DashboardPage.tsx__type_UserCardProps"),
            target.typeDeps,
        )
        assertEquals(
            listOf(
                "//repo/src:DashboardPage.tsx",
                "//repo/src:DashboardPage.tsx__type_UserCardProps",
                "antd#Tag",
                "fixtures/user-card.json",
            ),
            action.inputs,
        )
        assertEquals("UserCardFixture", action.mnemonic)
        assertEquals("artifacts/user-card.fixture.json", artifact.path)

        val pic = piecePackageToPicDsl(pkg)
        assertTrue(pic.contains("""label "//repo/src:dashboard_user_card""""))
        assertTrue(pic.contains("""visibility "//visibility:public""""))
        assertTrue(pic.contains("""inputs "fixtures/user-card.json""""))
        assertTrue(pic.contains("""path "artifacts/user-card.fixture.json""""))
    }
}
