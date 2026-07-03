package piece.bridge

import kotlin.js.ExperimentalJsExport
import kotlin.js.JsExport
import piece.dsl.pieceFile
import piece.graph.toGraph
import piece.model.PieceAction
import piece.model.PieceArtifact
import piece.model.PieceEdgeKind
import piece.model.PieceGraph
import piece.model.PieceGraphEdge
import piece.model.PiecePackage
import piece.model.PieceRule
import piece.model.PieceTarget
import piece.model.PieceTargetKind

object NpmBridge {
    fun sampleKotlinPackage(filePath: String = "Pricing.kt"): PiecePackage {
        return pieceFile(filePath) {
            language = kotlin()
            target("renderGreeting") {
                rule = function()
                deps(":User", ":Greeting", ":prefix")
                action(feedback("analysis"))
            }
        }
    }
}

@OptIn(ExperimentalJsExport::class)
@JsExport
fun sampleKotlinPackageJson(filePath: String = "/repo/src/Pricing.kt"): String {
    return NpmBridge.sampleKotlinPackage(filePath).toJson()
}

@OptIn(ExperimentalJsExport::class)
@JsExport
fun createPiecePackageJson(filePath: String, language: String, targetSpecs: String): String {
    return packageFromTargetSpecs(filePath, language, targetSpecs).toJson()
}

@OptIn(ExperimentalJsExport::class)
@JsExport
fun createPieceGraphJson(filePath: String, language: String, targetSpecs: String): String {
    return packageFromTargetSpecs(filePath, language, targetSpecs).toGraph().toJson()
}

private data class TargetSpec(
    val kind: PieceTargetKind,
    val name: String,
    val deps: List<String>,
    val actionName: String,
)

private fun packageFromTargetSpecs(filePath: String, languageName: String, targetSpecs: String): PiecePackage {
    val specs = targetSpecs
        .lineSequence()
        .map { it.trim() }
        .filter { it.isNotEmpty() && !it.startsWith("#") }
        .map(::parseTargetSpec)
        .toList()

    return pieceFile(filePath) {
        language = languageName.ifBlank { "generic" }
        for (spec in specs) {
            target(spec.name) {
                rule = spec.kind
                if (spec.deps.isNotEmpty()) {
                    deps(*spec.deps.toTypedArray())
                }
                action(feedback(spec.actionName))
            }
        }
    }
}

private fun parseTargetSpec(line: String): TargetSpec {
    val parts = line.split('\t')
    require(parts.size >= 2) {
        "Target spec must be tab-separated as: kind<TAB>name<TAB>dep1,dep2<TAB>action"
    }
    return TargetSpec(
        kind = parseTargetKind(parts[0]),
        name = parts[1],
        deps = parts.getOrNull(2).orEmpty().split(',').map { it.trim() }.filter { it.isNotEmpty() },
        actionName = parts.getOrNull(3)?.takeIf { it.isNotBlank() } ?: "analysis",
    )
}

private fun parseTargetKind(value: String): PieceTargetKind {
    return when (value.lowercase()) {
        "type" -> PieceTargetKind.Type
        "class", "klass" -> PieceTargetKind.Class
        "function", "fun" -> PieceTargetKind.Function
        "value", "val", "var" -> PieceTargetKind.Value
        "effect" -> PieceTargetKind.Effect
        "header" -> PieceTargetKind.Header
        else -> error("Unsupported piece target kind: $value")
    }
}

private fun PiecePackage.toJson(): String {
    return buildJsonObject {
        field("version", version)
        field("kind", kind)
        field("language", language)
        field("packageName", packageName)
        field("label", label)
        field("filePath", filePath)
        field("sourceFile", sourceFile)
        field("rules", rules) { it.toJson() }
        field("targets", targets) { it.toJson() }
        field("actions", actions) { it.toJson() }
        field("artifacts", artifacts) { it.toJson() }
    }
}

private fun PieceRule.toJson(): String {
    return buildJsonObject {
        field("name", name)
        field("language", language)
        field("targetKind", targetKind.name.lowercase())
        field("actionKind", actionKind.name.lowercase())
        field("implementation", implementation)
    }
}

private fun PieceTarget.toJson(): String {
    return buildJsonObject {
        field("id", id)
        field("label", label)
        field("name", name)
        field("kind", kind.name.lowercase())
        field("rule", rule)
        field("source", source)
        field("deps", deps)
        field("runtimeDeps", runtimeDeps)
        field("typeDeps", typeDeps)
        field("externalDeps", externalDeps)
        field("actions", actions)
        field("artifacts", artifacts)
        field("visibility", visibility)
    }
}

private fun PieceAction.toJson(): String {
    return buildJsonObject {
        field("id", id)
        field("target", target)
        field("kind", kind.name.lowercase())
        field("mnemonic", mnemonic)
        field("inputs", inputs)
        field("outputs", outputs)
    }
}

private fun PieceArtifact.toJson(): String {
    return buildJsonObject {
        field("id", id)
        field("target", target)
        field("kind", kind)
        field("path", path)
        cacheKey?.let { field("cacheKey", it) }
    }
}

private fun PieceGraph.toJson(): String {
    return buildJsonObject {
        field("packageLabel", packageLabel)
        field("targets", targets) { it.toJson() }
        field("edges", edges) { it.toJson() }
    }
}

private fun PieceGraphEdge.toJson(): String {
    return buildJsonObject {
        field("from", from)
        field("to", to)
        field("kind", kind.toJsonValue())
        field("symbols", symbols)
    }
}

private fun PieceEdgeKind.toJsonValue(): String {
    return name.lowercase()
}

private class JsonObjectBuilder {
    private val fields = mutableListOf<String>()

    fun field(name: String, value: String) {
        fields += "${name.jsonString()}:${value.jsonString()}"
    }

    fun field(name: String, value: Number) {
        fields += "${name.jsonString()}:$value"
    }

    fun field(name: String, values: List<String>) {
        fields += "${name.jsonString()}:${values.joinToString(prefix = "[", postfix = "]") { it.jsonString() }}"
    }

    fun <T> field(name: String, values: List<T>, encode: (T) -> String) {
        fields += "${name.jsonString()}:${values.joinToString(prefix = "[", postfix = "]") { encode(it) }}"
    }

    fun build(): String = fields.joinToString(prefix = "{", postfix = "}")
}

private fun buildJsonObject(init: JsonObjectBuilder.() -> Unit): String {
    return JsonObjectBuilder().apply(init).build()
}

private fun String.jsonString(): String {
    val builder = StringBuilder(length + 2)
    builder.append('"')
    for (char in this) {
        when (char) {
            '\\' -> builder.append("\\\\")
            '"' -> builder.append("\\\"")
            '\b' -> builder.append("\\b")
            '\u000C' -> builder.append("\\f")
            '\n' -> builder.append("\\n")
            '\r' -> builder.append("\\r")
            '\t' -> builder.append("\\t")
            else -> {
                if (char.code < 0x20) {
                    builder.append("\\u")
                    builder.append(char.code.toString(16).padStart(4, '0'))
                } else {
                    builder.append(char)
                }
            }
        }
    }
    builder.append('"')
    return builder.toString()
}
