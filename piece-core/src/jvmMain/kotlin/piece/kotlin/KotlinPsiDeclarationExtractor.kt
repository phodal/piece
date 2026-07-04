package piece.kotlin

import org.jetbrains.kotlin.cli.common.messages.MessageCollector
import org.jetbrains.kotlin.cli.jvm.compiler.EnvironmentConfigFiles
import org.jetbrains.kotlin.cli.jvm.compiler.KotlinCoreEnvironment
import org.jetbrains.kotlin.com.intellij.openapi.util.Disposer
import org.jetbrains.kotlin.com.intellij.psi.util.PsiTreeUtil
import org.jetbrains.kotlin.config.CommonConfigurationKeys
import org.jetbrains.kotlin.config.CompilerConfiguration
import org.jetbrains.kotlin.psi.KtClass
import org.jetbrains.kotlin.psi.KtDeclaration
import org.jetbrains.kotlin.psi.KtDotQualifiedExpression
import org.jetbrains.kotlin.psi.KtFile
import org.jetbrains.kotlin.psi.KtNameReferenceExpression
import org.jetbrains.kotlin.psi.KtNamedFunction
import org.jetbrains.kotlin.psi.KtObjectDeclaration
import org.jetbrains.kotlin.psi.KtParameter
import org.jetbrains.kotlin.psi.KtProperty
import org.jetbrains.kotlin.psi.KtPsiFactory
import org.jetbrains.kotlin.psi.KtTypeAlias
import org.jetbrains.kotlin.psi.KtTypeReference
import org.jetbrains.kotlin.psi.psiUtil.collectDescendantsOfType
import piece.extract.DeclarationExtractor
import piece.extract.SourceFile
import piece.model.PieceAction
import piece.model.PieceActionKind
import piece.model.PieceArtifact
import piece.model.PiecePackage
import piece.model.PieceRule
import piece.model.PieceSourceRange
import piece.model.PieceTarget
import piece.model.PieceTargetKind
import piece.model.piecePackageName
import piece.model.pieceSourceLabel
import piece.model.pieceTargetLabel

class KotlinPsiDeclarationExtractor : DeclarationExtractor {
    override val name: String = "kotlin-psi-declaration-extractor"

    override fun extract(file: SourceFile): PiecePackage {
        return withKtFile(file) { ktFile ->
            val declarations = ktFile.declarations.mapNotNull { declaration ->
                declaration.toPieceDeclaration(file)
            }
            val labelsByName = declarations.associate { it.name to pieceTargetLabel(file.filePath, it.kind, it.name) }
            val packageName = piecePackageName(file.filePath)
            val sourceLabel = pieceSourceLabel(file.filePath)
            val targets = declarations.map { declaration ->
                declaration.toTarget(file.filePath, sourceLabel, labelsByName)
            }
            val rules = targets
                .map { PieceRule(name = it.rule, language = "kotlin", targetKind = it.kind) }
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

            PiecePackage(
                language = "kotlin",
                packageName = packageName,
                label = sourceLabel,
                filePath = file.filePath,
                sourceFile = sourceLabel,
                rules = rules,
                targets = targets,
                actions = actions,
                artifacts = artifacts,
            )
        }
    }
}

internal data class KotlinPieceDeclaration(
    val name: String,
    val kind: PieceTargetKind,
    val range: PieceSourceRange,
    val runtimeReferences: List<String>,
    val typeReferences: List<String>,
)

private fun KotlinPieceDeclaration.toTarget(
    filePath: String,
    sourceLabel: String,
    labelsByName: Map<String, String>,
): PieceTarget {
    val label = pieceTargetLabel(filePath, kind, name)
    val runtimeDeps = runtimeReferences.mapNotNull(labelsByName::get).filterNot { it == label }.distinct().sorted()
    val typeDeps = typeReferences.mapNotNull(labelsByName::get).filterNot { it == label }.distinct().sorted()
    val knownReferences = runtimeReferences + typeReferences
    val externalDeps = knownReferences
        .filterNot { labelsByName.containsKey(it) }
        .filterNot { it in KOTLIN_STDLIB_NAMES }
        .distinct()
        .sorted()
    val deps = (runtimeDeps + typeDeps).distinct().sorted()
    val actionId = "$label%feedback"
    val artifactId = "$label.piece.json"

    return PieceTarget(
        id = "$filePath#${kind.name.lowercase()}:$name",
        label = label,
        name = name,
        kind = kind,
        rule = "kotlin_piece_${kind.name.lowercase()}",
        source = sourceLabel,
        deps = deps,
        runtimeDeps = runtimeDeps,
        typeDeps = typeDeps,
        externalDeps = externalDeps,
        actions = listOf(actionId),
        artifacts = listOf(artifactId),
    )
}

internal fun KtDeclaration.toPieceDeclaration(file: SourceFile): KotlinPieceDeclaration? {
    val name = name ?: return null
    val kind = when (this) {
        is KtClass -> if (isInterface()) PieceTargetKind.Type else PieceTargetKind.Class
        is KtObjectDeclaration -> PieceTargetKind.Class
        is KtNamedFunction -> PieceTargetKind.Function
        is KtProperty -> PieceTargetKind.Value
        is KtTypeAlias -> PieceTargetKind.Type
        else -> return null
    }
    val localNames = collectLocalNames(name)
    val typeReferences = collectTypeReferences(localNames)
    val runtimeReferences = collectRuntimeReferences(localNames, typeReferences)

    return KotlinPieceDeclaration(
        name = name,
        kind = kind,
        range = sourceRange(file.source, textRange.startOffset, textRange.endOffset),
        runtimeReferences = runtimeReferences,
        typeReferences = typeReferences,
    )
}

private fun KtDeclaration.collectLocalNames(selfName: String): Set<String> {
    val names = linkedSetOf(selfName)
    collectDescendantsOfType<KtParameter>().mapNotNullTo(names) { it.name }
    collectDescendantsOfType<KtProperty>().mapNotNullTo(names) { it.name }
    collectDescendantsOfType<KtNamedFunction>().mapNotNullTo(names) { it.name }
    return names
}

private fun KtDeclaration.collectTypeReferences(localNames: Set<String>): List<String> {
    return collectDescendantsOfType<KtTypeReference>()
        .flatMap { typeReference ->
            typeReference.collectDescendantsOfType<KtNameReferenceExpression>().map { it.getReferencedName() }
        }
        .filterUsefulReference(localNames)
}

private fun KtDeclaration.collectRuntimeReferences(localNames: Set<String>, typeReferences: List<String>): List<String> {
    val typeReferenceSet = typeReferences.toSet()
    return collectDescendantsOfType<KtNameReferenceExpression>()
        .filterNot { it.isInsideTypeReference() }
        .filterNot { it.isQualifiedSelector() }
        .map { it.getReferencedName() }
        .filterUsefulReference(localNames + typeReferenceSet)
}

private fun Iterable<String>.filterUsefulReference(excluded: Set<String>): List<String> {
    return filterNot { it in excluded }
        .filterNot { it in KOTLIN_KEYWORDS }
        .filterNot { it in KOTLIN_STDLIB_NAMES }
        .distinct()
        .sorted()
}

private fun KtNameReferenceExpression.isInsideTypeReference(): Boolean {
    return PsiTreeUtil.getParentOfType(this, KtTypeReference::class.java, false) != null
}

private fun KtNameReferenceExpression.isQualifiedSelector(): Boolean {
    val parentExpression = parent
    val dotQualified = when (parentExpression) {
        is KtDotQualifiedExpression -> parentExpression
        else -> parentExpression?.parent as? KtDotQualifiedExpression
    }
    val selector = dotQualified?.selectorExpression ?: return false
    return selector.textRange.contains(textRange)
}

internal fun sourceRange(source: String, startByte: Int, endByte: Int): PieceSourceRange {
    return PieceSourceRange(
        startByte = startByte,
        endByte = endByte,
        startLine = lineNumberAt(source, startByte),
        endLine = lineNumberAt(source, endByte),
    )
}

internal fun lineNumberAt(source: String, offset: Int): Int {
    return source.take(offset.coerceIn(0, source.length)).count { it == '\n' } + 1
}

internal inline fun <T> withKtFile(file: SourceFile, block: (KtFile) -> T): T {
    val disposable = Disposer.newDisposable()
    try {
        val configuration = CompilerConfiguration().apply {
            put(CommonConfigurationKeys.MODULE_NAME, "piece-core")
            put(CommonConfigurationKeys.MESSAGE_COLLECTOR_KEY, MessageCollector.NONE)
        }
        val environment = KotlinCoreEnvironment.createForProduction(
            disposable,
            configuration,
            EnvironmentConfigFiles.JVM_CONFIG_FILES,
        )
        val ktFile = KtPsiFactory(environment.project, markGenerated = false)
            .createFile(file.filePath.substringAfterLast('/'), file.source)
        return block(ktFile)
    } finally {
        Disposer.dispose(disposable)
    }
}

private val KOTLIN_KEYWORDS = setOf(
    "abstract",
    "actual",
    "annotation",
    "as",
    "break",
    "by",
    "catch",
    "class",
    "companion",
    "const",
    "constructor",
    "continue",
    "data",
    "do",
    "dynamic",
    "else",
    "enum",
    "expect",
    "external",
    "false",
    "final",
    "finally",
    "for",
    "fun",
    "if",
    "import",
    "in",
    "infix",
    "init",
    "inline",
    "inner",
    "interface",
    "internal",
    "is",
    "lateinit",
    "noinline",
    "null",
    "object",
    "open",
    "operator",
    "out",
    "override",
    "package",
    "private",
    "protected",
    "public",
    "reified",
    "return",
    "sealed",
    "super",
    "suspend",
    "tailrec",
    "this",
    "throw",
    "true",
    "try",
    "typealias",
    "val",
    "var",
    "vararg",
    "when",
    "where",
    "while",
)

private val KOTLIN_STDLIB_NAMES = setOf(
    "Any",
    "Array",
    "Boolean",
    "Byte",
    "Char",
    "CharSequence",
    "Collection",
    "Double",
    "Float",
    "Int",
    "Iterable",
    "List",
    "Long",
    "Map",
    "MutableList",
    "MutableMap",
    "MutableSet",
    "Nothing",
    "Pair",
    "Sequence",
    "Set",
    "Short",
    "String",
    "Triple",
    "Unit",
    "emptyList",
    "emptyMap",
    "emptySet",
    "listOf",
    "mapOf",
    "mutableListOf",
    "mutableMapOf",
    "mutableSetOf",
    "println",
    "setOf",
)
