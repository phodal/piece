@file:Suppress("DEPRECATION")

package piece.kotlin

import org.jetbrains.kotlin.cli.common.config.addKotlinSourceRoot
import org.jetbrains.kotlin.cli.common.messages.MessageCollector
import org.jetbrains.kotlin.cli.jvm.compiler.EnvironmentConfigFiles
import org.jetbrains.kotlin.cli.jvm.compiler.CliBindingTrace
import org.jetbrains.kotlin.cli.jvm.compiler.KotlinCoreEnvironment
import org.jetbrains.kotlin.cli.jvm.compiler.TopDownAnalyzerFacadeForJVM
import org.jetbrains.kotlin.cli.jvm.config.addJvmClasspathRoot
import org.jetbrains.kotlin.com.intellij.openapi.util.Disposer
import org.jetbrains.kotlin.com.intellij.psi.util.PsiTreeUtil
import org.jetbrains.kotlin.config.CommonConfigurationKeys
import org.jetbrains.kotlin.config.CompilerConfiguration
import org.jetbrains.kotlin.descriptors.DeclarationDescriptor
import org.jetbrains.kotlin.descriptors.ModuleDescriptor
import org.jetbrains.kotlin.descriptors.PackageFragmentDescriptor
import org.jetbrains.kotlin.psi.KtCallExpression
import org.jetbrains.kotlin.psi.KtDeclaration
import org.jetbrains.kotlin.psi.KtNameReferenceExpression
import org.jetbrains.kotlin.psi.KtTypeReference
import org.jetbrains.kotlin.psi.psiUtil.collectDescendantsOfType
import org.jetbrains.kotlin.resolve.BindingContext
import java.io.File
import java.nio.file.Files
import java.nio.file.Path
import java.util.Locale
import kotlin.io.path.ExperimentalPathApi
import kotlin.io.path.createDirectories
import kotlin.io.path.deleteRecursively
import kotlin.io.path.writeText

data class KotlinBindingSymbolRequest(
    val filePath: String,
    val source: String,
    val companionFiles: List<KotlinBindingSourceFile> = emptyList(),
    val classpath: List<String> = defaultKotlinSemanticClasspath(),
)

data class KotlinBindingSourceFile(
    val filePath: String,
    val source: String,
)

data class KotlinBindingSymbolResult(
    val symbolsByDeclaration: Map<String, KotlinSemanticSymbols>,
    val importBindings: List<KotlinPsiImportBinding> = emptyList(),
    val diagnostics: List<KotlinPsiDiagnostic> = emptyList(),
)

data class KotlinSemanticSymbols(
    val runtimeReferences: List<String> = emptyList(),
    val typeReferences: List<String> = emptyList(),
    val resolvedRuntimeNames: List<String> = emptyList(),
    val resolvedTypeNames: List<String> = emptyList(),
    val importBindings: List<KotlinPsiImportBinding> = emptyList(),
)

internal class KotlinBindingSymbolBackend {
    fun symbols(request: KotlinBindingSymbolRequest): KotlinBindingSymbolResult {
        val workspace = Files.createTempDirectory("piece-kotlin-binding-")
        val disposable = Disposer.newDisposable()
        return try {
            val sourceFile = workspace.resolve("primary").resolve(sourceName(request.filePath, "Main.kt"))
            workspace.createDirectories()
            sourceFile.parent.createDirectories()
            sourceFile.writeText(request.source)
            val sourcePathKey = workspacePathKey(sourceFile.toString())
            val virtualPathByActualPath = mutableMapOf(sourcePathKey to request.filePath)
            val companionSourceFiles = request.companionFiles
                .filterNot { it.filePath == request.filePath }
                .mapIndexed { index, companion ->
                    val companionFile = workspace
                        .resolve("companions")
                        .resolve("${index}-${sourceName(companion.filePath, "Companion.kt")}")
                    companionFile.parent.createDirectories()
                    companionFile.writeText(companion.source)
                    virtualPathByActualPath[workspacePathKey(companionFile.toString())] = companion.filePath
                    companionFile
                }
            val allSourceFiles = listOf(sourceFile) + companionSourceFiles

            val configuration = CompilerConfiguration().apply {
                put(CommonConfigurationKeys.MODULE_NAME, "piece-semantic-symbols")
                put(CommonConfigurationKeys.MESSAGE_COLLECTOR_KEY, MessageCollector.NONE)
                allSourceFiles.forEach { file -> addKotlinSourceRoot(file.toString()) }
                request.classpath
                    .filter { it.isNotBlank() }
                    .map(::File)
                    .filter { it.exists() }
                    .forEach(::addJvmClasspathRoot)
            }
            // FE10 BindingContext is a pinned Kotlin 2.2 fallback until a standalone Analysis API artifact is available.
            val environment = KotlinCoreEnvironment.createForProduction(
                disposable,
                configuration,
                EnvironmentConfigFiles.JVM_CONFIG_FILES,
            )
            val sourceFiles = environment.getSourceFiles()
            val sourceKtFile = sourceFiles.firstOrNull {
                workspacePathKey(it.virtualFilePath) == sourcePathKey
            } ?: sourceFiles.firstOrNull()
                ?: return KotlinBindingSymbolResult(emptyMap())
            val analysis = TopDownAnalyzerFacadeForJVM.analyzeFilesWithJavaIntegration(
                project = environment.project,
                files = sourceFiles,
                trace = CliBindingTrace(environment.project),
                configuration = configuration,
                packagePartProvider = { scope -> environment.createPackagePartProvider(scope) },
            )
            val bindingContext = analysis.bindingContext
            val descriptorToDeclaration = sourceKtFile.declarations
                .mapNotNull { declaration ->
                    val name = declaration.name ?: return@mapNotNull null
                    val descriptor = bindingContext.get(BindingContext.DECLARATION_TO_DESCRIPTOR, declaration)?.topLevelOriginal()
                        ?: return@mapNotNull null
                    descriptor to name
                }
                .toMap()
            val descriptorToExternalBinding = sourceFiles
                .filterNot { ktFile -> ktFile == sourceKtFile }
                .flatMap { ktFile ->
                    val virtualPath = virtualPathByActualPath[workspacePathKey(ktFile.virtualFilePath)] ?: ktFile.virtualFilePath
                    ktFile.declarations.mapNotNull { declaration ->
                        val name = declaration.name ?: return@mapNotNull null
                        val descriptor = bindingContext.get(BindingContext.DECLARATION_TO_DESCRIPTOR, declaration)?.topLevelOriginal()
                            ?: return@mapNotNull null
                        descriptor to KotlinPsiImportBinding(
                            local = name,
                            imported = name,
                            source = virtualPath,
                            kind = "named",
                            isTypeOnly = false,
                        )
                    }
                }
                .toMap()

            val symbolsByDeclaration = sourceKtFile.declarations
                .mapNotNull { declaration ->
                    val name = declaration.name ?: return@mapNotNull null
                    name to declaration.collectSemanticSymbols(
                        bindingContext = bindingContext,
                        descriptorToDeclaration = descriptorToDeclaration,
                        descriptorToExternalBinding = descriptorToExternalBinding,
                    )
                }
                .toMap()
            KotlinBindingSymbolResult(
                symbolsByDeclaration = symbolsByDeclaration,
                importBindings = symbolsByDeclaration.values
                    .flatMap { it.importBindings }
                    .distinctBy { "${it.local}:${it.imported}:${it.source}:${it.kind}:${it.isTypeOnly}:${it.signature.orEmpty()}" }
                    .sortedWith(compareBy({ it.source }, { it.imported }, { it.local }, { it.signature.orEmpty() })),
            )
        } catch (error: Throwable) {
            KotlinBindingSymbolResult(
                symbolsByDeclaration = emptyMap(),
                diagnostics = listOf(
                    KotlinPsiDiagnostic(
                        code = "kotlin-binding-symbol-analysis-error",
                        severity = "warning",
                        message = error.message ?: error::class.java.name,
                        path = request.filePath,
                    ),
                ),
            )
        } finally {
            Disposer.dispose(disposable)
            workspace.deleteRecursivelyIfExists()
        }
    }
}

private fun workspacePathKey(path: String): String {
    val normalized = Path.of(path).toAbsolutePath().normalize().toString().replace('\\', '/')
    return if (File.separatorChar == '\\') normalized.lowercase(Locale.ROOT) else normalized
}

private fun KtDeclaration.collectSemanticSymbols(
    bindingContext: BindingContext,
    descriptorToDeclaration: Map<DeclarationDescriptor, String>,
    descriptorToExternalBinding: Map<DeclarationDescriptor, KotlinPsiImportBinding>,
): KotlinSemanticSymbols {
    val runtimeReferences = linkedSetOf<String>()
    val typeReferences = linkedSetOf<String>()
    val resolvedRuntimeNames = linkedSetOf<String>()
    val resolvedTypeNames = linkedSetOf<String>()
    val importBindings = linkedMapOf<String, KotlinPsiImportBinding>()

    for (reference in collectDescendantsOfType<KtNameReferenceExpression>()) {
        val referencedName = reference.getReferencedName()
        val isTypeReference = reference.isInsideTypeReference()
        val resolvedDescriptor = reference.resolveTargetDescriptor(bindingContext)?.topLevelOriginal()
        if (resolvedDescriptor != null) {
            if (isTypeReference) {
                resolvedTypeNames += referencedName
            } else {
                resolvedRuntimeNames += referencedName
            }
        }
        val localDeclaration = resolvedDescriptor?.let(descriptorToDeclaration::get)
        if (localDeclaration != null && localDeclaration != name) {
            if (isTypeReference) {
                typeReferences += localDeclaration
            } else {
                runtimeReferences += localDeclaration
            }
        } else {
            val externalBinding = resolvedDescriptor?.let(descriptorToExternalBinding::get)
            if (externalBinding != null) {
                importBindings["${externalBinding.local}:${externalBinding.imported}:${externalBinding.source}:${externalBinding.isTypeOnly}:${externalBinding.signature.orEmpty()}"] = externalBinding
            }
        }
    }

    return KotlinSemanticSymbols(
        runtimeReferences = runtimeReferences.sorted(),
        typeReferences = typeReferences.sorted(),
        resolvedRuntimeNames = resolvedRuntimeNames.sorted(),
        resolvedTypeNames = resolvedTypeNames.sorted(),
        importBindings = importBindings.values.sortedWith(compareBy({ it.source }, { it.imported }, { it.local }, { it.signature.orEmpty() })),
    )
}

private fun sourceName(filePath: String, fallback: String): String {
    return filePath.replace('\\', '/').substringAfterLast('/').ifBlank { fallback }
}

private fun KtNameReferenceExpression.resolveTargetDescriptor(bindingContext: BindingContext): DeclarationDescriptor? {
    bindingContext.get(BindingContext.REFERENCE_TARGET, this)?.let { return it }
    val callExpression = parent as? KtCallExpression ?: parent?.parent as? KtCallExpression ?: return null
    if (callExpression.calleeExpression != this) return null
    bindingContext.get(BindingContext.REFERENCE_TARGET, callExpression)?.let { return it }
    val call = bindingContext.get(BindingContext.CALL, callExpression)
        ?: bindingContext.get(BindingContext.CALL, this)
        ?: return null
    return bindingContext.get(BindingContext.RESOLVED_CALL, call)?.resultingDescriptor
}

private fun KtNameReferenceExpression.isInsideTypeReference(): Boolean {
    return PsiTreeUtil.getParentOfType(this, KtTypeReference::class.java, false) != null
}

private fun DeclarationDescriptor.topLevelOriginal(): DeclarationDescriptor {
    var current = original
    while (true) {
        val parent = current.containingDeclaration?.original ?: return current
        if (parent is PackageFragmentDescriptor || parent is ModuleDescriptor) {
            return current
        }
        current = parent
    }
}

@OptIn(ExperimentalPathApi::class)
private fun Path.deleteRecursivelyIfExists() {
    if (Files.exists(this)) {
        deleteRecursively()
    }
}
