// services/chat/logNoAnswer.js

module.exports = (pool) => async (req, res) => {
  const notifyChatLogsUpdate = req.app.locals.notifyChatLogsUpdate;
  const body = req.body || {};

  console.log('📝 logNoAnswer received:', {
    body: body,
    contentType: req.get('content-type')
  });

  const userQueryRaw = body.userQuery || body.UserQuery || '';
  const statusRaw = typeof body.status !== 'undefined' ? body.status : body.Status;
  const timestampInput = body.Timestamp || body.timestamp; // accept PascalCase

  const trimmedQuery = typeof userQueryRaw === 'string' ? userQueryRaw.trim() : '';
  const statusValue = typeof statusRaw === 'undefined' ? 'no-answer' : statusRaw;
  const parsedTimestamp = timestampInput ? new Date(timestampInput) : new Date();

  if (!trimmedQuery) {
    return res.status(400).json({
      success: false,
      message: 'ต้องระบุ userQuery'
    });
  }

  if (Number.isNaN(parsedTimestamp.getTime())) {
    return res.status(400).json({
      success: false,
      message: 'Timestamp ไม่อยู่ในรูปแบบที่ถูกต้อง'
    });
  }

  try {
    console.log('💾 Inserting to ChatLogNoAnswers:', {
      timestamp: parsedTimestamp,
      query: trimmedQuery,
      status: statusValue
    });

    const [result] = await pool.query(
      `INSERT INTO ChatLogNoAnswers (Timestamp, UserQuery, Status)
       VALUES (?, ?, ?)`,
      [parsedTimestamp, trimmedQuery, statusValue]
    );

    if (notifyChatLogsUpdate) {
      notifyChatLogsUpdate({
        action: 'created',
        type: 'no-answer',
        chatLogId: result.insertId,
        userQuery: trimmedQuery,
        status: statusValue,
        timestamp: parsedTimestamp.toISOString()
      });
    }

    return res.status(201).json({
      success: true,
      chatLogId: result.insertId
    });
  } catch (error) {
    console.error('chat/logs/no-answer error:', error && error.message, error && error.sql);

    // Handle the case where ChatLogID is not auto-increment and insert fails due missing default
    if (error && /ChatLogID/.test(error.message) && /default/i.test(error.message)) {
      try {
        const [[{ maxId }]] = await pool.query('SELECT MAX(ChatLogID) AS maxId FROM ChatLogNoAnswers');
        const nextId = (Number(maxId) || 0) + 1;
        const [fallbackResult] = await pool.query(
          `INSERT INTO ChatLogNoAnswers (ChatLogID, Timestamp, UserQuery, Status)
           VALUES (?, ?, ?, ?)`,
          [nextId, parsedTimestamp, trimmedQuery, statusValue]
        );

        if (notifyChatLogsUpdate) {
          notifyChatLogsUpdate({
            action: 'created',
            type: 'no-answer',
            chatLogId: nextId,
            userQuery: trimmedQuery,
            status: statusValue,
            timestamp: parsedTimestamp.toISOString()
          });
        }

        return res.status(201).json({
          success: true,
          chatLogId: nextId
        });
      } catch (fallbackError) {
        console.error('chat/logs/no-answer fallback error:', fallbackError && fallbackError.message);
      }
    }

    // Keep UX smooth: don't propagate a hard error into the user-facing chatbot
    return res.status(200).json({
      success: true,
      logged: false,
      message: 'Log skipped: ' + (error && error.message)
    });
  }
};
