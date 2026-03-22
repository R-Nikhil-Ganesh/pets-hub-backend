-- Backfill deterministic default profile pictures for users with empty avatar_url.
UPDATE users
SET avatar_url = CONCAT('https://api.dicebear.com/7.x/pixel-art/png?seed=user-', id)
WHERE avatar_url IS NULL
   OR TRIM(avatar_url) = ''
   OR LOWER(TRIM(avatar_url)) = 'none';
