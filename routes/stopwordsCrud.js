/**
 * API endpoints for managing Stopwords
 * CRUD operations for stopwords management
 */

const express = require('express');
const router = express.Router();
const { clearStopwordsCache } = require('../services/stopwords/loadStopwords');
// นำเข้า standard stopwords จาก sync script (pythainlp-based)
const { STANDARD_THAI_STOPWORDS } = require('../scripts/sync_stopwords_from_standard');

// Middleware: ตรวจสอบ Database Pool
router.use((req, res, next) => {
  const poolFromApp = req.app && req.app.locals && req.app.locals.pool;
  if (!req.pool && !poolFromApp && !global.__DB_POOL__ && !global.pool) {
    console.error('🔴 DB pool not found (req.pool, app.locals.pool, global.__DB_POOL__, global.pool)');
    return res.status(500).json({ ok: false, message: 'Database connection failed' });
  }
  req.pool = req.pool || poolFromApp || global.__DB_POOL__ || global.pool;
  next();
});

// ใช้ req.pool จาก middleware แทน createPool()

/**
 * GET /stopwords
 * Get all stopwords
 */
router.get('/', async (req, res) => {
  try {
    const [stopwords] = await req.pool.query(
      `SELECT 
        ROW_NUMBER() OVER (ORDER BY StopwordID ASC) as RowNum,
        StopwordID, StopwordText, CreatedAt, UpdatedAt 
      FROM Stopwords 
      ORDER BY StopwordID DESC`
    );

    res.json(stopwords);
  } catch (error) {
    console.error('Error fetching stopwords:', error);
    res.status(500).json({ error: error.message });
  }
});

/**
 * POST /stopwords
 * Add a new stopword
 * Body: { text: 'คำ' }
 */
router.post('/', async (req, res) => {
  const { text } = req.body;

  if (!text || typeof text !== 'string') {
    return res.status(400).json({ error: 'Missing or invalid text' });
  }

  const cleanText = text.trim().toLowerCase();
  
  if (!cleanText) {
    return res.status(400).json({ error: 'Stopword text cannot be empty' });
  }

  try {
    // Check if already exists
    const [existing] = await req.pool.query(
      'SELECT StopwordID FROM Stopwords WHERE StopwordText = ?',
      [cleanText]
    );

    if (existing.length > 0) {
      return res.status(409).json({ 
        error: 'Stopword already exists', 
        existingId: existing[0].StopwordID 
      });
    }

    // Insert new stopword
    const [result] = await req.pool.query(
      'INSERT INTO Stopwords (StopwordText) VALUES (?)',
      [cleanText]
    );

    res.status(201).json({
      message: 'Stopword added successfully',
      id: result.insertId,
      text: cleanText
    });
  } catch (error) {
    console.error('Error adding stopword:', error);
    
    // Handle duplicate entry error
    if (error.code === 'ER_DUP_ENTRY') {
      return res.status(409).json({ error: 'Stopword already exists' });
    }
    
    res.status(500).json({ error: error.message });
  }
});

/**
 * GET /stopwords/seed/preview
 * ดูตัวอย่างคำที่จะถูกเพิ่มเมื่อกด seed (แสดงเฉพาะคำที่ยังไม่มีในระบบ)
 */
router.get('/seed/preview', async (req, res) => {
  try {
    // Get existing stopwords
    const [existingRows] = await req.pool.query('SELECT StopwordText FROM Stopwords');
    const existingWords = new Set(existingRows.map(r => (r.StopwordText || '').trim().toLowerCase()));

    // Filter out existing words (ใช้ STANDARD_THAI_STOPWORDS จาก pythainlp)
    const wordsToAdd = STANDARD_THAI_STOPWORDS.filter(word => 
      !existingWords.has(word.trim().toLowerCase())
    );

    const alreadyExists = STANDARD_THAI_STOPWORDS.filter(word =>
      existingWords.has(word.trim().toLowerCase())
    );

    // Diagnostic info
    console.log(`📊 Seed Preview Stats:`);
    console.log(`  - Standard stopwords total: ${STANDARD_THAI_STOPWORDS.length}`);
    console.log(`  - Already in DB: ${alreadyExists.length}`);
    console.log(`  - Ready to add: ${wordsToAdd.length}`);
    console.log(`  - Total in DB: ${existingRows.length}`);

    res.json({
      ok: true,
      data: {
        toAdd: wordsToAdd,
        alreadyExists: alreadyExists,
        totalStandard: STANDARD_THAI_STOPWORDS.length,
        totalInDatabase: existingRows.length,
        // Diagnostic info
        diagnostics: {
          pythainlpStopwordsCount: STANDARD_THAI_STOPWORDS.length,
          databaseStopwordsCount: existingRows.length,
          newWordsToAdd: wordsToAdd.length,
          pythainlpLoaded: STANDARD_THAI_STOPWORDS.length > 0
        }
      }
    });

  } catch (error) {
    console.error('Error getting seed preview:', error);
    res.status(500).json({ ok: false, message: error && error.message });
  }
});

/**
 * POST /stopwords/seed
 * เติมคำ stopwords มาตรฐานจาก pythainlp อัตโนมัติ
 * คำที่มีอยู่แล้วจะถูกข้าม
 */
router.post('/seed', async (req, res) => {
  try {
    let addedCount = 0;
    let skippedCount = 0;

    // ใช้ STANDARD_THAI_STOPWORDS จาก pythainlp-based sync script
    for (const word of STANDARD_THAI_STOPWORDS) {
      const cleanText = word.trim().toLowerCase();
      if (!cleanText) continue;

      try {
        // Use INSERT IGNORE to skip existing words
        const [result] = await req.pool.query(
          'INSERT IGNORE INTO Stopwords (StopwordText) VALUES (?)',
          [cleanText]
        );

        if (result.affectedRows > 0) {
          addedCount++;
        } else {
          skippedCount++;
        }
      } catch (err) {
        if (err.code !== 'ER_DUP_ENTRY') {
          console.error(`Error adding stopword "${cleanText}":`, err.message);
        }
        skippedCount++;
      }
    }

    // Clear cache after adding
    clearStopwordsCache();

    res.json({
      ok: true,
      message: addedCount > 0 
        ? `เติมข้อมูลสำเร็จ! เพิ่ม stopwords ใหม่ ${addedCount} คำ` 
        : 'ข้อมูลเป็นปัจจุบันอยู่แล้ว ไม่มีคำใหม่ที่ต้องเพิ่ม',
      addedCount,
      skippedCount,
      totalStandard: STANDARD_THAI_STOPWORDS.length
    });
  } catch (error) {
    console.error('Error seeding stopwords:', error);
    res.status(500).json({ ok: false, message: error.message });
  }
});

/**
 * PUT /stopwords/:id
 * Update a stopword
 * Body: { text: 'คำใหม่' }
 */
router.put('/:id', async (req, res) => {
  const { id } = req.params;
  const { text } = req.body;

  if (!text || typeof text !== 'string') {
    return res.status(400).json({ error: 'Missing or invalid text' });
  }

  const cleanText = text.trim().toLowerCase();
  
  if (!cleanText) {
    return res.status(400).json({ error: 'Stopword text cannot be empty' });
  }

  try {
    // Check if stopword exists
    const [existing] = await req.pool.query(
      'SELECT StopwordID FROM Stopwords WHERE StopwordID = ?',
      [id]
    );

    if (existing.length === 0) {
      return res.status(404).json({ error: 'Stopword not found' });
    }

    // Check if new text already exists (different ID)
    const [duplicate] = await req.pool.query(
      'SELECT StopwordID FROM Stopwords WHERE StopwordText = ? AND StopwordID != ?',
      [cleanText, id]
    );

    if (duplicate.length > 0) {
      return res.status(409).json({ 
        error: 'Another stopword with this text already exists',
        existingId: duplicate[0].StopwordID 
      });
    }

    // Update stopword
    await req.pool.query(
      'UPDATE Stopwords SET StopwordText = ? WHERE StopwordID = ?',
      [cleanText, id]
    );

    res.json({
      message: 'Stopword updated successfully',
      id: parseInt(id),
      text: cleanText
    });
  } catch (error) {
    console.error('Error updating stopword:', error);
    
    if (error.code === 'ER_DUP_ENTRY') {
      return res.status(409).json({ error: 'Stopword already exists' });
    }
    
    res.status(500).json({ error: error.message });
  }
});

/**
 * DELETE /stopwords/:id
 * Delete a stopword
 */
router.delete('/:id', async (req, res) => {
  const { id } = req.params;

  try {
    // Check if stopword exists
    const [existing] = await req.pool.query(
      'SELECT StopwordID, StopwordText FROM Stopwords WHERE StopwordID = ?',
      [id]
    );

    if (existing.length === 0) {
      return res.status(404).json({ error: 'Stopword not found' });
    }

    const deletedText = existing[0].StopwordText;

    // Delete stopword
    await req.pool.query('DELETE FROM Stopwords WHERE StopwordID = ?', [id]);

    res.json({
      message: 'Stopword deleted successfully',
      id: parseInt(id),
      deletedText
    });
  } catch (error) {
    console.error('Error deleting stopword:', error);
    res.status(500).json({ error: error.message });
  }
});

/**
 * POST /stopwords/bulk
 * Add multiple stopwords at once
 * Body: { words: ['คำ1', 'คำ2', 'คำ3'] }
 */
router.post('/bulk', async (req, res) => {
  const { words } = req.body;

  if (!Array.isArray(words) || words.length === 0) {
    return res.status(400).json({ error: 'Missing or invalid words array' });
  }

  try {
    const results = {
      added: [],
      skipped: [],
      errors: []
    };

    for (const word of words) {
      if (!word || typeof word !== 'string') {
        results.errors.push({ word, error: 'Invalid word' });
        continue;
      }

      const cleanText = word.trim().toLowerCase();
      if (!cleanText) {
        results.skipped.push({ word, reason: 'Empty after trim' });
        continue;
      }

      try {
        await req.pool.query(
          'INSERT IGNORE INTO Stopwords (StopwordText) VALUES (?)',
          [cleanText]
        );
        results.added.push(cleanText);
      } catch (err) {
        if (err.code === 'ER_DUP_ENTRY') {
          results.skipped.push({ word: cleanText, reason: 'Already exists' });
        } else {
          results.errors.push({ word: cleanText, error: err.message });
        }
      }
    }

    res.json({
      message: 'Bulk operation completed',
      added: results.added.length,
      skipped: results.skipped.length,
      errors: results.errors.length,
      details: results
    });
  } catch (error) {
    console.error('Error in bulk add:', error);
    res.status(500).json({ error: error.message });
  }
});

/**
 * DELETE /stopwords/bulk
 * Delete multiple stopwords at once
 * Body: { ids: [1, 2, 3] }
 */
router.delete('/bulk', async (req, res) => {
  const { ids } = req.body;

  if (!Array.isArray(ids) || ids.length === 0) {
    return res.status(400).json({ error: 'Missing or invalid ids array' });
  }

  try {
    const placeholders = ids.map(() => '?').join(',');
    const [result] = await req.pool.query(
      `DELETE FROM Stopwords WHERE StopwordID IN (${placeholders})`,
      ids
    );

    res.json({
      message: 'Bulk delete completed',
      deletedCount: result.affectedRows
    });
  } catch (error) {
    console.error('Error in bulk delete:', error);
    res.status(500).json({ error: error.message });
  }
});

/**
 * POST /stopwords/refresh
 * Force clear stopwords cache so changes in DB take effect immediately
 */
router.post('/refresh', async (req, res) => {
  try {
    clearStopwordsCache();
    res.json({ message: 'Stopwords cache cleared' });
  } catch (error) {
    console.error('Error refreshing stopwords cache:', error);
    res.status(500).json({ error: error.message });
  }
});

module.exports = router;