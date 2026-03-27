-- Initialize GoogleOAuth table with proper AUTO_INCREMENT configuration
-- This script will DROP and recreate the table to ensure it has the correct structure

-- Step 1: Drop existing table and foreign key constraints
DROP TABLE IF EXISTS `GoogleOAuth`;

-- Step 2: Create GoogleOAuth table with proper AUTO_INCREMENT
CREATE TABLE `GoogleOAuth` (
  `GoogleOAuthID` int(11) NOT NULL AUTO_INCREMENT,
  `GoogleID` varchar(255) NOT NULL COMMENT 'Google Account ID (sub)',
  `GoogleEmail` varchar(255) NOT NULL COMMENT 'Email จาก Google Account',
  `GoogleName` varchar(255) DEFAULT NULL COMMENT 'ชื่อจาก Google Account',
  `GooglePicture` varchar(512) DEFAULT NULL COMMENT 'รูปโปรไฟล์จาก Google',
  `UserType` ENUM('admin', 'officer') NOT NULL COMMENT 'ประเภทผู้ใช้ที่ผูกกับ Google',
  `AdminUserID` int(3) DEFAULT NULL COMMENT 'FK to AdminUsers (สำหรับ Super Admin, Admin)',
  `OfficerID` int(11) DEFAULT NULL COMMENT 'FK to Officers',
  `IsActive` tinyint(1) NOT NULL DEFAULT 1 COMMENT 'สถานะการใช้งาน',
  `CreatedAt` timestamp NOT NULL DEFAULT current_timestamp(),
  `UpdatedAt` timestamp NOT NULL DEFAULT current_timestamp() ON UPDATE current_timestamp(),
  PRIMARY KEY (`GoogleOAuthID`),
  UNIQUE KEY `uk_google_id` (`GoogleID`),
  UNIQUE KEY `uk_admin_user` (`AdminUserID`),
  UNIQUE KEY `uk_officer` (`OfficerID`),
  KEY `idx_google_email` (`GoogleEmail`),
  CONSTRAINT `fk_google_oauth_admin` FOREIGN KEY (`AdminUserID`) REFERENCES `AdminUsers` (`AdminUserID`) ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT `fk_google_oauth_officer` FOREIGN KEY (`OfficerID`) REFERENCES `Officers` (`OfficerID`) ON DELETE CASCADE ON UPDATE CASCADE
) ENGINE=InnoDB AUTO_INCREMENT=1 DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci COMMENT='ตารางสำหรับ Google OAuth Login';

-- Verify the table was created with AUTO_INCREMENT
SELECT 'GoogleOAuth table created successfully with AUTO_INCREMENT' as status;
SELECT EXTRA FROM information_schema.COLUMNS 
WHERE TABLE_SCHEMA = DATABASE() 
  AND TABLE_NAME = 'GoogleOAuth' 
  AND COLUMN_NAME = 'GoogleOAuthID';
