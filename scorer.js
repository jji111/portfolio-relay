const Parser = require('tree-sitter');
const Cpp = require('tree-sitter-cpp');
const C = require('tree-sitter-c');
const Python = require('tree-sitter-python');
const diff = require('diff');

const parser = new Parser();

const LOOP_NODES = ['for_statement', 'while_statement', 'do_statement'];

const STRUCTURE_SCORE = {
    cpp:    { 'function_definition': 10, 'main_function': 4, 'class_specifier': 10, 'loop': 6, 'if_statement': 5, 'pointer_declarator': 4, 'init_declarator': 2, 'call_expression': 1 },
    c:      { 'function_definition': 10, 'main_function': 4, 'loop': 6, 'if_statement': 5, 'pointer_declarator': 4, 'declaration': 2, 'call_expression': 1 },
    python: { 'function_definition': 10, 'main_function': 4, 'class_definition': 10, 'loop': 6, 'if_statement': 5, 'assignment': 2, 'call': 1 }
};

function getFunctionName(node, lang) {
    try {
        if (lang === 'python') {
            return node.childForFieldName('name')?.text;
        } else {
            let decl = node.childForFieldName('declarator');
            while (decl) {
                if (decl.type === 'identifier') return decl.text;
                decl = decl.childForFieldName('declarator') || decl.firstChild;
            }
        }
    } catch (e) {
        return null;
    }
    return null;
}

function updateLineAuthors(oldCode, newCode, playerId, prevLineAuthors) {
    const changes = diff.diffLines(oldCode || '', newCode || '');
    const newAuthors = {};
    let currentNewLine = 0;
    let currentOldLine = 0;

    changes.forEach((part) => {
        const lines = part.value.split('\n');
        if (lines[lines.length - 1] === '') lines.pop();

        if (part.added) {
            lines.forEach(() => { newAuthors[currentNewLine++] = playerId; });
        } else if (part.removed) {
            currentOldLine += lines.length;
        } else {
            lines.forEach(() => { newAuthors[currentNewLine++] = prevLineAuthors[currentOldLine++] || 'system'; });
        }
    });

    return newAuthors;
}

function calcSurvivalRate(lineAuthors, playerId) {
    const lines = Object.values(lineAuthors);
    const total = lines.length;
    if (total === 0) return 0;
    return lines.filter(id => id === playerId).length / total;
}

function calculateScore(node, lang) {
    const scoreTable = STRUCTURE_SCORE[lang];
    if (!scoreTable) return { score: 0, breakdown: {} };

    let score = 0;
    const breakdown = {};

    const addNode = (type, pts) => {
        score += pts;
        breakdown[type] = (breakdown[type] || 0) + 1;
    };

    if (LOOP_NODES.includes(node.type)) {
        addNode('loop', scoreTable['loop'] || 0);
    } else if (node.type === 'function_definition') {
        const funcName = getFunctionName(node, lang);
        if (funcName === 'main') {
            addNode('main_function', scoreTable['main_function'] || 0);
        } else {
            addNode('function_definition', scoreTable['function_definition'] || 0);
        }
    } else if (scoreTable[node.type] !== undefined) {
        addNode(node.type, scoreTable[node.type]);
    }

    for (let i = 0; i < node.childCount; i++) {
        const child = calculateScore(node.child(i), lang);
        score += child.score;
        for (const [type, count] of Object.entries(child.breakdown)) {
            breakdown[type] = (breakdown[type] || 0) + count;
        }
    }

    return { score, breakdown };
}

function analyzeTurn(oldCode, newCode, lang, playerId, lineAuthors) {
    const langMap = { 'cpp': Cpp, 'c': C, 'python': Python };
    if (!langMap[lang]) return { structuralImpact: 0, oldScore: 0, newScore: 0, breakdown: {}, newLineAuthors: lineAuthors };

    parser.setLanguage(langMap[lang]);

    const newLineAuthors = updateLineAuthors(oldCode, newCode, playerId, lineAuthors);

    const oldResult = calculateScore(parser.parse(oldCode || '').rootNode, lang);
    const newResult = calculateScore(parser.parse(newCode || '').rootNode, lang);

    const structuralImpact = Math.max(0, newResult.score - oldResult.score);

    return {
        structuralImpact,
        oldScore: oldResult.score,
        newScore: newResult.score,
        breakdown: newResult.breakdown,
        newLineAuthors
    };
}

function calcFinalScores(playerIds, structureScores, finalLineAuthors) {
    const finalResults = {};
    playerIds.forEach((playerId) => {
        const survivalRate = calcSurvivalRate(finalLineAuthors, playerId);
        const baseScore = structureScores[playerId] || 0;
        finalResults[playerId] = {
            baseScore,
            survivalRate,
            finalScore: Math.round(baseScore * survivalRate)
        };
    });
    return finalResults;
}

module.exports = { analyzeTurn, calcFinalScores };