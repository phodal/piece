package main

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"flag"
	"fmt"
	"go/ast"
	"go/parser"
	"go/token"
	"os"
	"sort"
	"strconv"
	"strings"
)

type sourceRange struct {
	StartByte int `json:"startByte"`
	EndByte   int `json:"endByte"`
	StartLine int `json:"startLine"`
	EndLine   int `json:"endLine"`
}

type importBinding struct {
	Local      string `json:"local"`
	Imported   string `json:"imported"`
	Source     string `json:"source"`
	Kind       string `json:"kind"`
	IsTypeOnly bool   `json:"isTypeOnly"`
}

type pieceSlice struct {
	ID              string      `json:"id"`
	FilePath        string      `json:"filePath"`
	Kind            string      `json:"kind"`
	Name            string      `json:"name,omitempty"`
	ExportName      string      `json:"exportName,omitempty"`
	IsDefaultExport bool        `json:"isDefaultExport"`
	Range           sourceRange `json:"range"`
	Source          string      `json:"source"`
	Symbols         struct {
		Defines        []string `json:"defines"`
		References     []string `json:"references"`
		TypeReferences []string `json:"typeReferences"`
		JSXReferences  []string `json:"jsxReferences"`
	} `json:"symbols"`
	Preview struct {
		Previewable bool   `json:"previewable"`
		Reason      string `json:"reason,omitempty"`
	} `json:"preview"`
	Hashes struct {
		BodyHash      string `json:"bodyHash"`
		SignatureHash string `json:"signatureHash"`
		TypeHash      string `json:"typeHash,omitempty"`
	} `json:"hashes"`
	Safety safety `json:"safety"`
}

type safety struct {
	HasTopLevelSideEffect bool `json:"hasTopLevelSideEffect"`
	HasDynamicImport      bool `json:"hasDynamicImport"`
	HasUnknownGlobal      bool `json:"hasUnknownGlobal"`
	FallbackRequired      bool `json:"fallbackRequired"`
}

type headerSegment struct {
	ID             string          `json:"id"`
	FilePath       string          `json:"filePath"`
	Kind           string          `json:"kind"`
	Range          sourceRange     `json:"range"`
	Source         string          `json:"source"`
	ImportBindings []importBinding `json:"importBindings"`
}

type effectSegment struct {
	ID       string      `json:"id"`
	FilePath string      `json:"filePath"`
	Kind     string      `json:"kind"`
	Range    sourceRange `json:"range"`
	Source   string      `json:"source"`
	Hashes   struct {
		BodyHash string `json:"bodyHash"`
	} `json:"hashes"`
	Safety safety `json:"safety"`
}

type diagnostic struct {
	Code     string `json:"code"`
	Severity string `json:"severity"`
	Message  string `json:"message"`
}

type manifest struct {
	Version           int             `json:"version"`
	FilePath          string          `json:"filePath"`
	Source            string          `json:"source"`
	Parser            string          `json:"parser"`
	Slices            []pieceSlice    `json:"slices"`
	Headers           []headerSegment `json:"headers"`
	Effects           []effectSegment `json:"effects"`
	ImportBindings    []importBinding `json:"importBindings"`
	HasTopLevelEffect bool            `json:"hasTopLevelEffect"`
	AnalysisBackend   analysisBackend `json:"analysisBackend"`
	Diagnostics       []diagnostic    `json:"diagnostics"`
}

// batchInput lets a host write sources into one temporary directory while
// retaining the original path identities in the emitted manifests. It avoids
// spawning `go run` once for every source file in a package-sized analysis.
type batchInput struct {
	File string `json:"file"`
	Path string `json:"path"`
}

type analysisBackend struct {
	Requested      string `json:"requested"`
	Actual         string `json:"actual"`
	Declarations   string `json:"declarations"`
	Symbols        string `json:"symbols"`
	Diagnostics    string `json:"diagnostics"`
	Status         string `json:"status"`
	FallbackReason string `json:"fallbackReason,omitempty"`
}

type segment struct {
	kind  string
	start int
	end   int
}

var predeclared = map[string]bool{
	"any": true, "append": true, "bool": true, "byte": true, "cap": true, "clear": true,
	"close": true, "comparable": true, "complex": true, "complex64": true, "complex128": true,
	"copy": true, "delete": true, "error": true, "false": true, "float32": true, "float64": true,
	"imag": true, "int": true, "int8": true, "int16": true, "int32": true, "int64": true,
	"iota": true, "len": true, "make": true, "new": true, "nil": true, "panic": true,
	"print": true, "println": true, "real": true, "recover": true, "rune": true, "string": true,
	"true": true, "uint": true, "uint8": true, "uint16": true, "uint32": true, "uint64": true, "uintptr": true,
}

func main() {
	sourceFile := flag.String("file", "", "Go source file to analyze")
	hostPath := flag.String("path", "", "Host-visible source path")
	batchFile := flag.String("batch", "", "JSON array of {file,path} source inputs to analyze")
	flag.Parse()
	if *batchFile != "" {
		analyzeBatch(*batchFile)
		return
	}
	if *sourceFile == "" {
		fail("missing --file")
	}
	sourceBytes, err := os.ReadFile(*sourceFile)
	if err != nil {
		fail(err.Error())
	}
	filePath := *hostPath
	if filePath == "" {
		filePath = *sourceFile
	}
	source := string(sourceBytes)
	result := analyze(filePath, source)
	encoder := json.NewEncoder(os.Stdout)
	encoder.SetEscapeHTML(false)
	if err := encoder.Encode(result); err != nil {
		fail(err.Error())
	}
}

func analyzeBatch(batchFile string) {
	encodedInputs, err := os.ReadFile(batchFile)
	if err != nil {
		fail(err.Error())
	}
	inputs := []batchInput{}
	if err := json.Unmarshal(encodedInputs, &inputs); err != nil {
		fail(err.Error())
	}
	if len(inputs) == 0 {
		fail("--batch must contain one or more source inputs")
	}
	results := make([]manifest, 0, len(inputs))
	for _, input := range inputs {
		if input.File == "" {
			fail("--batch input is missing file")
		}
		sourceBytes, err := os.ReadFile(input.File)
		if err != nil {
			fail(err.Error())
		}
		filePath := input.Path
		if filePath == "" {
			filePath = input.File
		}
		results = append(results, analyze(filePath, string(sourceBytes)))
	}
	encoder := json.NewEncoder(os.Stdout)
	encoder.SetEscapeHTML(false)
	if err := encoder.Encode(results); err != nil {
		fail(err.Error())
	}
}

func fail(message string) {
	fmt.Fprintln(os.Stderr, message)
	os.Exit(1)
}

func analyze(filePath, source string) manifest {
	fset := token.NewFileSet()
	file, err := parser.ParseFile(fset, filePath, source, parser.ParseComments)
	result := manifest{
		Version:  1,
		FilePath: filePath,
		Source:   source,
		Parser:   "go-ast-declaration-extractor",
		AnalysisBackend: analysisBackend{
			Requested:    "go-ast",
			Actual:       "go-ast",
			Declarations: "go/parser",
			Symbols:      "go/ast",
			Diagnostics:  "go/parser",
			Status:       "ready",
		},
		Diagnostics: []diagnostic{},
	}
	if err != nil {
		result.Diagnostics = append(result.Diagnostics, diagnostic{
			Code:     "go-parse-error",
			Severity: "error",
			Message:  err.Error(),
		})
	}
	if file == nil {
		return result
	}

	headers, headerSegments := createHeaders(filePath, source, fset, file)
	result.Headers = headers
	result.ImportBindings = headerSegments

	slices, declarationSegments := createSlices(filePath, source, fset, file)
	result.Slices = slices
	allSegments := append([]segment{}, declarationSegments...)
	for _, header := range headers {
		allSegments = append(allSegments, segment{kind: "header", start: header.Range.StartByte, end: header.Range.EndByte})
	}
	result.Effects = createEffects(filePath, source, allSegments)
	result.HasTopLevelEffect = len(result.Effects) > 0
	return result
}

func createHeaders(filePath, source string, fset *token.FileSet, file *ast.File) ([]headerSegment, []importBinding) {
	headers := []headerSegment{}
	bindings := []importBinding{}
	if file.Package.IsValid() && file.Name != nil {
		headers = append(headers, headerSegment{
			ID:             filePath + "#header:header-0",
			FilePath:       filePath,
			Kind:           "header",
			Range:          makeRange(source, fset, file.Package, file.Name.End()),
			Source:         sourceSlice(source, fset, file.Package, file.Name.End()),
			ImportBindings: []importBinding{},
		})
	}
	for _, decl := range file.Decls {
		genDecl, ok := decl.(*ast.GenDecl)
		if !ok || genDecl.Tok != token.IMPORT {
			continue
		}
		imports := []importBinding{}
		for _, spec := range genDecl.Specs {
			importSpec, ok := spec.(*ast.ImportSpec)
			if !ok {
				continue
			}
			binding, ok := importBindingFromSpec(importSpec)
			if ok {
				imports = append(imports, binding)
				bindings = append(bindings, binding)
			}
		}
		sortImportBindings(imports)
		headers = append(headers, headerSegment{
			ID:             fmt.Sprintf("%s#header:header-%d", filePath, len(headers)),
			FilePath:       filePath,
			Kind:           "header",
			Range:          makeRange(source, fset, genDecl.Pos(), genDecl.End()),
			Source:         sourceSlice(source, fset, genDecl.Pos(), genDecl.End()),
			ImportBindings: imports,
		})
	}
	sortImportBindings(bindings)
	return headers, bindings
}

func importBindingFromSpec(spec *ast.ImportSpec) (importBinding, bool) {
	importPath, err := strconv.Unquote(spec.Path.Value)
	if err != nil {
		importPath = strings.Trim(spec.Path.Value, "\"")
	}
	alias := ""
	if spec.Name != nil {
		alias = spec.Name.Name
	}
	if alias == "_" || importPath == "" {
		return importBinding{}, false
	}
	imported := importPath[strings.LastIndex(importPath, "/")+1:]
	local := imported
	if alias != "" && alias != "." {
		local = alias
	}
	return importBinding{Local: local, Imported: imported, Source: importPath, Kind: "namespace", IsTypeOnly: false}, true
}

func createSlices(filePath, source string, fset *token.FileSet, file *ast.File) ([]pieceSlice, []segment) {
	slices := []pieceSlice{}
	segments := []segment{}
	for _, decl := range file.Decls {
		switch typed := decl.(type) {
		case *ast.FuncDecl:
			slice := createFuncSlice(filePath, source, fset, typed, len(slices))
			slices = append(slices, slice)
			segments = append(segments, segment{kind: "declaration", start: slice.Range.StartByte, end: slice.Range.EndByte})
		case *ast.GenDecl:
			if typed.Tok != token.TYPE && typed.Tok != token.CONST && typed.Tok != token.VAR {
				continue
			}
			for _, spec := range typed.Specs {
				for _, slice := range createGenDeclSlices(filePath, source, fset, typed, spec, len(slices)) {
					slices = append(slices, slice)
					segments = append(segments, segment{kind: "declaration", start: slice.Range.StartByte, end: slice.Range.EndByte})
				}
			}
		}
	}
	return slices, segments
}

func createFuncSlice(filePath, source string, fset *token.FileSet, decl *ast.FuncDecl, index int) pieceSlice {
	name := decl.Name.Name
	if decl.Recv != nil && len(decl.Recv.List) > 0 {
		if receiver := receiverTypeName(decl.Recv.List[0].Type); receiver != "" {
			name = receiver + "." + name
		}
	}
	typeRefs := collectTypeReferences(decl.Type, map[string]bool{name: true})
	localNames := localNamesForFunc(decl)
	refs := collectReferences(decl, mergeSets(localNames, map[string]bool{name: true}))
	refs = uniqueSorted(append(refs, typeRefs...))
	start, end := decl.Pos(), decl.End()
	text := sourceSlice(source, fset, start, end)
	signatureEnd := len(text)
	if brace := strings.Index(text, "{"); brace >= 0 {
		signatureEnd = brace
	}
	slice := newSlice(filePath, "function", name, source, fset, start, end, text, refs, typeRefs, index)
	slice.Hashes.SignatureHash = stableTextHash(text[:signatureEnd])
	return slice
}

func createGenDeclSlices(filePath, source string, fset *token.FileSet, decl *ast.GenDecl, spec ast.Spec, index int) []pieceSlice {
	start := decl.Pos()
	if decl.Lparen.IsValid() {
		start = spec.Pos()
	}
	switch typed := spec.(type) {
	case *ast.TypeSpec:
		name := typed.Name.Name
		typeRefs := collectTypeReferences(typed.Type, map[string]bool{name: true})
		text := sourceSlice(source, fset, start, typed.End())
		slice := newSlice(filePath, "type", name, source, fset, start, typed.End(), text, typeRefs, typeRefs, index)
		slice.Hashes.TypeHash = stableTextHash(text)
		return []pieceSlice{slice}
	case *ast.ValueSpec:
		kind := "value"
		result := []pieceSlice{}
		for _, nameIdent := range typed.Names {
			name := nameIdent.Name
			excluded := map[string]bool{name: true}
			typeRefs := collectTypeReferences(typed.Type, excluded)
			refs := collectReferences(typed, excluded)
			refs = uniqueSorted(append(refs, typeRefs...))
			text := sourceSlice(source, fset, start, typed.End())
			result = append(result, newSlice(filePath, kind, name, source, fset, start, typed.End(), text, refs, typeRefs, index+len(result)))
		}
		return result
	}
	return nil
}

func newSlice(filePath, kind, name, source string, fset *token.FileSet, start, end token.Pos, text string, refs, typeRefs []string, index int) pieceSlice {
	slice := pieceSlice{
		ID:              filePath + "#" + kind + ":" + name,
		FilePath:        filePath,
		Kind:            kind,
		Name:            name,
		ExportName:      name,
		IsDefaultExport: false,
		Range:           makeRange(source, fset, start, end),
		Source:          text,
		Safety:          safety{},
	}
	slice.Symbols.Defines = []string{name}
	slice.Symbols.References = uniqueSorted(refs)
	slice.Symbols.TypeReferences = uniqueSorted(typeRefs)
	slice.Symbols.JSXReferences = []string{}
	slice.Preview.Previewable = kind == "function" || kind == "type"
	if !slice.Preview.Previewable {
		slice.Preview.Reason = "not a runnable feedback target"
	}
	slice.Hashes.BodyHash = stableTextHash(text)
	slice.Hashes.SignatureHash = stableTextHash(text)
	return slice
}

func createEffects(filePath, source string, segments []segment) []effectSegment {
	sort.Slice(segments, func(i, j int) bool {
		if segments[i].start == segments[j].start {
			return segments[i].end < segments[j].end
		}
		return segments[i].start < segments[j].start
	})
	effects := []effectSegment{}
	cursor := 0
	for _, item := range segments {
		if item.start > cursor {
			addEffect(filePath, source, cursor, item.start, &effects)
		}
		if item.end > cursor {
			cursor = item.end
		}
	}
	if cursor < len(source) {
		addEffect(filePath, source, cursor, len(source), &effects)
	}
	return effects
}

func addEffect(filePath, source string, start, end int, effects *[]effectSegment) {
	text := source[start:end]
	if strings.TrimSpace(text) == "" {
		return
	}
	effect := effectSegment{
		ID:       fmt.Sprintf("%s#effect:top-level-%d", filePath, len(*effects)),
		FilePath: filePath,
		Kind:     "effect",
		Range:    rangeFromOffsets(source, start, end),
		Source:   text,
		Safety:   safety{HasTopLevelSideEffect: true, HasUnknownGlobal: true, FallbackRequired: true},
	}
	effect.Hashes.BodyHash = stableTextHash(text)
	*effects = append(*effects, effect)
}

func localNamesForFunc(decl *ast.FuncDecl) map[string]bool {
	names := map[string]bool{}
	addFieldNames(names, decl.Recv)
	addFieldNames(names, decl.Type.Params)
	addFieldNames(names, decl.Type.Results)
	ast.Inspect(decl.Body, func(node ast.Node) bool {
		switch typed := node.(type) {
		case *ast.AssignStmt:
			if typed.Tok == token.DEFINE {
				for _, expr := range typed.Lhs {
					if ident, ok := expr.(*ast.Ident); ok {
						names[ident.Name] = true
					}
				}
			}
		case *ast.ValueSpec:
			for _, ident := range typed.Names {
				names[ident.Name] = true
			}
		case *ast.RangeStmt:
			if ident, ok := typed.Key.(*ast.Ident); ok {
				names[ident.Name] = true
			}
			if ident, ok := typed.Value.(*ast.Ident); ok {
				names[ident.Name] = true
			}
		}
		return true
	})
	return names
}

func addFieldNames(names map[string]bool, fields *ast.FieldList) {
	if fields == nil {
		return
	}
	for _, field := range fields.List {
		for _, name := range field.Names {
			names[name.Name] = true
		}
	}
}

func collectTypeReferences(node ast.Node, excluded map[string]bool) []string {
	refs := map[string]bool{}
	collectIdentifiers(node, excluded, refs)
	return mapKeys(refs)
}

func collectReferences(node ast.Node, excluded map[string]bool) []string {
	refs := map[string]bool{}
	collectIdentifiers(node, excluded, refs)
	return mapKeys(refs)
}

func collectIdentifiers(node ast.Node, excluded map[string]bool, refs map[string]bool) {
	if node == nil {
		return
	}
	ast.Inspect(node, func(current ast.Node) bool {
		switch typed := current.(type) {
		case nil:
			return true
		case *ast.SelectorExpr:
			collectIdentifiers(typed.X, excluded, refs)
			return false
		case *ast.KeyValueExpr:
			collectIdentifiers(typed.Value, excluded, refs)
			return false
		case *ast.Field:
			collectIdentifiers(typed.Type, excluded, refs)
			return false
		case *ast.ValueSpec:
			collectIdentifiers(typed.Type, excluded, refs)
			for _, value := range typed.Values {
				collectIdentifiers(value, excluded, refs)
			}
			return false
		case *ast.AssignStmt:
			for _, expr := range typed.Rhs {
				collectIdentifiers(expr, excluded, refs)
			}
			if typed.Tok != token.DEFINE {
				for _, expr := range typed.Lhs {
					collectIdentifiers(expr, excluded, refs)
				}
			}
			return false
		case *ast.Ident:
			if typed.Name == "_" || excluded[typed.Name] || predeclared[typed.Name] {
				return false
			}
			refs[typed.Name] = true
			return false
		}
		return true
	})
}

func receiverTypeName(expr ast.Expr) string {
	switch typed := expr.(type) {
	case *ast.Ident:
		return typed.Name
	case *ast.StarExpr:
		return receiverTypeName(typed.X)
	case *ast.IndexExpr:
		return receiverTypeName(typed.X)
	case *ast.IndexListExpr:
		return receiverTypeName(typed.X)
	}
	return ""
}

func mergeSets(left, right map[string]bool) map[string]bool {
	result := map[string]bool{}
	for key, value := range left {
		result[key] = value
	}
	for key, value := range right {
		result[key] = value
	}
	return result
}

func uniqueSorted(values []string) []string {
	set := map[string]bool{}
	for _, value := range values {
		if value != "" {
			set[value] = true
		}
	}
	return mapKeys(set)
}

func mapKeys(values map[string]bool) []string {
	keys := []string{}
	for key := range values {
		keys = append(keys, key)
	}
	sort.Strings(keys)
	return keys
}

func sortImportBindings(bindings []importBinding) {
	sort.Slice(bindings, func(i, j int) bool {
		return bindings[i].Local < bindings[j].Local
	})
}

func sourceSlice(source string, fset *token.FileSet, start, end token.Pos) string {
	startOffset := offset(fset, start)
	endOffset := offset(fset, end)
	if startOffset < 0 {
		startOffset = 0
	}
	if endOffset > len(source) {
		endOffset = len(source)
	}
	if endOffset < startOffset {
		endOffset = startOffset
	}
	return source[startOffset:endOffset]
}

func makeRange(source string, fset *token.FileSet, start, end token.Pos) sourceRange {
	return rangeFromOffsets(source, offset(fset, start), offset(fset, end))
}

func rangeFromOffsets(source string, start, end int) sourceRange {
	return sourceRange{
		StartByte: start,
		EndByte:   end,
		StartLine: strings.Count(source[:clamp(start, 0, len(source))], "\n") + 1,
		EndLine:   strings.Count(source[:clamp(end, 0, len(source))], "\n") + 1,
	}
}

func offset(fset *token.FileSet, pos token.Pos) int {
	if !pos.IsValid() {
		return 0
	}
	return fset.Position(pos).Offset
}

func clamp(value, min, max int) int {
	if value < min {
		return min
	}
	if value > max {
		return max
	}
	return value
}

func stableTextHash(value string) string {
	framed := fmt.Sprintf("piece-text-v2\x00%d\x00%s", len(value), value)
	digest := sha256.Sum256([]byte(framed))
	return hex.EncodeToString(digest[:])
}
