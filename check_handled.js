const mysql = require('mysql2/promise');

const pool = mysql.createPool({
  host: process.env.DB_HOST || 'localhost',
  user: process.env.DB_USER || 'root',
  password: process.env.DB_PASSWORD || '',
  database: process.env.DB_NAME || 'pcru_chatbot_db',
  waitForConnections: true,
  connectionLimit: 10,
  queueLimit: 0,
});

async function check() {
  try {
    const [total] = await pool.query('SELECT COUNT(*) as count FROM Feedbacks');
    console.log('📊 Total Feedbacks:', total[0].count);

    const [handled] = await pool.query('SELECT COUNT(*) as count FROM Feedbacks WHERE HandledAt IS NOT NULL');
    console.log('✅ Handled:', handled[0].count);

    const [unhandled] = await pool.query('SELECT COUNT(*) as count FROM Feedbacks WHERE HandledAt IS NULL');
    console.log('⏳ Unhandled:', unhandled[0].count);

    await pool.end();
  } catch (error) {
    console.error('❌ Error:', error.message);
    process.exit(1);
  }
}

check();
