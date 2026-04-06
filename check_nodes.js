const Parser = require('tree-sitter');
const Cpp = require('tree-sitter-cpp');
const C = require('tree-sitter-c');
const Python = require('tree-sitter-python');

const parser = new Parser();

function collectNodes(node, found = new Set()) {
    if (node.isNamed) found.add(node.type);
    for (let i = 0; i < node.childCount; i++) {
        collectNodes(node.child(i), found);
    }
    return found;
}

// ===== C =====
parser.setLanguage(C);
const cCode = `
#include <stdio.h>
int add(int a, int b) { return a + b; }
int main() {
    int x = 5;
    int *p = &x;
    for (int i = 0; i < 3; i++) { x += i; }
    while (x > 0) { x--; }
    if (x == 0) { printf("zero"); }
    add(1, 2);
    return 0;
}`;
console.log("===== C 노드 =====");
console.log([...collectNodes(parser.parse(cCode).rootNode)].sort().join('\n'));

// ===== C++ =====
parser.setLanguage(Cpp);
const cppCode = `
#include <iostream>
class Solution {
public:
    int solve(int n) { return n * 2; }
};
int main() {
    int x = 0;
    int *p = &x;
    for (int i = 0; i < 3; i++) { x += i; }
    while (x > 0) { x--; }
    if (x == 0) { std::cout << "zero"; }
    Solution s;
    s.solve(3);
    return 0;
}`;
console.log("\n===== C++ 노드 =====");
console.log([...collectNodes(parser.parse(cppCode).rootNode)].sort().join('\n'));

// ===== Python =====
parser.setLanguage(Python);
const pyCode = `
class Solution:
    def solve(self, n):
        return n * 2

def main():
    x = 0
    for i in range(3):
        x += i
    while x > 0:
        x -= 1
    if x == 0:
        print("zero")
    s = Solution()
    s.solve(3)
`;
console.log("\n===== Python 노드 =====");
console.log([...collectNodes(parser.parse(pyCode).rootNode)].sort().join('\n'));
