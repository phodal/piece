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

console.log(".pic override merge smoke passed");
