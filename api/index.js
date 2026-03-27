// Vercel serverless function entry point
const express = require('express');
const cors = require('cors');
const mysql = require('mysql2/promise');
const dotenv = require('dotenv');

dotenv.config();

const app = express();

// Middleware
app.use(cors({
  origin: '*',
  credentials: true
}));
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ extended: true, limit: '50mb' }));

// ⚠️ Handle WebSocket upgrade requests on Vercel (serverless doesn't support WebSocket)
// Return a proper error response instead of hanging
app.all('/ws/*', (req, res) => {
  const endpoint = req.path;
  console.warn(`⚠️  WebSocket upgrade attempt to ${endpoint} on Vercel serverless (not supported)`);
  res.status(501).json({
    success: false,
    message: 'WebSocket not supported on Vercel serverless. Please use polling endpoints instead.',
    error: 'WEBSOCKET_NOT_SUPPORTED',
    endpoint: endpoint,
    alternative: 'Use polling API endpoints for real-time updates'
  });
});

// Database connection pool
const pool = mysql.createPool({
  host: process.env.DB_HOST,
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  database: process.env.DB_NAME,
  port: process.env.DB_PORT || 3306,
  waitForConnections: true,
  connectionLimit: 5,
  queueLimit: 0,
  connectTimeout: 60000,
  ssl: process.env.DB_SSL === 'true' ? { rejectUnauthorized: false } : undefined
});

// Health check
app.get('/', (req, res) => {
  res.json({ status: 'ok', message: 'PCRU Chatbot Backend API', timestamp: new Date().toISOString() });
});

app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// Public: Get negative keywords
app.get('/negativekeywords/public', async (req, res) => {
  try {
    const [rows] = await pool.query(`
      SELECT Word
      FROM NegativeKeywords
      WHERE IsActive = 1
      ORDER BY Word
      LIMIT 50
    `);
    res.status(200).json({ success: true, data: rows });
  } catch (err) {
    console.error('Get public negative keywords error:', err);
    res.status(500).json({ success: false, message: err.message });
  }
});

// Public: Get synonyms
app.get('/synonyms/public', async (req, res) => {
  try {
    const [rows] = await pool.query(`
      SELECT ks.InputWord, k.KeywordText AS TargetKeyword
      FROM KeywordSynonyms ks
      LEFT JOIN Keywords k ON ks.TargetKeywordID = k.KeywordID
      WHERE ks.IsActive = 1
      LIMIT 50
    `);
    res.status(200).json({ success: true, data: rows });
  } catch (err) {
    console.error('Get public synonyms error:', err);
    res.status(500).json({ success: false, message: err.message });
  }
});

// Public: Get popular questions
app.get('/questionsanswers/popular', async (req, res) => {
  try {
    const limit = parseInt(req.query.limit) || 10;
    const [rows] = await pool.query(`
      SELECT 
        q.QuestionsAnswersID,
        q.QuestionTitle,
        COUNT(f.FeedbackID) as likeCount
      FROM QuestionsAnswers q
      LEFT JOIN ChatLogHasAnswers cl ON cl.QuestionsAnswersID = q.QuestionsAnswersID
      LEFT JOIN Feedbacks f ON f.ChatLogID = cl.ChatLogID AND f.FeedbackValue = 1
      GROUP BY q.QuestionsAnswersID, q.QuestionTitle
      HAVING likeCount > 0
      ORDER BY likeCount DESC
      LIMIT ?
    `, [limit]);
    
    res.status(200).json({ 
      success: true, 
      data: rows.map(r => ({
        id: r.QuestionsAnswersID,
        title: r.QuestionTitle,
        likeCount: r.likeCount
      }))
    });
  } catch (err) {
    console.error('Get popular questions error:', err);
    res.status(500).json({ success: false, message: err.message });
  }
});

// Public: Get navigation questions
app.get('/questionsanswers/navigation', async (req, res) => {
  try {
    const limit = parseInt(req.query.limit) || 10;
    const [rows] = await pool.query(`
      SELECT 
        QuestionsAnswersID,
        QuestionTitle,
        QuestionText
      FROM QuestionsAnswers 
      WHERE 
        (QuestionTitle LIKE '%พิกัด%' OR QuestionTitle LIKE '%นำทาง%' OR QuestionTitle LIKE '%ที่ตั้ง%' OR QuestionTitle LIKE '%แผนที่%')
        AND (
          QuestionText LIKE '%maps.app.goo.gl%'
          OR QuestionText LIKE '%maps.google%'
          OR QuestionText LIKE '%goo.gl/maps%'
          OR QuestionText LIKE '%google.com/maps%'
          OR QuestionText REGEXP '[0-9]+\\\\.[0-9]+,[[:space:]]*[0-9]+\\\\.[0-9]+'
        )
      ORDER BY QuestionsAnswersID DESC
      LIMIT ?
    `, [limit]);
    
    res.status(200).json({ 
      success: true, 
      data: rows.map(r => ({
        id: r.QuestionsAnswersID,
        title: r.QuestionTitle,
        hasMap: true
      }))
    });
  } catch (err) {
    console.error('Get navigation questions error:', err);
    res.status(500).json({ success: false, message: err.message });
  }
});

// Tokenize endpoint - simple Thai word tokenization
// Returns array of tokens from input text
// Fallback: If external tokenizer unavailable, uses simple split
app.post('/tokenize', async (req, res) => {
  try {
    const { text } = req.body;
    
    if (!text || typeof text !== 'string') {
      return res.status(400).json({ error: 'Missing or invalid text parameter' });
    }
    
    // Simple tokenization: split by spaces and common punctuation
    // For Thai: this is basic but works for keyword extraction
    const cleanText = String(text).toLowerCase().trim();
    
    // Remove punctuation and special characters (keep Thai characters and alphanumeric)
    // Thai character ranges: \u0E01-\u0E3A (main), \u0E40-\u0E5B (combining)
    const normalized = cleanText
      .replace(/[\p{P}\p{S}]/gu, ' ')  // Remove punctuation and symbols
      .replace(/\s+/g, ' ')            // Collapse multiple spaces
      .trim();
    
    // Split by whitespace
    const tokens = normalized
      .split(/\s+/)
      .filter(t => t && t.length > 0);
    
    // Additional: Try to use external tokenizer if available (with timeout)
    // This is async but we return early with simple tokens to avoid delays
    tryExternalTokenizer(text).then(externalTokens => {
      // Log for monitoring (don't block response)
      if (externalTokens && externalTokens.length > 0) {
        console.log(`✅ External tokenizer available, returned ${externalTokens.length} tokens`);
      }
    }).catch(err => {
      console.log(`ℹ️ External tokenizer unavailable, using simple tokenization: ${err.message}`);
    });
    
    return res.json({ 
      ok: true,
      tokens: tokens,
      source: 'simple-tokenizer' 
    });
  } catch (error) {
    console.error('Tokenize error:', error);
    res.status(500).json({ ok: false, error: error.message, tokens: [] });
  }
});

// Helper: Try to call external tokenizer (non-blocking)
async function tryExternalTokenizer(text) {
  const TOKENIZER_URL = process.env.TOKENIZER_URL || 'http://project.3bbddns.com:36146/tokenize';
  try {
    const urlObj = new URL(TOKENIZER_URL);
    const client = urlObj.protocol === 'https:' ? require('https') : require('http');
    const payload = JSON.stringify({ text });
    
    return new Promise((resolve) => {
      const req = client.request({
        hostname: urlObj.hostname,
        port: urlObj.port || (urlObj.protocol === 'https:' ? 443 : 80),
        path: urlObj.pathname,
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(payload)
        },
        timeout: 1000 // 1 second timeout
      }, (res) => {
        let data = '';
        res.on('data', (chunk) => { data += chunk; });
        res.on('end', () => {
          try {
            const json = JSON.parse(data || '{}');
            resolve(Array.isArray(json.tokens) ? json.tokens : null);
          } catch (err) {
            resolve(null);
          }
        });
      });
      
      req.on('error', () => resolve(null));
      req.on('timeout', () => { req.destroy(); resolve(null); });
      req.write(payload);
      req.end();
    });
  } catch (err) {
    // Silently fail - external tokenizer is optional
    return null;
  }
}


// 404 handler
app.use((req, res) => {
  res.status(404).json({ error: 'Not Found', path: req.path });
});

// Export for Vercel
module.exports = app;
