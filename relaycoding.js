require('dotenv').config();
const express = require('express');
const app = express();
const path = require('path');
const port = 3000;

const http = require('http');
const { Server } = require('socket.io');
const server = http.createServer(app);
const io = new Server(server);

const { runCode, judgeCode } = require('./judge');
const { analyzeTurn, calcFinalScores } = require('./scorer');
const problems = require('./problems.json');
const { generateProblemHandler } = require('./ai-generate');
app.use(express.json({ limit: '64kb' }));

app.get('/', (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    res.sendFile(path.join(__dirname, 'relaycoding.html'));
});

app.get('/problems', (req, res) => res.json(problems));

app.post('/run', async (req, res) => {
    const { code, lang, input } = req.body;
    if (!code || typeof code !== 'string') return res.status(400).json({ error: '코드가 없습니다.' });
    const ALLOWED = ['python', 'cpp', 'c'];
    if (!ALLOWED.includes(lang)) return res.status(400).json({ error: '지원하지 않는 언어입니다.' });
    try {
        const result = await runCode(code, lang, input || '');
        res.json(result);
    } catch (err) {
        res.status(500).json({ error: '서버 내부 오류' });
    }
});

app.post('/judge', async (req, res) => {
    const { code, lang, problemId } = req.body;
    if (!code || typeof code !== 'string') return res.status(400).json({ error: '코드가 없습니다.' });
    const ALLOWED = ['python', 'cpp', 'c'];
    if (!ALLOWED.includes(lang)) return res.status(400).json({ error: '지원하지 않는 언어입니다.' });
    try {
        const problem = problems.find(p => p.id === problemId);
        if (!problem) return res.status(404).json({ error: '문제를 찾을 수 없습니다.' });
        const result = await judgeCode(code, lang, problem.testCases);
        res.json(result);
    } catch (err) {
        res.status(500).json({ error: '서버 내부 오류' });
    }
});

app.post('/generate-problem', generateProblemHandler);

function shuffle(arr) {
    const a = [...arr];
    for (let i = a.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [a[i], a[j]] = [a[j], a[i]];
    }
    return a;
}

const gameState = {
    allParticipants: [],
    turnQueue: [],
    finishedPlayers: [],
    currentCode: '',
    currentLang: 'cpp',
    structureScores: {},
    lineAuthors: {},
    turnLogs: [],
    isGameStarted: false,
    selectedProblem: null,
    usedProblems: [],
    totalScores: {},
    timeLeft: 0,
    timerInterval: null
};

function getHostId() {
    return gameState.allParticipants[0] || null;
}

function stopServerTimer() {
    if (gameState.timerInterval) {
        clearInterval(gameState.timerInterval);
        gameState.timerInterval = null;
    }
}

function startServerTimer(duration) {
    stopServerTimer();
    gameState.timeLeft = duration;
    io.emit('timer_update', { timeLeft: gameState.timeLeft });

    gameState.timerInterval = setInterval(() => {
        gameState.timeLeft--;
        io.emit('timer_update', { timeLeft: gameState.timeLeft });

        if (gameState.timeLeft <= 0) {
            stopServerTimer();
            const currentPlayerId = gameState.turnQueue[0];
            if (currentPlayerId) {
                io.to(currentPlayerId).emit('force_pass');
            }
        }
    }, 1000);
}

function broadcastStatus() {
    const playerList = gameState.allParticipants.map(id => id.substring(0, 6));
    const queueList = gameState.turnQueue.map(id => id.substring(0, 6));

    gameState.allParticipants.forEach((id) => {
        const myQueueIndex = gameState.turnQueue.indexOf(id);
        const isHost = id === getHostId();

        io.to(id).emit('status_update', {
            myOrder: myQueueIndex !== -1 ? myQueueIndex : (gameState.isGameStarted ? 0: (isHost ? 1 : 0)),
            currentPlayer: gameState.turnQueue[0] || null,
            currentCode: gameState.currentCode,
            currentLang: gameState.currentLang,
            totalRemaining: gameState.turnQueue.length,
            isGameStarted: gameState.isGameStarted,
            selectedProblem: gameState.selectedProblem,
            usedProblems: gameState.usedProblems,
            isHost,
            totalPlayers: gameState.allParticipants.length,
            playerList,
            queueList,
            myId: id.substring(0, 6)
        });
    });
}

function handleTurnFinished(socketId, data) {
    if (socketId !== gameState.turnQueue[0]) return;

    if (data.code && typeof data.code === 'string') {
        const lang = data.lang || 'cpp';
        const { structuralImpact, oldScore, newScore, breakdown, newLineAuthors } = analyzeTurn(
            gameState.currentCode, data.code, lang, socketId, gameState.lineAuthors
        );

        gameState.currentCode = data.code;
        gameState.currentLang = lang;
        gameState.lineAuthors = newLineAuthors;
        gameState.structureScores[socketId] = (gameState.structureScores[socketId] || 0) + structuralImpact;

        const turnNum = gameState.finishedPlayers.length + 1;
        const breakdownStr = Object.entries(breakdown)
            .map(([type, count]) => `${type}(${count}개)`)
            .join(', ');

        gameState.turnLogs.push(
            `[턴 ${turnNum}] 플레이어 ${socketId.substring(0, 5)}\n` +
            `  - 이전 점수: ${oldScore}  현재 점수: ${newScore}  기여도: +${structuralImpact}\n` +
            `  - 사용된 구조: ${breakdownStr || '없음'}\n`
        );
    }

    const finishedPlayer = gameState.turnQueue.shift();
    gameState.finishedPlayers.push(finishedPlayer);

    if (gameState.turnQueue.length > 0) {
        startServerTimer(gameState.selectedProblem.timeLimit);
    } else {
        stopServerTimer();
    }

    checkGameOver();
    broadcastStatus();
}

function checkGameOver() {
    if (gameState.turnQueue.length === 0 && gameState.finishedPlayers.length > 0) {
        console.log('\n--- 전체 턴 진행 상세 로그 ---');
        gameState.turnLogs.forEach(log => console.log(log));

        const roundResults = calcFinalScores(
            gameState.finishedPlayers,
            gameState.structureScores,
            gameState.lineAuthors
        );

        Object.entries(roundResults).forEach(([id, stats]) => {
            gameState.totalScores[id] = (gameState.totalScores[id] || 0) + stats.finalScore;
        });

        const finalScores = {};
        Object.entries(roundResults).forEach(([id, stats]) => {
            finalScores[id] = { ...stats, totalScore: gameState.totalScores[id] || 0 };
        });

        console.log('\n--- 최종 성적표 ---');
        Object.entries(finalScores).forEach(([id, stats]) => {
            console.log(`플레이어 [${id.substring(0, 5)}] => 이번 라운드: ${stats.finalScore}pt / 누적: ${stats.totalScore}pt`);
        });

        io.emit('game_over', { finalScores });
    }
}

io.on('connection', (socket) => {
    gameState.allParticipants.push(socket.id);
    gameState.totalScores[socket.id] = gameState.totalScores[socket.id] || 0;

    console.log(`새로운 접속: ${socket.id} (현재 인원: ${gameState.allParticipants.length}명)`);
    broadcastStatus();

    socket.on('lang_update', (data) => {
        if (socket.id !== gameState.turnQueue[0]) return;
        const ALLOWED = ['python', 'cpp', 'c'];
        if (ALLOWED.includes(data.lang)) {
            gameState.currentLang = data.lang;
        }
    });

    socket.on('select_problem', (problem) => {
        if (socket.id !== getHostId() || gameState.isGameStarted) return;
        const found = problems.find(p => p.id === problem.id);
        if (!found || gameState.usedProblems.includes(found.id)) return;
        gameState.selectedProblem = found;
        console.log(`문제 미리보기: ${found.title}`);
        broadcastStatus();
    });

    socket.on('start_test', () => {
        if (socket.id !== getHostId() || !gameState.selectedProblem || gameState.isGameStarted) return;

        gameState.isGameStarted = true;
        const rest = shuffle(gameState.allParticipants.filter(id => id !== getHostId()));
        gameState.turnQueue = [getHostId(), ...rest];
        gameState.finishedPlayers = [];
        gameState.currentCode = '';
        gameState.currentLang = 'cpp';
        gameState.structureScores = {};
        gameState.lineAuthors = {};
        gameState.turnLogs = [];

        if (!gameState.usedProblems.includes(gameState.selectedProblem.id)) {
            gameState.usedProblems.push(gameState.selectedProblem.id);
        }

        console.log(`\n--- 테스트 시작 ---`);
        console.log(`문제: ${gameState.selectedProblem.title}`);
        console.log(`셔플된 순서: ${gameState.turnQueue.map(id => id.substring(0, 5)).join(' → ')}`);

        io.emit('problem_locked', gameState.selectedProblem);
        startServerTimer(gameState.selectedProblem.timeLimit);
        broadcastStatus();
    });

    socket.on('turn_finished', (data) => {
        handleTurnFinished(socket.id, data);
    });

    socket.on('request_restart', () => {
        console.log('\n--- 새 라운드 시작 ---');
        stopServerTimer();
        gameState.allParticipants = shuffle(gameState.allParticipants);
        console.log(`새 방장: ${gameState.allParticipants[0].substring(0, 5)}`);
        gameState.isGameStarted = false;
        gameState.selectedProblem = null;
        gameState.turnQueue = [];
        io.emit('game_reset');
        broadcastStatus();
    });

    socket.on('disconnect', () => {
        console.log(`접속 종료: ${socket.id}`);
        const wasCurrentTurn = gameState.turnQueue[0] === socket.id;
        gameState.allParticipants = gameState.allParticipants.filter(id => id !== socket.id);
        gameState.turnQueue = gameState.turnQueue.filter(id => id !== socket.id);
        if (wasCurrentTurn) {
            stopServerTimer();
            if (gameState.turnQueue.length > 0) {
                startServerTimer(gameState.selectedProblem.timeLimit);
            }
            checkGameOver();
        }
        broadcastStatus();
    });
});

server.listen(port, () => {
    console.log(`서버 가동: http://localhost:${port}`);
});