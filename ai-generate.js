const axios = require('axios');

const GEMINI_API_KEY = process.env.GEMINI_API_KEY; 
const GEMINI_MODEL = 'gemini-2.5-flash';

async function generateProblemHandler(req, res) {
    const { difficulty = 'easy', currentProblems = [] } = req.body;
    
    const diffMap = {
        easy: '쉬운(입출력, 반복문)',
        medium: '중간(배열, 문자열)',
        hard: '어려운(DP, 그래프)'
    };
    
    const timeLimitMap = { easy: 60, medium: 90, hard: 120 };
    const timeLimit = timeLimitMap[difficulty] || 60;
    const exTitles = currentProblems.map(p => p.title).join(', ') || '없음';
    const nextId = currentProblems.length > 0 ? Math.max(...currentProblems.map(p => p.id)) + 1 : 5;
    const prompt = [
        '알고리즘 문제를 JSON 형식으로 만들어줘',
        `난이도: ${diffMap[difficulty] || diffMap.easy}`,
        `기존문제(중복금지): ${exTitles}`,
        'Python, C++, C로 다 풀 수 있어야돼.',
        '중요: ` 사용 금지. 줄바꿈 없이 한 줄로만 반환.',
        '',
        '형식:',
        `{"id":${nextId},"title":"제목","description":"설명","inputDescription":"입력형식","outputDescription":"출력형식","timeLimit":${timeLimit},"example":{"input":"예제입력","output":"예제출력"},"testCases":[{"input":"입력1","output":"출력1"},{"input":"입력2","output":"출력2"}]}`
    ].join('\n');

    try {
        const response = await axios.post(
            `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent?key=${GEMINI_API_KEY}`,
            {
                contents: [{ parts: [{ text: prompt }] }],
                generationConfig: { temperature: 0.5, maxOutputTokens: 2048 }
            }
        );

        let raw = response.data.candidates[0].content.parts[0].text.trim();
        
        if (raw.startsWith('```')) {
            raw = raw.replace(/```json/g, '').replace(/```/g, '').trim();
        }

        const problem = JSON.parse(raw);
        res.json({ success: true, problem });

    } catch (e) {
        if (e.response) {
            console.error('[구글 API가 화난 이유]:', JSON.stringify(e.response.data, null, 2));
        } else {
            console.error('[기타 에러]:', e.message);
        }
        res.status(500).json({ success: false, error: 'AI 생성 실패' });
    }
}

module.exports = { generateProblemHandler };