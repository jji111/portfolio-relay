const Parser = require('tree-sitter');
const C = require('tree-sitter-c');

// 1. 파서 기계 준비 및 C언어 모드 장착
const parser = new Parser();
parser.setLanguage(C);

// 2. 우리가 분석할 C언어 코드 (텍스트)
const sourceCode = `
#include <stdio.h>

int main() {
    int sum = 0;
    for (int i = 0; i < 10; i++) {
        sum += i;
    }
    return 0;
}
`;

console.log("--- 분석할 C언어 코드 ---");
console.log(sourceCode);
console.log("--- Tree-sitter AST 노드 분석 결과 ---");

// 3. 코드를 씹고 뜯어서 도면(AST)으로 만듦
const tree = parser.parse(sourceCode);

function prettyPrint(node, indent = 0) {
    const prefix = '  '.repeat(indent);
    const name = node.isNamed ? node.type : `"${node.type}"`;
    console.log(`${prefix}(${name})`);
    for (let i = 0; i < node.childCount; i++) {
        prettyPrint(node.child(i), indent + 1);
    }
}

prettyPrint(tree.rootNode);