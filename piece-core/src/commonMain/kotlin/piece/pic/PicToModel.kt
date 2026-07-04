package piece.pic

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

fun picDocumentToPiecePackage(document: PicDocument): PiecePackage {
    val packageName = packageNameFromLabel(document.packageLabel) ?: piecePackageName(document.source)
    val sourceLabel = pieceSourceLabel(document.source)
    val targetLabelsByName = document.targets.associate { target ->
        target.name to pieceTargetLabel(document.source, target.kind.toPieceTargetKind(), target.name)
    }
    val targets = document.targets.map { target ->
        val targetKind = target.kind.toPieceTargetKind()
        val label = pieceTargetLabel(document.source, targetKind, target.name)
        val normalizedDeps = target.normalizedDeps(packageName, targetLabelsByName)
        val normalizedRuntimeDeps = target.normalizedRuntimeDeps(packageName, targetLabelsByName)
        val normalizedTypeDeps = target.normalizedTypeDeps(packageName, targetLabelsByName)
        val actions = target.effectiveActions().map { action ->
            "$label%${action.name()}"
        }
        val artifacts = target.effectiveActions().map { action ->
            artifactId(label, action)
        }
        PieceTarget(
            id = "${document.source}#${targetKind.name.lowercase()}:${target.name}",
            label = label,
            name = target.name,
            kind = targetKind,
            rule = "${document.language}_piece_${targetKind.name.lowercase()}",
            source = sourceLabel,
            deps = normalizedDeps,
            runtimeDeps = normalizedRuntimeDeps,
            typeDeps = normalizedTypeDeps,
            externalDeps = target.externalDeps.distinct().sorted(),
            actions = actions,
            artifacts = artifacts,
        )
    }
    val rules = document.targets.map { target ->
        val targetKind = target.kind.toPieceTargetKind()
        val actionKind = target.primaryRuleAction().kind.toPieceActionKind()
        PieceRule(
            name = "${document.language}_piece_${targetKind.name.lowercase()}",
            language = document.language,
            targetKind = targetKind,
            actionKind = actionKind,
            implementation = "${document.language}.${targetKind.name.lowercase()}.${actionKind.name.lowercase()}",
        )
    }.distinctBy { it.name }.sortedBy { it.name }
    val actions = document.targets.flatMap { target ->
        val targetKind = target.kind.toPieceTargetKind()
        val label = pieceTargetLabel(document.source, targetKind, target.name)
        val normalizedDeps = target.normalizedDeps(packageName, targetLabelsByName)
        val externalDeps = target.externalDeps.distinct().sorted()
        target.effectiveActions().map { action ->
            val actionKind = action.kind.toPieceActionKind()
            val artifactId = artifactId(label, action)
            PieceAction(
                id = "$label%${action.name()}",
                target = label,
                kind = actionKind,
                mnemonic = action.mnemonic ?: "Piece${actionKind.name}",
                inputs = listOf(sourceLabel) + normalizedDeps + externalDeps,
                outputs = listOf(action.output ?: artifactId),
            )
        }
    }
    val artifacts = document.targets.flatMap { target ->
        val targetKind = target.kind.toPieceTargetKind()
        val label = pieceTargetLabel(document.source, targetKind, target.name)
        target.effectiveActions().map { action ->
            val artifactId = artifactId(label, action)
            PieceArtifact(
                id = artifactId,
                target = label,
                kind = "piece-${action.kind.name.lowercase()}",
                path = action.path ?: action.output ?: artifactId.replace("//", "").replace(":", "__"),
            )
        }
    }

    return PiecePackage(
        language = document.language,
        packageName = packageName,
        label = document.packageLabel,
        filePath = document.source,
        sourceFile = sourceLabel,
        rules = rules,
        targets = targets,
        actions = actions,
        artifacts = artifacts,
    )
}

private fun packageNameFromLabel(label: String): String? {
    if (!label.startsWith("//")) return null
    val separator = label.indexOf(':')
    if (separator < 0) return null
    return label.substring(2, separator).ifBlank { "." }
}

private fun PicTarget.effectiveActions(): List<PicAction> {
    return actions.ifEmpty { listOf(PicAction(PicActionKind.Feedback)) }
}

private fun PicTarget.primaryRuleAction(): PicAction {
    return effectiveActions().firstOrNull { it.kind == PicActionKind.Compile } ?: effectiveActions().first()
}

private fun PicTarget.normalizedDeps(packageName: String, targetLabelsByName: Map<String, String>): List<String> {
    return (
        deps.normalizedPackageDeps(packageName, targetLabelsByName) +
            runtimeDeps.normalizedPackageDeps(packageName, targetLabelsByName) +
            typeDeps.normalizedPackageDeps(packageName, targetLabelsByName)
        ).distinct().sorted()
}

private fun PicTarget.normalizedRuntimeDeps(packageName: String, targetLabelsByName: Map<String, String>): List<String> {
    if (runtimeDeps.isNotEmpty()) {
        return runtimeDeps.normalizedPackageDeps(packageName, targetLabelsByName)
    }
    return deps.normalizedPackageDeps(packageName, targetLabelsByName)
}

private fun PicTarget.normalizedTypeDeps(packageName: String, targetLabelsByName: Map<String, String>): List<String> {
    return typeDeps.normalizedPackageDeps(packageName, targetLabelsByName)
}

private fun List<String>.normalizedPackageDeps(packageName: String, targetLabelsByName: Map<String, String>): List<String> {
    return map { dep -> pieceNormalizeDep(packageName, dep, targetLabelsByName) }.distinct().sorted()
}

private fun PicAction.name(): String {
    return when (kind) {
        PicActionKind.Feedback -> "feedback"
        PicActionKind.Compile -> "compile"
        PicActionKind.Preview -> "preview"
        PicActionKind.Test -> "test"
        PicActionKind.Typecheck -> "typecheck"
        PicActionKind.Documentation -> "documentation"
    }
}

private fun artifactId(label: String, action: PicAction): String {
    return when (action.kind) {
        PicActionKind.Feedback -> "$label.piece.json"
        PicActionKind.Compile -> "$label.compile.json"
        else -> "$label.${action.name()}.json"
    }
}

private fun PicTargetKind.toPieceTargetKind(): PieceTargetKind {
    return when (this) {
        PicTargetKind.Type -> PieceTargetKind.Type
        PicTargetKind.Class -> PieceTargetKind.Class
        PicTargetKind.Function -> PieceTargetKind.Function
        PicTargetKind.Value -> PieceTargetKind.Value
        PicTargetKind.Effect -> PieceTargetKind.Effect
        PicTargetKind.Header -> PieceTargetKind.Header
    }
}

private fun PicActionKind.toPieceActionKind(): PieceActionKind {
    return when (this) {
        PicActionKind.Feedback -> PieceActionKind.Feedback
        PicActionKind.Compile -> PieceActionKind.Compile
        PicActionKind.Preview -> PieceActionKind.Preview
        PicActionKind.Test -> PieceActionKind.Test
        PicActionKind.Typecheck -> PieceActionKind.Typecheck
        PicActionKind.Documentation -> PieceActionKind.Documentation
    }
}
