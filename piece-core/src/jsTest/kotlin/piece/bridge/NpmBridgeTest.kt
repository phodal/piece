package piece.bridge

import kotlin.test.Test
import kotlin.test.assertContains
import kotlin.test.assertTrue

class NpmBridgeTest {
    @Test
    fun exportsPackageJsonForJavaScriptHosts() {
        val packageJson = createPiecePackageJson(
            filePath = "/repo/src/Pricing.kt",
            language = "kotlin",
            targetSpecs = listOf(
                "class\tUser\t\tanalysis",
                "class\tGreeting\t\tanalysis",
                "value\tprefix\t\tanalysis",
                "function\trenderGreeting\t:User,:Greeting,:prefix\tanalysis",
            ).joinToString("\n"),
        )

        assertContains(packageJson, "\"label\":\"//repo/src:Pricing.kt\"")
        assertContains(packageJson, "\"label\":\"//repo/src:Pricing.kt__function_renderGreeting\"")
        assertContains(packageJson, "\"//repo/src:Pricing.kt__class_Greeting\"")
        assertContains(packageJson, "\"//repo/src:Pricing.kt__class_User\"")
        assertContains(packageJson, "\"//repo/src:Pricing.kt__value_prefix\"")
    }

    @Test
    fun exportsGraphJsonForJavaScriptHosts() {
        val graphJson = createPieceGraphJson(
            filePath = "/repo/src/Pricing.kt",
            language = "kotlin",
            targetSpecs = "value\tprefix\t\tanalysis\nfunction\trenderGreeting\t:prefix\tanalysis",
        )

        assertContains(graphJson, "\"packageLabel\":\"//repo/src:Pricing.kt\"")
        assertContains(graphJson, "\"from\":\"//repo/src:Pricing.kt__function_renderGreeting\"")
        assertContains(graphJson, "\"to\":\"//repo/src:Pricing.kt__value_prefix\"")
        assertTrue(graphJson.contains("\"kind\":\"runtime\"") || graphJson.contains("\"kind\":\"type\""))
    }

    @Test
    fun exportsCompileActionsForGeneratedTargetSpecs() {
        val packageJson = createPiecePackageJson(
            filePath = "/repo/src/Pricing.kt",
            language = "kotlin",
            targetSpecs = "function\trenderGreeting\t\tcompile\tcompile",
        )

        assertContains(packageJson, "\"actionKind\":\"compile\"")
        assertContains(packageJson, "\"id\":\"//repo/src:Pricing.kt__function_renderGreeting%compile\"")
        assertContains(packageJson, "\"kind\":\"compile\"")
        assertContains(packageJson, "\"mnemonic\":\"PieceCompile\"")
        assertContains(packageJson, "\"kind\":\"piece-compile\"")
    }
}
