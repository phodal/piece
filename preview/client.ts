import { javascript } from "@codemirror/lang-javascript";
import { EditorView, basicSetup } from "codemirror";
import * as esbuild from "esbuild-wasm/esm/browser";
import {
  analyzePieceFile,
  applyPieceEdit,
  buildPiecePreview
} from "../src/core/piece-pipeline.js";
import { createFallbackDeclarationExtractor } from "../src/core/declaration-extractor.js";

const filePath = "/workspace/DashboardPage.tsx";
const targetName = "UserCard";
const fixturePath = "/@fixture/DashboardPage.UserCard.fixture.ts";
const previewPropsModule = `export const previewProps = { user: { id: "u-1024", name: "Ada Lovelace", status: "active", score: 94 } };`;

type MetricRecord = Record<string, string | number>;

const editorHost = document.querySelector<HTMLElement>("#editor")!;
const editorPosition = document.querySelector<HTMLElement>("#editor-position")!;
const editorStats = document.querySelector<HTMLElement>("#editor-stats")!;
const iframe = document.querySelector<HTMLIFrameElement>("#preview")!;
const status = document.querySelector<HTMLElement>("#status")!;
const target = document.querySelector<HTMLElement>("#target")!;
const metricsGrid = document.querySelector<HTMLElement>("#metrics-grid")!;
const runBenchmarkButton = document.querySelector<HTMLButtonElement>("#run-benchmark")!;
const sampleEditButton = document.querySelector<HTMLButtonElement>("#apply-sample-edit")!;

let esbuildReady = false;
let currentAnalysis: any;
let currentPreview: any;
let currentSource = "";
let lastMetrics: MetricRecord = {};
let debounceTimer = 0;
let editorView: EditorView;
let suppressEditorRebuild = false;
let latestRebuildVersion = 0;
const declarationExtractor = createFallbackDeclarationExtractor();
const textEncoder = new TextEncoder();

function createLongFixture() {
  const helpers: string[] = [];
  for (let index = 0; index < 620; index += 1) {
    helpers.push(`export function DetailBlock${index}(props: { value: number }) {
  const normalized = props.value * ${index + 1};
  return <div className="detail-row"><span>Metric ${index}</span><strong>{normalized}</strong></div>;
}
`);
  }

  return `import * as React from "react";

type UserStatus = "active" | "disabled" | "paused";

interface User {
  id: string;
  name: string;
  status: UserStatus;
  score: number;
}

interface UserCardProps {
  user: User;
}

const statusColorMap = {
  active: "#0f7a4f",
  disabled: "#6b7280",
  paused: "#a45b00"
};

const statusLabelMap = {
  active: "Active account",
  disabled: "Disabled account",
  paused: "Paused account"
};

export function formatScore(score: number) {
  return score.toFixed(1);
}

export function UserCard(props: UserCardProps) {
  const color = statusColorMap[props.user.status];
  return (
    <article className="user-card" style={{ borderColor: color }}>
      <h1>{props.user.name}</h1>
      <p data-testid="status-label" style={{ color }}>{statusLabelMap[props.user.status]}</p>
      <strong data-testid="score">Score: {formatScore(props.user.score)}</strong>
    </article>
  );
}

${helpers.join("\n")}
export default function DashboardPage() {
  const user: User = { id: "u-1024", name: "Ada Lovelace", status: "active", score: 94 };
  return (
    <main>
      <UserCard user={user} />
      <DetailBlock0 value={1} />
      <DetailBlock1 value={2} />
      <DetailBlock2 value={3} />
    </main>
  );
}
`;
}

function metric(label: string, value: string | number, tone = "") {
  return `<div class="metric ${tone}"><b>${value}</b><span>${label}</span></div>`;
}

function getEditorSource() {
  return editorView.state.doc.toString();
}

function updateEditorStatus(view: EditorView) {
  const source = view.state.doc.toString();
  const mainSelection = view.state.selection.main;
  const line = view.state.doc.lineAt(mainSelection.head);
  const selected = view.state.selection.ranges.reduce((total, range) => total + Math.abs(range.to - range.from), 0);
  editorPosition.textContent = `Ln ${line.number}, Col ${mainSelection.head - line.from + 1}`;
  editorStats.textContent = `${view.state.doc.lines} lines | ${textEncoder.encode(source).length} bytes${selected > 0 ? ` | ${selected} selected` : ""}`;
}

function setEditorSource(value: string, selection = 0) {
  const boundedSelection = Math.max(0, Math.min(selection, value.length));
  suppressEditorRebuild = true;
  editorView.dispatch({
    changes: { from: 0, to: editorView.state.doc.length, insert: value },
    selection: { anchor: boundedSelection },
    scrollIntoView: true
  });
  suppressEditorRebuild = false;
  updateEditorStatus(editorView);
}

const previewEditorTheme = EditorView.theme({
  "&": {
    height: "100%"
  },
  ".cm-scroller": {
    overflow: "auto"
  },
  ".cm-content": {
    minHeight: "100%"
  }
});

function createEditor() {
  return new EditorView({
    doc: createLongFixture(),
    parent: editorHost,
    extensions: [
      basicSetup,
      javascript({ jsx: true, typescript: true }),
      previewEditorTheme,
      EditorView.updateListener.of((update) => {
        if (update.docChanged) {
          updateEditorStatus(update.view);
          if (!suppressEditorRebuild) {
            scheduleRebuild();
          }
          return;
        }
        if (update.selectionSet || update.focusChanged) {
          updateEditorStatus(update.view);
        }
      })
    ]
  });
}

function renderMetrics(metrics: MetricRecord) {
  metricsGrid.dataset.metrics = JSON.stringify(metrics);
  metricsGrid.innerHTML = [
    metric("piece total", metrics.pieceTotalMs ?? "-", "good"),
    metric("piece e2e", metrics.pieceE2EMs ?? "-"),
    metric("full esbuild-wasm", metrics.fullTotalMs ?? "-", "warn"),
    metric("speedup", metrics.speedup ?? "-", "good"),
    metric("e2e speedup", metrics.e2eSpeedup ?? "-"),
    metric("cache", metrics.cache ?? "-"),
    metric("version", metrics.version ?? "-"),
    metric("analyze", metrics.analyzeMs ?? "-"),
    metric("closure", metrics.closureMs ?? "-"),
    metric("piece bundle", metrics.bundleMs ?? "-"),
    metric("closure bytes", metrics.closureBytes ?? "-"),
    metric("source bytes", metrics.sourceBytes ?? "-"),
    metric("affected", metrics.affectedTargets ?? "-"),
    metric("dirty", metrics.dirtyPieces ?? "-"),
    metric("shape changes", metrics.publicShapeChanges ?? "-"),
    metric("artifact reuse", metrics.reusedArtifacts ?? "-"),
    metric("invalidated", metrics.invalidatedArtifacts ?? "-"),
    metric("slices", metrics.slices ?? "-"),
    metric("edges", metrics.edges ?? "-")
  ].join("");
}

function assetUrl(path: string) {
  return new URL(path, document.baseURI).href;
}

function iframeSrcDoc(code: string) {
  return `<!doctype html>
<html>
  <head>
    <meta charset="utf-8" />
    <script type="importmap">
      {
        "imports": {
          "react": ${JSON.stringify(assetUrl("dist/vendor/react.js"))},
          "react-dom/client": ${JSON.stringify(assetUrl("dist/vendor/react-dom-client.js"))},
          "react/jsx-runtime": ${JSON.stringify(assetUrl("dist/vendor/react-jsx-runtime.js"))}
        }
      }
    </script>
    <style>
      body { margin: 0; font: 14px/1.5 Inter, system-ui, sans-serif; background: #f8fafc; color: #17202a; }
      #root { min-height: 100vh; display: grid; place-items: center; padding: 24px; }
      .user-card { width: min(420px, 90vw); border: 2px solid #0f7a4f; border-radius: 8px; padding: 24px; background: #fff; box-shadow: 0 12px 30px rgba(15, 23, 42, 0.12); }
      .user-card h1 { margin: 0 0 8px; font-size: 28px; }
      .user-card p { margin: 0 0 16px; }
    </style>
  </head>
  <body>
    <div id="root"></div>
    <script type="module">${code.replace(/<\/script/gi, "<\\/script")}</script>
  </body>
</html>`;
}

async function ensureEsbuild() {
  if (esbuildReady) {
    return;
  }
  await esbuild.initialize({
    wasmURL: assetUrl("dist/vendor/esbuild.wasm"),
    worker: true
  });
  esbuildReady = true;
}

function virtualPlugin(files: Record<string, string>) {
  return {
    name: "preview-vfs",
    setup(build: any) {
      build.onResolve({ filter: /^\/workspace\// }, (args: any) => ({ path: args.path, namespace: "preview-vfs" }));
      build.onLoad({ filter: /.*/, namespace: "preview-vfs" }, (args: any) => ({
        contents: files[args.path],
        loader: args.path.endsWith(".ts") ? "ts" : "tsx"
      }));
    }
  };
}

async function buildFullEsbuild(source: string) {
  const startedAt = performance.now();
  const files = {
    [filePath]: source,
    "/workspace/full-entry.tsx": `import * as React from "react";
import { createRoot } from "react-dom/client";
import DashboardPage from "${filePath}";
createRoot(document.getElementById("root")!).render(<DashboardPage />);`
  };
  await esbuild.build({
    entryPoints: ["/workspace/full-entry.tsx"],
    bundle: true,
    platform: "browser",
    format: "esm",
    target: "es2022",
    write: false,
    sourcemap: "inline",
    external: ["react", "react-dom/client", "react/jsx-runtime"],
    plugins: [virtualPlugin(files)]
  });
  return Math.round((performance.now() - startedAt) * 1000) / 1000;
}

function sourceRangeForChangedText(previousSource: string, nextSource: string) {
  let startByte = 0;
  while (startByte < previousSource.length && startByte < nextSource.length && previousSource[startByte] === nextSource[startByte]) {
    startByte += 1;
  }

  let previousEnd = previousSource.length;
  let nextEnd = nextSource.length;
  while (previousEnd > startByte && nextEnd > startByte && previousSource[previousEnd - 1] === nextSource[nextEnd - 1]) {
    previousEnd -= 1;
    nextEnd -= 1;
  }

  const startLine = nextSource.slice(0, startByte).split("\n").length;
  const endLine = nextSource.slice(0, nextEnd).split("\n").length;
  return {
    startByte,
    endByte: Math.max(startByte + 1, nextEnd),
    startLine,
    endLine
  };
}

async function compilePiece(source: string, previousPreview?: any, analysisOverride?: any) {
  await ensureEsbuild();
  const buildEngine = {
    name: "browser-esbuild-wasm",
    build(options: any) {
      return esbuild.build(options);
    },
    transform(source: string, options: any) {
      return esbuild.transform(source, options);
    }
  };
  const analysis = analysisOverride ?? (await analyzePieceFile({ filePath, source, declarationExtractor }));
  const preview = await buildPiecePreview({
    filePath,
    source,
    analysis,
    declarationExtractor,
    target: targetName,
    buildEngine,
    compileStrategy: "transform",
    previousPreview,
    preview: {
      propsModulePath: fixturePath,
      virtualFiles: {
        [fixturePath]: previewPropsModule
      }
    }
  });
  return { analysis, preview };
}

async function rebuild(source: string, mode: "initial" | "edit" | "benchmark" = "edit") {
  const rebuildVersion = latestRebuildVersion + 1;
  latestRebuildVersion = rebuildVersion;
  try {
    status.textContent = "Compiling...";
    const previousAnalysis = currentAnalysis;
    const previousPreview = currentPreview;
    const reuseAnalysis = mode === "benchmark" && currentAnalysis;
    let affectedTargets = 1;
    let analysisWorkMs = 0;
    let analysisOverride = reuseAnalysis ? currentAnalysis : undefined;
    let reconciliationMetrics = {
      dirtyPieces: 0,
      publicShapeChanges: 0,
      reusedArtifacts: 0,
      invalidatedArtifacts: 0
    };

    if (mode === "edit" && previousAnalysis && currentSource) {
      const editResult = await applyPieceEdit({
        filePath,
        source,
        previousAnalysis,
        declarationExtractor,
        changedRanges: [sourceRangeForChangedText(currentSource, source)]
      });
      affectedTargets = editResult.affectedTargets.length;
      analysisWorkMs = editResult.metrics.totalMs;
      analysisOverride = editResult.analysis;
      reconciliationMetrics = {
        dirtyPieces: editResult.reconciliation.dirtyPieces.length,
        publicShapeChanges: editResult.reconciliation.publicShapeChangedPieces.length,
        reusedArtifacts: editResult.reconciliation.reusedArtifactIds.length,
        invalidatedArtifacts: editResult.reconciliation.invalidatedArtifactIds.length
      };
    }

    const result = await compilePiece(source, previousPreview, analysisOverride);

    if (reuseAnalysis) {
      affectedTargets = 0;
    } else if (!previousAnalysis) {
      analysisWorkMs = result.analysis.metrics.totalMs;
    }

    const fullTotalMs = await buildFullEsbuild(source);
    if (rebuildVersion !== latestRebuildVersion) {
      return;
    }

    currentAnalysis = result.analysis;
    currentPreview = result.preview;
    currentSource = source;
    iframe.srcdoc = iframeSrcDoc(result.preview.bundle?.code ?? "");
    const pieceTotalMs = result.preview.metrics.totalMs;
    const pieceE2EMs = Math.round(((reuseAnalysis ? 0 : analysisWorkMs) + pieceTotalMs) * 1000) / 1000;
    const speedup = fullTotalMs > 0 ? `${(fullTotalMs / Math.max(pieceTotalMs, 0.001)).toFixed(2)}x` : "-";
    const e2eSpeedup = fullTotalMs > 0 ? `${(fullTotalMs / Math.max(pieceE2EMs, 0.001)).toFixed(2)}x` : "-";
    lastMetrics = {
      version: rebuildVersion,
      pieceTotalMs,
      pieceE2EMs,
      fullTotalMs,
      speedup,
      e2eSpeedup,
      cache: result.preview.metrics.cache.status,
      analyzeMs: reuseAnalysis ? 0 : analysisWorkMs,
      closureMs: result.preview.metrics.phases.closureMs,
      bundleMs: result.preview.metrics.phases.bundleMs,
      closureBytes: result.preview.metrics.closureBytes,
      sourceBytes: result.preview.metrics.sourceBytes,
      affectedTargets,
      ...reconciliationMetrics,
      slices: result.analysis.metrics.sliceCount,
      edges: result.analysis.metrics.edgeCount
    };
    renderMetrics(lastMetrics);
    status.textContent = `${mode}: piece=${pieceTotalMs}ms, full=${fullTotalMs}ms, speedup=${speedup}, e2e=${e2eSpeedup}`;
    target.textContent = `target: ${targetName}`;
    (window as any).__piecePreview = {
      version: rebuildVersion,
      source,
      metrics: lastMetrics,
      analysis: result.analysis,
      preview: result.preview
    };
  } catch (error) {
    if (rebuildVersion !== latestRebuildVersion) {
      return;
    }
    console.error(error);
    status.textContent = error instanceof Error ? error.message : String(error);
  }
}

function scheduleRebuild() {
  window.clearTimeout(debounceTimer);
  debounceTimer = window.setTimeout(() => {
    void rebuild(getEditorSource(), "edit");
  }, 250);
}

function applySampleEdit() {
  const source = getEditorSource();
  const cursor = editorView.state.selection.main.head;
  const next = source
    .replace("Active account", "Active account - browser edited")
    .replace("Score: {formatScore(props.user.score)}", "Live score: {formatScore(props.user.score + 1)}");
  setEditorSource(next, cursor);
  void rebuild(next, "edit");
}

editorView = createEditor();
updateEditorStatus(editorView);
runBenchmarkButton.addEventListener("click", () => void rebuild(getEditorSource(), "benchmark"));
sampleEditButton.addEventListener("click", applySampleEdit);

void rebuild(getEditorSource(), "initial");
