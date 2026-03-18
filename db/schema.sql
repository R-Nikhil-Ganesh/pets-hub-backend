-- ============================================================
-- Pawprint Social Hub — MySQL Schema
-- Run: mysql -u root -p < schema.sql
-- ============================================================

CREATE DATABASE IF NOT EXISTS pawprint CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
USE pawprint;

-- -----------------------------------------------
-- USERS
-- -----------------------------------------------
CREATE TABLE IF NOT EXISTS users (
  id                INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  email             VARCHAR(255) NOT NULL UNIQUE,
  username          VARCHAR(30)  NOT NULL UNIQUE,
  display_name      VARCHAR(60)  NOT NULL,
  password_hash     VARCHAR(255) NOT NULL,
  bio               TEXT,
  avatar_url        VARCHAR(512) DEFAULT '',
  location_lat      DECIMAL(9,6) DEFAULT NULL,
  location_lng      DECIMAL(9,6) DEFAULT NULL,
  is_professional   TINYINT(1)   NOT NULL DEFAULT 0,
  professional_type VARCHAR(60)  DEFAULT NULL,
  follower_count    INT UNSIGNED NOT NULL DEFAULT 0,
  following_count   INT UNSIGNED NOT NULL DEFAULT 0,
  created_at        DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at        DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
) ENGINE=InnoDB;

-- -----------------------------------------------
-- PET PROFILES
-- -----------------------------------------------
CREATE TABLE IF NOT EXISTS pet_profiles (
  id        INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  user_id   INT UNSIGNED NOT NULL,
  name      VARCHAR(60)  NOT NULL,
  breed     VARCHAR(80)  NOT NULL,
  age       TINYINT UNSIGNED NOT NULL DEFAULT 0,
  species   ENUM('dog','cat','bird','rabbit','other') NOT NULL DEFAULT 'dog',
  photo_url VARCHAR(512) DEFAULT '',
  created_at DATETIME    NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
) ENGINE=InnoDB;

-- -----------------------------------------------
-- FOLLOWS
-- -----------------------------------------------
CREATE TABLE IF NOT EXISTS follows (
  follower_id  INT UNSIGNED NOT NULL,
  following_id INT UNSIGNED NOT NULL,
  created_at   DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (follower_id, following_id),
  FOREIGN KEY (follower_id)  REFERENCES users(id) ON DELETE CASCADE,
  FOREIGN KEY (following_id) REFERENCES users(id) ON DELETE CASCADE
) ENGINE=InnoDB;

-- -----------------------------------------------
-- POSTS
-- -----------------------------------------------
CREATE TABLE IF NOT EXISTS posts (
  id            INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  user_id       INT UNSIGNED NOT NULL,
  pet_id        INT UNSIGNED DEFAULT NULL,
  caption       TEXT,
  media_url     VARCHAR(512) DEFAULT '',
  media_type    ENUM('image','video') NOT NULL DEFAULT 'image',
  location_name VARCHAR(120) DEFAULT '',
  score         DECIMAL(10,6) NOT NULL DEFAULT 0,
  deleted_at    DATETIME DEFAULT NULL,
  created_at    DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
  FOREIGN KEY (pet_id)  REFERENCES pet_profiles(id) ON DELETE SET NULL,
  INDEX idx_posts_user   (user_id),
  INDEX idx_posts_score  (score DESC),
  INDEX idx_posts_created (created_at DESC)
) ENGINE=InnoDB;

-- -----------------------------------------------
-- POST REACTIONS
-- -----------------------------------------------
CREATE TABLE IF NOT EXISTS post_reactions (
  id         INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  post_id    INT UNSIGNED NOT NULL,
  user_id    INT UNSIGNED NOT NULL,
  emoji      VARCHAR(10)  NOT NULL DEFAULT '🐾',
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY uq_reaction (post_id, user_id),
  FOREIGN KEY (post_id)  REFERENCES posts(id) ON DELETE CASCADE,
  FOREIGN KEY (user_id)  REFERENCES users(id) ON DELETE CASCADE
) ENGINE=InnoDB;

-- -----------------------------------------------
-- COMMENTS
-- -----------------------------------------------
CREATE TABLE IF NOT EXISTS comments (
  id         INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  post_id    INT UNSIGNED NOT NULL,
  user_id    INT UNSIGNED NOT NULL,
  content    TEXT NOT NULL,
  deleted_at DATETIME DEFAULT NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (post_id) REFERENCES posts(id) ON DELETE CASCADE,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
  INDEX idx_comments_post (post_id)
) ENGINE=InnoDB;

-- -----------------------------------------------
-- STORIES
-- -----------------------------------------------
CREATE TABLE IF NOT EXISTS stories (
  id          INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  user_id     INT UNSIGNED NOT NULL,
  pet_id      INT UNSIGNED DEFAULT NULL,
  media_url   VARCHAR(512) NOT NULL,
  media_type  ENUM('image','video') NOT NULL DEFAULT 'image',
  expires_at  DATETIME NOT NULL,
  deleted_at  DATETIME DEFAULT NULL,
  created_at  DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
  FOREIGN KEY (pet_id)  REFERENCES pet_profiles(id) ON DELETE SET NULL,
  INDEX idx_stories_expires (expires_at),
  INDEX idx_stories_user    (user_id)
) ENGINE=InnoDB;

-- -----------------------------------------------
-- STORY VIEWS
-- -----------------------------------------------
CREATE TABLE IF NOT EXISTS story_views (
  story_id   INT UNSIGNED NOT NULL,
  user_id    INT UNSIGNED NOT NULL,
  viewed_at  DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (story_id, user_id),
  FOREIGN KEY (story_id) REFERENCES stories(id) ON DELETE CASCADE,
  FOREIGN KEY (user_id)  REFERENCES users(id)   ON DELETE CASCADE
) ENGINE=InnoDB;

-- -----------------------------------------------
-- HOT TAKES
-- -----------------------------------------------
CREATE TABLE IF NOT EXISTS hot_takes (
  id         INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  user_id    INT UNSIGNED NOT NULL,
  content    TEXT NOT NULL,
  media_url  VARCHAR(512) DEFAULT '',
  flair      ENUM('hot_take','unpopular','meme','debate','confession') NOT NULL DEFAULT 'hot_take',
  deleted_at DATETIME DEFAULT NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
  INDEX idx_hot_takes_created (created_at DESC)
) ENGINE=InnoDB;

-- -----------------------------------------------
-- HOT TAKE UPVOTES
-- -----------------------------------------------
CREATE TABLE IF NOT EXISTS hot_take_upvotes (
  hot_take_id INT UNSIGNED NOT NULL,
  user_id     INT UNSIGNED NOT NULL,
  created_at  DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (hot_take_id, user_id),
  FOREIGN KEY (hot_take_id) REFERENCES hot_takes(id) ON DELETE CASCADE,
  FOREIGN KEY (user_id)     REFERENCES users(id)      ON DELETE CASCADE
) ENGINE=InnoDB;

-- -----------------------------------------------
-- COMMUNITIES
-- -----------------------------------------------
CREATE TABLE IF NOT EXISTS communities (
  id           INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  name         VARCHAR(80)  NOT NULL,
  description  TEXT,
  type         ENUM('breed','topic','local') NOT NULL DEFAULT 'topic',
  icon_emoji   VARCHAR(10) DEFAULT '🐾',
  icon_url     VARCHAR(512) DEFAULT NULL,
  is_default   TINYINT(1) NOT NULL DEFAULT 0,
  created_at   DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
) ENGINE=InnoDB;

-- -----------------------------------------------
-- COMMUNITY MEMBERS
-- -----------------------------------------------
CREATE TABLE IF NOT EXISTS community_members (
  community_id INT UNSIGNED NOT NULL,
  user_id      INT UNSIGNED NOT NULL,
  joined_at    DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (community_id, user_id),
  FOREIGN KEY (community_id) REFERENCES communities(id) ON DELETE CASCADE,
  FOREIGN KEY (user_id)      REFERENCES users(id)        ON DELETE CASCADE
) ENGINE=InnoDB;

-- -----------------------------------------------
-- THREADS
-- -----------------------------------------------
CREATE TABLE IF NOT EXISTS threads (
  id           INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  community_id INT UNSIGNED NOT NULL,
  user_id      INT UNSIGNED NOT NULL,
  title        VARCHAR(200) NOT NULL,
  content      TEXT,
  flair        VARCHAR(60) DEFAULT NULL,
  deleted_at   DATETIME DEFAULT NULL,
  created_at   DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (community_id) REFERENCES communities(id) ON DELETE CASCADE,
  FOREIGN KEY (user_id)      REFERENCES users(id)        ON DELETE CASCADE,
  INDEX idx_threads_community (community_id)
) ENGINE=InnoDB;

-- -----------------------------------------------
-- THREAD REPLIES
-- -----------------------------------------------
CREATE TABLE IF NOT EXISTS thread_replies (
  id         INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  thread_id  INT UNSIGNED NOT NULL,
  user_id    INT UNSIGNED NOT NULL,
  parent_id  INT UNSIGNED DEFAULT NULL,
  content    TEXT NOT NULL,
  deleted_at DATETIME DEFAULT NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (thread_id) REFERENCES threads(id)        ON DELETE CASCADE,
  FOREIGN KEY (user_id)   REFERENCES users(id)           ON DELETE CASCADE,
  FOREIGN KEY (parent_id) REFERENCES thread_replies(id)  ON DELETE SET NULL,
  INDEX idx_replies_thread (thread_id)
) ENGINE=InnoDB;

-- -----------------------------------------------
-- THREAD UPVOTES (for threads and replies)
-- -----------------------------------------------
CREATE TABLE IF NOT EXISTS thread_upvotes (
  id         INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  thread_id  INT UNSIGNED DEFAULT NULL,
  reply_id   INT UNSIGNED DEFAULT NULL,
  user_id    INT UNSIGNED NOT NULL,
  is_upvote  TINYINT(1) NOT NULL DEFAULT 1,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY uq_thread_vote (thread_id, reply_id, user_id),
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
) ENGINE=InnoDB;

-- -----------------------------------------------
-- GAME SESSIONS
-- -----------------------------------------------
CREATE TABLE IF NOT EXISTS game_sessions (
  id          INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  mode        ENUM('trivia','photo_contest','training','breed_guess') NOT NULL,
  player1_id  INT UNSIGNED NOT NULL,
  player2_id  INT UNSIGNED DEFAULT NULL,
  status      ENUM('waiting','active','finished') NOT NULL DEFAULT 'waiting',
  winner_id   INT UNSIGNED DEFAULT NULL,
  created_at  DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  finished_at DATETIME DEFAULT NULL,
  FOREIGN KEY (player1_id) REFERENCES users(id) ON DELETE CASCADE,
  INDEX idx_game_sessions_players (player1_id, player2_id)
) ENGINE=InnoDB;

-- -----------------------------------------------
-- TRIVIA QUESTIONS
-- -----------------------------------------------
CREATE TABLE IF NOT EXISTS trivia_questions (
  id            INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  question      TEXT NOT NULL,
  choice_a      VARCHAR(200) NOT NULL,
  choice_b      VARCHAR(200) NOT NULL,
  choice_c      VARCHAR(200) NOT NULL,
  choice_d      VARCHAR(200) NOT NULL,
  correct_index TINYINT UNSIGNED NOT NULL COMMENT '0=A,1=B,2=C,3=D',
  category      VARCHAR(60) DEFAULT 'general',
  created_at    DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
) ENGINE=InnoDB;

-- -----------------------------------------------
-- USER POINTS
-- -----------------------------------------------
CREATE TABLE IF NOT EXISTS user_points (
  user_id      INT UNSIGNED PRIMARY KEY,
  total_points INT UNSIGNED NOT NULL DEFAULT 0,
  updated_at   DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
) ENGINE=InnoDB;

-- -----------------------------------------------
-- POINT TRANSACTIONS
-- -----------------------------------------------
CREATE TABLE IF NOT EXISTS point_transactions (
  id         INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  user_id    INT UNSIGNED NOT NULL,
  amount     INT          NOT NULL,
  action     VARCHAR(80)  NOT NULL,
  created_at DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
  INDEX idx_pt_user (user_id)
) ENGINE=InnoDB;

-- -----------------------------------------------
-- REWARDS
-- -----------------------------------------------
CREATE TABLE IF NOT EXISTS rewards (
  id           INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  title        VARCHAR(120) NOT NULL,
  description  TEXT,
  points_cost  INT UNSIGNED NOT NULL,
  image_url    VARCHAR(512) DEFAULT '',
  is_active    TINYINT(1) NOT NULL DEFAULT 1,
  created_at   DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
) ENGINE=InnoDB;

-- -----------------------------------------------
-- EVENTS
-- -----------------------------------------------
CREATE TABLE IF NOT EXISTS events (
  id           INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  organizer_id INT UNSIGNED NOT NULL,
  title        VARCHAR(200) NOT NULL,
  description  TEXT,
  cover_url    VARCHAR(512) DEFAULT '',
  location_name VARCHAR(120) DEFAULT '',
  location_lat DECIMAL(9,6) DEFAULT NULL,
  location_lng DECIMAL(9,6) DEFAULT NULL,
  starts_at    DATETIME NOT NULL,
  ends_at      DATETIME DEFAULT NULL,
  deleted_at   DATETIME DEFAULT NULL,
  created_at   DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (organizer_id) REFERENCES users(id) ON DELETE CASCADE,
  INDEX idx_events_starts (starts_at)
) ENGINE=InnoDB;

-- -----------------------------------------------
-- NOTIFICATIONS
-- -----------------------------------------------
CREATE TABLE IF NOT EXISTS notifications (
  id          INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  user_id     INT UNSIGNED NOT NULL,
  actor_id    INT UNSIGNED DEFAULT NULL,
  type        ENUM('like','comment','follow','game_invite','reply','mention') NOT NULL,
  ref_id      INT UNSIGNED DEFAULT NULL COMMENT 'post_id / thread_id / etc.',
  ref_type    VARCHAR(30)  DEFAULT NULL,
  is_read     TINYINT(1)   NOT NULL DEFAULT 0,
  created_at  DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (user_id)  REFERENCES users(id) ON DELETE CASCADE,
  INDEX idx_notif_user (user_id, is_read, created_at DESC)
) ENGINE=InnoDB;

-- -----------------------------------------------
-- SEED: Default communities
-- -----------------------------------------------
INSERT IGNORE INTO communities (name, description, type, icon_emoji, icon_url, is_default) VALUES
  ('General Pet Talk',    'Chat about anything pet-related!', 'topic', '🐾', 'https://i.pinimg.com/736x/15/24/5b/15245b93abd62b3392a99bfb1766d617.jpg', 1),
  ('Dog Lovers',          'For all dog breeds and mixes',     'breed', '🐶', 'https://images.ctfassets.net/sfnkq8lmu5d7/1wwJDuKWXF4niMBJE9gaSH/97b11bcd7d41039f3a8eb5c3350acdfd/2024-05-24_Doge_meme_death_-_Hero.jpg', 1),
  ('Cat Owners',          'From kittens to senior cats',      'breed', '🐱', 'https://stickerrs.com/cdn-cgi/image/format=auto,quality=80,width=300/wp-content/uploads/2024/03/Cat-Meme-Stickers-Featured-300x300.png', 1),
  ('Bird Enthusiasts',    'Parrots, canaries, and more',      'breed', '🦜', NULL, 0),
  ('Vet Tips & Health',   'Professional advice & Q&A',        'topic', '💊', 'https://media.makeameme.org/created/please-help-me-596e8b.jpg', 1),
  ('Training & Behavior', 'Tips, tricks & behaviour help',    'topic', '🎓', NULL, 0);

-- -----------------------------------------------
-- SEED: Sample trivia questions
-- -----------------------------------------------
INSERT IGNORE INTO trivia_questions (question, choice_a, choice_b, choice_c, choice_d, correct_index, category) VALUES
  ('How many teeth does an adult dog have?', '28', '32', '42', '36', 2, 'dogs'),
  ('What is the normal body temperature of a cat (°F)?', '98.6', '100–102.5', '103–105', '96–98', 1, 'cats'),
  ('Which breed is known as the "Sausage Dog"?', 'Beagle', 'Corgi', 'Dachshund', 'Basset Hound', 2, 'dogs'),
  ('How many toes does a cat have on each front paw?', '4', '5', '6', '3', 1, 'cats'),
  ('What is a group of cats called?', 'Pack', 'Herd', 'Clowder', 'Pounce', 2, 'cats'),
  ('Which dog breed is the fastest?', 'Whippet', 'Greyhound', 'Saluki', 'Vizsla', 1, 'dogs'),
  ('A rabbit''s teeth never stop growing. True or False?', 'True', 'False', 'Only top teeth', 'Only incisors', 0, 'rabbits'),
  ('What is the average lifespan of a domestic cat?', '5–8 years', '8–10 years', '12–18 years', '20–25 years', 2, 'cats'),
  ('Which parrot is known to mimic human speech best?', 'Budgerigar', 'Cockatoo', 'African Grey', 'Amazon', 2, 'birds'),
  ('How often should you brush your dog''s teeth?', 'Monthly', 'Weekly', 'Daily', 'Never', 2, 'dogs');

-- -----------------------------------------------
-- SEED: Sample rewards
-- -----------------------------------------------
INSERT IGNORE INTO rewards (title, description, points_cost, is_active) VALUES
  ('Premium Filter Pack',   '10 exclusive photo filters for your pet pics', 200,  1),
  ('VIP Community Badge',   'Stand out with a gold badge in communities',   500,  1),
  ('Double Points Weekend', 'Earn 2× points for 48 hours',                 1000, 1),
  ('Custom Flair',          'Create your own thread flair',                 750,  1),
  ('Ad-Free Month',         'Enjoy a 30-day ad-free experience',            2000, 1);
