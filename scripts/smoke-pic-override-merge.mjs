import { analyzePieceFile, mergePieceDslFiles, parsePieceDslFile } from "../src/node.js";

const source = `import { Tag } from "antd";

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

const override = `package "//repo/src:DashboardPage.tsx" {
  language typescript
  source "/repo/src/DashboardPage.tsx"

  target function "UserCard" {
    label "//repo/src:dashboard_user_card"
    visibility "//visibility:public"
    action feedback {
      mnemonic "UserCardFixture"
      inputs "fixtures/user-card.json"
      path "artifacts/user-card.fixture.json"
    }
  }
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

const packageViewOverride = `package "//repo/src:Pricing.go" {
  language go
  source "/repo/src/Pricing.go"

  target type "Discount" {
    source "//repo/src:Discount.go"
    visibility "//visibility:public"
    action compile {
      mnemonic "DiscountFixture"
      inputs "fixtures/discount.json"
      path "artifacts/discount.fixture.json"
    }
  }
}
`;

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

const analysis = await analyzePieceFile({
  filePath: "/repo/src/DashboardPage.tsx",
  source
});

const merged = await mergePieceDslFiles({
  generatedFilePath: "/repo/src/DashboardPage.generated.pic",
  generatedSource: analysis.pieceDsl,
  overrideFilePath: "/repo/src/DashboardPage.override.pic",
  overrideSource: override
});

assert(
  !merged.diagnostics.some((diagnostic) => diagnostic.severity === "error" || diagnostic.severity === "warning"),
  `Unexpected .pic merge diagnostics: ${JSON.stringify(merged.diagnostics)}`
);
assert(merged.piecePackage, "Expected .pic merge to return a PiecePackage.");
assert(merged.pieceDsl.includes('label "//repo/src:dashboard_user_card"'), `Expected merged .pic to include label override:\n${merged.pieceDsl}`);
assert(merged.pieceDsl.includes('visibility "//visibility:public"'), `Expected merged .pic to include visibility override:\n${merged.pieceDsl}`);
assert(merged.pieceDsl.includes('"fixtures/user-card.json"'), `Expected merged .pic to include fixture input:\n${merged.pieceDsl}`);

const userCard = merged.piecePackage.targets.find((target) => target.name === "UserCard");
assert(userCard, `Expected UserCard target: ${JSON.stringify(merged.piecePackage.targets)}`);
assert(userCard.label === "//repo/src:dashboard_user_card", `Unexpected UserCard label: ${userCard.label}`);
assert(JSON.stringify(userCard.visibility) === JSON.stringify(["//visibility:public"]), `Unexpected UserCard visibility: ${JSON.stringify(userCard.visibility)}`);

const feedback = merged.piecePackage.actions.find((action) => action.id === "//repo/src:dashboard_user_card%feedback");
assert(feedback, `Expected remapped UserCard feedback action: ${JSON.stringify(merged.piecePackage.actions)}`);
assert(feedback.target === "//repo/src:dashboard_user_card", `Unexpected feedback action target: ${feedback.target}`);
assert(feedback.mnemonic === "UserCardFixture", `Unexpected feedback mnemonic: ${feedback.mnemonic}`);
assert(feedback.inputs.includes("fixtures/user-card.json"), `Expected fixture input: ${JSON.stringify(feedback.inputs)}`);
assert(feedback.inputs.includes("antd#Tag"), `Expected generated external input to be preserved: ${JSON.stringify(feedback.inputs)}`);
assert(
  feedback.inputs.includes("//repo/src:DashboardPage.tsx__type_UserCardProps"),
  `Expected generated type input to be preserved: ${JSON.stringify(feedback.inputs)}`
);

const artifact = merged.piecePackage.artifacts.find((item) => item.id === "//repo/src:dashboard_user_card.piece.json");
assert(artifact?.path === "artifacts/user-card.fixture.json", `Unexpected remapped artifact: ${JSON.stringify(artifact)}`);

const parsed = await parsePieceDslFile({
  filePath: "/repo/src/DashboardPage.merged.pic",
  source: merged.pieceDsl
});

assert(parsed.diagnostics.length === 0, `Unexpected merged .pic diagnostics: ${JSON.stringify(parsed.diagnostics)}`);
assert(
  JSON.stringify(parsed.piecePackage) === JSON.stringify(merged.piecePackage),
  `Merged .pic did not round-trip:\nmerged=${JSON.stringify(merged.piecePackage)}\nparsed=${JSON.stringify(parsed.piecePackage)}\npic=${merged.pieceDsl}`
);

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
  `Expected Go package analysis to expose selected package view .pic output: ${selectedGoAnalysis.pieceDslSource}`
);
assert(selectedGoAnalysis.packageScope?.packageView, `Expected selected package view: ${JSON.stringify(selectedGoAnalysis.packageScope)}`);

const mergedPackageView = await mergePieceDslFiles({
  generatedFilePath: "/repo/src/Pricing.package.generated.pic",
  generatedPackage: selectedGoAnalysis.packageScope.packageView,
  overrideFilePath: "/repo/src/Pricing.package.override.pic",
  overrideSource: packageViewOverride
});
assert(
  !mergedPackageView.diagnostics.some((diagnostic) => diagnostic.severity === "error" || diagnostic.severity === "warning"),
  `Unexpected package-view .pic merge diagnostics: ${JSON.stringify(mergedPackageView.diagnostics)}`
);
assert(mergedPackageView.piecePackage, "Expected package-view .pic merge to return a PiecePackage.");
assert(
  mergedPackageView.pieceDsl.includes('source "//repo/src:Discount.go"'),
  `Expected merged package-view .pic to preserve target-level source:\n${mergedPackageView.pieceDsl}`
);
assert(
  mergedPackageView.pieceDsl.includes('"fixtures/discount.json"'),
  `Expected merged package-view .pic to include fixture input:\n${mergedPackageView.pieceDsl}`
);

const discountTarget = mergedPackageView.piecePackage.targets.find((target) => target.label === "//repo/src:Discount.go__type_Discount");
assert(discountTarget, `Expected promoted Discount target: ${JSON.stringify(mergedPackageView.piecePackage.targets)}`);
assert(
  JSON.stringify(discountTarget.visibility) === JSON.stringify(["//visibility:public"]),
  `Unexpected Discount visibility: ${JSON.stringify(discountTarget.visibility)}`
);

const discountCompile = mergedPackageView.piecePackage.actions.find((action) => action.id === "//repo/src:Discount.go__type_Discount%compile");
assert(discountCompile, `Expected Discount compile action: ${JSON.stringify(mergedPackageView.piecePackage.actions)}`);
assert(discountCompile.mnemonic === "DiscountFixture", `Unexpected Discount compile mnemonic: ${discountCompile.mnemonic}`);
assert(discountCompile.inputs.includes("fixtures/discount.json"), `Expected fixture input: ${JSON.stringify(discountCompile.inputs)}`);
assert(
  discountCompile.inputs.some((input) => input.startsWith("go-package-scope:")),
  `Expected generated package-scope input to be preserved: ${JSON.stringify(discountCompile.inputs)}`
);

const discountArtifact = mergedPackageView.piecePackage.artifacts.find((item) => item.id === "//repo/src:Discount.go__type_Discount.compile.json");
assert(discountArtifact?.path === "artifacts/discount.fixture.json", `Unexpected Discount artifact: ${JSON.stringify(discountArtifact)}`);

const parsedPackageView = await parsePieceDslFile({
  filePath: "/repo/src/Pricing.package.merged.pic",
  source: mergedPackageView.pieceDsl
});
assert(parsedPackageView.diagnostics.length === 0, `Unexpected merged package-view .pic diagnostics: ${JSON.stringify(parsedPackageView.diagnostics)}`);
assert(
  JSON.stringify(parsedPackageView.piecePackage) === JSON.stringify(mergedPackageView.piecePackage),
  `Merged package-view .pic did not round-trip:\nmerged=${JSON.stringify(mergedPackageView.piecePackage)}\nparsed=${JSON.stringify(parsedPackageView.piecePackage)}\npic=${mergedPackageView.pieceDsl}`
);

console.log(".pic override merge smoke passed");
