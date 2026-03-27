/**
 * Service to get all QuestionsAnswers for the logged-in officer.
 * @param {object} pool - MySQL connection pool
 * @returns {function} - Express middleware (req, res)
 */
const getQuestionsAnswersService = (pool) => async (req, res) => {
    try {
        const officerId = (req.user?.userId ?? req.user?.officerId);
        const userRole = req.user?.role;
        
        // Allow admins to see all questions, officers only see their own
        const isAdmin = userRole === 'Super Admin' || userRole === 'Admin';
        const targetOfficerId = isAdmin ? null : officerId;
        
        if (!isAdmin && !officerId) {
            return res.status(401).json({ success: false, message: 'Unauthorized: Could not identify the user from the token.' });
        }

        // Get QuestionsAnswers (always order by QuestionsAnswersID DESC)
        let query, params;
        if (isAdmin) {
            // Admin sees all questions
            query = `SELECT qa.QuestionsAnswersID, qa.QuestionTitle, qa.ReviewDate, qa.QuestionText, qa.OfficerID,
                    qa.CategoriesID, c.CategoriesName
                 FROM QuestionsAnswers qa
                 LEFT JOIN Categories c ON qa.CategoriesID = c.CategoriesID
                 ORDER BY qa.QuestionsAnswersID DESC`;
            params = [];
        } else {
            // Officer sees only their questions
            query = `SELECT qa.QuestionsAnswersID, qa.QuestionTitle, qa.ReviewDate, qa.QuestionText, qa.OfficerID,
                    qa.CategoriesID, c.CategoriesName
                 FROM QuestionsAnswers qa
                 LEFT JOIN Categories c ON qa.CategoriesID = c.CategoriesID
                 WHERE qa.OfficerID = ?
                 ORDER BY qa.QuestionsAnswersID DESC`;
            params = [targetOfficerId];
        }
        const [rows] = await pool.query(query, params);
        
        if (!rows || rows.length === 0) {
            return res.status(200).json([]);
        }

        // Get all question IDs
        const questionIds = rows.map(r => r.QuestionsAnswersID);

        // BATCH OPTIMIZATION: Fetch all keywords in one query instead of N queries
        const [allKeywords] = await pool.query(
            `SELECT ak.QuestionsAnswersID, k.KeywordID, k.KeywordText 
             FROM Keywords k
             INNER JOIN AnswersKeywords ak ON k.KeywordID = ak.KeywordID
             WHERE ak.QuestionsAnswersID IN (${questionIds.map(() => '?').join(',')})`,
            questionIds
        );

        // Group keywords by QuestionsAnswersID
        const keywordMap = new Map();
        (allKeywords || []).forEach(kw => {
            if (!keywordMap.has(kw.QuestionsAnswersID)) {
                keywordMap.set(kw.QuestionsAnswersID, []);
            }
            keywordMap.get(kw.QuestionsAnswersID).push({
                KeywordID: kw.KeywordID,
                KeywordText: kw.KeywordText
            });
        });

        // BATCH OPTIMIZATION: Fetch all feedback counts in one query instead of N queries
        const [allFeedbackCounts] = await pool.query(
            `SELECT 
                c.QuestionsAnswersID,
                SUM(CASE WHEN f.FeedbackValue = 1 THEN 1 ELSE 0 END) as likeCount,
                SUM(CASE WHEN f.FeedbackValue = 0 AND f.HandledAt IS NULL THEN 1 ELSE 0 END) as unlikeCount,
                SUM(CASE WHEN f.FeedbackValue = 2 THEN 1 ELSE 0 END) as pendingCount
             FROM ChatLogHasAnswers c
             LEFT JOIN Feedbacks f ON f.ChatLogID = c.ChatLogID
             WHERE c.QuestionsAnswersID IN (${questionIds.map(() => '?').join(',')})
             GROUP BY c.QuestionsAnswersID`,
            questionIds
        );

        // Group feedback counts by QuestionsAnswersID
        const feedbackMap = new Map();
        (allFeedbackCounts || []).forEach(fb => {
            feedbackMap.set(fb.QuestionsAnswersID, {
                likeCount: fb.likeCount || 0,
                unlikeCount: fb.unlikeCount || 0,
                pendingCount: fb.pendingCount || 0
            });
        });

        // Merge keywords and feedback counts into questions
        const questionsWithKeywords = rows.map(question => ({
            ...question,
            keywords: keywordMap.get(question.QuestionsAnswersID) || [],
            likeCount: feedbackMap.get(question.QuestionsAnswersID)?.likeCount || 0,
            unlikeCount: feedbackMap.get(question.QuestionsAnswersID)?.unlikeCount || 0,
            pendingCount: feedbackMap.get(question.QuestionsAnswersID)?.pendingCount || 0
        }));

        res.status(200).json(questionsWithKeywords);
    } catch (error) {
        console.error('❌ Error fetching QuestionsAnswers:', error && (error.message || error));
        res.status(500).json({ 
            success: false, 
            message: 'Internal Server Error', 
            error: error.message,
            sqlMessage: error.sqlMessage 
        });
    }
};

module.exports = getQuestionsAnswersService;
