import { generateKotlinPieceDslFile, parsePieceDslFile } from "../src/node.js";

const source = `package demo.pricing

data class User(val id: String, val name: String)
data class Greeting(val message: String)

private val prefix = "Hello"

fun renderGreeting(user: User): Greeting {
  return Greeting(prefix + ", " + user.name)
}
`;

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

const generated = await generateKotlinPieceDslFile({
  filePath: "/repo/src/Pricing.kt",
  source
});

assert(generated.generator === "kotlin-psi-pic-generator", `Unexpected generator: ${generated.generator}`);
assert(generated.diagnostics.length === 0, `Unexpected generator diagnostics: ${JSON.stringify(generated.diagnostics)}`);
assert(generated.piecePackage, "Expected Kotlin .pic generation to include a source PiecePackage.");
assert(generated.pic.includes('language kotlin'), `Expected Kotlin language in .pic: ${generated.pic}`);
assert(
  generated.pic.includes('runtimeDeps "//repo/src:Pricing.kt__value_prefix"'),
  `Expected runtime deps in generated .pic: ${generated.pic}`
);
assert(
  generated.pic.includes('typeDeps "//repo/src:Pricing.kt__class_Greeting", "//repo/src:Pricing.kt__class_User"'),
  `Expected type deps in generated .pic: ${generated.pic}`
);

const parsed = await parsePieceDslFile({
  filePath: "/repo/src/Pricing.pic",
  source: generated.pic
});

assert(parsed.diagnostics.length === 0, `Unexpected parser diagnostics: ${JSON.stringify(parsed.diagnostics)}`);
assert(parsed.piecePackage, "Expected generated .pic parser to return a PiecePackage.");
assert(
  JSON.stringify(parsed.piecePackage) === JSON.stringify(generated.piecePackage),
  `Generated .pic did not round-trip to the Kotlin PSI package:\nsource=${JSON.stringify(generated.piecePackage)}\nparsed=${JSON.stringify(parsed.piecePackage)}`
);

console.log("Kotlin .pic generation smoke passed");
