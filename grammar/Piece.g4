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
    : depsDeclaration
    | runtimeDepsDeclaration
    | typeDepsDeclaration
    | externalDepsDeclaration
    | actionDeclaration
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
    ;

mnemonicDeclaration
    : MNEMONIC STRING
    ;

outputDeclaration
    : OUTPUT STRING
    ;

PACKAGE: 'package';
LANGUAGE: 'language';
SOURCE: 'source';
TARGET: 'target';
DEPS: 'deps';
RUNTIME_DEPS: 'runtimeDeps';
TYPE_DEPS: 'typeDeps';
EXTERNAL_DEPS: 'externalDeps';
ACTION: 'action';
MNEMONIC: 'mnemonic';
OUTPUT: 'output';

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
