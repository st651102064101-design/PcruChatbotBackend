-- Fix: Ensure GoogleOAuthID has AUTO_INCREMENT properly set
-- This handles cases where the table was created incorrectly

-- Check if table exists and has the column
ALTER TABLE GoogleOAuth MODIFY COLUMN `GoogleOAuthID` INT(11) NOT NULL AUTO_INCREMENT UNIQUE;

-- Alternatively, if the above fails, drop and recreate:
-- DROP TABLE IF EXISTS GoogleOAuth CASCADE;
-- Then run create_google_oauth_table.sql
