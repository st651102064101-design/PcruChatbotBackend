// services/login.js
// Requires: npm install jsonwebtoken
const jwt = require('jsonwebtoken');

const JWT_SECRET = process.env.JWT_SECRET;

if (!JWT_SECRET) {
    console.error('ERROR: JWT_SECRET environment variable is not defined.');
    process.exit(1);
}

const loginService = (pool, transporter) => async (req, res) => {
    
    const { id, password } = req.body;
    
    console.log(`Login attempt: ID=${id}`); 
    
    try {
        // Direct query without getConnection() - Vercel compatible
        // Look for user in AdminUsers table
        const [adminResults] = await pool.query(
            'SELECT AdminUserID, AdminName, AdminEmail, AdminPassword, ParentAdminID FROM AdminUsers WHERE AdminUserID = ? AND AdminPassword = ? LIMIT 1',
            [id, password]
        );

        if (adminResults && adminResults.length > 0) {
            const user = adminResults[0];
            const userId = user.AdminUserID;
            let usertype = 'Admin';
            if (user.ParentAdminID && Number(user.ParentAdminID) === Number(user.AdminUserID)) {
                usertype = 'Super Admin';
            }
            
            console.log(`✅ Login Successful (Admin): ${user.AdminName}`);
            
            const token = jwt.sign(
                { userId: userId, role: usertype },
                JWT_SECRET,
                { expiresIn: process.env.JWT_EXPIRES_IN }
            );
            
            return res.status(200).json({
                success: true,
                message: 'Login Successful',
                token: token,
                userInfo: user,
                usertype: usertype,
                role: usertype
            });
        }

        // Look for user in Officers table
        const [officerResults] = await pool.query(
            'SELECT OfficerID, OfficerName, Email AS OfficerEmail, OfficerPassword, OrgID FROM Officers WHERE OfficerID = ? AND OfficerPassword = ? LIMIT 1',
            [id, password]
        );

        if (officerResults && officerResults.length > 0) {
            const user = officerResults[0];
            const userId = user.OfficerID;
            const usertype = 'Officer';
            
            // Enrich with OrgName
            try {
                if (user.OrgID) {
                    const [orgRows] = await pool.query(
                        'SELECT OrgName FROM Organizations WHERE OrgID = ? LIMIT 1',
                        [user.OrgID]
                    );
                    if (orgRows && orgRows.length > 0) user.OrgName = orgRows[0].OrgName;
                }
            } catch (e) {
                console.warn('Could not enrich user with OrgName:', e.message);
            }

            console.log(`✅ Login Successful (Officer): ${user.OfficerName}`);

            const token = jwt.sign(
                { userId: userId, role: usertype },
                JWT_SECRET,
                { expiresIn: process.env.JWT_EXPIRES_IN }
            );

            return res.status(200).json({
                success: true,
                message: 'Login Successful',
                token: token,
                userInfo: user,
                usertype: usertype,
                role: usertype
            });
        }

        // User not found
        console.log('Access Denied: Invalid ID or Password');

        return res.status(401).json({
            success: false,
            message: 'Invalid ID or Password!'
        });

    } catch (error) {
        console.error('💥 Login Error:', error.message);
        console.error('   Code:', error.code);
        
        return res.status(500).json({
            success: false,
            message: 'Internal Server Error: Database access failed.'
        });
    }
};

module.exports = loginService;
