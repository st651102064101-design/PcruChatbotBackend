// Generic notifier for questions-answers
function notifyQuestionsAnswersUpdate(data) {
	const message = JSON.stringify({
		type: 'QUESTIONS_ANSWERS_UPDATE',
		timestamp: new Date().toISOString(),
		data: data || {}
	});
	console.log(`📢 Broadcasting questions-answers update to ${wss.clients.size} clients:`, data);
	let sentCount = 0;
	wss.clients.forEach((client) => {
		if (client.readyState === WebSocket.OPEN && (client.channel === 'questions-answers' || client.channel === '/')) {
			client.send(message);
			sentCount++;
		}
	});
	console.log(`✅ Sent WebSocket message to ${sentCount} active clients (questions-answers)`);
}
// server.js (ฉบับแก้ไข)

// 1. นำเข้า Express, dotenv, CORS, MySQL และ Nodemailer
const express = require('express');
const path = require('path');
const cors = require('cors'); 
const mysql = require('mysql2/promise');
const nodemailer = require('nodemailer'); // <--- เพิ่ม Nodemailer
const multer = require('multer'); // 1. Import multer
const dotenv = require('dotenv');
const http = require('http');
const WebSocket = require('ws');
const { spawn } = require('child_process');
const cron = require('node-cron');
const { cleanupOldLogs, cleanupOrphanedChatLogs } = require('./services/cleanup/cleanupOldLogs');
const { URL } = require('url');
const fs = require('fs');

// *** สำคัญ: โหลด Environment Variables ก่อนไฟล์อื่นทั้งหมด ***
dotenv.config();

// Detect Vercel production environment and set NODE_ENV accordingly (helps some middlewares/behaviors)
if (process.env.VERCEL === '1') {
  process.env.NODE_ENV = process.env.NODE_ENV || 'production';
  console.log('📦 Running on Vercel (production mode)');
}

// Tokenizer service auto-start (local only)
const TOKENIZER_HOST = process.env.TOKENIZER_HOST || 'project.3bbddns.com';
const TOKENIZER_PORT = process.env.TOKENIZER_PORT || '36146';
const TOKENIZER_PATH = process.env.TOKENIZER_PATH || '/tokenize';
const TOKENIZER_URL = process.env.TOKENIZER_URL || `http://${TOKENIZER_HOST}:${TOKENIZER_PORT}${TOKENIZER_PATH}`;
const AUTO_START_TOKENIZER = process.env.AUTO_START_TOKENIZER !== 'false';

let tokenizerProc = null;
async function startTokenizerService() {
  if (!AUTO_START_TOKENIZER) {
    console.log('🛑 Auto-start tokenizer disabled via AUTO_START_TOKENIZER=false');
    return;
  }

  try {
    const parsed = new URL(TOKENIZER_URL);
    const host = parsed.hostname;
    const port = parsed.port || TOKENIZER_PORT || '36146';

    // Only auto-start when pointing to local host
    if (host !== '127.0.0.1' && host !== 'project.3bbddns.com') {
      console.log(`ℹ️ Skipping tokenizer auto-start (TOKENIZER_URL points to ${host})`);
      return;
    }

    // Check if the port is already in use (avoid EADDRINUSE from uvicorn)
    const net = require('net');
    const isPortUsed = await new Promise((resolve) => {
      const socket = net.createConnection({ host, port: parseInt(port, 10) });
      let done = false;
      socket.on('connect', () => { done = true; socket.end(); resolve(true); });
      socket.on('error', () => { if (!done) { done = true; resolve(false); } });
      setTimeout(() => { if (!done) { done = true; socket.destroy(); resolve(false); } }, 300);
    });

    if (isPortUsed) {
      console.log(`ℹ️ Tokenizer already running at http://${host}:${port}, skipping auto-start.`);
      return;
    }

    // Avoid duplicate spawns
    if (tokenizerProc && !tokenizerProc.killed) {
      return;
    }

    const venvPython = path.join(__dirname, '.venv', 'bin', 'python3');
    const cmd = fs.existsSync(venvPython) ? venvPython : 'python3';
    const args = [
      '-m',
      'uvicorn',
      'scripts.pythainlp_tokenizer_service:app',
      '--host', host,
      '--port', port
    ];

    console.log(`🚀 Auto-starting PyThaiNLP tokenizer at http://${host}:${port}`);
    console.log(`🔎 Using python: ${cmd}`);
    tokenizerProc = spawn(cmd, args, {
      cwd: __dirname,
      stdio: 'inherit',
    });

    tokenizerProc.on('close', (code, signal) => {
      console.log(`ℹ️ Tokenizer service exited (code=${code}, signal=${signal})`);
    });
    tokenizerProc.on('error', (err) => {
      console.error('❌ Failed to start tokenizer service:', err.message);
    });
  } catch (err) {
    console.error('❌ Tokenizer auto-start error:', err.message);
  }
}

function stopTokenizerService() {
  if (tokenizerProc && !tokenizerProc.killed) {
    tokenizerProc.kill();
  }
}

// นำเข้า Middleware
const authenticateToken = require('./auth'); // แก้ไข path ให้ถูกต้อง

// นำเข้า Service ที่แยกออกมา
const loginService = require('./services/login');
const forgotPasswordService = require('./services/forgotpassword');
const setNewPasswordService = require('./services/setnewpassword');
const validateResetTokenService = require('./services/validateResetToken');
const getAdminUsersService = require('./services/reports/getAdminUsers'); // path ถูกต้องแล้ว
const getOrganizationsService = require('./services/reports/getOrganizations'); // path ถูกต้องแล้ว
const getOfficersService = require('./services/reports/getOfficers'); // path ถูกต้องแล้ว
const getCategoriesService = require('./services/reports/getCategories');
const getCategoriesPublicService = require('./services/public/getCategoriesPublic');
const getKeywordsService = require('./services/reports/getKeywords');
const getKeywordsPublicService = require('./services/public/getKeywordsPublic');
const getAutocompleteSuggestionsService = require('./services/public/getAutocompleteSuggestions');
const getFeedbacksService = require('./services/reports/getFeedbacks');
const { markFeedbackHandledService, getHandledFeedbacksService, cleanupHandledFeedbacksService, unhandleFeedbackService } = require('./services/reports/feedbackHandled');
const getAnswersKeywordsService = require('./services/reports/getAnswersKeywords');
const getQuestionsAnswersService = require('./services/reports/getQuestionsAnswers');
const uploadAdminUsersService = require('./services/adminUsers/uploadAdminUsers'); // admin users upload service
const uploadOrganizationsService = require('./services/organizations/uploadOrganizations'); // organizations upload service
const downloadLastUploadService = require('./services/adminUsers/downloadLastUpload'); // admin users download
const downloadOrganizationsLastUploadService = require('./services/organizations/downloadLastUpload'); // organizations download
const uploadOfficersService = require('./services/Officers/uploadOfficers'); // officers upload service
const downloadOfficersLastUploadService = require('./services/Officers/downloadLastUpload'); // officers download
const getChatLogHasAnswersService = require('./services/reports/getChatLogHasAnswers');
const getChatLogNoAnswersService = require('./services/reports/getChatLogNoAnswers');
const downloadCategoriesLastUploadService = require('./services/Categories/downloadLastUpload'); // categories download service
const uploadCategoriesService = require('./services/Categories/uploadCategories');
const uploadQuestionsAnswersService = require('./services/QuestionsAnswers/uploadQuestionsAnswers');
const downloadQuestionsAnswersLastUploadService = require('./services/QuestionsAnswers/downloadLastUpload');
const downloadLatestExportService = require('./services/QuestionsAnswers/downloadLatestExport');
const chatRespondService = require('./services/chat/respond');
const chatFeedbackService = require('./services/chat/feedback');
const chatLogHasAnswerService = require('./services/chat/logHasAnswer');
const chatLogNoAnswerService = require('./services/chat/logNoAnswer');
const getStopwordsService = require('./services/stopwords/getStopwords');
const addStopwordService = require('./services/stopwords/addStopword');
const deleteStopwordService = require('./services/stopwords/deleteStopword');
const { clearStopwordsCache } = require('./services/stopwords/loadStopwords');
const { clearNegativeKeywordsCache } = require('./services/negativeKeywords/loadNegativeKeywords');
const { syncStopwords } = require('./scripts/sync_stopwords_from_standard');
// Ranking route
const rankingRoute = require('./routes/ranking');
const geocodeService = require('./services/geo/geocode');
// Gemini AI route
const geminiRoute = require('./routes/gemini');

const upload = multer({ dest: 'uploads/' }); // Multer config

const app = express();
// Expose pool globally for background worker usage (lightweight)
try {
  const { pool } = require('./config');
  global.__DB_POOL__ = pool;
} catch (e) {
  // ignore if config structure differs
}

const server = http.createServer(app);
const wss = new WebSocket.Server({ server });
const PORT = process.env.PORT || 36161; 

// Assign after app is initialized
app.locals.notifyQuestionsAnswersUpdate = notifyQuestionsAnswersUpdate;

// --- Debug middleware: log incoming requests and auth status for troubleshooting 404/route issues ---
app.use((req, res, next) => {
  try {
    const authHeader = req.headers && req.headers.authorization ? '[AUTH]' : '[NO_AUTH]';
    console.log(`[req] ${req.method} ${req.path} ${authHeader} origin=${req.headers.origin || ''}`);
  } catch (e) {
    // ignore logging errors
  }
  next();
});


// Start tokenizer service when server boots (local TOKENIZER_URL only)
startTokenizerService();

// Schedule daily cleanup of old logs (runs at 03:00 AM)
cron.schedule('0 3 * * *', async () => {
  console.log('⏰ Running daily cleanup of old logs...');
  try {
    if (global.__DB_POOL__) {
      await cleanupOldLogs(global.__DB_POOL__);
    } else {
      console.error('❌ Daily cleanup failed: Database pool not available');
    }
  } catch (err) {
    console.error('❌ Daily cleanup failed:', err.message);
  }
});

// Schedule frequent cleanup of orphaned ChatLogHasAnswers (runs every 5 minutes)
// ChatLogHasAnswers ที่ไม่มี Feedback คู่กันจะถูกลบทันที
cron.schedule('*/5 * * * *', async () => {
  try {
    if (global.__DB_POOL__) {
      await cleanupOrphanedChatLogs(global.__DB_POOL__);
    }
  } catch (err) {
    console.error('❌ Orphaned cleanup failed:', err.message);
  }
});

// WebSocket connection handler
wss.on('connection', (ws, req) => {
  const pathName = req && req.url ? req.url : '/';
  // tag the client with a channel derived from path, e.g. /ws/feedbacks
  ws.channel = pathName.startsWith('/ws/') ? pathName.slice(4) : pathName; // e.g. 'feedbacks'
  console.log(`✅ New WebSocket client connected on ${pathName}`);
  
  ws.on('close', () => {
    console.log('❌ WebSocket client disconnected');
  });
  
  ws.on('error', (error) => {
    console.error('WebSocket error:', error);
  });
});

// Function to notify all connected clients about feedback updates
function notifyFeedbackUpdate(data) {
  const message = JSON.stringify({
    type: 'FEEDBACK_UPDATE',
    timestamp: new Date().toISOString(),
    data: data || {}
  });
  
  console.log(`📢 Broadcasting feedback update to ${wss.clients.size} clients:`, data);
  
  let sentCount = 0;
  wss.clients.forEach((client) => {
    if (client.readyState === WebSocket.OPEN && (client.channel === 'feedbacks' || client.channel === '/')) {
      client.send(message);
      sentCount++;
    }
  });
  
  console.log(`✅ Sent WebSocket message to ${sentCount} active clients`);
}

// Export notifyFeedbackUpdate for use in other modules
app.locals.notifyFeedbackUpdate = notifyFeedbackUpdate;

// Generic notifier for chat logs (has/no answer)
function notifyChatLogsUpdate(data) {
  const message = JSON.stringify({
    type: 'CHATLOGS_UPDATE',
    timestamp: new Date().toISOString(),
    data: data || {}
  });
  console.log(`📢 Broadcasting chat logs update to ${wss.clients.size} clients:`, data);
  let sentCount = 0;
  wss.clients.forEach((client) => {
    if (client.readyState === WebSocket.OPEN && (client.channel === 'chat-logs' || client.channel === '/')) {
      client.send(message);
      sentCount++;
    }
  });
  console.log(`✅ Sent WebSocket message to ${sentCount} active clients (chat-logs)`);
}
app.locals.notifyChatLogsUpdate = notifyChatLogsUpdate;

// Generic notifier for categories updates
function notifyCategoriesUpdate(data) {
  const message = JSON.stringify({
    type: 'CATEGORIES_UPDATE',
    timestamp: new Date().toISOString(),
    data: data || {}
  });
  console.log(`📢 Broadcasting categories update to ${wss.clients.size} clients:`, data);
  let sentCount = 0;
  wss.clients.forEach((client) => {
    if (client.readyState === WebSocket.OPEN && (client.channel === 'categories' || client.channel === '/')) {
      client.send(message);
      sentCount++;
    }
  });
  console.log(`✅ Sent WebSocket message to ${sentCount} active clients (categories)`);
}
app.locals.notifyCategoriesUpdate = notifyCategoriesUpdate;

// Semantic suggestions routes removed

// 2. สร้าง Nodemailer Transporter
// ******* ต้องมี EMAIL_USER และ EMAIL_PASS ในไฟล์ .env *******
// All schedulers and auto-tune features removed
// ใน server.js
const transporter = nodemailer.createTransport({
    service: 'gmail', 
    auth: {
        type: 'OAuth2', // <--- ต้องมีบรรทัดนี้
        user: process.env.EMAIL_USER,
        clientId: process.env.OAUTH_CLIENT_ID,
        clientSecret: process.env.OAUTH_CLIENT_SECRET,
        refreshToken: process.env.OAUTH_REFRESH_TOKEN // <--- ต้องมี Refresh Token
    }
});
console.log('✅ Nodemailer Transporter Initialized.');


// 3. สร้าง MySQL Connection Pool
const pool = mysql.createPool({
    host: process.env.DB_HOST,
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    database: process.env.DB_NAME,
    port: parseInt(process.env.DB_PORT) || 3306,
    waitForConnections: true,
    connectionLimit: parseInt(process.env.DB_CONNECTION_LIMIT) || 10,
    queueLimit: parseInt(process.env.DB_QUEUE_LIMIT) || 0,
    connectTimeout: 60000,
    ssl: process.env.DB_SSL === 'true' ? { rejectUnauthorized: false } : undefined
});

// 🔍 Debug: Log database configuration (without sensitive password)
console.log('📊 Database Configuration:');
console.log(`  HOST: ${process.env.DB_HOST || 'NOT SET'}`);
console.log(`  USER: ${process.env.DB_USER || 'NOT SET'}`);
console.log(`  DATABASE: ${process.env.DB_NAME || 'NOT SET'}`);
console.log(`  PORT: ${process.env.DB_PORT || 3306}`);
console.log(`  PASSWORD: ${process.env.DB_PASSWORD ? '***SET***' : 'NOT SET'}`);

// ตรวจสอบการเชื่อมต่อฐานข้อมูลเมื่อ Server เริ่มต้น
pool.getConnection()
    .then(async connection => {
        console.log('✅ MySQL Database Connected Successfully!');
        connection.release();

        // ตรวจสอบและแก้ไข AUTO_INCREMENT ของตาราง ChatLogNoAnswers
        try {
            const [rows] = await pool.query(`
                SELECT EXTRA FROM information_schema.COLUMNS
                WHERE TABLE_SCHEMA = DATABASE()
                  AND TABLE_NAME = 'ChatLogNoAnswers'
                  AND COLUMN_NAME = 'ChatLogID'
            `);
            if (rows.length > 0 && !rows[0].EXTRA.includes('auto_increment')) {
                console.log('⚠️  ChatLogID ไม่มี AUTO_INCREMENT กำลังแก้ไข...');
                await pool.query(`
                    ALTER TABLE ChatLogNoAnswers
                    MODIFY ChatLogID int(11) NOT NULL AUTO_INCREMENT
                `);
                console.log('✅ แก้ไข AUTO_INCREMENT ของ ChatLogID สำเร็จ');
            }
        } catch (err) {
            console.error('❌ ไม่สามารถแก้ไข AUTO_INCREMENT ของ ChatLogNoAnswers:', err.message);
        }

        // ตรวจสอบและแก้ไข AUTO_INCREMENT ของตาราง GoogleOAuth
        try {
            // First, check if table exists
            const [tableExists] = await pool.query(`
                SELECT 1 FROM information_schema.TABLES 
                WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'GoogleOAuth' LIMIT 1
            `);
            
            if (tableExists.length === 0) {
                console.log('⚠️  ตาราง GoogleOAuth ไม่มี กำลังสร้างใหม่...');
                // Drop and recreate table to ensure correct AUTO_INCREMENT
                await pool.query(`DROP TABLE IF EXISTS GoogleOAuth`);
                
                await pool.query(`
                    CREATE TABLE GoogleOAuth (
                      GoogleOAuthID int(11) NOT NULL AUTO_INCREMENT,
                      GoogleID varchar(255) NOT NULL,
                      GoogleEmail varchar(255) NOT NULL,
                      GoogleName varchar(255) DEFAULT NULL,
                      GooglePicture varchar(512) DEFAULT NULL,
                      UserType ENUM('admin', 'officer') NOT NULL,
                      AdminUserID int(3) DEFAULT NULL,
                      OfficerID int(11) DEFAULT NULL,
                      IsActive tinyint(1) NOT NULL DEFAULT 1,
                      CreatedAt timestamp NOT NULL DEFAULT current_timestamp(),
                      UpdatedAt timestamp NOT NULL DEFAULT current_timestamp() ON UPDATE current_timestamp(),
                      PRIMARY KEY (GoogleOAuthID),
                      UNIQUE KEY uk_google_id (GoogleID),
                      UNIQUE KEY uk_admin_user (AdminUserID),
                      UNIQUE KEY uk_officer (OfficerID),
                      KEY idx_google_email (GoogleEmail),
                      CONSTRAINT fk_google_oauth_admin FOREIGN KEY (AdminUserID) REFERENCES AdminUsers (AdminUserID) ON DELETE CASCADE ON UPDATE CASCADE,
                      CONSTRAINT fk_google_oauth_officer FOREIGN KEY (OfficerID) REFERENCES Officers (OfficerID) ON DELETE CASCADE ON UPDATE CASCADE
                    ) ENGINE=InnoDB AUTO_INCREMENT=1 DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
                `);
                console.log('✅ สร้างตาราง GoogleOAuth พร้อม AUTO_INCREMENT สำเร็จ');
            } else {
                // Verify AUTO_INCREMENT is set -- if not, recreate
                const [autoIncrementCheck] = await pool.query(`
                    SELECT EXTRA FROM information_schema.COLUMNS
                    WHERE TABLE_SCHEMA = DATABASE()
                      AND TABLE_NAME = 'GoogleOAuth'
                      AND COLUMN_NAME = 'GoogleOAuthID'
                `);
                
                if (autoIncrementCheck.length > 0 && !autoIncrementCheck[0].EXTRA.includes('auto_increment')) {
                    console.log('⚠️  GoogleOAuthID ไม่มี AUTO_INCREMENT กำลังสร้างใหม่...');
                    // Recreate table with correct AUTO_INCREMENT
                    await pool.query(`DROP TABLE GoogleOAuth`);
                    
                    await pool.query(`
                        CREATE TABLE GoogleOAuth (
                          GoogleOAuthID int(11) NOT NULL AUTO_INCREMENT,
                          GoogleID varchar(255) NOT NULL,
                          GoogleEmail varchar(255) NOT NULL,
                          GoogleName varchar(255) DEFAULT NULL,
                          GooglePicture varchar(512) DEFAULT NULL,
                          UserType ENUM('admin', 'officer') NOT NULL,
                          AdminUserID int(3) DEFAULT NULL,
                          OfficerID int(11) DEFAULT NULL,
                          IsActive tinyint(1) NOT NULL DEFAULT 1,
                          CreatedAt timestamp NOT NULL DEFAULT current_timestamp(),
                          UpdatedAt timestamp NOT NULL DEFAULT current_timestamp() ON UPDATE current_timestamp(),
                          PRIMARY KEY (GoogleOAuthID),
                          UNIQUE KEY uk_google_id (GoogleID),
                          UNIQUE KEY uk_admin_user (AdminUserID),
                          UNIQUE KEY uk_officer (OfficerID),
                          KEY idx_google_email (GoogleEmail),
                          CONSTRAINT fk_google_oauth_admin FOREIGN KEY (AdminUserID) REFERENCES AdminUsers (AdminUserID) ON DELETE CASCADE ON UPDATE CASCADE,
                          CONSTRAINT fk_google_oauth_officer FOREIGN KEY (OfficerID) REFERENCES Officers (OfficerID) ON DELETE CASCADE ON UPDATE CASCADE
                        ) ENGINE=InnoDB AUTO_INCREMENT=1 DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
                    `);
                    console.log('✅ สร้างใหม่ตาราง GoogleOAuth พร้อม AUTO_INCREMENT สำเร็จ');
                } else {
                    console.log('✅ ตาราง GoogleOAuth มี AUTO_INCREMENT แล้ว');
                }
            }
        } catch (err) {
            console.error('⚠️  ไม่สามารถตรวจสอบ/สร้าง GoogleOAuth:', err.message);
        }
    })
    .catch(err => {
        console.error('❌ CRITICAL: Failed to connect to MySQL Database');
        console.error('   Error:', err.message);
        console.error('   Error Code:', err.code);
        console.error('   ⚠️  PLEASE VERIFY:');
        console.error('      1. DB_HOST is set correctly');
        console.error('      2. DB_USER and DB_PASSWORD are correct');
        console.error('      3. DB_NAME database exists');
        console.error('      4. Database is accessible from Vercel network');
        console.error('      5. All environment variables are set in Vercel Settings');
    });

// Store pool in app.locals for use in routes
app.locals.pool = pool;

// 4. กำหนด Middleware 
// Explicit CORS for frontend dev origins to avoid Safari access-control blocks
const defaultFrontendOrigin = (() => { try { return new URL(process.env.CLIENT_URL || 'http://project.3bbddns.com:5173').origin; } catch (e) { return 'http://project.3bbddns.com:5173'; } })();
const allowedOrigins = [
  defaultFrontendOrigin,
  process.env.FRONTEND_ORIGIN || ''
].filter(Boolean);
app.use(cors({
  origin: '*', // หรือระบุเป็น ['https://pcru-chatbot-frontend.vercel.app'] เพื่อจำกัดแหล่งที่มา
  methods: ['GET','POST','PUT','DELETE','OPTIONS'],
  allowedHeaders: ['Content-Type','Authorization','X-Session-ID']
}));
app.use(express.json());
// add URL-encoded parser (for some form submissions)
app.use(express.urlencoded({ extended: true }));
// parse raw CSV/text bodies so upload endpoint can accept Content-Type: text/csv or text/plain
app.use(express.text({ type: ['text/csv', 'text/plain'], limit: '10mb' }));

// Serve frontend helper scripts (helpers will define bindSidebarResize / unbindSidebarResize)
app.use('/js', express.static(path.join(__dirname, 'public', 'js')));

// Serve frontend static files (if a built frontend exists)
const FRONTEND_DIR = process.env.FRONTEND_STATIC_DIR || path.join(__dirname, '..', 'PCRU-CHATBOT-FRONTEND-1', 'dist');
if (fs.existsSync(FRONTEND_DIR)) {
  console.log(`📦 Serving frontend static files from ${FRONTEND_DIR}`);
  app.use(express.static(FRONTEND_DIR));

  // Prefer explicit API/static routes above; fallback to SPA index for unknown GETs
  // Use a generic middleware instead of a path pattern to avoid path-to-regexp issues
  app.use((req, res, next) => {
    if (req.method !== 'GET') return next();

    // If request is coming to the backend host/port, skip SPA fallback so API root
    // and backend endpoints are not overridden by the frontend index.html.
    // This prevents visiting e.g. http://project.3bbddns.com:36145 from serving the
    // frontend app.
    const hostHeader = req.headers.host || '';
    if (hostHeader.includes(`:${PORT}`)) {
      console.log(`[spa-fallback] Skipping SPA fallback because request host ${hostHeader} matches backend port ${PORT}`);
      return next();
    }

    const skipPrefixes = ['/api', '/uploads', '/js', '/ranking', '/system', '/categories', '/getcategories', '/chat', '/login', '/forgotpassword', '/setnewpassword', '/validateresettoken', '/questionsanswers', '/getQuestionsAnswers', '/stopwords', '/synonyms', '/negativekeywords', '/adminusers', '/admin', '/officers', '/organizations', '/ai-image', '/health', '/keywords', '/autocomplete', '/getChatLogHasAnswers', '/getChatLogNoAnswers', '/getChatLogNoAnswers', '/feedbacks', '/debug', '/debug/feedbacks', '/auth'];
    // Debug: log the requested path and whether it will be skipped
    for (const p of skipPrefixes) {
      if (req.path.startsWith(p)) {
        console.log(`[spa-fallback] Skipping SPA fallback for path: ${req.path} (matched prefix: ${p})`);
        return next();
      }
    }
    console.log(`[spa-fallback] Serving index.html for path: ${req.path}`);
    const indexPath = path.join(FRONTEND_DIR, 'index.html');
    if (fs.existsSync(indexPath)) return res.sendFile(indexPath);
    return next();
  });
} else {
  console.log(`ℹ️ Frontend static directory not found at ${FRONTEND_DIR}; skipping SPA fallback.`);
}
// 5. สร้าง Route 
app.get('/', async (req, res) => {
  let dbStatus = 'unknown';
  let dbError = null;
  let tableList = [];
  try {
    const conn = await pool.getConnection();
    await conn.query('SELECT 1');
    conn.release();
    dbStatus = 'connected';
    const [tables] = await pool.query('SHOW TABLES');
    tableList = tables.map(t => Object.values(t)[0]);
  } catch (err) {
    dbStatus = 'error';
    dbError = { message: err.message, code: err.code };
  }
  res.json({
    message: 'PCRU Chatbot Backend running',
    db: dbStatus,
    dbError: dbError,
    tables: tableList,
    env: {
      DB_HOST: process.env.DB_HOST ? 'set' : 'not set',
      DB_USER: process.env.DB_USER ? 'set' : 'not set',
      DB_PASSWORD: process.env.DB_PASSWORD ? 'set' : 'not set',
      DB_NAME: process.env.DB_NAME ? 'set' : 'not set',
      DB_PORT: process.env.DB_PORT || '3306 (default)'
    }
  });
});

// Thai patterns routes removed

// --- Google OAuth Routes (Public) ---
const googleAuthRoutes = require('./routes/googleAuth');
app.use('/auth', (req, res, next) => {
  req.pool = pool;
  next();
}, googleAuthRoutes);

// --- Public Routes (No Authentication Required) ---
// Database connectivity diagnostic (remove after debugging)
app.get('/db-check', async (req, res) => {
  try {
    const conn = await pool.getConnection();
    const [rows] = await conn.query('SELECT 1 AS ok');
    conn.release();
    const [tables] = await pool.query("SHOW TABLES");
    res.json({ success: true, db: 'connected', tables: tables.map(t => Object.values(t)[0]) });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message, code: err.code, host: process.env.DB_HOST ? '(set)' : '(not set)' });
  }
});
app.post('/login', loginService(pool, transporter));
app.post('/forgotpassword', forgotPasswordService(pool, transporter));
app.post('/setnewpassword', setNewPasswordService(pool));
app.post('/validateresettoken', validateResetTokenService(pool));
// เพิ่ม public categories (ไม่ต้อง auth)
app.get('/categories', getCategoriesPublicService(pool));
app.get('/getcategories', authenticateToken, getCategoriesService(pool));
// Chat respond endpoint (Public)
app.post('/chat/respond', chatRespondService(pool));
// Handle OPTIONS prefligth request for /chat/respond
app.options('/chat/respond', cors());
// Handle GET request to /chat/respond with helpful error message
app.get('/chat/respond', (req, res) => {
  res.status(405).json({ 
    error: 'Method Not Allowed',
    message: 'Please use POST method to send messages',
    endpoint: '/chat/respond',
    method: 'POST'
  });
});
// Chat contacts endpoint (Public) - returns relevant officer contacts
app.get('/chat/contacts', async (req, res) => {
  if (!app.locals.pool) {
    return res.status(500).json({ success: false, message: 'Database pool not available' });
  }
  const q = String(req.query.q || '').toLowerCase();
  try {
    // Infer domain terms from query text
    const scholarshipTerms = ['ทุน','ทุนการศึกษา','ทุนเรียน','ทุนเรียนดี','ทุนช่วยเหลือ','ทุนความสามารถ'];
    const dormTerms = ['หอ','หอพัก'];
    const admissionsTerms = ['สมัคร','รับสมัคร'];
    const containsAny = (terms, text) => terms.some(t => text.includes(t));
    const wantScholarship = containsAny(scholarshipTerms, q);
    const wantDorm = containsAny(dormTerms, q);
    const wantAdmissions = containsAny(admissionsTerms, q);
    const orgTermMap = {
      scholarship: ['ทุน','ทุนการศึกษา','การเงิน'],
      dorm: ['หอ','หอพัก','สวัสดิการ'],
      admissions: ['รับสมัคร','ทะเบียน','วิชาการ']
    };
    const terms = [];
    if (wantScholarship) terms.push(...orgTermMap.scholarship);
    if (wantDorm) terms.push(...orgTermMap.dorm);
    if (wantAdmissions) terms.push(...orgTermMap.admissions);

    let rows = [];
    if (terms.length > 0) {
      const likes = terms.map(t => `%${t}%`);
      const ors = terms.map(() => 'org.OrgName LIKE ?').join(' OR ');
      const [rowsData] = await app.locals.pool.query(
        `SELECT o.OfficerID, o.OfficerName AS officer, o.OfficerPhone AS phone, org.OrgName AS organization
         FROM Officers o
         LEFT JOIN Organizations org ON o.OrgID = org.OrgID
         WHERE (${ors}) AND o.OfficerPhone IS NOT NULL AND TRIM(o.OfficerPhone) <> ''
         ORDER BY org.OrgName ASC LIMIT 10`,
        likes
      );
      rows = rowsData;
    }
    if (!rows || rows.length === 0) {
      // Fetch exactly the three preferred organizations from DB (no fallback values)
      const preferredOrgs = ['กองพัฒนานักศึกษา', 'สำนักส่งเสริมวิชาการและงานทะเบียน', 'สำนักเทคโนโลยีสารสนเทศ'];
      const [prefRows] = await app.locals.pool.query(
        `SELECT org.OrgName AS organization, o.OfficerName AS officer, o.OfficerPhone AS phone
         FROM Organizations org
         JOIN Officers o ON o.OrgID = org.OrgID
         WHERE org.OrgName IN (?, ?, ?) AND o.OfficerPhone IS NOT NULL AND TRIM(o.OfficerPhone) <> ''
         ORDER BY org.OrgName ASC, o.OfficerName ASC
         LIMIT 3`,
        preferredOrgs
      );

      // Only return organizations that exist and have officers/phones in DB
      rows = prefRows || [];
    }

    const { formatThaiPhone } = require('./utils/formatPhone');
    // Default contact is sourced from config/DB instead of hardcoding
    const { getDefaultContact } = require('./utils/getDefaultContact_fixed');
    const defaultContact = await getDefaultContact(app.locals.pool);

    const contacts = (rows || []).map(r => ({
      organization: r.organization || null,
      officer: r.officer || null,
      phone: r.phone || null,
      officerPhoneRaw: r.phone || null,
      officerPhone: r.phone ? formatThaiPhone(r.phone) : null
    }));

    // Prefer a contact where name matches 'วิพาด' or phone starts with '081' if present
    const findPreferred = (list) => {
      if (!list) return null;
      const nameMatch = list.find(c => /วิพาด/.test(String(c.officer || '')));
      if (nameMatch) return nameMatch;
      const phoneMatch = list.find(c => (c.phone || '').replace(/\D/g,'').startsWith('081'));
      if (phoneMatch) return phoneMatch;
      return null;
    };
    const preferred = findPreferred(contacts);
    if (preferred) { contacts.length = 0; contacts.push(preferred); console.log('Selected preferred contact (server):', preferred); }

    if (!contacts || contacts.length === 0) {
      // Try to find a matching DB contact first
      try {
        const [dbDefault] = await app.locals.pool.query(
          `SELECT o.OfficerPhone AS phone, o.OfficerName AS officer, org.OrgName AS organization
           FROM Officers o
           LEFT JOIN Organizations org ON o.OrgID = org.OrgID
           WHERE (REPLACE(o.OfficerName, '…', '') LIKE ? OR REPLACE(REPLACE(org.OrgName, '\\t', ''), '…', '') LIKE ?) AND o.OfficerPhone IS NOT NULL AND TRIM(o.OfficerPhone) <> ''
           LIMIT 1`, ['%วิพาด%', '%ส่งเสริม%']
        );
        if (dbDefault && dbDefault.length > 0) {
          const r = dbDefault[0];
          contacts.push({
            organization: r.organization || defaultContact?.organization || null,
            officer: r.officer || defaultContact?.officer || null,
            phone: r.phone || defaultContact?.phone || null,
            officerPhoneRaw: r.phone || defaultContact?.officerPhoneRaw || null,
            officerPhone: r.phone ? formatThaiPhone(r.phone) : (defaultContact?.officerPhone || null)
          });
        } else if (defaultContact) {
          contacts.push(defaultContact);
        } else {
          // defaultContact not configured; fallback to officers who authored QAs
          try {
            const [qaOfficers] = await app.locals.pool.query(
              `SELECT DISTINCT o.OfficerID, o.OfficerName AS officer, o.OfficerPhone AS phone, org.OrgName AS organization
               FROM Officers o
               LEFT JOIN Organizations org ON o.OrgID = org.OrgID
               INNER JOIN QuestionsAnswers qa ON qa.OfficerID = o.OfficerID
               WHERE o.OfficerPhone IS NOT NULL AND TRIM(o.OfficerPhone) <> ''
               ORDER BY qa.QuestionsAnswersID DESC
               LIMIT 5`
            );
            const fromQa = (qaOfficers || []).map(r => ({ organization: r.organization || null, officer: r.officer || null, phone: r.phone || null, officerPhoneRaw: r.phone || null, officerPhone: r.phone ? formatThaiPhone(r.phone) : null })).filter(Boolean);
            if (fromQa.length > 0) contacts.push(...fromQa);
          } catch (e) {
            console.error('Error fetching QA officers for contacts fallback (server):', e && e.message);
          }
        }
      } catch (e) {
        console.error('Error fetching default contact from DB', e && (e.message || e));
        contacts.push(defaultContact);
      }
    }
    // Deduplicate by officer+phone
    const dedup = [];
    const seen = new Set();
    for (const c of contacts) {
      const key = `${c.officer || ''}::${c.phone || ''}`;
      if (!seen.has(key)) { seen.add(key); dedup.push(c); }
    }
    return res.status(200).json({ success: true, contacts: dedup });
  } catch (err) {
    console.error('GET /chat/contacts error:', err && err.message);
    return res.status(500).json({ success: false, message: 'Internal Server Error' });
  }
});


// --- Protected Routes (Authentication Required) ---
// ใช้ authenticateToken middleware กับทุก route ที่อยู่ข้างใต้กลุ่มนี้
app.get('/adminusers', authenticateToken, getAdminUsersService(pool));
app.get('/organizations', authenticateToken, getOrganizationsService(pool));
app.get('/officers', authenticateToken, getOfficersService(pool));
// ยังคงเวอร์ชัน protected ไว้สำหรับผู้ใช้ที่ต้องการข้อมูลภายใต้สิทธิ์
app.get('/categories_protected', authenticateToken, getCategoriesService(pool));
// Public keywords endpoint for stopwords management UI (distinct KeywordText)
app.get('/keywords/public', getKeywordsPublicService(pool));

// Public autocomplete suggestions endpoint (keywords + synonyms + stopwords)
app.get('/autocomplete/suggest', getAutocompleteSuggestionsService(pool));
// Protected keywords endpoint
app.get('/keywords', authenticateToken, getKeywordsService(pool));
app.get('/feedbacks', authenticateToken, getFeedbacksService(pool));
app.get('/feedbacks/handled', authenticateToken, getHandledFeedbacksService(pool));
app.put('/feedbacks/:feedbackId/handle', authenticateToken, markFeedbackHandledService(pool));
app.put('/feedbacks/:feedbackId/unhandle', authenticateToken, unhandleFeedbackService(pool));
app.delete('/feedbacks/cleanup-handled', authenticateToken, cleanupHandledFeedbacksService(pool));
app.get('/answerskeywords', authenticateToken, getAnswersKeywordsService(pool));
app.get('/questionsanswers', authenticateToken, getQuestionsAnswersService(pool));
app.get('/chatloghasanswers', authenticateToken, getChatLogHasAnswersService(pool));
app.get('/chatlognoanswers', authenticateToken, getChatLogNoAnswersService(pool));

// --- Legacy / alternate endpoint aliases (to avoid 404s from frontend expecting different routes) ---
app.get('/getCategories_protected', authenticateToken, getCategoriesService(pool));
app.get('/getKeywords', authenticateToken, getKeywordsService(pool));
app.get('/getFeedbacks', authenticateToken, getFeedbacksService(pool));
app.get('/getAnswersKeywords', authenticateToken, getAnswersKeywordsService(pool));
app.get('/getQuestionsAnswers', authenticateToken, getQuestionsAnswersService(pool));
app.get('/getChatLogHasAnswers', authenticateToken, getChatLogHasAnswersService(pool));
app.get('/getChatLogNoAnswers', authenticateToken, getChatLogNoAnswersService(pool));

// Temporary debug endpoint (no auth) to return chat logs without answers for UI debugging
// NOTE: Remove or secure this in production.
app.get('/debug/chatlognoanswers', async (req, res) => {
  try {
    await getChatLogNoAnswersService(pool)(req, res);
  } catch (err) {
    console.error('[debug] /debug/chatlognoanswers error:', err);
    res.status(500).json({ success: false, message: 'Internal Server Error' });
  }
});

// Temporary debug endpoint (no auth) to return all feedbacks for UI debugging only
// NOTE: This is for local debugging. Remove or secure in production.
app.get('/debug/feedbacks', async (req, res) => {
  try {
    await getFeedbacksService(pool)(req, res);
  } catch (err) {
    console.error('[debug] /debug/feedbacks error:', err);
    res.status(500).json({ success: false, message: 'Internal Server Error' });
  }
});

// --- Stopwords Management ---
// Public list endpoint for viewing in UI without auth (must be before authenticateToken middleware)
app.get('/stopwords/public', getStopwordsService(pool));

// Public seed preview endpoint (for testing without auth)
// ใช้ STANDARD_THAI_STOPWORDS จาก sync script (pythainlp-based) แทน hard-coded
app.get('/stopwords/seed/preview-public', async (req, res) => {
  try {
    const [existingRows] = await pool.query('SELECT StopwordText FROM Stopwords');
    const existingWords = new Set(existingRows.map(r => (r.StopwordText || '').trim().toLowerCase()));
    // ใช้ STANDARD_THAI_STOPWORDS จาก sync_stopwords_from_standard.js
    const { STANDARD_THAI_STOPWORDS } = require('./scripts/sync_stopwords_from_standard');
    const wordsToAdd = STANDARD_THAI_STOPWORDS.filter(word => !existingWords.has(word.trim().toLowerCase()));
    const alreadyExists = STANDARD_THAI_STOPWORDS.filter(word => existingWords.has(word.trim().toLowerCase()));
    res.json({ ok: true, data: { toAdd: wordsToAdd, alreadyExists, totalStandard: STANDARD_THAI_STOPWORDS.length } });
  } catch (error) {
    console.error('Error getting seed preview:', error);
    res.status(500).json({ ok: false, message: error && error.message });
  }
});

// Mount full-featured stopwords CRUD router (includes seed/preview)
const stopwordsCrudRouter = require('./routes/stopwordsCrud');
app.use('/stopwords', authenticateToken, stopwordsCrudRouter);

// Protected list (legacy/for authenticated use)
app.get('/stopwords', authenticateToken, getStopwordsService(pool));
app.post('/stopwords', authenticateToken, async (req, res) => {
  await addStopwordService(pool)(req, res);
  clearStopwordsCache(); // Clear cache after adding
});
app.delete('/stopwords/:id', authenticateToken, async (req, res) => {
  await deleteStopwordService(pool)(req, res);
  clearStopwordsCache(); // Clear cache after deleting
});

// --- Negative Keywords CRUD Management ---
// Public endpoint for negative keywords list (chatbot help center - no auth required)
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

// Mount full-featured router for negative keywords management
const negativeKeywordsRouter = require('./routes/negativeKeywords');
app.use('/negativekeywords', authenticateToken, (req, res, next) => {
  req.pool = pool;
  next();
}, negativeKeywordsRouter);
// Also keep the legacy CRUD factory-based routes mounted for backward compatibility under /negativekeywords/crud
const negativeKeywordsCrudRoutes = require('./routes/negativeKeywordsCrud');
app.use('/negativekeywords/crud', authenticateToken, negativeKeywordsCrudRoutes(pool));
// Optional API-friendly path
app.use('/api/negative-keywords', authenticateToken, (req, res, next) => {
  req.pool = pool;
  next();
}, negativeKeywordsRouter);

// --- Admin Keyword Management ---
const adminRoutes = require('./routes/admin');
app.use('/admin', authenticateToken, adminRoutes); // 🔐 Protected with authenticateToken

// Thai patterns routes removed

// --- Keywords Management (cleanup/suggestions) ---
const keywordsRoutes = require('./routes/keywords');
app.use('/keywords', authenticateToken, keywordsRoutes); // 🔐 Protected with authenticateToken

// --- Categories CRUD (เพิ่ม แก้ไข ลบ หมวดหมู่) ---
const categoriesCrudRoutes = require('./routes/categoriesCrud');
app.use('/categories/crud', authenticateToken, categoriesCrudRoutes);

// --- Officers CRUD (เพิ่ม แก้ไข ลบ เจ้าหน้าที่) ---
const officersCrudRoutes = require('./routes/officersCrud');
app.use('/officers/crud', authenticateToken, officersCrudRoutes);

// --- Officers Upload/Download (CSV) ---
app.post('/officers/upload', authenticateToken, upload.single('file'), uploadOfficersService(pool));
app.get('/officers/last-upload', authenticateToken, downloadOfficersLastUploadService());

// --- Organizations Upload/Download (CSV) ---
app.post('/organizations/upload', authenticateToken, upload.single('file'), uploadOrganizationsService(pool));
app.get('/organizations/last-upload', authenticateToken, downloadOrganizationsLastUploadService());

// --- Admin Users Upload/Download (CSV) ---
app.post('/adminusers/upload', authenticateToken, upload.single('file'), uploadAdminUsersService(pool));
app.get('/adminusers/last-upload', authenticateToken, downloadLastUploadService());

// --- Organizations CRUD (เพิ่ม แก้ไข ลบ หน่วยงาน) ---
const organizationsCrudRoutes = require('./routes/organizationsCrud');
app.use('/organizations/crud', authenticateToken, organizationsCrudRoutes);

// --- AdminUsers CRUD (เพิ่ม แก้ไข ลบ ผู้ดูแลระบบ) ---
const adminUsersCrudRoutes = require('./routes/adminUsersCrud');
app.use('/adminusers', authenticateToken, adminUsersCrudRoutes);

// --- Keyword Synonyms CRUD (คำพ้อง/คำสนับสนุน) ---
const synonymsCrudRoutes = require('./routes/synonymsCrud');

// Public endpoint for synonyms list (chatbot help center - no auth required)
// MUST be defined BEFORE the authenticated route to avoid auth middleware
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

// Protected synonyms CRUD routes
app.use('/synonyms', authenticateToken, synonymsCrudRoutes(pool));

// --- QuestionsAnswers CRUD (เพิ่ม แก้ไข ลบ ง่ายๆ) ---
const questionsAnswersCrudRoutes = require('./routes/questionsAnswersCrud');

// Public endpoint for popular questions (no auth required)
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

// Public: Get navigation questions (questions with location/coordinates - title must indicate location)
app.get('/questionsanswers/navigation', async (req, res) => {
  try {
    const limit = parseInt(req.query.limit) || 10;
    // Find questions that:
    // 1. QuestionTitle contains location keywords (พิกัด, นำทาง, ที่ตั้ง, แผนที่)
    // 2. AND QuestionText contains Google Maps URL or coordinates
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
          OR QuestionText REGEXP '[0-9]+\\.[0-9]+,[[:space:]]*[0-9]+\\.[0-9]+'
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

// --- AI Image Management (Admin only) ---
const aiImageRoutes = require('./routes/aiImageCrud');
app.use('/ai-image', aiImageRoutes); // Public GET for chatbot, protected POST/DELETE via internal logic
// Serve uploaded AI images with explicit CORS
app.use('/uploads/ai-images', cors(), express.static(path.join(__dirname, 'uploads', 'ai-images')));

// Protected endpoints: create, update, delete, categories (auth required)
// Categories endpoint moved to questionsAnswersCrud.js with org filtering
app.use('/questionsanswers', authenticateToken, questionsAnswersCrudRoutes);

// Explicit public fallback with logging (calls service handler directly)
app.get('/getChatLogHasAnswers', async (req, res) => {
	console.log('[fallback] GET /getChatLogHasAnswers called, auth present=', !!req.headers.authorization);
	try {
		await getChatLogHasAnswersService(pool)(req, res);
	} catch (e) {
		console.error('[fallback] getChatLogHasAnswers error:', e);
		res.status(500).json({ success: false, message: 'Internal Server Error' });
	}
});

app.get('/getChatLogNoAnswers', async (req, res) => {
	console.log('[fallback] GET /getChatLogNoAnswers called, auth present=', !!req.headers.authorization);
	try {
		await getChatLogNoAnswersService(pool)(req, res);
	} catch (e) {
		console.error('[fallback] getChatLogNoAnswers error:', e);
		res.status(500).json({ success: false, message: 'Internal Server Error' });
	}
});

// Also provide lowercase/alternative forms if frontend uses different casing
app.get('/getchatloghasanswers', authenticateToken, getChatLogHasAnswersService(pool));
app.get('/getchatlognoanswers', authenticateToken, getChatLogNoAnswersService(pool));

// Public (no-auth) legacy aliases to prevent 404s when frontend requests legacy routes without Authorization
app.get('/getChatLogNoAnswers', getChatLogNoAnswersService(pool));
app.get('/getChatLogHasAnswers', getChatLogHasAnswersService(pool));
app.get('/getchatlognoanswers', getChatLogNoAnswersService(pool));
app.get('/getchatloghasanswers', getChatLogHasAnswersService(pool));

// --- Upload Routes ---
app.post('/adminusers/upload', authenticateToken, upload.single('file'), uploadAdminUsersService(pool));
app.post('/organizations/upload', authenticateToken, upload.any(), uploadOrganizationsService(pool));
app.post('/officers/upload', authenticateToken, upload.any(), uploadOfficersService(pool));
app.post('/categories/upload', authenticateToken, upload.any(), uploadCategoriesService(pool));
app.post('/questionsanswers/upload', authenticateToken, upload.any(), uploadQuestionsAnswersService(pool));
app.get('/questionsanswers/download-latest', authenticateToken, (req, res) => downloadLatestExportService(req, res, pool));

// Chat feedback endpoint (public)
app.post('/chat/feedback', chatFeedbackService(pool));
app.post('/chat/logs/has-answer', chatLogHasAnswerService(pool));
app.post('/chat/logs/no-answer', chatLogNoAnswerService(pool));

// Ranking API (public)
app.use('/ranking', rankingRoute);

// Gemini AI API (public)
app.use('/api/gemini', geminiRoute);

// --- System Information Route (public) ---
const systemRoute = require('./routes/system');
app.use('/system', systemRoute(pool));

// --- Geo helpers (auth required) ---
app.get('/geo/geocode', authenticateToken, geocodeService());

// --- Download Routes ---
app.get('/adminusers/last-upload', authenticateToken, downloadLastUploadService());
app.get('/organizations/last-upload', authenticateToken, downloadOrganizationsLastUploadService());
app.get('/officers/last-upload', authenticateToken, downloadOfficersLastUploadService());
app.get('/categories/last-upload', authenticateToken, downloadCategoriesLastUploadService());
app.get('/questionsanswers/last-upload', authenticateToken, downloadQuestionsAnswersLastUploadService());

// --- Global Error Handler ---
app.use((err, req, res, next) => {
  console.error('🔥 Unhandled Server Error:', err);
  res.status(err.status || 500).json({
    success: false,
    message: err.message || 'Internal Server Error',
    detail: process.env.NODE_ENV === 'development' ? err.stack : undefined
  });
});

// 7. เปิด Server
// BIND_HOST: address to bind the TCP server to (use 0.0.0.0 for all interfaces)
const BIND_HOST = process.env.HOST || '0.0.0.0';
// PUBLIC_HOST: the canonical hostname shown to users (e.g. project.3bbddns.com)
const PUBLIC_HOST = process.env.PUBLIC_HOST || 'project.3bbddns.com';

// Simple health-check endpoint to help detect when the backend is up
app.get('/health', (req, res) => {
  res.status(200).json({ success: true, status: 'ok', pid: process.pid, env: process.env.NODE_ENV || 'unknown' });
});

// Log server-level errors and uncaught exceptions to aid debugging and keep visibility
process.on('uncaughtException', (err) => {
  console.error('🔥 Uncaught Exception:', err && (err.stack || err));
});
process.on('unhandledRejection', (reason) => {
  console.error('🔥 Unhandled Rejection:', reason && (reason.stack || reason));
});

server.on('error', (err) => {
  console.error('❌ HTTP Server error:', err && (err.message || err));
});

// Only start server if not in Vercel serverless environment
if (process.env.VERCEL !== '1') {
  server.listen(PORT, BIND_HOST, async () => {
    // List non-internal, non-loopback IPv4 addresses for convenience when binding to 0.0.0.0
    const os = require('os');
    const nets = os.networkInterfaces();
    const addrs = [];
    for (const name of Object.keys(nets)) {
      for (const net of nets[name]) {
        if (net.family === 'IPv4' && !net.internal && !net.address.startsWith('127.')) {
          addrs.push(net.address);
        }
      }
    }

    // Always show the public host as the primary URL so logs do not expose loopback addresses
    console.log(`Server running at http://${PUBLIC_HOST}:${PORT}`);

    // Additionally list local interface addresses when binding to all interfaces (0.0.0.0)
    if (BIND_HOST === '0.0.0.0' && addrs.length > 0) {
      console.log(`Also accessible via: ${addrs.map(a => `http://${a}:${PORT}`).join(', ')}`);
    }

    console.log(`WebSocket server running at ws://${PUBLIC_HOST}:${PORT}`);
    
    // Auto-sync stopwords on server start
    console.log('🔄 Starting stopwords auto-sync...');
    try {
      await syncStopwords(pool);
    } catch (err) {
      console.error('⚠️  Stopwords auto-sync failed:', err.message);
      // Continue server startup even if sync fails
    }
  });

  // Graceful shutdown
  function shutdown() {
    stopTokenizerService();
    process.exit(0);
  }

  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

// Export for Vercel serverless
module.exports = app;