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
    
    let connection;
    try {
        // 🚀 Get explicit connection from pool
        connection = await pool.getConnection();
        if (!connection) throw new Error('Failed to get connection from pool');
        
        // Call Stored Procedure
        const [results] = await connection.query(
            'CALL sp_login_check(?, ?)', 
            [id, password]
        );

        const login_info = results[0]; 
        
        // Check result
        if (!login_info || login_info.length === 0 || login_info[0].usertype === 0) {
            console.log('Access Denied: Invalid ID or Password');

            // Send Alert Email (non-blocking)
            const mailOptions = {
                from: `"PCRU Chatbot" <${process.env.EMAIL_USER}>`,
                to: process.env.EMAIL_USER,
                subject: 'แจ้งเตือน: มีการพยายามเข้าสู่ระบบไม่สำเร็จ',
                html: `
                    <p>เรียนผู้ดูแลระบบ</p>
                    <p>มีการพยายามเข้าสู่ระบบไม่สำเร็จในระบบ PCRU Chatbot Backend</p>
                    <ul>
                        <li><b>ID ที่พยายามใช้:</b> ${id}</li>
                        <li><b>IP Address:</b> ${req.ip}</li>
                        <li><b>เวลา:</b> ${new Date().toISOString()}</li>
                    </ul>
                `
            };

            transporter.sendMail(mailOptions, (error, info) => {
                if (error) console.error('Error sending email:', error);
                else console.log('Alert email sent:', info.messageId);
            });

            return res.status(401).json({ 
                success: false, 
                message: 'Invalid ID or Password!' 
            });
        }
        
        // Login successful
        const user = login_info[0];
        const usertype = user.usertype;

        let userId, userName;

        if (usertype === "Super Admin" || usertype === "Admin") {
            userId = user.AdminUserID;
            userName = user.AdminName;
        } else if (usertype === "Officer") {
            userId = user.OfficerID;
            userName = user.OfficerName;
        }

        if (!userId) {
            console.error('Login Error: Could not determine user ID');
            return res.status(500).json({ 
                success: false, 
                message: 'Internal Server Error: User data inconsistency.' 
            });
        }
        
        console.log(`Login Successful: ${userName} (${userId}), Role: ${usertype}`);
        
        // Enrich with OrgName
        try {
            if (user && user.OrgID) {
                const [orgRows] = await connection.query(
                    'SELECT OrgName FROM Organizations WHERE OrgID = ? LIMIT 1', 
                    [user.OrgID]
                );
                if (orgRows && orgRows.length > 0) user.OrgName = orgRows[0].OrgName;
            }
        } catch (e) {
            console.warn('Could not enrich user with OrgName:', e.message);
        }

        // Create JWT Token
        const token = jwt.sign(
            { userId: userId, role: usertype },
            JWT_SECRET,
            { expiresIn: process.env.JWT_EXPIRES_IN }
        );
        
        // Send response
        res.status(200).json({
            success: true,
            message: 'Login Successful',
            token: token,
            userInfo: user, 
            usertype: usertype,
            role: usertype
        });

    } catch (error) {
        console.error('💥 Login Error:', error.message);
        console.error('   Code:', error.code);
        
        return res.status(500).json({ 
            success: false, 
            message: 'Internal Server Error: Database access failed.' 
        });
    } finally {
        // 🚀 CRITICAL: Always release connection
        if (connection) {
            try {
                await connection.release();
                console.log('✅ Connection released after login attempt');
            } catch (e) {
                console.error('Error releasing connection:', e.message);
            }
        }
    }
};

module.exports = loginService;
