import { analyzePieceFile, parsePieceDslFile, piecePackageToPicDsl } from "../src/node.js";

const typescriptSource = `import { Tag } from "antd";

interface User {
  id: string;
  status: "active" | "disabled";
}

interface UserCardProps {
  user: User;
}

const statusColorMap = {
  active: "green",
  disabled: "gray"
};

export function UserCard(props: UserCardProps) {
  return <Tag color={statusColorMap[props.user.status]}>{props.user.id}</Tag>;
}

export function OtherCard() {
  return <div>Other</div>;
}
`;

const goSource = `package pricing

import "fmt"

type User struct {
  ID string
  Name string
}

type Greeting struct {
  Message string
  Discount Discount
}

const prefix = "Hello"

func RenderGreeting(user User) Greeting {
  fmt.Println(prefix)
  return Greeting{Message: prefix + ", " + user.Name}
}
`;

const goCompanionSource = `package pricing

type Discount struct {
  Percent int
}
`;

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

async function assertRoundTrip({ filePath, source, language, expectedSnippets, analysisOptions = {} }) {
  const analysis = await analyzePieceFile({ filePath, source, ...analysisOptions });
  assert(analysis.piecePackage.language === language, `Expected ${language} package, got ${analysis.piecePackage.language}`);
  assert(analysis.pieceDsl === piecePackageToPicDsl(analysis.piecePackage), `Expected analysis.pieceDsl to match package writer for ${filePath}`);
  assert(analysis.pieceDslSource === "current-file", `Expected default .pic source to stay current-file for ${filePath}: ${analysis.pieceDslSource}`);

  for (const snippet of expectedSnippets) {
    assert(analysis.pieceDsl.includes(snippet), `Expected generated .pic to include ${snippet}:\n${analysis.pieceDsl}`);
  }

  const parsed = await parsePieceDslFile({
    filePath: filePath.replace(/\.[^.]+$/, ".pic"),
    source: analysis.pieceDsl
  });
  assert(parsed.diagnostics.length === 0, `Unexpected .pic diagnostics for ${filePath}: ${JSON.stringify(parsed.diagnostics)}`);
  assert(parsed.piecePackage, `Expected parsed package for ${filePath}.`);
  assert(
    JSON.stringify(parsed.piecePackage) === JSON.stringify(analysis.piecePackage),
    `Generated .pic did not round-trip for ${filePath}:\nsource=${JSON.stringify(analysis.piecePackage)}\nparsed=${JSON.stringify(parsed.piecePackage)}\npic=${analysis.pieceDsl}`
  );
  return analysis;
}

await assertRoundTrip({
  filePath: "/repo/src/DashboardPage.tsx",
  source: typescriptSource,
  language: "typescript",
  expectedSnippets: [
    "language typescript",
    'typeDeps "//repo/src:DashboardPage.tsx__type_UserCardProps"',
    'externalDeps "antd#Tag"',
    'path "repo-src-DashboardPage.tsx__function_UserCard.piece.json"'
  ]
});

await assertRoundTrip({
  filePath: "/repo/src/CachedDashboardPage.tsx",
  source: typescriptSource,
  language: "typescript",
  analysisOptions: {
    compilerOptions: {
      jsx: "react-jsx",
      target: "es2022"
    },
    dependencyArtifacts: [
      {
        id: "react",
        path: "/repo/node_modules/react/index.js",
        hash: "react-source-hash",
        cacheKey: "react-cache-key"
      }
    ]
  },
  expectedSnippets: [
    "language typescript",
    "compiler-options:",
    "dependency-artifacts:",
    'target function "UserCard"'
  ]
});

const goAnalysis = await assertRoundTrip({
  filePath: "/repo/src/Pricing.go",
  source: goSource,
  language: "go",
  analysisOptions: {
    sourceFiles: [
      {
        filePath: "/repo/src/Discount.go",
        source: goCompanionSource
      }
    ]
  },
  expectedSnippets: [
    "language go",
    "go-list:",
    "go-package-scope:",
    'externalDeps "/repo/src/Discount.go#Discount"',
    'runtimeDeps "//repo/src:Pricing.go__value_prefix"',
    'typeDeps "//repo/src:Pricing.go__type_Greeting", "//repo/src:Pricing.go__type_User"',
    'externalDeps "fmt#fmt"',
    'action compile {'
  ]
});
const selectedGoAnalysis = await analyzePieceFile({
  filePath: "/repo/src/Pricing.go",
  source: goSource,
  sourceFiles: [
    {
      filePath: "/repo/src/Discount.go",
      source: goCompanionSource
    }
  ],
  packageScopeSelection: "safe"
});
assert(
  selectedGoAnalysis.pieceDslSource === "selected-package-view",
  `Expected safe package-scope selection to make selected package view the primary .pic source: ${selectedGoAnalysis.pieceDslSource}`
);
assert(
  selectedGoAnalysis.pieceDsl === piecePackageToPicDsl(selectedGoAnalysis.packageScope.packageView),
  `Expected safe package-scope selection to emit packageView as primary .pic:\n${selectedGoAnalysis.pieceDsl}`
);
assert(
  selectedGoAnalysis.pieceDsl !== piecePackageToPicDsl(selectedGoAnalysis.piecePackage),
  `Expected selected package-scope .pic to differ from default current-file package .pic.`
);
assert(goAnalysis.manifest.parser === "go-ast-declaration-extractor", `Expected Node Go analysis to use Go AST backend: ${goAnalysis.manifest.parser}`);
assert(goAnalysis.manifest.analysisBackend?.actual === "go-ast", `Expected Go-owned analysis backend metadata: ${JSON.stringify(goAnalysis.manifest.analysisBackend)}`);
assert(goAnalysis.manifest.toolchain?.kind === "go-list", `Expected Go analysis to include go-list metadata: ${JSON.stringify(goAnalysis.manifest.toolchain)}`);
assert(goAnalysis.manifest.toolchain?.goList?.packageHash, `Expected Go list package hash: ${JSON.stringify(goAnalysis.manifest.toolchain)}`);
assert(
  goAnalysis.manifest.toolchain?.goList?.packages?.some((pkg) => pkg.goFiles.includes("Discount.go") && pkg.goFiles.includes("Pricing.go")),
  `Expected Go list package metadata to include companion package files: ${JSON.stringify(goAnalysis.manifest.toolchain?.goList)}`
);
assert(
  goAnalysis.manifest.toolchain?.packageScope?.files?.some((file) => file.filePath === "/repo/src/Discount.go"),
  `Expected Go package scope to include companion source file: ${JSON.stringify(goAnalysis.manifest.toolchain?.packageScope)}`
);
assert(
  goAnalysis.manifest.toolchain?.packageScope?.targetPolicy?.kind === "current-file-external-bindings" &&
    goAnalysis.manifest.toolchain?.packageScope?.targetPolicy?.targetScope === "current-file" &&
    goAnalysis.manifest.toolchain?.packageScope?.targetPolicy?.companionTargetMode === "external-binding" &&
    goAnalysis.manifest.toolchain?.packageScope?.targetPolicy?.companionTargets === false &&
    goAnalysis.manifest.toolchain?.packageScope?.targetPolicy?.fastPath === true,
  `Expected Go package scope to declare current-file external binding target policy: ${JSON.stringify(goAnalysis.manifest.toolchain?.packageScope)}`
);
assert(
  goAnalysis.manifest.importBindings.some((binding) => binding.local === "Discount" && binding.source === "/repo/src/Discount.go"),
  `Expected Go companion declaration binding: ${JSON.stringify(goAnalysis.manifest.importBindings)}`
);
assert(
  goAnalysis.graph.edges.some(
    (edge) => edge.kind === "external" && edge.to === "/repo/src/Discount.go#Discount" && edge.symbols.includes("Discount")
  ),
  `Expected Go companion declaration to become package-scoped graph edge: ${JSON.stringify(goAnalysis.graph.edges)}`
);
assert(
  goAnalysis.feedbackScope.level === "piece" &&
    goAnalysis.feedbackScope.reasons.some(
      (reason) =>
        reason.code === "go-package-scope-fast-path" &&
        reason.packageScopeHash === goAnalysis.manifest.toolchain.packageScope.hash &&
        reason.targetScope === "current-file" &&
        reason.companionTargetMode === "external-binding"
    ),
  `Expected Go feedback scope to preserve current-file fast path with package-scope reason: ${JSON.stringify(goAnalysis.feedbackScope)}`
);
assert(
  !goAnalysis.piecePackage.targets.some((target) => target.label.includes("Discount.go")),
  `Expected Go companion declarations to stay external instead of becoming current-file package targets: ${JSON.stringify(goAnalysis.piecePackage.targets)}`
);
assert(
  goAnalysis.packageScope?.kind === "package-scope-target-model" &&
    goAnalysis.packageScope?.status === "candidate" &&
    goAnalysis.packageScope?.promotion?.appliedToDefaultPackage === false,
  `Expected Go analysis to expose a candidate package-scope target model: ${JSON.stringify(goAnalysis.packageScope)}`
);
assert(
  goAnalysis.packageScope?.promotedTargets.some(
    (target) =>
      target.label === "//repo/src:Discount.go__type_Discount" &&
      target.kind === "type" &&
      target.sourceFile === "/repo/src/Discount.go" &&
      target.externalIdentity === "/repo/src/Discount.go#Discount"
  ),
  `Expected Go package-scope model to promote Discount as a candidate target: ${JSON.stringify(goAnalysis.packageScope?.promotedTargets)}`
);
assert(
  goAnalysis.packageScope?.promotedEdges.some(
    (edge) =>
      edge.from === "//repo/src:Pricing.go__type_Greeting" &&
      edge.to === "//repo/src:Discount.go__type_Discount" &&
      edge.symbols.includes("Discount")
  ),
  `Expected Go package-scope model to remap the companion external edge: ${JSON.stringify(goAnalysis.packageScope?.promotedEdges)}`
);
assert(
  selectedGoAnalysis.packageScope?.status === "selected" &&
    selectedGoAnalysis.packageScope?.promotion?.requested === "safe" &&
    selectedGoAnalysis.packageScope?.promotion?.appliedToPackageView === true,
  `Expected safe Go package-scope selection to pass: ${JSON.stringify(selectedGoAnalysis.packageScope)}`
);
const selectedDiscountTarget = selectedGoAnalysis.packageScope?.packageView?.targets.find(
  (target) => target.label === "//repo/src:Discount.go__type_Discount"
);
assert(
  selectedDiscountTarget?.source === "//repo/src:Discount.go",
  `Expected selected Go package view to include promoted Discount target: ${JSON.stringify(selectedGoAnalysis.packageScope?.packageView?.targets)}`
);
const selectedGreetingTarget = selectedGoAnalysis.packageScope?.packageView?.targets.find(
  (target) => target.label === "//repo/src:Pricing.go__type_Greeting"
);
assert(
  selectedGreetingTarget?.deps.includes("//repo/src:Discount.go__type_Discount") &&
    !selectedGreetingTarget?.externalDeps.includes("/repo/src/Discount.go#Discount"),
  `Expected selected Go package view to replace Discount external dep with promoted target dep: ${JSON.stringify(selectedGreetingTarget)}`
);
const selectedPackageViewPic = selectedGoAnalysis.pieceDsl;
assert(
  selectedPackageViewPic.includes('source "//repo/src:Discount.go"'),
  `Expected selected package view .pic to retain promoted target source label:\n${selectedPackageViewPic}`
);
const selectedPackageViewParsed = await parsePieceDslFile({
  filePath: "/repo/src/Pricing.package.pic",
  source: selectedPackageViewPic
});
assert(
  selectedPackageViewParsed.diagnostics.length === 0,
  `Unexpected selected package view .pic diagnostics: ${JSON.stringify(selectedPackageViewParsed.diagnostics)}\n${selectedPackageViewPic}`
);
assert(
  JSON.stringify(selectedPackageViewParsed.piecePackage) === JSON.stringify(selectedGoAnalysis.packageScope.packageView),
  `Selected package view .pic did not round-trip:\nsource=${JSON.stringify(selectedGoAnalysis.packageScope.packageView)}\nparsed=${JSON.stringify(selectedPackageViewParsed.piecePackage)}\npic=${selectedPackageViewPic}`
);
assert(
  goAnalysis.actionCache.toolchainInputs.includes(`go-list:${goAnalysis.manifest.toolchain.goList.packageHash}`),
  `Expected action cache to include Go list input: ${JSON.stringify(goAnalysis.actionCache)}`
);
assert(
  goAnalysis.actionCache.toolchainInputs.some((input) => input.startsWith("go-package-scope:")),
  `Expected action cache to include Go package scope input: ${JSON.stringify(goAnalysis.actionCache)}`
);
const goCompileAction = goAnalysis.piecePackage.actions.find((action) => action.id === "//repo/src:Pricing.go__function_RenderGreeting%compile");
assert(goCompileAction?.inputs.includes(`go-list:${goAnalysis.manifest.toolchain.goList.packageHash}`), `Expected Go compile action inputs to include go-list hash: ${JSON.stringify(goCompileAction)}`);
assert(
  goAnalysis.snapshot.actionCache.toolchainInputsHash === goAnalysis.actionCache.toolchainInputsHash,
  `Expected snapshot action cache to carry Go toolchain input hash: ${JSON.stringify(goAnalysis.snapshot.actionCache)}`
);

console.log("Source .pic generation smoke passed");
