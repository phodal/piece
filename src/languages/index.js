import { createFallbackDeclarationExtractor } from "../core/declaration-extractor.js";
import { createKotlinDeclarationExtractor } from "./kotlin/declaration-extractor.js";
import { createTypeScriptDeclarationExtractor } from "./typescript/declaration-extractor.js";

export async function createDefaultDeclarationExtractorForFile(filePath) {
  if (/\.(?:kt|kts)$/.test(filePath)) {
    return createKotlinDeclarationExtractor();
  }
  try {
    return await createTypeScriptDeclarationExtractor();
  } catch {
    return createFallbackDeclarationExtractor();
  }
}
