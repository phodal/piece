import { createRequire } from "node:module";
import { join } from "node:path";
import { createKotlinCoreBridge } from "../src/core/kotlin-core-bridge.js";

const require = createRequire(import.meta.url);
const kotlinCore = require(join(process.cwd(), "piece-core/build/dist/js/productionLibrary/piece-core.js"));
const bridge = createKotlinCoreBridge(kotlinCore);

const piecePackage = bridge.createPackageFromTargets({
  filePath: "/repo/src/Pricing.kt",
  language: "kotlin",
  targets: [
    { kind: "class", name: "User" },
    { kind: "class", name: "Greeting" },
    { kind: "value", name: "prefix" },
    { kind: "function", name: "renderGreeting", deps: [":User", ":Greeting", ":prefix"] }
  ]
});

if (piecePackage.label !== "//repo/src:Pricing.kt") {
  throw new Error(`Unexpected package label: ${piecePackage.label}`);
}

const renderGreeting = piecePackage.targets.find((target) => target.name === "renderGreeting");
if (!renderGreeting || renderGreeting.label !== "//repo/src:Pricing.kt__function_renderGreeting") {
  throw new Error("Kotlin core bridge did not return the renderGreeting target.");
}

const graph = bridge.createGraphFromTargets({
  filePath: "/repo/src/Pricing.kt",
  language: "kotlin",
  targets: [
    { kind: "value", name: "prefix" },
    { kind: "function", name: "renderGreeting", deps: [":prefix"] }
  ]
});

if (!graph.edges.some((edge) => edge.from.endsWith("__function_renderGreeting") && edge.to.endsWith("__value_prefix"))) {
  throw new Error("Kotlin core bridge did not expose the expected graph edge.");
}

console.log("Kotlin core JS bridge smoke passed");
