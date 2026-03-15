const fs = require('fs');
const { exec } = require('child_process');
const { v4: uuidv4 } = require('uuid');
const path = require('path');
const { performance } = require('perf_hooks');

const FORBIDDEN_WORDS = {
    python: ['os', 'sys', 'subprocess', 'open', 'eval', 'exec', '__import__'],
    cpp: ['system', 'popen', 'fstream', 'unistd.h'],
    c: ['system', 'popen', 'unistd.h']
};

function isSafeCode(code, lang) {
    const blacklist = FORBIDDEN_WORDS[lang] || [];
    for (const word of blacklist) {
        const regex = new RegExp(`\\b${word}\\b`, 'g');
        if (regex.test(code)) return { safe: false, word };
    }
    return { safe: true };
}

function buildDockerCmd(lang, fileId, fileName, inputFileName) {
    const securityFlags = [
        '--rm',
        '--network=none',
        '--memory=128m',
        '--cpus=0.5',
        '--read-only',
        '--tmpfs /tmp:exec',
        '--security-opt no-new-privileges',
        `-v "${__dirname}:/app:ro"`,
    ].join(' ');

    const inputRedirect = inputFileName ? `< /app/${inputFileName}` : '';

    if (lang === 'python') {
        return `docker run ${securityFlags} python:3.9-slim sh -c "python /app/${fileName} ${inputRedirect}"`;
    } else if (lang === 'cpp') {
        return `docker run ${securityFlags} gcc:latest sh -c "g++ /app/${fileName} -o /tmp/${fileId}.out && /tmp/${fileId}.out ${inputRedirect}"`;
    } else if (lang === 'c') {
        return `docker run ${securityFlags} gcc:latest sh -c "gcc /app/${fileName} -o /tmp/${fileId}.out && /tmp/${fileId}.out ${inputRedirect}"`;
    }
    return null;
}

const runCode = (userCode, lang, customInput = '') => {
    return new Promise((resolve) => {
        const check = isSafeCode(userCode, lang);
        if (!check.safe) return resolve({ success: false, output: `보안 에러: '${check.word}' 사용이 금지되어 있습니다.` });

        const fileId = uuidv4();
        const extMap = { python: '.py', cpp: '.cpp', c: '.c' };
        if (!extMap[lang]) return resolve({ success: false, output: '지원하지 않는 언어입니다.' });

        const fileName = `temp_${fileId}${extMap[lang]}`;
        const filePath = path.join(__dirname, fileName);
        fs.writeFileSync(filePath, userCode);

        let inputFileName = null;
        if (customInput) {
            inputFileName = `temp_${fileId}_input.txt`;
            fs.writeFileSync(path.join(__dirname, inputFileName), customInput);
        }

        const dockerCmd = buildDockerCmd(lang, fileId, fileName, inputFileName);
        const startTime = performance.now();

        exec(dockerCmd, { timeout: 5000, maxBuffer: 1024 * 512 }, (error, stdout, stderr) => {
            const executionTime = (performance.now() - startTime).toFixed(2);
            try { if (fs.existsSync(filePath)) fs.unlinkSync(filePath); } catch (e) {}
            if (inputFileName) {
                try { if (fs.existsSync(path.join(__dirname, inputFileName))) fs.unlinkSync(path.join(__dirname, inputFileName)); } catch (e) {}
            }
            if (error) {
                if (error.killed || error.signal === 'SIGTERM') return resolve({ success: false, output: '시간 초과 (5초 이상 실행)' });
                if (error.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER') return resolve({ success: false, output: '출력 초과 (최대 512KB)' });
                return resolve({ success: false, output: stderr || error.message });
            }
            resolve({ success: true, output: stdout, time: `${executionTime} ms` });
        });
    });
};

const judgeCode = (userCode, lang, testCases) => {
    return new Promise(async (resolve) => {
        const check = isSafeCode(userCode, lang);
        if (!check.safe) return resolve({ success: false, results: [], error: `보안 에러: '${check.word}' 사용이 금지되어 있습니다.` });

        const extMap = { python: '.py', cpp: '.cpp', c: '.c' };
        const fileId = uuidv4();
        const fileName = `temp_${fileId}${extMap[lang]}`;
        const filePath = path.join(__dirname, fileName);
        fs.writeFileSync(filePath, userCode);

        const results = [];
        for (let i = 0; i < testCases.length; i++) {
            const tc = testCases[i];
            const inputFileName = `temp_${fileId}_input${i}.txt`;
            const inputFilePath = path.join(__dirname, inputFileName);
            fs.writeFileSync(inputFilePath, tc.input);

            const dockerCmd = buildDockerCmd(lang, `${fileId}_${i}`, fileName, inputFileName);
            const startTime = performance.now();

            await new Promise((res) => {
                exec(dockerCmd, { timeout: 5000, maxBuffer: 1024 * 512 }, (error, stdout, stderr) => {
                    const executionTime = (performance.now() - startTime).toFixed(2);
                    try { if (fs.existsSync(inputFilePath)) fs.unlinkSync(inputFilePath); } catch (e) {}

                    if (error) {
                        if (error.killed || error.signal === 'SIGTERM') {
                            results.push({ index: i + 1, pass: false, reason: '시간 초과', time: `${executionTime} ms` });
                        } else {
                            results.push({ index: i + 1, pass: false, reason: stderr || error.message, time: `${executionTime} ms` });
                        }
                        return res();
                    }

                    const actual   = stdout.trim();
                    const expected = tc.output.trim();
                    const pass     = actual === expected;

                    results.push({
                        index: i + 1,
                        pass,
                        reason: pass ? null : `예상: "${expected}" / 실제: "${actual}"`,
                        time: `${executionTime} ms`
                    });
                    res();
                });
            });
        }
        try { if (fs.existsSync(filePath)) fs.unlinkSync(filePath); } catch (e) {}
        resolve({ success: true, results, allPass: results.every(r => r.pass) });
    });
};

module.exports = { runCode, judgeCode };