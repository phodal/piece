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
}

const prefix = "Hello"

func RenderGreeting(user User) Greeting {
  fmt.Println(prefix)
  return Greeting{Message: prefix + ", " + user.Name}
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

await assertRoundTrip({
  filePath: "/repo/src/Pricing.go",
  source: goSource,
  language: "go",
  expectedSnippets: [
    "language go",
    'runtimeDeps "//repo/src:Pricing.go__value_prefix"',
    'typeDeps "//repo/src:Pricing.go__type_Greeting", "//repo/src:Pricing.go__type_User"',
    'externalDeps "fmt#fmt"',
    'action compile {'
  ]
});

console.log("Source .pic generation smoke passed");
