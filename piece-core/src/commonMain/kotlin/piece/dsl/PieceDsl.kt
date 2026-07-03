package piece.dsl

import piece.model.PieceAction
import piece.model.PieceActionKind
import piece.model.PieceArtifact
import piece.model.PiecePackage
import piece.model.PieceRule
import piece.model.PieceTarget
import piece.model.PieceTargetKind
import piece.model.pieceNormalizeDep
import piece.model.piecePackageName
import piece.model.pieceSourceLabel
import piece.model.pieceTargetLabel

@DslMarker
annotation class PieceDsl

fun pieceFile(filePath: String, init: PieceFileBuilder.() -> Unit): PiecePackage {
    return PieceFileBuilder(filePath).apply(init).build()
}

@PieceDsl
class PieceFileBuilder(private val filePath: String) {
    var language: String = "generic"
    private val targetBuilders = mutableListOf<PieceTargetBuilder>()

    fun kotlin(): String = "kotlin"

    fun typescript(): String = "typescript"

    fun javascript(): String = "javascript"

    fun target(name: String, init: PieceTargetBuilder.() -> Unit) {
        targetBuilders += PieceTargetBuilder(filePath, name).apply(init)
    }

    fun build(): PiecePackage {
        val packageName = piecePackageName(filePath)
        val sourceLabel = pieceSourceLabel(filePath)
        val targetLabelsByName = targetBuilders.associate { builder ->
            builder.name to pieceTargetLabel(filePath, builder.rule, builder.name)
        }
        val targets = targetBuilders.map { it.build(language, packageName, sourceLabel, targetLabelsByName) }
        val rules = targets
            .map { PieceRule(name = it.rule, language = language, targetKind = it.kind) }
            .distinctBy { it.name }
            .sortedBy { it.name }
        val actions = targets.flatMap { target ->
            target.actions.map { actionId ->
                PieceAction(
                    id = actionId,
                    target = target.label,
                    kind = PieceActionKind.Feedback,
                    inputs = listOf(target.source) + target.deps + target.externalDeps,
                    outputs = target.artifacts,
                )
            }
        }
        val artifacts = targets.flatMap { target ->
            target.artifacts.map { artifactId ->
                PieceArtifact(
                    id = artifactId,
                    target = target.label,
                    kind = "piece-feedback",
                    path = artifactId.replace("//", "").replace(":", "__"),
                )
            }
        }
        return PiecePackage(
            language = language,
            packageName = packageName,
            label = sourceLabel,
            filePath = filePath,
            sourceFile = sourceLabel,
            rules = rules,
            targets = targets,
            actions = actions,
            artifacts = artifacts,
        )
    }
}

@PieceDsl
class PieceTargetBuilder(private val filePath: String, internal val name: String) {
    var rule: PieceTargetKind = PieceTargetKind.Function
    private val deps = mutableListOf<String>()
    private var actionName: String = "analysis"

    fun type(): PieceTargetKind = PieceTargetKind.Type

    fun klass(): PieceTargetKind = PieceTargetKind.Class

    fun function(): PieceTargetKind = PieceTargetKind.Function

    fun value(): PieceTargetKind = PieceTargetKind.Value

    fun deps(vararg labels: String) {
        deps += labels
    }

    fun feedback(name: String): String = name

    fun action(name: String) {
        actionName = name
    }

    fun build(language: String, packageName: String, sourceLabel: String, targetLabelsByName: Map<String, String>): PieceTarget {
        val ruleName = "${language}_piece_${rule.name.lowercase()}"
        val label = pieceTargetLabel(filePath, rule, name)
        val normalizedDeps = deps.map { pieceNormalizeDep(packageName, it, targetLabelsByName) }.sorted()
        val actionId = "$label%$actionName"
        val artifactId = "$label.piece.json"
        return PieceTarget(
            id = "$filePath#${rule.name.lowercase()}:$name",
            label = label,
            name = name,
            kind = rule,
            rule = ruleName,
            source = sourceLabel,
            deps = normalizedDeps,
            runtimeDeps = normalizedDeps,
            actions = listOf(actionId),
            artifacts = listOf(artifactId),
        )
    }
}
