// /config.js

const dotenv = require('dotenv');
dotenv.config(); // โหลดค่าจากไฟล์ .env เข้าสู่ process.env

const config = {
    CLIENT_URL: process.env.CLIENT_URL || 'https://ict.pcru.ac.th/~s651102064101/frontend/'
};

module.exports = config; 