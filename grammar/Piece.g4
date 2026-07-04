grammar Piece;

document
    : packageDeclaration EOF
    ;

packageDeclaration
    : PACKAGE STRING LBRACE packageMember* RBRACE
    ;

packageMember
    : languageDeclaration
    | sourceDeclaration
    | targetDeclaration
    ;

languageDeclaration
    : LANGUAGE IDENTIFIER
    ;

sourceDeclaration
    : SOURCE STRING
    ;

targetDeclaration
    : TARGET targetKind STRING LBRACE targetMember* RBRACE
    ;

targetKind
    : TYPE
    | CLASS
    | FUNCTION
    | VALUE
    | EFFECT
    | HEADER
    ;

targetMember
    : labelDeclaration
    | visibilityDeclaration
    | depsDeclaration
    | runtimeDepsDeclaration
    | typeDepsDeclaration
    | externalDepsDeclaration
    | actionDeclaration
    ;

labelDeclaration
    : LABEL STRING
    ;

visibilityDeclaration
    : VISIBILITY stringList
    ;

depsDeclaration
    : DEPS stringList
    ;

runtimeDepsDeclaration
    : RUNTIME_DEPS stringList
    ;

typeDepsDeclaration
    : TYPE_DEPS stringList
    ;

externalDepsDeclaration
    : EXTERNAL_DEPS stringList
    ;

stringList
    : STRING (COMMA STRING)*
    ;

actionDeclaration
    : ACTION actionKind LBRACE actionMember* RBRACE
    ;

actionKind
    : FEEDBACK
    | COMPILE
    | PREVIEW
    | TEST
    | TYPECHECK
    | DOCUMENTATION
    ;

actionMember
    : mnemonicDeclaration
    | outputDeclaration
    | pathDeclaration
    | inputsDeclaration
    ;

mnemonicDeclaration
    : MNEMONIC STRING
    ;

outputDeclaration
    : OUTPUT STRING
    ;

pathDeclaration
    : PATH STRING
    ;

inputsDeclaration
    : INPUTS stringList
    ;

PACKAGE: 'package';
LANGUAGE: 'language';
SOURCE: 'source';
TARGET: 'target';
LABEL: 'label';
VISIBILITY: 'visibility';
DEPS: 'deps';
RUNTIME_DEPS: 'runtimeDeps';
TYPE_DEPS: 'typeDeps';
EXTERNAL_DEPS: 'externalDeps';
ACTION: 'action';
MNEMONIC: 'mnemonic';
OUTPUT: 'output';
PATH: 'path';
INPUTS: 'inputs';

TYPE: 'type';
CLASS: 'class';
FUNCTION: 'function';
VALUE: 'value';
EFFECT: 'effect';
HEADER: 'header';

FEEDBACK: 'feedback';
COMPILE: 'compile';
PREVIEW: 'preview';
TEST: 'test';
TYPECHECK: 'typecheck';
DOCUMENTATION: 'documentation';

LBRACE: '{';
RBRACE: '}';
COMMA: ',';

IDENTIFIER: [A-Za-z_][A-Za-z0-9_.-]*;

STRING
    : '"' ( '\\' [btnfr"\\] | '\\u' HEX HEX HEX HEX | ~["\\\r\n] )* '"'
    ;

LINE_COMMENT: '//' ~[\r\n]* -> skip;
BLOCK_COMMENT: '/*' .*? '*/' -> skip;
WS: [ \t\r\n]+ -> skip;

fragment HEX: [0-9a-fA-F];
