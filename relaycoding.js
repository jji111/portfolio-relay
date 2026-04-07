require('dotenv').config();
const pool = require('./db');
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
    res.sendFile(path.join(__dirname, 'index.html'));
});

app.get('/game', (req, res) => {
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

const rooms = {};

function createRoom(roomId) {
    return {
        id: roomId,
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
}

function getHostId(roomId) {
    return rooms[roomId].allParticipants[0] || null;
}

function stopServerTimer(roomId) {
    if (rooms[roomId].timerInterval) {
        clearInterval(rooms[roomId].timerInterval);
        rooms[roomId].timerInterval = null;
    }
}

function startServerTimer(duration, roomId) {
    stopServerTimer(roomId);
    rooms[roomId].timeLeft = duration;
    io.to(roomId).emit('timer_update', { timeLeft: rooms[roomId].timeLeft });

    rooms[roomId].timerInterval = setInterval(() => {
        rooms[roomId].timeLeft--;
        io.to(roomId).emit('timer_update', { timeLeft: rooms[roomId].timeLeft });

        if (rooms[roomId].timeLeft <= 0) {
            stopServerTimer(roomId);
            const currentPlayerId = rooms[roomId].turnQueue[0];
            if (currentPlayerId) {
                io.to(currentPlayerId).emit('force_pass');
            }
        }
    }, 1000);
}

function broadcastStatus(roomId) {
    const playerList = rooms[roomId].allParticipants.map(id => id.substring(0, 6));
    const queueList = rooms[roomId].turnQueue.map(id => id.substring(0, 6));

    rooms[roomId].allParticipants.forEach((id) => {
        const myQueueIndex = rooms[roomId].turnQueue.indexOf(id);
        const isHost = id === getHostId(roomId);

        io.to(id).emit('status_update', {
            myOrder: myQueueIndex !== -1 ? myQueueIndex : (rooms[roomId].isGameStarted ? 0 : (isHost ? 1 : 0)),
            currentPlayer: rooms[roomId].turnQueue[0] || null,
            currentCode: rooms[roomId].currentCode,
            currentLang: rooms[roomId].currentLang,
            totalRemaining: rooms[roomId].turnQueue.length,
            isGameStarted: rooms[roomId].isGameStarted,
            selectedProblem: rooms[roomId].selectedProblem,
            usedProblems: rooms[roomId].usedProblems,
            isHost,
            totalPlayers: rooms[roomId].allParticipants.length,
            playerList,
            queueList,
            myId: id.substring(0, 6)
        });
    });
}

function handleTurnFinished(socketId, data, roomId) {
    if (socketId !== rooms[roomId].turnQueue[0]) return;

    if (data.code && typeof data.code === 'string') {
        const lang = data.lang || 'cpp';
        const { structuralImpact, oldScore, newScore, breakdown, newLineAuthors } = analyzeTurn(
            rooms[roomId].currentCode, data.code, lang, socketId, rooms[roomId].lineAuthors
        );

        rooms[roomId].currentCode = data.code;
        rooms[roomId].currentLang = lang;
        rooms[roomId].lineAuthors = newLineAuthors;
        rooms[roomId].structureScores[socketId] = (rooms[roomId].structureScores[socketId] || 0) + structuralImpact;

        const turnNum = rooms[roomId].finishedPlayers.length + 1;
        const breakdownStr = Object.entries(breakdown)
            .map(([type, count]) => `${type}(${count}개)`)
            .join(', ');

        rooms[roomId].turnLogs.push(
            `[턴 ${turnNum}] 플레이어 ${socketId.substring(0, 5)}\n` +
            `  - 이전 점수: ${oldScore}  현재 점수: ${newScore}  기여도: +${structuralImpact}\n` +
            `  - 사용된 구조: ${breakdownStr || '없음'}\n`
        );
    }

    const finishedPlayer = rooms[roomId].turnQueue.shift();
    rooms[roomId].finishedPlayers.push(finishedPlayer);

    if (rooms[roomId].turnQueue.length > 0) {
        startServerTimer(rooms[roomId].selectedProblem.timeLimit, roomId);
    } else {
        stopServerTimer(roomId);
    }

    checkGameOver(roomId);
    broadcastStatus(roomId);
}

async function checkGameOver(roomId) {
    if (rooms[roomId].turnQueue.length === 0 && rooms[roomId].finishedPlayers.length > 0) {
        console.log('\n--- 전체 턴 진행 상세 로그 ---');
        rooms[roomId].turnLogs.forEach(log => console.log(log));

        const roundResults = calcFinalScores(
            rooms[roomId].finishedPlayers,
            rooms[roomId].structureScores,
            rooms[roomId].lineAuthors
        );

        Object.entries(roundResults).forEach(([id, stats]) => {
            rooms[roomId].totalScores[id] = (rooms[roomId].totalScores[id] || 0) + stats.finalScore;
        });

        const finalScores = {};
        Object.entries(roundResults).forEach(([id, stats]) => {
            finalScores[id] = { ...stats, totalScore: rooms[roomId].totalScores[id] || 0 };
        });

        console.log('\n--- 최종 성적표 ---');
        Object.entries(finalScores).forEach(([id, stats]) => {
            console.log(`플레이어 [${id.substring(0, 5)}] => 이번 라운드: ${stats.finalScore}pt / 누적: ${stats.totalScore}pt`);
        });

        for (const [id, stats] of Object.entries(finalScores)) {
            await pool.query(
                'INSERT INTO scores (socket_id, room_id, round_score, total_score) VALUES ($1, $2, $3, $4)',
                [id, roomId, stats.finalScore, stats.totalScore]
            );
        }

        io.to(roomId).emit('game_over', { finalScores });
    }
}

io.on('connection', (socket) => {

    socket.on('create_room', async (data) => {
        const roomId = data.roomId;
        socket.roomId = roomId;
        socket.join(roomId);
        rooms[roomId] = createRoom(roomId);
        await pool.query('INSERT INTO rooms (id) VALUES ($1)', [roomId]);
        await pool.query('INSERT INTO players (socket_id, room_id) VALUES ($1, $2)', [socket.id, roomId]);
        rooms[roomId].allParticipants.push(socket.id);
        rooms[roomId].totalScores[socket.id] = 0;
        broadcastStatus(roomId);
    });

    socket.on('join_room', async (data) => {
        const roomId = data.roomId;

        const result = await pool.query('SELECT id FROM rooms WHERE id = $1', [roomId]);
        if (result.rowCount === 0) {

            socket.emit('room_not_found');
            return;
        }

        await pool.query('INSERT INTO players (socket_id, room_id) VALUES ($1, $2)', [socket.id, roomId]);
        socket.roomId = roomId;
        socket.join(roomId);

        if (!rooms[roomId]) {
            rooms[roomId] = createRoom(roomId);
        }

        if (!rooms[roomId].allParticipants.includes(socket.id)) {
            rooms[roomId].allParticipants.push(socket.id);
            rooms[roomId].totalScores[socket.id] = 0;
        }

        broadcastStatus(roomId);
    });

    socket.on('lang_update', (data) => {
        const roomId = socket.roomId;
        if (socket.id !== rooms[roomId].turnQueue[0]) return;
        const ALLOWED = ['python', 'cpp', 'c'];
        if (ALLOWED.includes(data.lang)) {
            rooms[roomId].currentLang = data.lang;
        }
    });

    socket.on('select_problem', (problem) => {
        const roomId = socket.roomId;
        if (socket.id !== getHostId(roomId) || rooms[roomId].isGameStarted) return;
        const found = problems.find(p => p.id === problem.id);
        if (!found || rooms[roomId].usedProblems.includes(found.id)) return;
        rooms[roomId].selectedProblem = found;
        console.log(`문제 미리보기: ${found.title}`);
        broadcastStatus(roomId);
    });

    socket.on('start_test', () => {
        const roomId = socket.roomId;
        if (socket.id !== getHostId(roomId) || !rooms[roomId].selectedProblem || rooms[roomId].isGameStarted) return;

        rooms[roomId].isGameStarted = true;
        const rest = shuffle(rooms[roomId].allParticipants.filter(id => id !== getHostId(roomId)));
        rooms[roomId].turnQueue = [getHostId(roomId), ...rest];
        rooms[roomId].finishedPlayers = [];
        rooms[roomId].currentCode = '';
        rooms[roomId].currentLang = 'cpp';
        rooms[roomId].structureScores = {};
        rooms[roomId].lineAuthors = {};
        rooms[roomId].turnLogs = [];

        if (!rooms[roomId].usedProblems.includes(rooms[roomId].selectedProblem.id)) {
            rooms[roomId].usedProblems.push(rooms[roomId].selectedProblem.id);
        }

        console.log(`\n--- 테스트 시작 ---`);
        console.log(`문제: ${rooms[roomId].selectedProblem.title}`);
        console.log(`셔플된 순서: ${rooms[roomId].turnQueue.map(id => id.substring(0, 5)).join(' → ')}`);

        io.to(roomId).emit('problem_locked', rooms[roomId].selectedProblem);
        startServerTimer(rooms[roomId].selectedProblem.timeLimit, roomId);
        broadcastStatus(roomId);
    });

    socket.on('turn_finished', (data) => {
        const roomId = socket.roomId;
        handleTurnFinished(socket.id, data, roomId);
    });

    socket.on('request_restart', () => {
        const roomId = socket.roomId;
        console.log('\n--- 새 라운드 시작 ---');
        stopServerTimer(roomId);
        rooms[roomId].allParticipants = shuffle(rooms[roomId].allParticipants);
        console.log(`새 방장: ${rooms[roomId].allParticipants[0].substring(0, 5)}`);
        rooms[roomId].isGameStarted = false;
        rooms[roomId].selectedProblem = null;
        rooms[roomId].turnQueue = [];
        io.to(roomId).emit('game_reset');
        broadcastStatus(roomId);
    });

    socket.on('disconnect', async () => {
        const roomId = socket.roomId;
        if (!roomId || !rooms[roomId]) return;

        await pool.query('DELETE FROM players WHERE socket_id = $1', [socket.id]);
        
        console.log(`접속 종료: ${socket.id}`);
        const wasCurrentTurn = rooms[roomId].turnQueue[0] === socket.id;
        rooms[roomId].allParticipants = rooms[roomId].allParticipants.filter(id => id !== socket.id);
        rooms[roomId].turnQueue = rooms[roomId].turnQueue.filter(id => id !== socket.id);
        if (wasCurrentTurn) {
            stopServerTimer(roomId);
            if (rooms[roomId].turnQueue.length > 0) {
                startServerTimer(rooms[roomId].selectedProblem.timeLimit, roomId);
            }
            checkGameOver(roomId);
        }

        broadcastStatus(roomId);

        if (rooms[roomId].allParticipants.length === 0) {
                await pool.query('DELETE FROM players WHERE room_id = $1', [roomId]);
                await pool.query('DELETE FROM rooms WHERE id = $1', [roomId]);       
                delete rooms[roomId];
            
        }
    });
});

server.listen(port, () => {
    console.log(`서버 가동: http://localhost:${port}`);
});