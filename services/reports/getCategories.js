/**
 * Service to get all categories for the logged-in officer.
 * @param {object} pool - MySQL connection pool
 * @returns {function} - Express middleware (req, res)
 */
const getCategoriesService = (pool) => async (req, res) => {
    try {
        const officerId = req.user?.userId;
        if (!officerId) {
            return res.status(401).json({ success: false, message: 'Unauthorized: Could not identify the user from the token.' });
        }
        
        const usertype = req.user?.usertype;
        let rows;
        const order = req.query && String(req.query.order || '').toLowerCase() === 'asc' ? 'ASC' : 'DESC';
        
        if (usertype === 'Officer') {
            // Officer: show only their own categories and global categories
            [rows] = await pool.query(
                `SELECT c.CategoriesID, c.CategoriesName, c.OfficerID, c.ParentCategoriesID, c.CategoriesPDF,
                        (SELECT GROUP_CONCAT(Contact SEPARATOR ' ||| ') FROM Categories_Contact cc2 WHERE cc2.CategoriesID = c.CategoriesID) AS Contact
                 FROM Categories c
                 WHERE c.OfficerID = ? OR c.OfficerID IS NULL
                 ORDER BY c.CategoriesID ${order}`,
                [officerId]
            );
        } else {
            // Admin/Super Admin: show all categories in their organization
            // First, get the officer's OrgID from the Officers table
            const [adminOfficer] = await pool.query(
                `SELECT OrgID FROM Officers WHERE AdminUserID = ? LIMIT 1`,
                [officerId]
            );
            
            if (adminOfficer && adminOfficer.length > 0) {
                const orgId = adminOfficer[0].OrgID;
                
                // Get all categories for officers in this organization + global categories
                [rows] = await pool.query(
                    `SELECT DISTINCT c.CategoriesID, c.CategoriesName, c.OfficerID, c.ParentCategoriesID, c.CategoriesPDF,
                            (SELECT GROUP_CONCAT(Contact SEPARATOR ' ||| ') FROM Categories_Contact cc2 WHERE cc2.CategoriesID = c.CategoriesID) AS Contact
                     FROM Categories c
                     LEFT JOIN Officers o ON c.OfficerID = o.OfficerID
                     WHERE c.OfficerID IS NULL OR o.OrgID = ?
                     ORDER BY c.CategoriesID ${order}`,
                    [orgId]
                );
            } else {
                // Fallback: show all categories (for Super Admin without organization)
                [rows] = await pool.query(
                    `SELECT c.CategoriesID, c.CategoriesName, c.OfficerID, c.ParentCategoriesID, c.CategoriesPDF,
                            (SELECT GROUP_CONCAT(Contact SEPARATOR ' ||| ') FROM Categories_Contact cc2 WHERE cc2.CategoriesID = c.CategoriesID) AS Contact
                     FROM Categories c
                     ORDER BY c.CategoriesID ${order}`
                );
            }
        }

        console.log('[getCategories] fetched', Array.isArray(rows) ? rows.length : 0, 'rows for usertype=' + usertype);

        // Ensure Contact is populated by fetching grouped contacts and merging (fallback if subquery failed for any reason)
        try {
            const [contactsGrouped] = await pool.query(`SELECT CategoriesID, GROUP_CONCAT(Contact SEPARATOR ' ||| ') AS Contact FROM Categories_Contact GROUP BY CategoriesID`);
            const contactMap = new Map((contactsGrouped || []).map(r => [String(r.CategoriesID), String(r.Contact || '')]));
            // merge into rows
            if (Array.isArray(rows)) {
                rows = rows.map(r => {
                    const key = String(r.CategoriesID);
                    const fromMap = contactMap.has(key) ? contactMap.get(key) : (contactMap.has(key.replace(/\s+$/, '')) ? contactMap.get(key.replace(/\s+$/, '')) : '');
                    // Ensure Contact property exists (empty string if missing)
                    const contactVal = String(r.Contact || '') || fromMap || '';
                    return Object.assign({}, r, { Contact: contactVal });
                });
            }
        } catch (e) {
            console.warn('[getCategories] failed to merge grouped Contacts:', e && (e.message || e));
        }

        // Ensure Contact is always present as a property in the response objects
        if (Array.isArray(rows)) {
            rows = rows.map(r => ({
                CategoriesID: r.CategoriesID,
                CategoriesName: r.CategoriesName,
                OfficerID: r.OfficerID,
                ParentCategoriesID: r.ParentCategoriesID,
                CategoriesPDF: r.CategoriesPDF,
                Contact: String(r.Contact || '')
            }));
        }

        res.status(200).json({ success: true, categories: rows, count: Array.isArray(rows) ? rows.length : 0 });
    } catch (error) {
        console.error('❌ Error fetching categories:', error);
        res.status(500).json({ success: false, message: 'Internal Server Error' });
    }
};

module.exports = getCategoriesService;
