package piece.kotlin;

import java.lang.reflect.Method;
import java.lang.reflect.Proxy;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.Collection;
import java.util.List;
import java.util.Map;
import java.util.TreeSet;

/**
 * Isolated JVM runner for the opt-in Kotlin Analysis API prototype.
 *
 * <p>The main backend is compiled against kotlin-compiler-embeddable, while Analysis API standalone
 * expects the unshaded Kotlin compiler and IntelliJ classes. This runner intentionally uses
 * reflection so the default build does not need Analysis API on the compile classpath.
 */
public final class KotlinAnalysisApiSymbolRunner {
    private KotlinAnalysisApiSymbolRunner() {
    }

    public static void main(String[] args) {
        try {
            if (args.length == 0) {
                throw new IllegalArgumentException("Usage: KotlinAnalysisApiSymbolRunner <primary-source> [source...]");
            }
            new Runner(args).run();
            System.exit(0);
        } catch (Throwable error) {
            error.printStackTrace(System.err);
            System.exit(1);
        }
    }

    private static final class Runner {
        private final String[] sourcePaths;
        private final Class<?> compilerConfigurationClass;
        private final Class<?> compilerConfigurationKeyClass;
        private final Class<?> function1Class;
        private final Class<?> disposableClass;
        private final Class<?> psiElementClass;
        private final Class<?> ktElementClass;
        private final Class<?> ktFileClass;
        private final Class<?> ktDeclarationClass;
        private final Class<?> ktNameReferenceExpressionClass;
        private final Class<?> ktTypeReferenceClass;
        private final Class<?> kaSessionClass;
        private final Class<?> kaSymbolClass;
        private final Class<?> kaSymbolBasedReferenceClass;
        private final Class<?> psiTreeUtilClass;

        Runner(String[] sourcePaths) throws ClassNotFoundException {
            this.sourcePaths = sourcePaths;
            compilerConfigurationClass = cls("org.jetbrains.kotlin.config.CompilerConfiguration");
            compilerConfigurationKeyClass = cls("org.jetbrains.kotlin.config.CompilerConfigurationKey");
            function1Class = cls("kotlin.jvm.functions.Function1");
            disposableClass = cls("com.intellij.openapi.Disposable");
            psiElementClass = cls("com.intellij.psi.PsiElement");
            ktElementClass = cls("org.jetbrains.kotlin.psi.KtElement");
            ktFileClass = cls("org.jetbrains.kotlin.psi.KtFile");
            ktDeclarationClass = cls("org.jetbrains.kotlin.psi.KtDeclaration");
            ktNameReferenceExpressionClass = cls("org.jetbrains.kotlin.psi.KtNameReferenceExpression");
            ktTypeReferenceClass = cls("org.jetbrains.kotlin.psi.KtTypeReference");
            kaSessionClass = cls("org.jetbrains.kotlin.analysis.api.KaSession");
            kaSymbolClass = cls("org.jetbrains.kotlin.analysis.api.symbols.KaSymbol");
            kaSymbolBasedReferenceClass = cls("org.jetbrains.kotlin.analysis.api.resolution.KaSymbolBasedReference");
            psiTreeUtilClass = cls("com.intellij.psi.util.PsiTreeUtil");
        }

        void run() throws Exception {
            Object config = compilerConfigurationClass.getConstructor().newInstance();
            Object moduleNameKey = cls("org.jetbrains.kotlin.config.CommonConfigurationKeys")
                .getField("MODULE_NAME")
                .get(null);
            compilerConfigurationClass
                .getMethod("put", compilerConfigurationKeyClass, Object.class)
                .invoke(config, moduleNameKey, "piece-analysis-api-prototype");
            Method addSourceRoot = cls("org.jetbrains.kotlin.cli.common.config.ContentRootsKt")
                .getMethod("addKotlinSourceRoot", compilerConfigurationClass, String.class);
            for (String sourcePath : sourcePaths) {
                addSourceRoot.invoke(null, config, sourcePath);
            }

            Object disposable = cls("com.intellij.openapi.util.Disposer")
                .getMethod("newDisposable")
                .invoke(null);
            try {
                Object session = buildSession(config, disposable);
                Object ktFile = findPrimaryKtFile(session, Path.of(sourcePaths[0]).getFileName().toString());
                emitSymbols(ktFile);
            } finally {
                cls("com.intellij.openapi.util.Disposer")
                    .getMethod("dispose", disposableClass)
                    .invoke(null, disposable);
            }
        }

        private Object buildSession(Object config, Object disposable) throws Exception {
            Object unit = cls("kotlin.Unit").getField("INSTANCE").get(null);
            Object builderLambda = Proxy.newProxyInstance(
                function1Class.getClassLoader(),
                new Class<?>[] { function1Class },
                (proxy, method, args) -> {
                    if ("invoke".equals(method.getName())) {
                        args[0].getClass()
                            .getMethod("buildKtModuleProviderByCompilerConfiguration", compilerConfigurationClass)
                            .invoke(args[0], config);
                        return unit;
                    }
                    if ("toString".equals(method.getName())) {
                        return "piece-analysis-api-session-builder";
                    }
                    if ("hashCode".equals(method.getName())) {
                        return System.identityHashCode(proxy);
                    }
                    if ("equals".equals(method.getName())) {
                        return proxy == args[0];
                    }
                    return null;
                }
            );
            return cls("org.jetbrains.kotlin.analysis.api.standalone.StandaloneAnalysisAPISessionBuilderKt")
                .getMethod("buildStandaloneAnalysisAPISession", disposableClass, boolean.class, function1Class)
                .invoke(null, disposable, false, builderLambda);
        }

        private Object findPrimaryKtFile(Object session, String primaryFileName) throws Exception {
            Map<?, ?> modulesWithFiles = (Map<?, ?>) session.getClass()
                .getMethod("getModulesWithFiles")
                .invoke(session);
            Object fallback = null;
            for (Object filesObject : modulesWithFiles.values()) {
                for (Object file : (List<?>) filesObject) {
                    if (fallback == null && ktFileClass.isInstance(file)) {
                        fallback = file;
                    }
                    Object name = file.getClass().getMethod("getName").invoke(file);
                    if (primaryFileName.equals(name)) {
                        return file;
                    }
                }
            }
            if (fallback != null) {
                return fallback;
            }
            throw new IllegalStateException("Analysis API session did not return a Kotlin source file.");
        }

        private void emitSymbols(Object ktFile) throws Exception {
            List<?> declarations = (List<?>) ktFileClass.getMethod("getDeclarations").invoke(ktFile);
            for (Object declaration : declarations) {
                String declarationName = nameOfDeclaration(declaration);
                if (declarationName == null || declarationName.isBlank()) {
                    continue;
                }
                SymbolBuckets symbols = collectDeclarationSymbols(declaration, declarationName);
                System.out.println(
                    "DECL\t" + declarationName +
                        "\t" + join(symbols.runtimeReferences) +
                        "\t" + join(symbols.typeReferences) +
                        "\t" + join(symbols.resolvedRuntimeNames) +
                        "\t" + join(symbols.resolvedTypeNames)
                );
            }
        }

        private SymbolBuckets collectDeclarationSymbols(Object declaration, String declarationName) throws Exception {
            SymbolBuckets buckets = new SymbolBuckets();
            Collection<?> references = (Collection<?>) psiTreeUtilClass
                .getMethod("findChildrenOfType", psiElementClass, Class.class)
                .invoke(null, declaration, ktNameReferenceExpressionClass);
            for (Object reference : references) {
                String referencedName = (String) ktNameReferenceExpressionClass
                    .getMethod("getReferencedName")
                    .invoke(reference);
                boolean typeReference = isInsideTypeReference(reference);
                ReferenceResolution resolution = resolveReference(reference);
                if (resolution.resolved) {
                    if (typeReference) {
                        buckets.resolvedTypeNames.add(referencedName);
                    } else {
                        buckets.resolvedRuntimeNames.add(referencedName);
                    }
                }
                for (String topLevelName : resolution.topLevelNames) {
                    if (declarationName.equals(topLevelName)) {
                        continue;
                    }
                    if (typeReference) {
                        buckets.typeReferences.add(topLevelName);
                    } else {
                        buckets.runtimeReferences.add(topLevelName);
                    }
                }
            }
            return buckets;
        }

        private ReferenceResolution resolveReference(Object reference) throws Exception {
            Object lambda = Proxy.newProxyInstance(
                function1Class.getClassLoader(),
                new Class<?>[] { function1Class },
                (proxy, method, args) -> {
                    if (!"invoke".equals(method.getName())) {
                        return null;
                    }
                    Object kaSession = args[0];
                    ReferenceResolution resolution = new ReferenceResolution();
                    Object[] psiReferences = (Object[]) reference.getClass()
                        .getMethod("getReferences")
                        .invoke(reference);
                    for (Object psiReference : psiReferences) {
                        if (!kaSymbolBasedReferenceClass.isInstance(psiReference)) {
                            continue;
                        }
                        Collection<?> symbols = (Collection<?>) kaSymbolBasedReferenceClass
                            .getMethod("resolveToSymbols", kaSessionClass)
                            .invoke(psiReference, kaSession);
                        if (!symbols.isEmpty()) {
                            resolution.resolved = true;
                        }
                        for (Object symbol : symbols) {
                            Object psi = kaSymbolClass.getMethod("getPsi").invoke(symbol);
                            String topLevelName = topLevelDeclarationName(psi);
                            if (topLevelName != null) {
                                resolution.topLevelNames.add(topLevelName);
                            }
                        }
                    }
                    return resolution;
                }
            );
            return (ReferenceResolution) cls("org.jetbrains.kotlin.analysis.api.AnalyzeKt")
                .getMethod("analyze", ktElementClass, function1Class)
                .invoke(null, reference, lambda);
        }

        private boolean isInsideTypeReference(Object reference) throws Exception {
            Object parent = psiTreeUtilClass
                .getMethod("getParentOfType", psiElementClass, Class.class, boolean.class)
                .invoke(null, reference, ktTypeReferenceClass, false);
            return parent != null;
        }

        private String topLevelDeclarationName(Object psi) throws Exception {
            Object current = psi;
            while (current != null) {
                Object parent = psiElementClass.getMethod("getParent").invoke(current);
                if (parent != null && ktFileClass.isInstance(parent)) {
                    return ktDeclarationClass.isInstance(current) ? nameOfDeclaration(current) : null;
                }
                current = parent;
            }
            return null;
        }

        private String nameOfDeclaration(Object declaration) throws Exception {
            Object name = ktDeclarationClass.getMethod("getName").invoke(declaration);
            return name == null ? null : name.toString();
        }

        private static Class<?> cls(String name) throws ClassNotFoundException {
            return Class.forName(name);
        }

        private static String join(TreeSet<String> values) {
            return String.join(",", values);
        }
    }

    private static final class SymbolBuckets {
        final TreeSet<String> runtimeReferences = new TreeSet<>();
        final TreeSet<String> typeReferences = new TreeSet<>();
        final TreeSet<String> resolvedRuntimeNames = new TreeSet<>();
        final TreeSet<String> resolvedTypeNames = new TreeSet<>();
    }

    private static final class ReferenceResolution {
        boolean resolved = false;
        final List<String> topLevelNames = new ArrayList<>();
    }
}
