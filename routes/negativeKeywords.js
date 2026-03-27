const express = require('express');
const router = express.Router();
// นำเข้า Service ที่เราเตรียมไว้ (path ให้ตรงกับโครงสร้างโฟลเดอร์)
const negativeService = require('../services/managenegativekeywords');
// Loader service (for reloading cache after seeding)
const negativeLoader = require('../services/negativeKeywords/loadNegativeKeywords');

// Middleware: ตรวจสอบ Database Pool
router.use((req, res, next) => {
  // Resolve pool from request, app.locals, or global
  const poolFromApp = req.app && req.app.locals && req.app.locals.pool;
  if (!req.pool && !poolFromApp && !global.__DB_POOL__ && !global.pool) {
    console.error('🔴 DB pool not found (req.pool, app.locals.pool, global.__DB_POOL__, global.pool)');
    return res.status(500).json({ ok: false, message: 'Database connection failed' });
  }
  req.pool = req.pool || poolFromApp || global.__DB_POOL__ || global.pool;
  next();
});

/**
 * GET /
 * ดึงข้อมูลพร้อม Pagination, Search, Filter และ Stats
 */
router.get('/', async (req, res) => {
  try {
    console.log('🔍 GET /negativekeywords called; auth=', !!req.user, 'pool=', !!req.pool);

    if (!req.pool) {
      console.error('❌ req.pool not available');
      return res.status(500).json({ ok: false, message: 'Database connection not available' });
    }

    const page = parseInt(req.query.page) || 1;
    const limit = parseInt(req.query.limit) || 50;
    const offset = (page - 1) * limit;
    const search = req.query.search ? req.query.search.trim() : '';
    const activeFilter = req.query.active; // 1, 0, or undefined

    // 1. สร้างเงื่อนไข WHERE
    let whereClauses = [];
    let params = [];

    if (search) {
      whereClauses.push('Word LIKE ?');
      params.push(`%${search}%`);
    }

    if (activeFilter !== undefined && activeFilter !== 'undefined') {
      whereClauses.push('IsActive = ?');
      params.push(parseInt(activeFilter));
    }

    const whereSql = whereClauses.length > 0 ? 'WHERE ' + whereClauses.join(' AND ') : '';

    // 2. Query ข้อมูลหลัก (without SQL_CALC_FOUND_ROWS for better compatibility)
    const sql = `
      SELECT * FROM NegativeKeywords 
      ${whereSql} 
      ORDER BY NegativeKeywordID DESC 
      LIMIT ? OFFSET ?
    `;
    
    const [rows] = await req.pool.query(sql, [...params, limit, offset]);

    // 3. หา count ทั้งหมดสำหรับ pagination
    const countParams = params.slice(0, params.length); // ใช้ params เดียวกัน (ไม่มี LIMIT/OFFSET)
    const countSql = `SELECT COUNT(*) as total FROM NegativeKeywords ${whereSql}`;
    const [countResult] = await req.pool.query(countSql, countParams);
    const total = countResult[0]?.total || 0;

    // 4. คำนวณ Stats (นับรวมทั้งหมด ไม่สนใจ Filter)
    const [statsRows] = await req.pool.query(`
      SELECT 
        COUNT(*) as total,
        SUM(CASE WHEN IsActive = 1 THEN 1 ELSE 0 END) as active,
        SUM(CASE WHEN WeightModifier = -1.0 THEN 1 ELSE 0 END) as negativeModifier,
        SUM(CASE WHEN WeightModifier = 0.0 THEN 1 ELSE 0 END) as zeroModifier
      FROM NegativeKeywords
    `);
    const stats = statsRows[0];

    res.json({
      ok: true,
      data: rows,
      pagination: {
        page,
        limit,
        total,
        totalPages: Math.ceil(total / limit)
      },
      stats: {
        total: stats.total || 0,
        active: stats.active || 0,
        negativeModifier: stats.negativeModifier || 0,
        zeroModifier: stats.zeroModifier || 0
      }
    });

  } catch (error) {
    console.error('❌ Error fetching keywords:', error && (error.stack || error));
    res.status(500).json({ ok: false, message: 'เกิดข้อผิดพลาด: ' + (error && error.message ? error.message : String(error)) });
  }
});

/**
 * POST /
 * เพิ่มคำปฏิเสธ (ทีละคำ)
 */
router.post('/', async (req, res) => {
  let conn;
  try {
    const { word, weightModifier, description } = req.body;
    
    if (!word) return res.status(400).json({ ok: false, message: 'กรุณาระบุคำปฏิเสธ' });

    conn = await req.pool.getConnection();
    
    const [result] = await conn.query(
      `INSERT INTO NegativeKeywords (Word, WeightModifier, Description, IsActive) 
       VALUES (?, ?, ?, 1)
       ON DUPLICATE KEY UPDATE IsActive = 1, WeightModifier = VALUES(WeightModifier), Description = VALUES(Description)`,
      [word.trim(), parseFloat(weightModifier) || -1.0, description || '']
    );

    res.json({ 
      ok: true, 
      message: `เพิ่มคำว่า "${word}" เรียบร้อยแล้ว`,
      id: result.insertId
    });

  } catch (error) {
    console.error('Error adding keyword:', error);
    res.status(500).json({ ok: false, message: 'บันทึกไม่สำเร็จ: ' + (error && error.message) });
  } finally {
    if (conn) conn.release();
  }
});

/**
 * POST /bulk
 * เพิ่มคำปฏิเสธ (หลายคำคั่นด้วย comma)
 */
router.post('/bulk', async (req, res) => {
  let conn;
  try {
    const { words, weightModifier } = req.body;
    if (!words) return res.status(400).json({ ok: false, message: 'กรุณาระบุคำ' });

    const wordList = words.split(',').map(w => w.trim()).filter(w => w);
    if (wordList.length === 0) return res.status(400).json({ ok: false, message: 'ไม่พบคำที่ถูกต้อง' });

    conn = await req.pool.getConnection();
    
    let successCount = 0;
    for (const w of wordList) {
      await conn.query(
        `INSERT INTO NegativeKeywords (Word, WeightModifier, IsActive) 
         VALUES (?, ?, 1)
         ON DUPLICATE KEY UPDATE IsActive = 1`,
        [w, parseFloat(weightModifier) || -1.0]
      );
      successCount++;
    }

    res.json({ ok: true, message: `เพิ่มสำเร็จ ${successCount} คำ` });

  } catch (error) {
    console.error('Error bulk adding:', error);
    res.status(500).json({ ok: false, message: error && error.message });
  } finally {
    if (conn) conn.release();
  }
});

/**
 * PUT /:id
 * แก้ไขข้อมูล
 */
router.put('/:id', async (req, res) => {
  let conn;
  try {
    const id = req.params.id;
    const { word, weightModifier, description } = req.body;

    conn = await req.pool.getConnection();
    await conn.query(
      'UPDATE NegativeKeywords SET Word = ?, WeightModifier = ?, Description = ? WHERE NegativeKeywordID = ?',
      [word.trim(), weightModifier, description, id]
    );

    res.json({ ok: true, message: 'บันทึกการแก้ไขแล้ว' });

  } catch (error) {
    console.error('Error updating:', error);
    res.status(500).json({ ok: false, message: error && error.message });
  } finally {
    if (conn) conn.release();
  }
});

/**
 * POST /toggle/:id
 * เปลี่ยนสถานะ Active/Inactive
 */
router.post('/toggle/:id', async (req, res) => {
  let conn;
  try {
    const id = req.params.id;
    conn = await req.pool.getConnection();
    
    const [rows] = await conn.query('SELECT IsActive FROM NegativeKeywords WHERE NegativeKeywordID = ?', [id]);
    if (rows.length === 0) return res.status(404).json({ ok: false, message: 'ไม่พบข้อมูล' });

    const newStatus = rows[0].IsActive ? 0 : 1;
    await conn.query('UPDATE NegativeKeywords SET IsActive = ? WHERE NegativeKeywordID = ?', [newStatus, id]);

    res.json({ 
      ok: true, 
      message: newStatus ? 'เปิดใช้งานแล้ว' : 'ปิดใช้งานแล้ว',
      data: { isActive: newStatus }
    });

  } catch (error) {
    console.error('Error toggling:', error);
    res.status(500).json({ ok: false, message: error && error.message });
  } finally {
    if (conn) conn.release();
  }
});

/**
 * DELETE /:id
 * ลบคำปฏิเสธ (Safe Delete)
 */
router.delete('/:id', async (req, res) => {
  try {
    const id = parseInt(req.params.id);
    
    const result = await negativeService.deleteNegativeKeywordSafe(req.pool, id);

    if (result.ok) {
      res.json({ 
        ok: true, 
        message: `ลบคำว่า "${result.word || 'คำนี้'}" เรียบร้อยแล้ว (Added to ignore list)` 
      });
    } else {
      res.status(400).json({ ok: false, message: result.message || 'ไม่สามารถลบได้' });
    }

  } catch (error) {
    console.error('Error deleting:', error);
    res.status(500).json({ ok: false, message: 'เกิดข้อผิดพลาด: ' + (error && error.message) });
  }
});

// Standard negative keywords list (shared between preview and seed)
const STANDARD_NEGATIVE_KEYWORDS = [
  { word: 'ไม่', modifier: -1.0 },
  { word: 'ไม่ได้', modifier: -1.0 },
  { word: 'มิได้', modifier: -1.0 },
  { word: 'หาไม่', modifier: -1.0 },
  { word: 'หามิได้', modifier: -1.0 },
  { word: 'เปล่า', modifier: -1.0 },
  { word: 'อย่า', modifier: -1.0 },
  { word: 'ไม่ใช่', modifier: -1.0 },
  { word: 'มิใช่', modifier: -1.0 },
  { word: 'ไม่มี', modifier: -1.0 },
  { word: 'บ่', modifier: -1.0 },
  { word: 'ไม่เอา', modifier: -1.0 },
  { word: 'ไม่ต้อง', modifier: -1.0 },
  { word: 'ไม่อยาก', modifier: -1.0 },
  { word: 'ไม่ต้องการ', modifier: -1.0 },
  { word: 'ไม่สนใจ', modifier: -1.0 },
  { word: 'ไม่ชอบ', modifier: -1.0 },
  { word: 'ไม่รับ', modifier: -1.0 },
  { word: 'ยกเว้น', modifier: -1.0 },
  { word: 'ปราศจาก', modifier: -1.0 },
  { word: 'ไร้', modifier: -1.0 },
  { word: 'ห้าม', modifier: -1.0 },
  { word: 'งด', modifier: -1.0 },
  { word: 'เลิก', modifier: -1.0 },
  { word: 'หยุด', modifier: -1.0 },
  { word: 'ปฏิเสธ', modifier: -1.0 },
  { word: 'ขาด', modifier: -0.5 },
  { word: 'แต่', modifier: -0.5 },
  { word: 'ทว่า', modifier: -0.5 },
  { word: 'แม้', modifier: -0.5 },
  { word: 'ถึงแม้', modifier: -0.5 },
  { word: 'นอกจาก', modifier: -1.0 },
  { word: 'เว้นแต่', modifier: -1.0 },
];

/**
 * GET /seed/preview
 * ดูตัวอย่างคำที่จะถูกเพิ่มเมื่อกด seed (แสดงเฉพาะคำที่ยังไม่มีในระบบ)
 */
router.get('/seed/preview', async (req, res) => {
  let conn;
  try {
    conn = await req.pool.getConnection();

    // Get existing words
    const [existingRows] = await conn.query('SELECT Word FROM NegativeKeywords');
    const existingWords = new Set(existingRows.map(r => r.Word.toLowerCase()));

    // Get ignored words (all deleted words, not just standard ones)
    const [ignoredRows] = await conn.query('SELECT Word FROM NegativeKeywords_Ignored');
    const ignoredWordsSet = new Set(ignoredRows.map(r => r.Word.toLowerCase()));
    
    // All ignored words as array for display (not just standard ones)
    const allIgnoredWords = ignoredRows.map(r => ({ word: r.Word }));

    // Filter out existing and ignored words for toAdd (only standard keywords)
    const wordsToAdd = STANDARD_NEGATIVE_KEYWORDS.filter(item => 
      !existingWords.has(item.word.toLowerCase()) && 
      !ignoredWordsSet.has(item.word.toLowerCase())
    );

    const alreadyExists = STANDARD_NEGATIVE_KEYWORDS.filter(item =>
      existingWords.has(item.word.toLowerCase())
    );

    // Show only standard keywords that were deleted (for consistency with seed purpose)
    const ignored = STANDARD_NEGATIVE_KEYWORDS.filter(item =>
      ignoredWordsSet.has(item.word.toLowerCase())
    );

    res.json({
      ok: true,
      data: {
        toAdd: wordsToAdd,
        alreadyExists: alreadyExists,
        ignored: allIgnoredWords,  // Show ALL deleted words, not just standard ones
        totalStandard: STANDARD_NEGATIVE_KEYWORDS.length
      }
    });

  } catch (error) {
    console.error('Error getting seed preview:', error);
    res.status(500).json({ ok: false, message: error && error.message });
  } finally {
    if (conn) conn.release();
  }
});

/**
 * POST /seed
 * เติมคำมาตรฐานเข้า DB หากยังไม่มี และไม่อยู่ในตาราง Ignored
 */
router.post('/seed', async (req, res) => {
  let conn;
  try {
    conn = await req.pool.getConnection();

    // Get existing + ignored words for fast checks (case-insensitive)
    const [existingRows] = await conn.query('SELECT Word, IsActive FROM NegativeKeywords');
    const existingMap = new Map(
      (Array.isArray(existingRows) ? existingRows : []).map(r => [String(r.Word || '').toLowerCase(), Number(r.IsActive) || 0])
    );

    const [ignoredRows] = await conn.query('SELECT Word FROM NegativeKeywords_Ignored');
    const ignoredSet = new Set(
      (Array.isArray(ignoredRows) ? ignoredRows : []).map(r => String(r.Word || '').toLowerCase())
    );

    await conn.beginTransaction();

    let addedCount = 0;
    for (const item of STANDARD_NEGATIVE_KEYWORDS) {
      const word = String(item.word || '').trim();
      if (!word) continue;
      const key = word.toLowerCase();

      if (ignoredSet.has(key)) continue;
      if (existingMap.has(key)) {
        // If exists but inactive, reactivate it (do not override modifier)
        if ((existingMap.get(key) || 0) === 0) {
          await conn.query(
            'UPDATE NegativeKeywords SET IsActive = 1 WHERE LOWER(Word) = LOWER(?)',
            [word]
          );
          existingMap.set(key, 1);
        }
        continue;
      }

      await conn.query(
        'INSERT INTO NegativeKeywords (Word, WeightModifier, IsActive) VALUES (?, ?, 1)',
        [word, Number(item.modifier)]
      );
      existingMap.set(key, 1);
      addedCount++;
    }

    await conn.commit();

    // Reload in-memory cache
    try {
      await negativeLoader.loadNegativeKeywords(req.pool);
    } catch (e) {
      console.warn('⚠️ Reloading negative keywords cache after seed failed:', e && e.message);
    }

    res.json({ 
      ok: true, 
      message: `ตรวจสอบและเติมคำมาตรฐานสำเร็จ (เพิ่มใหม่ ${addedCount} คำ)`,
      addedCount
    });

  } catch (error) {
    if (conn) {
      try { await conn.rollback(); } catch (e) {}
    }
    console.error('Error seeding:', error && (error.stack || error));
    res.status(500).json({ ok: false, message: error && error.message ? error.message : String(error) });
  } finally {
    if (conn) conn.release();
  }
});

/**
 * GET /deleted
 * ดึงรายการคำที่ถูกลบไปแล้ว (Recently Deleted - Apple Style)
 */
router.get('/deleted', async (req, res) => {
  let conn;
  try {
    conn = await req.pool.getConnection();
    
    const [rows] = await conn.query(`
      SELECT 
        Id,
        Word,
        DeletedAt,
        DATEDIFF(DATE_ADD(DeletedAt, INTERVAL 30 DAY), NOW()) as daysRemaining
      FROM NegativeKeywords_Ignored 
      ORDER BY DeletedAt DESC
    `);

    res.json({
      ok: true,
      data: rows,
      total: rows.length
    });

  } catch (error) {
    console.error('Error getting deleted keywords:', error);
    res.status(500).json({ ok: false, message: error && error.message });
  } finally {
    if (conn) conn.release();
  }
});

/**
 * POST /restore/:id
 * กู้คืนคำที่ถูกลบ (Restore from Recently Deleted)
 */
router.post('/restore/:id', async (req, res) => {
  let conn;
  try {
    const { id } = req.params;
    conn = await req.pool.getConnection();
    
    // Get the word from ignored table
    const [rows] = await conn.query(
      'SELECT Word FROM NegativeKeywords_Ignored WHERE Id = ?',
      [id]
    );
    
    if (rows.length === 0) {
      return res.status(404).json({ ok: false, message: 'ไม่พบคำที่ต้องการกู้คืน' });
    }
    
    const word = rows[0].Word;
    
    await conn.beginTransaction();
    
    // Check if word already exists in NegativeKeywords
    const [existing] = await conn.query(
      'SELECT NegativeKeywordID FROM NegativeKeywords WHERE LOWER(Word) = LOWER(?)',
      [word]
    );
    
    if (existing.length > 0) {
      // Re-activate the existing word
      await conn.query(
        'UPDATE NegativeKeywords SET IsActive = 1 WHERE LOWER(Word) = LOWER(?)',
        [word]
      );
    } else {
      // Insert as new word
      await conn.query(
        'INSERT INTO NegativeKeywords (Word, WeightModifier, IsActive) VALUES (?, -1.0, 1)',
        [word]
      );
    }
    
    // Remove from ignored table
    await conn.query('DELETE FROM NegativeKeywords_Ignored WHERE Id = ?', [id]);
    
    await conn.commit();
    
    // Reload cache
    try {
      await negativeLoader.loadNegativeKeywords(req.pool);
    } catch (e) {
      console.warn('Cache reload failed:', e && e.message);
    }
    
    res.json({
      ok: true,
      message: `กู้คืนคำว่า "${word}" สำเร็จ`,
      word: word
    });

  } catch (error) {
    if (conn) await conn.rollback();
    console.error('Error restoring keyword:', error);
    res.status(500).json({ ok: false, message: error && error.message });
  } finally {
    if (conn) conn.release();
  }
});

/**
 * POST /restore-all
 * กู้คืนคำทั้งหมดที่ถูกลบ
 */
router.post('/restore-all', async (req, res) => {
  let conn;
  try {
    conn = await req.pool.getConnection();
    
    // Get all ignored words
    const [rows] = await conn.query('SELECT Id, Word FROM NegativeKeywords_Ignored');
    
    if (rows.length === 0) {
      return res.json({ ok: true, message: 'ไม่มีคำที่ต้องกู้คืน', restoredCount: 0 });
    }
    
    await conn.beginTransaction();
    
    let restoredCount = 0;
    for (const row of rows) {
      const [existing] = await conn.query(
        'SELECT NegativeKeywordID FROM NegativeKeywords WHERE LOWER(Word) = LOWER(?)',
        [row.Word]
      );
      
      if (existing.length > 0) {
        await conn.query(
          'UPDATE NegativeKeywords SET IsActive = 1 WHERE LOWER(Word) = LOWER(?)',
          [row.Word]
        );
      } else {
        await conn.query(
          'INSERT INTO NegativeKeywords (Word, WeightModifier, IsActive) VALUES (?, -1.0, 1)',
          [row.Word]
        );
      }
      restoredCount++;
    }
    
    // Clear ignored table
    await conn.query('DELETE FROM NegativeKeywords_Ignored');
    
    await conn.commit();
    
    // Reload cache
    try {
      await negativeLoader.loadNegativeKeywords(req.pool);
    } catch (e) {
      console.warn('Cache reload failed:', e && e.message);
    }
    
    res.json({
      ok: true,
      message: `กู้คืนทั้งหมด ${restoredCount} คำสำเร็จ`,
      restoredCount
    });

  } catch (error) {
    if (conn) await conn.rollback();
    console.error('Error restoring all keywords:', error);
    res.status(500).json({ ok: false, message: error && error.message });
  } finally {
    if (conn) conn.release();
  }
});

/**
 * DELETE /deleted/:id
 * ลบถาวร (Permanently delete from Recently Deleted)
 */
router.delete('/deleted/:id', async (req, res) => {
  let conn;
  try {
    const { id } = req.params;
    conn = await req.pool.getConnection();
    
    const [rows] = await conn.query(
      'SELECT Word FROM NegativeKeywords_Ignored WHERE Id = ?',
      [id]
    );
    
    if (rows.length === 0) {
      return res.status(404).json({ ok: false, message: 'ไม่พบคำที่ต้องการลบ' });
    }
    
    const word = rows[0].Word;
    
    await conn.query('DELETE FROM NegativeKeywords_Ignored WHERE Id = ?', [id]);
    
    res.json({
      ok: true,
      message: `ลบคำว่า "${word}" ถาวรแล้ว`,
      word: word
    });

  } catch (error) {
    console.error('Error permanently deleting keyword:', error);
    res.status(500).json({ ok: false, message: error && error.message });
  } finally {
    if (conn) conn.release();
  }
});

/**
 * DELETE /deleted-all
 * ลบถาวรทั้งหมด (Empty Recently Deleted)
 */
router.delete('/deleted-all', async (req, res) => {
  let conn;
  try {
    conn = await req.pool.getConnection();
    
    const [countResult] = await conn.query('SELECT COUNT(*) as total FROM NegativeKeywords_Ignored');
    const total = countResult[0].total;
    
    if (total === 0) {
      return res.json({ ok: true, message: 'ไม่มีคำที่ต้องลบ', deletedCount: 0 });
    }
    
    await conn.query('DELETE FROM NegativeKeywords_Ignored');
    
    res.json({
      ok: true,
      message: `ลบถาวรทั้งหมด ${total} คำแล้ว`,
      deletedCount: total
    });

  } catch (error) {
    console.error('Error emptying deleted keywords:', error);
    res.status(500).json({ ok: false, message: error && error.message });
  } finally {
    if (conn) conn.release();
  }
});

module.exports = router;

