const { Pool } = require('pg');

const pool = new Pool({
    host: process.env.DB_HOST,
    port: process.env.DB_PORT,
    database: process.env.DB_NAME,
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
});

pool.connect((err, client, release) => {
    if (err) {
        console.error('DB 연결 실패:', err.message);
    } else {
        console.log('DB 연결 성공!');
        release(); 
    }
});

module.exports = pool;
