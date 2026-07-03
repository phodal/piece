import { setDefaultDeclarationExtractorResolver } from "./core/extractor-registry.js";
import { createDefaultDeclarationExtractorForFile } from "./languages/index.js";

setDefaultDeclarationExtractorResolver(createDefaultDeclarationExtractorForFile);

export * from "./core/compiler.js";
export * from "./core/declaration-extractor.js";
export * from "./core/extractor-registry.js";
export * from "./core/piece-package.js";
export * from "./core/piece-pipeline.js";
export * from "./core/reconciler.js";
export * from "./core/options.js";
export * from "./core/status.js";
export * from "./languages/index.js";
export * from "./languages/kotlin/declaration-extractor.js";
export * from "./languages/typescript/declaration-extractor.js";
