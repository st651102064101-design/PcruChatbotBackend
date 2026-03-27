const { getStopwordsSet } = require('../stopwords/loadStopwords');
const NEG_KW_MODULE = require('../negativeKeywords/loadNegativeKeywords');
const geminiIntegration = require('./geminiIntegration');

// Extract functions safely to avoid errors if module structure differs
const simpleTokenize = NEG_KW_MODULE.simpleTokenize || ((t) => String(t || '').toLowerCase().split(/\s+/));
const analyzeQueryNegation = NEG_KW_MODULE.analyzeQueryNegation || (() => ({ hasNegation: false, negatedKeywords: [] }));
const checkNegation = NEG_KW_MODULE.checkNegation || (() => ({ isNegated: false }));
const getNegativeKeywordsMap = NEG_KW_MODULE.getNegativeKeywordsMap || (() => ({}));
const INLINE_NEGATION_PATTERNS = NEG_KW_MODULE.INLINE_NEGATION_PATTERNS || [];
const { calculateFinalRanking } = require('../ranking/calculateFinalRanking');

// --- Global Caches ---
let SEMANTIC_SIM_MAP = {};
let getSemanticSimilarity = (a, b) => 0;
let SYNONYMS_MAPPING = {};
const BOT_PRONOUN = process.env.BOT_PRONOUN || 'หนู';
const NEGATION_BLOCKS = new Map();

// 🚀 Cache with TTL (Time-To-Live) to avoid repeated DB queries
const CACHE_TTL = 1000 * 60 * 5; // 5 minutes cache
const caches = {
  semanticData: { data: null, timestamp: 0 },
  synonymsMapping: { data: null, timestamp: 0 },
  negativeKeywords: { data: null, timestamp: 0 }
};

function isCacheValid(cacheName) {
  const cache = caches[cacheName];
  if (!cache || !cache.data) return false;
  return (Date.now() - cache.timestamp) < CACHE_TTL;
}

// --- Configuration ---
const KW_SIM_THRESHOLD = parseFloat(process.env.KW_SIM_THRESHOLD) || 0.5;
const TOKENIZER_HOST = process.env.TOKENIZER_HOST || 'project.3bbddns.com';
const TOKENIZER_PORT = process.env.TOKENIZER_PORT || '36146';
const TOKENIZER_PATH = process.env.TOKENIZER_PATH || '/tokenize';
const TOKENIZER_URL = process.env.TOKENIZER_URL || `http://${TOKENIZER_HOST}:${TOKENIZER_PORT}${TOKENIZER_PATH}`;

// --------------------------------------------------------------------------------
// HELPER FUNCTIONS (Defined BEFORE usage)
// --------------------------------------------------------------------------------

async function fetchQAWithKeywords(pool) {
  // 🚀 OPTIMIZED: Single query with LEFT JOIN instead of N+1 Query Loop
  // This replaces 501 queries (1 + 500) with just 1 query!
  const [rows] = await pool.query(`
    SELECT 
      qa.QuestionsAnswersID, 
      qa.QuestionTitle, 
      qa.ReviewDate, 
      qa.QuestionText, 
      qa.OfficerID,
      c.CategoriesName AS CategoriesID, 
      c.CategoriesPDF,
      GROUP_CONCAT(k.KeywordText SEPARATOR '||') AS keywords_concat
    FROM QuestionsAnswers qa
    LEFT JOIN Categories c ON qa.CategoriesID = c.CategoriesID
    LEFT JOIN AnswersKeywords ak ON qa.QuestionsAnswersID = ak.QuestionsAnswersID
    LEFT JOIN Keywords k ON ak.KeywordID = k.KeywordID
    GROUP BY qa.QuestionsAnswersID, qa.QuestionTitle, qa.ReviewDate, qa.QuestionText, 
             qa.OfficerID, c.CategoriesName, c.CategoriesPDF
  `);
  
  const result = [];
  for (const row of rows) {
    // Parse concatenated keywords
    const keywords = row.keywords_concat 
      ? row.keywords_concat.split('||').filter(k => k && k.trim() !== '')
      : [];
    result.push({ 
      ...row, 
      keywords: keywords
    });
  }
  return result;
}

function getSessionKey(req) {
  try {
    if (!req) return 'anonymous';
    const sid = (req.session && (req.session.id || req.sessionID)) ? (req.session.id || req.sessionID) : null;
    if (sid) return String(sid);
    if (req.ip) return String(req.ip);
    return 'anonymous';
  } catch (e) { return 'anonymous'; }
}

function loadBlockedDomains(req) {
  try {
    // 1. ลองดึงจาก Session ก่อน
    let sessionDomains = (req && req.session && req.session.blockedDomains) ? req.session.blockedDomains : [];
    
    // 2. ดึงจาก Global Cache (แผนสำรอง ถ้า Session หลุด)
    const key = getSessionKey(req);
    const globalEntry = NEGATION_BLOCKS.get(key);
    let globalDomains = globalEntry ? Array.from(globalEntry.blockedDomains) : [];

    // รวมกันทั้ง 2 แหล่ง
    return new Set([...sessionDomains, ...globalDomains]);
  } catch (e) { return new Set(); }
}

function loadBlockedKeywords(req) {
  try {
    // 1. ลองดึงจาก Session ก่อน
    let sessionKeywords = (req && req.session && req.session.blockedKeywords) ? req.session.blockedKeywords : [];
    
    // 2. ดึงจาก Global Cache (แผนสำรอง ถ้า Session หลุด)
    const key = getSessionKey(req);
    const globalEntry = NEGATION_BLOCKS.get(key);
    let globalKeywords = globalEntry ? Array.from(globalEntry.blockedKeywords) : [];

    // รวมกันทั้ง 2 แหล่ง
    const combined = new Set([...sessionKeywords, ...globalKeywords]);
    
    // DEBUG: ดูว่าโหลดคำแบนอะไรมาได้บ้าง
    if (combined.size > 0) {
        console.log(`[DEBUG] Loaded Blocked Keywords for ${key}:`, Array.from(combined));
    }
    
    return combined;
  } catch (e) { return new Set(); }
}

function clearBlockedDomains(req) {
  try {
    // 1. Clear session data
    if (req && req.session) {
      req.session.blockedDomains = [];
      req.session.blockedKeywords = [];
    }
    
    // 2. 🗑️ Clear global NEGATION_BLOCKS cache for this session
    const key = getSessionKey(req);
    if (key && NEGATION_BLOCKS.has(key)) {
      NEGATION_BLOCKS.delete(key);
      console.log(`🗑️ Cleared blocked keywords cache for session: ${key}`);
    }
  } catch (e) { 
    console.warn('clearBlockedDomains error:', e && (e.message || e));
  }
}

function persistBlockedKeywords(req, keywords) {
  try {
    if (!Array.isArray(keywords)) return;
    const existing = loadBlockedKeywords(req);
    const combined = new Set([...(existing || []), ...keywords.map(k => String(k).toLowerCase())]);
    if (req && req.session) req.session.blockedKeywords = Array.from(combined);
    const key = getSessionKey(req);
    const entry = NEGATION_BLOCKS.get(key) || { blockedDomains: new Set(), blockedKeywords: new Set(), updatedAt: 0 };
    entry.blockedKeywords = new Set(Array.from(entry.blockedKeywords || []).concat(Array.from(combined)));
    entry.updatedAt = Date.now();
    NEGATION_BLOCKS.set(key, entry);
  } catch (e) { console.warn('persistBlockedKeywords failed', e && (e.message || e)); }
}

function persistBlockedDomains(req, domains) {
  try {
    if (!Array.isArray(domains)) return;
    const existing = loadBlockedDomains(req);
    const combined = new Set([...(existing || []), ...domains.map(d => String(d).toLowerCase())]);
    if (req && req.session) req.session.blockedDomains = Array.from(combined);
    const key = getSessionKey(req);
    const entry = NEGATION_BLOCKS.get(key) || { blockedDomains: new Set(), blockedKeywords: new Set(), updatedAt: 0 };
    entry.blockedDomains = new Set(Array.from(entry.blockedDomains || []).concat(Array.from(combined)));
    entry.updatedAt = Date.now();
    NEGATION_BLOCKS.set(key, entry);
  } catch (e) { console.warn('persistBlockedDomains failed', e && (e.message || e)); }
}

function resolveSynonyms(tokens) {
  if (!Array.isArray(tokens)) return tokens;
  try {
    return tokens.map(t => {
      const k = String(t || '').toLowerCase().trim();
      if (SYNONYMS_MAPPING && SYNONYMS_MAPPING[k]) return SYNONYMS_MAPPING[k];
      return t;
    });
  } catch (e) { return tokens; }
}

async function loadSemanticData(pool) {
  try {
    // 🚀 Check cache first (5 minute TTL)
    if (isCacheValid('semanticData')) {
      SEMANTIC_SIM_MAP = caches.semanticData.data;
      getSemanticSimilarity = (w1, w2) => {
        try {
          if (!w1 || !w2) return 0;
          if (SEMANTIC_SIM_MAP[w1] && typeof SEMANTIC_SIM_MAP[w1][w2] !== 'undefined') return SEMANTIC_SIM_MAP[w1][w2];
          return 0;
        } catch (e) { return 0; }
      };
      return SEMANTIC_SIM_MAP;
    }

    const loader = require('../semanticData/loadSemanticData');
    const map = await loader.getSemanticSimilarity(pool);
    SEMANTIC_SIM_MAP = map || {};
    
    // 💾 Store in cache with timestamp
    caches.semanticData.data = SEMANTIC_SIM_MAP;
    caches.semanticData.timestamp = Date.now();
    
    getSemanticSimilarity = (w1, w2) => {
      try {
        if (!w1 || !w2) return 0;
        if (SEMANTIC_SIM_MAP[w1] && typeof SEMANTIC_SIM_MAP[w1][w2] !== 'undefined') return SEMANTIC_SIM_MAP[w1][w2];
        return 0;
      } catch (e) { return 0; }
    };
    return SEMANTIC_SIM_MAP;
  } catch (e) {
    SEMANTIC_SIM_MAP = {};
    getSemanticSimilarity = () => 0;
    return {};
  }
}

async function loadSynonymsMapping(pool) {
  try {
    // 🚀 Check cache first (5 minute TTL)
    if (isCacheValid('synonymsMapping')) {
      SYNONYMS_MAPPING = caches.synonymsMapping.data;
      return SYNONYMS_MAPPING;
    }

    const connection = await pool.getConnection();
    const [rows] = await connection.query(`SELECT s.InputWord AS input, k.KeywordText AS target FROM KeywordSynonyms s JOIN Keywords k ON s.TargetKeywordID = k.KeywordID WHERE s.IsActive = 1`);
    connection.release();
    SYNONYMS_MAPPING = {};
    for (const r of rows || []) {
      if (r && r.input && r.target) SYNONYMS_MAPPING[String(r.input).toLowerCase().trim()] = String(r.target).toLowerCase().trim();
    }
    
    // 💾 Store in cache with timestamp
    caches.synonymsMapping.data = SYNONYMS_MAPPING;
    caches.synonymsMapping.timestamp = Date.now();
    
    return SYNONYMS_MAPPING;
  } catch (e) {
    SYNONYMS_MAPPING = {};
    return {};
  }
}

async function tokenizeWithPython(text) {
  if (!TOKENIZER_URL) return null;
  let urlObj;
  try { urlObj = new URL(TOKENIZER_URL); } catch (err) { return null; }
  const payload = JSON.stringify({ text });
  const client = urlObj.protocol === 'https:' ? require('https') : require('http');
  return new Promise((resolve) => {
    const req = client.request({ hostname: urlObj.hostname, port: urlObj.port || (urlObj.protocol === 'https:' ? 443 : 80), path: urlObj.pathname, method: 'POST', headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) }, timeout: 2000 }, (res) => {
      let data = '';
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => { try { const json = JSON.parse(data || '{}'); const tokens = Array.isArray(json.tokens) ? json.tokens : []; const cleaned = tokens.map((t) => String(t || '').trim()).filter(Boolean); resolve(cleaned); } catch (errParse) { resolve(null); } });
    });
    req.on('error', () => resolve(null));
    req.on('timeout', () => { req.destroy(); resolve(null); });
    req.write(payload);
    req.end();
  });
}

async function normalize(text, pool) {
  try {
    const t = String(text || '').toLowerCase().trim();
    const cleaned = t.replace(/[\p{P}\p{S}]/gu, ' ');
    const separated = cleaned.replace(/(\p{L})(\p{N})/gu, '$1 $2').replace(/(\p{N})(\p{L})/gu, '$1 $2');
    const stopwords = await getStopwordsSet(pool);
    const shortStopwords = Array.from(stopwords).filter((sw) => sw && sw.length <= 4);
    const sortedStopwords = Array.from(stopwords).sort((a, b) => b.length - a.length);

    const refineTokens = (tokens) => {
      const result = [];
      const queue = [...tokens];
      const seen = new Set();
      let loopCount = 0;
      while (queue.length > 0) {
        if (loopCount++ > 1000) break;
        const tok = queue.shift().trim();
        if (!tok || seen.has(tok)) continue;
        seen.add(tok);
        if (stopwords.has(tok)) continue;
        let splitPerformed = false;
        for (const sw of sortedStopwords) {
          if (!sw) continue;
          if (tok.includes(sw) && tok !== sw) {
            const parts = tok.split(sw).map((p) => p.trim()).filter(Boolean);
            if (parts.length > 0) queue.unshift(...parts);
            splitPerformed = true;
            break;
          }
        }
        if (!splitPerformed) result.push(tok);
      }
      return result;
    };

    // 🚀 DISABLED: Python tokenizer to improve performance (was causing 2-3 second delays)
    // const pythonTokens = await tokenizeWithPython(separated);
    // if (pythonTokens && pythonTokens.length > 0) {
    //   const refined = refineTokens(pythonTokens);
    //   return resolveSynonyms(refined);
    // }

    // Use simple tokenization without Python service
    let segmented = separated;
    for (const sw of shortStopwords) segmented = segmented.split(sw).join(' ');
    const rawTokens = segmented.split(/\s+/).filter(Boolean);
    const tokens = [];
    for (const tok of rawTokens) {
      if (stopwords.has(tok)) continue;
      let stripped = tok;
      for (const sw of stopwords) {
        if (sw.length <= 2 && stripped.startsWith(sw) && stripped.length > sw.length) {
          stripped = stripped.slice(sw.length);
          break;
        }
      }
      if (stripped && !stopwords.has(stripped)) tokens.push(stripped);
    }
    const refined = refineTokens(tokens);
    return resolveSynonyms(refined);
  } catch (err) {
    return [String(text || '').trim()];
  }
}


function jaccardSimilarity(aTokens, bTokens) {
  const a = new Set(aTokens);
  const b = new Set(bTokens);
  let intersection = 0;
  for (const x of a) if (b.has(x)) intersection++;
  const union = a.size + b.size - intersection;
  return union === 0 ? 0 : intersection / union;
}

function overlapScore(aTokens, bTokens) {
  const bSet = new Set(bTokens);
  let overlap = 0;
  for (const x of aTokens) if (bSet.has(x)) overlap++;
  return overlap;
}

function semanticOverlapScore(queryTokens, targetTokens) {
  let totalScore = 0;
  for (const qToken of queryTokens) {
    let maxSimilarity = 0;
    for (const tToken of targetTokens) {
      const similarity = getSemanticSimilarity(qToken, tToken);
      if (similarity > maxSimilarity) maxSimilarity = similarity;
    }
    totalScore += maxSimilarity;
  }
  return totalScore;
}

async function rankCandidates(queryTokens, candidates, pool, injectedTokens = []) {
  const results = [];
  const injectedSet = new Set(injectedTokens.map(t => String(t).toLowerCase()));

  for (const item of candidates) {
    const kwTokens = await normalize((item.keywords || []).join(' '), pool);
    const qTextTokens = await normalize(item.QuestionText || '', pool);
    const titleTokens = await normalize(item.QuestionTitle || '', pool);
    // Include Category Name in scoring
    const catTokens = await normalize(item.CategoriesID || '', pool);

    // 🔥 Keyword dominance: compute raw overlap count and scaled score so we can compare counts for strict filtering
    const rawOverlapCount = overlapScore(queryTokens, kwTokens);

    // 💡 NEW: Calculate overlap specifically for INJECTED synonyms
    // This tells us if this item contains the "Golden Keyword" (e.g., "365") that we forced in.
    let injectedOverlapCount = 0;
    if (injectedSet.size > 0) {
        for (const t of kwTokens) {
            if (injectedSet.has(String(t).toLowerCase())) injectedOverlapCount++;
        }
    }

    const scoreOverlap = rawOverlapCount * 10;
    const scoreSemanticKw = semanticOverlapScore(queryTokens, kwTokens) * 2.5;
    const scoreSemanticText = semanticOverlapScore(queryTokens, qTextTokens) * 1.0;
    const scoreSemanticTitle = semanticOverlapScore(queryTokens, titleTokens) * 2.0;
    const scoreCategory = overlapScore(queryTokens, catTokens) * 3.0; // Boost for category match

    const scoreSemantic = jaccardSimilarity(queryTokens, qTextTokens);
    const scoreTitle = jaccardSimilarity(queryTokens, titleTokens) * 2;
    const total = scoreOverlap + scoreSemantic + scoreTitle + scoreSemanticKw + scoreSemanticText + scoreSemanticTitle + scoreCategory;
    
    results.push({ 
        item, 
        score: total, 
        components: { 
            overlapScore: scoreOverlap, 
            overlapCount: rawOverlapCount, 
            injectedOverlap: injectedOverlapCount, // Store this for filtering
            semantic: scoreSemantic, 
            title: scoreTitle, 
            semanticKw: scoreSemanticKw, 
            semanticText: scoreSemanticText, 
            semanticTitle: scoreSemanticTitle, 
            category: scoreCategory 
        } 
    });
  }
  return results.sort((a, b) => b.score - a.score);
} 

// --------------------------------------------------------------------------------
// MAIN MODULE
// --------------------------------------------------------------------------------

module.exports = (pool) => async (req, res) => {
  if (req.body?.resetConversation) {
    clearBlockedDomains(req);
    if (!req.body?.message && !req.body?.text && !req.body?.id) return res.status(200).json({ success: true, reset: true });
  }

  // Load basic data with caching (TTL: 5 minutes)
  try { await loadSemanticData(pool); } catch (e) {}
  try { await loadSynonymsMapping(pool); } catch (e) {}
  try { 
    if (!isCacheValid('negativeKeywords')) {
      const negResult = await NEG_KW_MODULE.loadNegativeKeywords(pool);
      caches.negativeKeywords.data = negResult || true; // Store result or flag as loaded
      caches.negativeKeywords.timestamp = Date.now();
    }
  } catch (e) { console.warn('Failed to load negative keywords:', e.message); }
  
  const message = req.body?.message || req.body?.text || '';
  const questionId = req.body?.id;
  let rankingById = new Map();

  try {
    // 2. Fetch QA List FIRST (using pool directly, not connection)
    const qaList = await fetchQAWithKeywords(pool);
    if (!qaList || qaList.length === 0) return res.status(200).json({ success: true, found: false, message: 'ฐานข้อมูลยังไม่พร้อม', results: [] });

    // 3. Normalize Query
    let queryTokens = await normalize(message, pool);

    // Track tokens that were force-injected via synonyms
    const injectedTokens = [];

    // 🔥 FORCE SYNONYM INJECTION (Fix for tokenization splitting synonyms like "สามหกห้า" -> "สาม","หก","ห้า")
    // If the raw message contains a key in SYNONYMS_MAPPING (e.g. "สามหกห้า"),
    // but the tokens don't contain the target (e.g. "365"), force add it to guarantee a keyword hit.
    if (SYNONYMS_MAPPING && Object.keys(SYNONYMS_MAPPING).length > 0) {
        const msgLower = String(message || '').toLowerCase().replace(/\s+/g, '');
        for (const [key, target] of Object.entries(SYNONYMS_MAPPING)) {
            if (!key) continue;
            const cleanKey = String(key).toLowerCase().replace(/\s+/g, '');
            if (!cleanKey) continue;
            try {
                if (msgLower.includes(cleanKey)) {
                    const targetLower = String(target || '').toLowerCase();
                    if (targetLower) {
                        // 🌟 Normalize the target before injecting to match DB-normalized tokens (e.g. "e-book" -> ["e","book"]).
                        try {
                            const normalizedTargets = await normalize(targetLower, pool);
                            for (const nt of normalizedTargets) {
                                const ntLower = String(nt || '').toLowerCase();
                                if (ntLower && !queryTokens.some(t => String(t || '').toLowerCase() === ntLower)) {
                                    console.log(`🔧 Force injecting normalized synonym: "${key}" -> "${ntLower}"`);
                                    queryTokens.push(ntLower);
                                    injectedTokens.push(ntLower); // Mark as injected
                                }
                            }
                        } catch (e) {
                            // Fallback: inject raw target if normalization fails
                            if (!queryTokens.some(t => String(t || '').toLowerCase() === targetLower)) {
                                console.log(`🔧 Force injecting synonym (fallback): "${key}" -> "${target}"`);
                                queryTokens.push(targetLower);
                                injectedTokens.push(targetLower);
                            }
                        }
                    }
                }
            } catch (e) { continue; }
        }
    }
    
    // 3.1 Check Strict No-Match (English Only or Unknown Keywords)
    const isEnglishOnly = /^[a-zA-Z0-9\s.,?!]+$/.test(message);
    const allKeywords = new Set();
    const allCategories = new Set();
    // เก็บ Keywords แบบ Array เพื่อใช้ตรวจสอบ substring (กรณีพิมพ์ 365 แต่ keyword คือ Office 365)
    const rawKeywordsList = []; 

    for (const qa of qaList) {
        for (const k of (qa.keywords || [])) {
            const kwStr = String(k).toLowerCase().trim();
            allKeywords.add(kwStr);
            rawKeywordsList.push(kwStr); // เก็บไว้เช็ค partial match
        }
        if (qa.CategoriesID) allCategories.add(String(qa.CategoriesID).toLowerCase().trim());
    }

    const hasKnownKeyword = queryTokens.some(t => {
        const token = String(t).toLowerCase().trim();
        
        // 1. เช็คแบบตรงตัว (Exact Match)
        if (allKeywords.has(token)) return true;
        
        // 2. เช็ค Category
        for (const cat of allCategories) { if (cat.includes(token)) return true; }
        
        // 3. (เพิ่มใหม่) เช็ค Partial Match สำหรับตัวเลขหรือภาษาอังกฤษ (เช่น พิมพ์ 365 ให้เจอ Office 365)
        if (isEnglishOnly && token.length > 2) {
             // เช็คว่า token นี้เป็นส่วนหนึ่งของ Keyword ใดๆ หรือไม่
             if (rawKeywordsList.some(k => k.includes(token))) return true;
        }

        return false;
    });

    // แก้ไขเงื่อนไขตรงนี้: เปลี่ยน || เป็น &&
    // ความหมาย: บล็อกเฉพาะถ้า "เป็นอังกฤษล้วน" และ "ไม่มี Keyword"
    // (ถ้าเป็นภาษาไทย ยอมให้ผ่านไปทำ Semantic Search ได้แม้ไม่มี Keyword)
    if (isEnglishOnly && !hasKnownKeyword) {
        const { getDefaultContacts } = require('../../utils/getDefaultContact_fixed');
        try {
            const contacts = await getDefaultContacts(connection);
            return res.status(200).json({
                success: true,
                found: false,
                message: `😓 ขออภัยจริงๆ ฉันไม่มีข้อมูลเกี่ยวกับคำถามนี้`,
                contacts: contacts
            });
        } catch (e) {
            return res.status(200).json({ success: true, found: false, message: `😓 ขออภัยจริงๆ ฉันไม่มีข้อมูลเกี่ยวกับคำถามนี้`, contacts: [] });
        }
    }

    // --- DEBUG START: วางตรงนี้เพื่อดู log ใน Terminal ---
    const debugNegMap = (NEG_KW_MODULE.getNegativeKeywordsMap && NEG_KW_MODULE.getNegativeKeywordsMap()) || {};
    const debugStopwords = await getStopwordsSet(pool); // ✅ เพิ่มการ Debug Stopwords
    console.log('--- DEBUG NEGATION ---');
    console.log('User Message:', message);
    console.log('Loaded Negative Words:', Object.keys(debugNegMap).length); 
    console.log('Loaded Stopwords:', debugStopwords.size); // ✅ แสดงจำนวน Stopwords ที่โหลดได้
    // ถ้า Loaded Negative Words เป็น 0 แสดงว่า Module ไม่ส่งค่ามา ต้องใช้การ Query สด
    // --- DEBUG END ---

    // -------------------------------------------------------------
    // 4. Negation Handling (Ultimate Fix)
    // -------------------------------------------------------------
    const blockedDomainsFromSession = loadBlockedDomains(req);
    const blockedKeywordsFromSession = loadBlockedKeywords(req);
    
    // --- DEBUG: เช็คว่า Server เห็นข้อความว่าอะไร ---
    console.log('------------------------------------------------');
    console.log('Incoming Message Raw:', message); 
    // ถ้าตรงนี้ขึ้นว่า "เอาทุน" แสดงว่า "ไม่" ถูกตัดมาจาก Frontend หรือ Middleware อื่น
    console.log('------------------------------------------------');

    // 🆕 Check if this message has "want" pattern - if so, skip session check and parse properly
    const wantTriggersForCheck = /(?:แต่|ส่วน)[\s]*(?:หนู|ผม|เรา|ฉัน)?[\s]*(?:จะ)?[\s]*(?:เอา|ต้องการ|อยากได้|อยาก|หา|ขอ|สนใจ)/gi;
    const hasWantPattern = wantTriggersForCheck.test(message.toLowerCase());
    
    // 4.1 ตรวจสอบว่าคำที่ user พิมพ์มา เคยถูกบล็อกไปแล้วหรือยัง
    // 🆕 BUT skip this check if message has "want" pattern - user wants to search AND reject
    // 🆕🆕 ALSO skip if there's NO negative word in the current message - user is searching, not rejecting!
    
    // ก่อนอื่น: ตรวจว่าข้อความปัจจุบันมีคำปฏิเสธหรือไม่ (เช็คง่ายๆ ก่อน)
    const quickNegCheck = ['ไม่', 'ไม่เอา', 'ยกเลิก', 'พอ', 'หยุด', 'ไม่ต้องการ', 'บ่เอา', 'อย่า', 'ห้าม', 'เลิก'];
    const hasNegativeInMessage = quickNegCheck.some(neg => message.toLowerCase().includes(neg));
    
    if (blockedKeywordsFromSession.size > 0 && !hasWantPattern && hasNegativeInMessage) {
      const msgLowerForBlock = message.toLowerCase();
      let matchedBlockedKeyword = null;
      for (const blocked of blockedKeywordsFromSession) {
        if (msgLowerForBlock.includes(blocked)) { 
             matchedBlockedKeyword = blocked; 
             break; 
        }
      }
      if (matchedBlockedKeyword) {
        // ✅ เพิ่ม ✨ ให้เหมือนตอนเจอ Keyword
        return res.status(200).json({ 
            success: true, 
            found: false, 
            message: `✨ ${BOT_PRONOUN}จำได้ว่าคุณไม่สนใจเรื่อง "${matchedBlockedKeyword}" แล้วค่ะ (พิมพ์ค้นหาเรื่องอื่นได้เลยนะคะ)`, 
            blockedDomains: Array.from(blockedDomainsFromSession), 
            blockedKeywords: Array.from(blockedKeywordsFromSession), 
            blockedKeywordsDisplay: [matchedBlockedKeyword] 
        });
      }
    }

    // 4.2 Dynamic Negative Detection (Robust Fetch)
    let negativeWordsList = [];
    
    // พยายามโหลดจาก Module ก่อน
    const moduleMap = (NEG_KW_MODULE.getNegativeKeywordsMap && NEG_KW_MODULE.getNegativeKeywordsMap()) || {};
    negativeWordsList = Object.keys(moduleMap).map(w => w.trim().toLowerCase()).filter(w => w);

    // ถ้า Module ว่าง ให้ดึงจาก DB โดยตรง (แบบครอบคลุมทุกชื่อ Column)
    if (negativeWordsList.length === 0) {
        try {
            // SELECT * เพื่อกันพลาดเรื่องชื่อ Column
            const [negRows] = await pool.query("SELECT * FROM NegativeKeywords WHERE IsActive = 1"); 
            if (negRows.length > 0) {
                // หา Column ที่น่าจะเป็นคำศัพท์ (Word, InputWord, KeywordText, etc.)
                const firstRow = negRows[0];
                const keyCol = Object.keys(firstRow).find(k => /word|text|keyword/i.test(k)) || Object.keys(firstRow)[1]; // เดาเอาถ้าหาไม่เจอ
                
                negativeWordsList = negRows.map(r => String(r[keyCol] || '').trim().toLowerCase());
                console.log(`Fetched ${negativeWordsList.length} negative words from DB (Column: ${keyCol})`);
            }
        } catch (dbErr) {
            console.error('Error fetching negative keywords:', dbErr.message);
        }
    }

    // *** FALLBACK LIST (กันตาย) *** // ถ้า DB พัง หรือหาไม่เจอ ให้ใช้ลิสต์นี้แน่นอน
    if (negativeWordsList.length === 0) {
        negativeWordsList = ['ไม่', 'ไม่เอา', 'ยกเลิก', 'พอ', 'หยุด', 'ไม่ต้องการ', 'บ่เอา'];
        console.log('Using Hardcoded Fallback Negative List');
    }

    // เรียงคำปฏิเสธจาก "ยาวไปสั้น" (สำคัญมาก: 'ไม่เอา' ต้องมาก่อน 'ไม่')
    negativeWordsList.sort((a, b) => b.length - a.length);

    // DEBUG: แสดงรายการคำปฏิเสธที่โหลดได้
    console.log('🔴 Negative Words List (sorted):', negativeWordsList.slice(0, 10), '... total:', negativeWordsList.length);

    const msgLower = message.toLowerCase().trim();
    console.log('🔴 Checking message:', msgLower);

    // 🆕 Advanced Multi-Rejection & Multi-Search Parser
    // รองรับ: "ไม่เอา ทุน และ ไม่เอาทุนเรียนดี แต่หนูจะเอา เกณฑ์ และ กยศ"
    // ผลลัพธ์: rejections = ["ทุน", "ทุนเรียนดี"], searches = ["เกณฑ์", "กยศ"]
    
    const rejections = [];  // คำที่ต้องปฏิเสธ
    const searches = [];    // คำที่ต้องค้นหา
    
    // 🆕 Pattern-based approach: แยกส่วน "ไม่เอา" และ "เอา/ต้องการ" ออกจากกัน
    // Step 1: หาตำแหน่งที่เปลี่ยนจาก "ไม่เอา" เป็น "เอา"
    const wantTriggers = /(?:แต่|ส่วน)[\s]*(?:หนู|ผม|เรา|ฉัน)?[\s]*(?:จะ)?[\s]*(?:เอา|ต้องการ|อยากได้|อยาก|หา|ขอ|สนใจ)/gi;
    
    // หาตำแหน่งที่เริ่มส่วน "want"
    const wantMatch = msgLower.match(wantTriggers);
    let rejectPart = msgLower;
    let wantPart = '';
    
    if (wantMatch && wantMatch.length > 0) {
      const wantIndex = msgLower.indexOf(wantMatch[0]);
      rejectPart = msgLower.substring(0, wantIndex).trim();
      wantPart = msgLower.substring(wantIndex).trim();
      // ตัดคำ trigger ออกจาก wantPart
      wantPart = wantPart.replace(wantTriggers, ' ').trim();
    }
    
    console.log('🔴 Reject part:', rejectPart);
    console.log('🟢 Want part:', wantPart);
    
    // 🆕 เช็คว่า rejectPart มีคำปฏิเสธจริงๆ หรือไม่ก่อนที่จะ parse
    const rejectPartHasNegative = negativeWordsList.some(neg => rejectPart.includes(neg));
    
    // Step 2: Parse ส่วน reject (เฉพาะเมื่อมีคำปฏิเสธจริงๆ)
    if (rejectPart && rejectPartHasNegative) {
      // แยกด้วย และ/กับ/,
      const rejectSegments = rejectPart.split(/[\s]*(?:และ|กับ|,|;)[\s]*/);
      for (const seg of rejectSegments) {
        if (!seg.trim()) continue;
        let keyword = seg.trim();
        
        // ตัดคำปฏิเสธออก
        for (const negWord of negativeWordsList) {
          if (keyword.includes(negWord)) {
            keyword = keyword.replace(new RegExp(negWord.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi'), '').trim();
            break;
          }
        }
        
        // ลบคำฟุ่มเฟือย
        keyword = keyword.replace(/^[\s]*(แต่|ส่วน|หนู|ผม|เรา|ฉัน|จะ|ว่า|นะ|ค่ะ|ครับ)[\s]*/gi, '').trim();
        
        if (keyword.length > 0) {
          rejections.push(keyword);
        }
      }
    }
    
    // Step 3: Parse ส่วน want
    if (wantPart) {
      // แยกด้วย และ/กับ/,
      const wantSegments = wantPart.split(/[\s]*(?:และ|กับ|,|;)[\s]*/);
      for (const seg of wantSegments) {
        if (!seg.trim()) continue;
        let keyword = seg.trim();
        
        // ลบคำฟุ่มเฟือย
        keyword = keyword.replace(/^[\s]*(แต่|ส่วน|หนู|ผม|เรา|ฉัน|จะ|ว่า|นะ|ค่ะ|ครับ|เอา|ต้องการ|อยาก|หา|ขอ|สนใจ)[\s]*/gi, '').trim();
        
        if (keyword.length > 0) {
          searches.push(keyword);
        }
      }
    }
    
    // ถ้าไม่พบ pattern ใหม่ ลองใช้ logic เดิม (simple check)
    // 🆕 แต่ต้องเช็คว่ามีคำปฏิเสธจริงๆ ใน message ก่อน!
    if (rejections.length === 0 && searches.length === 0) {
      // 🆕 เช็คว่ามีคำปฏิเสธจริงๆ หรือไม่ก่อนที่จะทำการ parse
      const hasActualNegative = negativeWordsList.some(neg => msgLower.includes(neg));
      
      if (hasActualNegative) {
        for (const prefix of negativeWordsList) {
          if (msgLower.startsWith(prefix)) {
            const remaining = msgLower.substring(prefix.length).trim();
            if (remaining.length > 0) {
              rejections.push(remaining);
            }
            break;
          }
        }
      }
    }
    
    console.log('🔴 Parsed rejections:', rejections);
    console.log('🟢 Parsed searches:', searches);

    // 4.3 ตัดสินใจ (Decision Logic)
    const hasRejections = rejections.length > 0;
    const hasSearches = searches.length > 0;
    
    if (hasRejections) {
      // บันทึกคำปฏิเสธทั้งหมด
      persistBlockedKeywords(req, rejections);
      
      if (hasSearches) {
        // 🆕 มีทั้งคำปฏิเสธและคำค้นหา → ปฏิเสธ + ค้นหาให้
        console.log(`🔴🟢 Mixed mode: Rejecting [${rejections.join(', ')}], Searching [${searches.join(', ')}]`);
        
        // แทนที่ข้อความค้นหาด้วยคำที่ต้องการเท่านั้น
        const searchMessage = searches.join(' ');
        
        // Re-tokenize ด้วยคำค้นหาใหม่
        const searchTokens = await tokenizeWithPython(searchMessage) || searchMessage.split(/\s+/).filter(Boolean);
        
        // ค้นหาแบบใหม่ด้วยคำที่ต้องการ
        const searchRanked = await rankCandidates(searchTokens, qaList, pool, []);
        searchRanked.sort((a, b) => b.score - a.score);
        
        // กรองผลลัพธ์ที่ไม่ตรงกับคำปฏิเสธ
        const blockedSet = new Set([...rejections, ...Array.from(loadBlockedKeywords(req))].map(k => k.toLowerCase()));
        let filteredResults = searchRanked.filter(r => {
          const title = (r.item.QuestionTitle || '').toLowerCase();
          const keywords = (r.item.keywords || []).map(k => k.toLowerCase());
          // ถ้า title หรือ keywords มีคำที่ถูก block ให้ตัดออก
          for (const blocked of blockedSet) {
            if (title.includes(blocked) || keywords.some(k => k.includes(blocked))) {
              return false;
            }
          }
          return true;
        });
        
        if (filteredResults.length === 0) {
          return res.status(200).json({
            success: true,
            found: false,
            message: `✨ รับทราบค่ะ ${BOT_PRONOUN}จะไม่แสดงข้อมูลเกี่ยวกับ ${rejections.map(r => `"<span style="color:#e74c3c;text-decoration:line-through">${r}</span>"`).join(' และ ')} ให้กวนใจแล้ว แต่ไม่พบข้อมูลเกี่ยวกับ ${searches.map(s => `"<span style="color:#27ae60">${s}</span>"`).join(' และ ')} ที่ไม่เกี่ยวกับเรื่องที่ปฏิเสธค่ะ`,
            blockedKeywords: Array.from(loadBlockedKeywords(req)),
            blockedKeywordsDisplay: rejections,
            negationInfo: {
              hasNegation: true,
              negatedKeywords: rejections.map(r => ({ keyword: r, negativeWord: 'ไม่เอา', modifier: -1.0 })),
              negativeWordsFound: rejections.map((r, i) => ({ word: 'ไม่เอา', index: i, modifier: -1.0, targetKeyword: r }))
            }
          });
        }
        
        // ส่งผลลัพธ์กลับ
        const topResults = filteredResults.slice(0, 30);
        const rejectMsg = rejections.length > 0 ? `✨ รับทราบค่ะ ${BOT_PRONOUN}จะไม่แสดงข้อมูลเกี่ยวกับ ${rejections.map(r => `"<span style="color:#e74c3c;text-decoration:line-through">${r}</span>"`).join(' และ ')} ให้กวนใจแล้ว และจะหาคำตอบเกี่ยวกับ ${searches.map(s => `"<span style="color:#27ae60">${s}</span>"`).join(' และ ')} ให้นะคะ\n\n` : '';
        const foundCount = topResults.length;
        
        return res.status(200).json({
          success: true,
          found: true,
          message: `${rejectMsg}✨ พบ ${foundCount} คำตอบที่ใกล้เคียง\n(ลองเลือกซักอันดูสิ 😊)`,
          multipleResults: topResults.length > 1,
          query: searchMessage,
          blockedKeywords: Array.from(loadBlockedKeywords(req)),
          blockedKeywordsDisplay: rejections,
          negationInfo: {
            hasNegation: rejections.length > 0,
            negatedKeywords: rejections.map(r => ({ keyword: r, negativeWord: 'ไม่เอา', modifier: -1.0 })),
            negativeWordsFound: rejections.map((r, i) => ({ word: 'ไม่เอา', index: i, modifier: -1.0, targetKeyword: r }))
          },
          alternatives: topResults.map(r => ({
            id: r.item.QuestionsAnswersID,
            title: r.item.QuestionTitle,
            preview: (r.item.QuestionText || '').slice(0, 200),
            text: r.item.QuestionText,
            score: r.score.toFixed(2),
            keywords: r.item.keywords,
            categories: r.item.CategoriesID || null,
            categoriesPDF: r.item.CategoriesPDF || null
          }))
        });
        
      } else {
        // มีแค่คำปฏิเสธ ไม่มีคำค้นหา
        const rejectListHtml = rejections.map(r => `"<span style="color:#e74c3c;text-decoration:line-through">${r}</span>"`).join(' และ ');
        return res.status(200).json({ 
          success: true, 
          found: false, 
          message: `✨ รับทราบค่ะ ${BOT_PRONOUN}จะไม่แสดงข้อมูลเกี่ยวกับ ${rejectListHtml} ให้กวนใจแล้วค่ะ`,
          blockedDomains: Array.from(loadBlockedDomains(req)), 
          blockedKeywords: Array.from(loadBlockedKeywords(req)), 
          blockedKeywordsDisplay: rejections,
          negationInfo: {
            hasNegation: true,
            negatedKeywords: rejections.map(r => ({ keyword: r, negativeWord: 'ไม่เอา', modifier: -1.0 })),
            negativeWordsFound: rejections.map((r, i) => ({ word: 'ไม่เอา', index: i, modifier: -1.0, targetKeyword: r }))
          }
        });
      }
    }

    // 5. Ranking (Pass injected tokens for priority calculation)
    const ranked = await rankCandidates(queryTokens, qaList, pool, injectedTokens);
    ranked.sort((a, b) => b.score - a.score);

    // 6. Filtering (Smart & Strict)
    let finalResults = ranked;
    if (ranked.length > 0) {
        // 🔥 LOGIC ใหม่ (2-Stage Filtering):
        // 1. ตรวจสอบว่ามี "Injected Keyword" (คำพ้องที่ถูกบังคับใส่) หรือไม่
        const maxInjectedOverlap = Math.max(...ranked.map(r => r.components?.injectedOverlap || 0));

        if (maxInjectedOverlap > 0) {
             console.log(`🎯 Injected Keyword Dominance (Max: ${maxInjectedOverlap}): Filtering strictly for injected terms.`);
             // ถ้ามี Injected Keyword (เช่น 365) ให้กรองเอาเฉพาะข้อที่มีคำนี้อยู่จริงเท่านั้น
             // (วิธีนี้จะแก้ปัญหา "สามหกห้า" -> เจอ "สาม", "หก", "ห้า" ที่คะแนนเท่ากันได้ เพราะข้ออื่นจะไม่มี injected keyword นี้)
             finalResults = finalResults.filter(r => (r.components?.injectedOverlap || 0) >= maxInjectedOverlap);
        } 
        else {
             // 2. ถ้าไม่มี Injected Keyword ก็ใช้ Logic เดิม (Max Overlap)
             const maxOverlap = Math.max(...ranked.map(r => r.components?.overlapCount || 0));
             if (maxOverlap > 0) {
                  finalResults = finalResults.filter(r => (r.components?.overlapCount || 0) >= maxOverlap);
             } else {
                  // Fallback: ใช้คะแนน Relative
                  const bestScore = ranked[0].score;
                  if (bestScore > 5.0) {
                      finalResults = finalResults.filter(r => r.score >= (bestScore * 0.7));
                  } else {
                      // 🆕 FIX: ถ้าไม่มี keyword match และ bestScore ต่ำมาก (<=5.0) ให้ถือว่าไม่พบผลลัพธ์
                      // ป้องกันการ return ทุก QA ในระบบเมื่อ user พิมพ์คำที่ไม่เกี่ยวข้อง เช่น "ไก่"
                      console.log(`🚫 No keyword match & low score (${bestScore.toFixed(2)}): Clearing results`);
                      finalResults = [];
                  }
             }
        }

        // 6.2 Specific Keyword Constraint (Re-apply if needed inside remaining results)
        if (finalResults.length > 0) {
            const rawQuery = message.toLowerCase().replace(/\s+/g, '');
            const currentBestMatch = finalResults[0]; 
            const bestKeywords = (currentBestMatch.item.keywords || []).map(k => k.toLowerCase().replace(/\s+/g, ''));
            const specificTerm = bestKeywords.find(k => rawQuery.includes(k) && k.length > 4 && !['สมัครเรียน', 'ข้อมูล', 'ติดต่อ'].includes(k));

            if (specificTerm) {
                 console.log(`🔒 Enforcing strict filter for term: "${specificTerm}"`);
                 finalResults = finalResults.filter(r => {
                     const rKw = (r.item.keywords || []).map(k => k.toLowerCase().replace(/\s+/g, ''));
                     const rTitle = (r.item.QuestionTitle || '').toLowerCase().replace(/\s+/g, '');
                     return rKw.some(k => k.includes(specificTerm)) || rTitle.includes(specificTerm);
                 });
            }
        }
    }

    // 7. Final Response (Success or Fallback)
    if (finalResults.length === 0) {
        // � เช็คโหมด: ถ้าไม่ใช่ AI Mode ห้ามเรียก Gemini เด็ดขาด
        const useGemini = req.body.useGemini === true || req.body.useGemini === 'true';
        
        if (useGemini) {
            // 🔥 โหมด AI: ใช้ Gemini AI ตอบแทนเมื่อไม่มีคำตอบจากระบบเดิม
            console.log('📢 [AI MODE] ไม่พบคำตอบ ลองใช้ Gemini AI ด้วย Conversation...');
            
            // สร้าง sessionId จาก user session หรือ IP
            const sessionId = req.sessionID || req.ip || 'anonymous-' + Date.now();
            
            const aiResponse = await geminiIntegration.continueConversation(
                sessionId,
                message,
                { category: 'general' }
            );

            if (aiResponse.success) {
                console.log('✅ AI ตอบสำเร็จ (Conversation Mode)');
                return res.status(200).json({
                    success: true,
                    found: true,
                    aiGenerated: true,
                    source: 'ai-conversation',
                    sessionId: sessionId,
                    message: aiResponse.message,
                    alternatives: [{
                        id: 'ai-generated',
                        title: 'ตอบจาก AI Assistant',
                        preview: aiResponse.message.slice(0, 200),
                        text: aiResponse.message,
                        score: '1.00',
                        aiGenerated: true,
                    }],
                });
            }
            
            // Check for quota exceeded error
            if (aiResponse.isQuotaExceeded) {
                console.warn('⚠️  [QUOTA EXCEEDED] Google Gemini API quota เต็มแล้ว');
                return res.status(200).json({
                    success: true,
                    found: true,
                    lowConfidence: true,
                    message: aiResponse.fallbackMessage || 'ขออภัยค่ะ ระบบ AI ของเรากำลังมีภาระงานเยอะ กรุณาลองใหม่ในอีกสักครู่',
                    contacts: [],
                    retryAfter: aiResponse.retryAfter,
                });
            }
        } else {
            // 🔍 โหมด Keyword: ห้ามเรียก Gemini - แสดง contact เท่านั้น
            console.log('📢 [KEYWORD MODE] ไม่พบคำตอบ - ส่ง contact กลับ (ไม่เรียก Gemini)');
        }

        // ถ้า AI error หรือโหมด Keyword ให้ส่งข้อมูลติดต่อแทน
        const { getDefaultContacts } = require('../../utils/getDefaultContact_fixed');
        try {
            const contacts = await getDefaultContacts(pool);
            console.log(`📧 Sending ${contacts.length} default contacts as fallback`);
            return res.status(200).json({ 
                success: true, 
                found: false, 
                message: `ไม่พบข้อมูลที่ตรงกับคำค้นหา`, 
                answer: `ไม่พบข้อมูลที่ตรงกับคำค้นหา`,
                text: `ไม่พบข้อมูลที่ตรงกับคำค้นหา`,
                contacts: contacts 
            });
        } catch (e) {
            console.error('❌ Failed to load default contacts:', e.message);
            return res.status(200).json({ 
                success: true, 
                found: false, 
                message: `ไม่พบข้อมูลที่ตรงกับคำค้นหา`, 
                answer: `ไม่พบข้อมูลที่ตรงกับคำค้นหา`,
                text: `ไม่พบข้อมูลที่ตรงกับคำค้นหา`,
                contacts: [] 
            });
        }
    }

    // 🚀 FIXED: Pagination & Read More Logic
    // เปลี่ยนจาก .slice(0, 3) เป็น dynamic limit
    const offset = parseInt(req.body.offset) || 0;
    const limit = parseInt(req.body.limit) || 30; // เพิ่ม Default เป็น 30 รายการ เพื่อให้แสดงผลเยอะขึ้น (หรือปรับเป็น 10 ก็ได้)
    
    const topRanked = finalResults.slice(offset, offset + limit);

    // 🔥 ปรับปรุงคำตอบแรกด้วย Gemini AI (Enhance Mode)
    let enhancedAlternatives = topRanked.map(r => ({
        id: r.item.QuestionsAnswersID,
        title: r.item.QuestionTitle,
        preview: (r.item.QuestionText || '').slice(0, 200),
        text: r.item.QuestionText,
        score: r.score.toFixed(2),
        keywords: r.item.keywords,
        categories: r.item.CategoriesID || null,
        categoriesPDF: r.item.CategoriesPDF || null,
        keywordMatch: r.components && r.components.overlapCount > 0
    }));

    // 🔴 DISABLED: ปรับปรุงคำตอบแรกเพื่อให้ดูธรรมชาติมากขึ้น (ด้วย Conversation)
    // ⚠️ DO NOT USE AI ENHANCEMENT IN KEYWORD SEARCH MODE
    // In keyword search mode, only return database answers without AI processing
    // AI enhancement should only happen in Gemini AI mode (/api/gemini/conversation)
    /*
    if (topRanked.length > 0 && topRanked[0].item.QuestionText) {
        try {
            const firstAnswer = topRanked[0].item;
            
            // สร้าง sessionId
            const sessionId = req.sessionID || req.ip || 'anonymous-' + Date.now();
            
            // ใช้ continueConversation แทน enhanceAnswer เพื่อเก็บ history
            const enhanced = await geminiIntegration.continueConversation(
                sessionId,
                message,
                { category: firstAnswer.CategoriesID || 'general' }
            );

            if (enhanced.success) {
                console.log('✨ ปรับปรุงคำตอบด้วย AI Conversation สำเร็จ');
                enhancedAlternatives[0].text = enhanced.message;
                enhancedAlternatives[0].enhanced = true;
                enhancedAlternatives[0].sessionId = sessionId;
                // เพิ่ม flag ว่าเป็น conversation
                enhancedAlternatives[0].conversationMode = true;
            }
        } catch (aiError) {
            console.warn('⚠️ ไม่สามารถปรับปรุงคำตอบด้วย AI:', aiError.message);
            // ใช้คำตอบเดิมต่อ ไม่ error
        }
    }
    */
    
    // 🆕 8. Contact Fetching Logic (Hide if 1 answer, Show if >1)
    let specificContacts = [];
    if (topRanked.length > 1) { 
        try {
          const qaIds = topRanked.map(r => r.item.QuestionsAnswersID).filter(id => !!id);
          if (qaIds.length > 0) {
            const [rows] = await pool.query(`
              SELECT DISTINCT org.OrgName AS organization, c.CategoriesName AS category, cc.Contact AS contact 
              FROM QuestionsAnswers qa 
              LEFT JOIN Officers o ON qa.OfficerID = o.OfficerID 
              LEFT JOIN Organizations org ON o.OrgID = org.OrgID 
              LEFT JOIN Categories c ON qa.CategoriesID = c.CategoriesID 
              LEFT JOIN Categories_Contact cc ON (c.CategoriesID = cc.CategoriesID OR c.ParentCategoriesID = cc.CategoriesID) 
              WHERE qa.QuestionsAnswersID IN (?) AND ((cc.Contact IS NOT NULL AND TRIM(cc.Contact) <> '') OR (c.CategoriesID IS NULL)) 
              ORDER BY org.OrgID ASC, c.CategoriesName ASC`, [qaIds]);
            
            specificContacts = (rows || []).map(row => ({ organization: row.organization, category: row.category || null, contact: row.contact || null }));
          }
        } catch (e) { specificContacts = []; }
    }

    const msgText = topRanked.length > 1 
      ? `✨ พบ ${finalResults.length} คำถามที่ใกล้เคียง\n(ลองเลือกซักอันดูสิ 😊)`
      : `✨ นี่คือคำตอบที่คุณหา`;

    // 🆕 Check if the top result was matched by keyword or by text/title only
    const topResult = topRanked[0];
    const keywordMatch = topResult && topResult.components && topResult.components.overlapCount > 0;

    // ถ้าปรับปรุงด้วย AI แล้วแสดง message มาจาก AI
    let finalMessage = msgText;
    if (enhancedAlternatives[0]?.enhanced) {
        finalMessage = enhancedAlternatives[0].text;
    }

    return res.status(200).json({
      success: true,
      found: topRanked.length > 0,
      keywordMatch: keywordMatch, // 🆕 true if matched by keyword, false if only by text/title
      title: topRanked.length > 0 ? topRanked[0].item.QuestionTitle : null, // 🆕 Add question title
      totalMatches: finalResults.length, // ✅ เพิ่ม totalMatches ส่งกลับไปเพื่อให้ Frontend ทำปุ่ม Read more
      limit: limit,
      offset: offset,
      multipleResults: topRanked.length > 1,
      query: message,
      message: finalMessage,
      contacts: specificContacts,
      alternatives: enhancedAlternatives
    });
  } catch (err) {
    console.error('API Error:', err);
    res.status(500).json({ success: false, message: 'เกิดข้อผิดพลาด', detail: err.message });
  }
};