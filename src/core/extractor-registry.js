import { createFallbackDeclarationExtractor } from "./declaration-extractor.js";

let defaultDeclarationExtractorResolver;

export function setDefaultDeclarationExtractorResolver(resolver) {
  defaultDeclarationExtractorResolver = resolver;
}

export async function resolveDefaultDeclarationExtractor(filePath) {
  if (defaultDeclarationExtractorResolver) {
    return defaultDeclarationExtractorResolver(filePath);
  }
  return createFallbackDeclarationExtractor();
}
