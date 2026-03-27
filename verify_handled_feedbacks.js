const mysql = require('mysql2/promise');
require('dotenv').config();

async function checkHandledFeedbacks() {
  const pool = mysql.createPool({
    host: process.env.DB_HOST || 'localhost',
    user: process.env.DB_USER || 'root',
    password: process.env.DB_PASSWORD || '',
    database: process.env.DB_NAME || 'pcru_chatbot_db',
    waitForConnections: true,
    connectionLimit: 5,
  });

  try {
    console.log('🔍 Connecting to database...');
    console.log('Host:', process.env.DB_HOST || 'localhost');
    console.log('Database:', process.env.DB_NAME || 'pcru_chatbot_db');
    console.log('');

    // Check total feedbacks
    const [totalRows] = await pool.query('SELECT COUNT(*) as count FROM Feedbacks');
    console.log('📊 Total Feedbacks in database:', totalRows[0].count);

    // Check unhandled feedbacks (HandledAt IS NULL)
    const [unhandledRows] = await pool.query(`
      SELECT COUNT(*) as count FROM Feedbacks WHERE HandledAt IS NULL
    `);
    console.log('⏳ Unhandled Feedbacks (HandledAt IS NULL):', unhandledRows[0].count);

    // Check handled feedbacks (HandledAt IS NOT NULL)
    const [handledRows] = await pool.query(`
      SELECT COUNT(*) as count FROM Feedbacks WHERE HandledAt IS NOT NULL
    `);
    console.log('✅ Handled Feedbacks (HandledAt IS NOT NULL):', handledRows[0].count);
    console.log('');

    // If there are handled feedbacks, show details
    if (handledRows[0].count > 0) {
      console.log('📝 Handled Feedbacks Details:');
      const [details] = await pool.query(`
        SELECT 
          f.FeedbackID,
          f.FeedbackValue,
          f.Timestamp,
          f.HandledAt,
          f.FeedbackReason,
          f.FeedbackComment,
          c.UserQuery,
          qa.QuestionText
        FROM Feedbacks f
        LEFT JOIN ChatLogHasAnswers c ON f.ChatLogID = c.ChatLogID
        LEFT JOIN QuestionsAnswers qa ON c.QuestionsAnswersID = qa.QuestionsAnswersID
        WHERE f.HandledAt IS NOT NULL
        ORDER BY f.HandledAt DESC
        LIMIT 10
      `);
      details.forEach((row, i) => {
        console.log(`\n  #${i+1}:`);
        console.log(`    FeedbackID: ${row.FeedbackID}`);
        console.log(`    FeedbackValue: ${row.FeedbackValue}`);
        console.log(`    HandledAt: ${row.HandledAt}`);
        console.log(`    CreatedAt: ${row.Timestamp}`);
        console.log(`    Query: ${row.UserQuery?.substring(0, 50) || 'N/A'}...`);
        console.log(`    Question: ${row.QuestionText?.substring(0, 50) || 'N/A'}...`);
      });
    } else {
      console.log('❌ No handled feedbacks found in database');
      console.log('');
      console.log('✨ This is CORRECT - the page shows empty because:');
      console.log('   1. Feedbacks are created when users click Like/Unlike on chat responses');
      console.log('   2. Those feedbacks have HandledAt = NULL initially');
      console.log('   3. Handled Feedbacks page only shows feedbacks with HandledAt IS NOT NULL');
      console.log('   4. To see data here, go to Feedbacks Report and click "Mark as Handled"');
    }

    console.log('');
    console.log('Summary:');
    console.log(`Total: ${totalRows[0].count} | Unhandled: ${unhandledRows[0].count} | Handled: ${handledRows[0].count}`);

  } catch (error) {
    console.error('❌ Database error:', error.message);
    process.exit(1);
  } finally {
    await pool.end();
  }
}

checkHandledFeedbacks();
