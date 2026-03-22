const path = require('path');
const mongoose = require('mongoose');

require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

const db = require('../config/db');
const { initMongo } = require('../config/mongo');
const ChatMessage = require('../models/ChatMessage');

const POST_CAPTIONS = [
  'Morning zoomies with my best friend.',
  'Fresh groom and feeling fancy today.',
  'Park day highlights. Who else went outside?',
  'Snack review: 10/10, would beg again.',
  'Post-bath face says everything.',
  'Training win: we finally nailed "stay".',
  'Caught this perfect side profile.',
  'Lazy couch afternoon with my floof.',
];

const POST_IMAGE_URLS = [
  'https://api.dicebear.com/7.x/shapes/png?seed=post-dog-1&scale=80',
  'https://api.dicebear.com/7.x/shapes/png?seed=post-dog-2&scale=80',
  'https://api.dicebear.com/7.x/shapes/png?seed=post-cat-1&scale=80',
  'https://api.dicebear.com/7.x/shapes/png?seed=post-cat-2&scale=80',
  'https://api.dicebear.com/7.x/shapes/png?seed=post-dog-3&scale=80',
  'https://api.dicebear.com/7.x/shapes/png?seed=post-cat-3&scale=80',
  'https://api.dicebear.com/7.x/shapes/png?seed=post-dog-4&scale=80',
  'https://api.dicebear.com/7.x/shapes/png?seed=post-cat-4&scale=80',
  'https://api.dicebear.com/7.x/shapes/png?seed=post-dog-5&scale=80',
  'https://api.dicebear.com/7.x/shapes/png?seed=post-cat-5&scale=80',
  'https://api.dicebear.com/7.x/shapes/png?seed=post-dog-6&scale=80',
  'https://api.dicebear.com/7.x/shapes/png?seed=post-cat-6&scale=80',
];

const COMMENT_BODIES = [
  'This is adorable.',
  'Look at that face!',
  'So wholesome, love this.',
  'Absolutely iconic pet energy.',
  'I needed this today.',
  'That pose is elite.',
  'What a cutie!',
  'Please post more updates.',
];

const THREAD_TITLES = [
  'Best budget toys that lasted more than a week?',
  'Share your go-to training reward snacks',
  'How do you handle rainy-day energy?',
  'Drop your funniest pet habit below',
  'Any tips for introducing a new kitten?',
  'What camera settings do you use for pet photos?',
];

const THREAD_BODIES = [
  'Looking for practical ideas that do not get destroyed instantly. Please share links or examples.',
  'Trying to keep training sessions short but effective. What treats actually keep focus high?',
  'Indoor enrichment ideas welcome. We need more mental games for high-energy days.',
  'Mine steals socks and then brings them back for praise. What is your pet\'s weird routine?',
  'We are prepping a safe intro zone and would love a proven checklist from other owners.',
  'Would love quick advice for low-light indoor shots without too much blur.',
];

const REPLY_BODIES = [
  'We had good luck rotating toys every 2 days.',
  'Frozen lick mats have been a game changer for us.',
  'Short 5-minute sessions worked better than one long session.',
  'Snuffle mats and hide-and-seek are our rainy-day staples.',
  'Try rewarding calm behavior before meals, it helped a lot.',
  'Natural window light plus burst mode works surprisingly well.',
  'We introduced slowly over one week and it reduced stress a lot.',
  'Puzzle feeders helped us burn extra energy indoors.',
];

const CHAT_LINES = [
  'Hey everyone, welcome to the chat.',
  'Who is online for a quick pet photo share?',
  'Just posted a new update in the feed.',
  'Any good weekend plans with your pets?',
  'Reminder: hydration and shade if it is hot outside.',
  'Show us your pet\'s funniest sleeping position.',
  'Training progress check-in: what improved this week?',
  'Community challenge idea: happiest tail wag clip.',
  'I can drop a toy rotation template if anyone wants it.',
  'That sounds great, please share it here.',
];

function pick(list) {
  return list[Math.floor(Math.random() * list.length)];
}

function shuffle(list) {
  const clone = [...list];
  for (let i = clone.length - 1; i > 0; i -= 1) {
    const j = Math.floor(Math.random() * (i + 1));
    [clone[i], clone[j]] = [clone[j], clone[i]];
  }
  return clone;
}

function pickDistinctUsers(users, count, excludeIds = new Set()) {
  const eligible = users.filter((user) => !excludeIds.has(Number(user.id)));
  return shuffle(eligible).slice(0, Math.min(count, eligible.length));
}

async function getSeedBaseData(connection) {
  const [users] = await connection.query(
    `SELECT u.id, u.username, u.display_name, u.avatar_url, MIN(pp.id) AS pet_id
     FROM users u
     LEFT JOIN pet_profiles pp ON pp.user_id = u.id
     GROUP BY u.id, u.username, u.display_name, u.avatar_url
     ORDER BY u.id ASC`
  );

  const [communities] = await connection.query(
    'SELECT id, name FROM communities ORDER BY is_default DESC, id ASC'
  );

  return { users, communities };
}

async function resetMysqlContent(connection) {
  const result = {
    event_group_requests: 0,
    event_groups: 0,
    events: 0,
    notifications: 0,
    story_views: 0,
    stories: 0,
    hot_take_upvotes: 0,
    hot_takes: 0,
    thread_upvotes: 0,
    thread_replies: 0,
    threads: 0,
    comments: 0,
    post_reactions: 0,
    posts: 0,
  };

  const deleteOrder = [
    'event_group_requests',
    'event_groups',
    'events',
    'notifications',
    'story_views',
    'stories',
    'hot_take_upvotes',
    'hot_takes',
    'thread_upvotes',
    'thread_replies',
    'threads',
    'comments',
    'post_reactions',
    'posts',
  ];

  for (const table of deleteOrder) {
    const [deleted] = await connection.query(`DELETE FROM ${table}`);
    result[table] = Number(deleted.affectedRows || 0);
  }

  return result;
}

async function seedCommunityMemberships(connection, users, communities) {
  let inserted = 0;
  const topCommunities = communities.slice(0, Math.min(3, communities.length));

  for (const user of users) {
    const sample = shuffle(topCommunities).slice(0, Math.min(2, topCommunities.length));
    for (const community of sample) {
      const [res] = await connection.query(
        'INSERT IGNORE INTO community_members (community_id, user_id) VALUES (?, ?)',
        [community.id, user.id]
      );
      inserted += Number(res.affectedRows || 0);
    }
  }

  return inserted;
}

async function seedPostsAndComments(connection, users) {
  const counts = {
    posts: 0,
    comments: 0,
    post_reactions: 0,
  };

  const postTotal = Math.min(12, users.length * 2);
  for (let i = 0; i < postTotal; i += 1) {
    const author = users[i % users.length];
    const caption = `${pick(POST_CAPTIONS)} #pawprint`;
    const mediaUrl = POST_IMAGE_URLS[i % POST_IMAGE_URLS.length];

    const [postInsert] = await connection.query(
      `INSERT INTO posts (user_id, pet_id, caption, media_url, media_type, location_name)
       VALUES (?, ?, ?, ?, 'image', ?)` ,
      [author.id, author.pet_id || null, caption, mediaUrl, i % 2 === 0 ? 'Neighborhood Park' : 'Home']
    );

    const postId = Number(postInsert.insertId);
    counts.posts += 1;

    const commenters = pickDistinctUsers(users, 2, new Set([Number(author.id)]));
    for (const commenter of commenters) {
      await connection.query(
        'INSERT INTO comments (post_id, user_id, content) VALUES (?, ?, ?)',
        [postId, commenter.id, pick(COMMENT_BODIES)]
      );
      counts.comments += 1;
    }

    const reactors = pickDistinctUsers(users, 3);
    for (const reactor of reactors) {
      const [reactionInsert] = await connection.query(
        'INSERT IGNORE INTO post_reactions (post_id, user_id, emoji) VALUES (?, ?, ?)',
        [postId, reactor.id, '🐾']
      );
      counts.post_reactions += Number(reactionInsert.affectedRows || 0);
    }
  }

  return counts;
}

async function seedThreadsAndReplies(connection, users, communities) {
  const counts = {
    threads: 0,
    thread_replies: 0,
    thread_upvotes: 0,
  };

  const scopedCommunities = communities.slice(0, Math.min(3, communities.length));
  const threadTotal = Math.min(8, scopedCommunities.length * 3);

  for (let i = 0; i < threadTotal; i += 1) {
    const author = users[i % users.length];
    const community = scopedCommunities[i % scopedCommunities.length];

    const [threadInsert] = await connection.query(
      `INSERT INTO threads (community_id, user_id, title, content, media_url, flair)
       VALUES (?, ?, ?, ?, '', ?)` ,
      [
        community.id,
        author.id,
        pick(THREAD_TITLES),
        pick(THREAD_BODIES),
        i % 2 === 0 ? 'Tips' : 'Discussion',
      ]
    );

    const threadId = Number(threadInsert.insertId);
    counts.threads += 1;

    const upvoters = pickDistinctUsers(users, 4);
    for (const voter of upvoters) {
      const [voteInsert] = await connection.query(
        'INSERT IGNORE INTO thread_upvotes (thread_id, reply_id, user_id, is_upvote) VALUES (?, NULL, ?, 1)',
        [threadId, voter.id]
      );
      counts.thread_upvotes += Number(voteInsert.affectedRows || 0);
    }

    const repliers = pickDistinctUsers(users, 3, new Set([Number(author.id)]));
    const insertedReplyIds = [];
    for (const replier of repliers) {
      const [replyInsert] = await connection.query(
        'INSERT INTO thread_replies (thread_id, user_id, parent_id, content) VALUES (?, ?, NULL, ?)',
        [threadId, replier.id, pick(REPLY_BODIES)]
      );
      const replyId = Number(replyInsert.insertId);
      insertedReplyIds.push(replyId);
      counts.thread_replies += 1;

      const [replyVoteInsert] = await connection.query(
        'INSERT IGNORE INTO thread_upvotes (thread_id, reply_id, user_id, is_upvote) VALUES (NULL, ?, ?, 1)',
        [replyId, author.id]
      );
      counts.thread_upvotes += Number(replyVoteInsert.affectedRows || 0);
    }

    if (insertedReplyIds.length > 0) {
      const nestedAuthor = pickDistinctUsers(users, 1, new Set([Number(author.id)]))[0] || author;
      await connection.query(
        'INSERT INTO thread_replies (thread_id, user_id, parent_id, content) VALUES (?, ?, ?, ?)',
        [threadId, nestedAuthor.id, insertedReplyIds[0], 'Replying here because this worked really well for us too.']
      );
      counts.thread_replies += 1;
    }
  }

  return counts;
}

async function resetAndSeedCommunityChat(users, communities) {
  const deleted = await ChatMessage.deleteMany({});
  const deletedCount = Number(deleted.deletedCount || 0);

  const scopedCommunities = communities.slice(0, Math.min(3, communities.length));
  const documents = [];
  const now = Date.now();
  let offset = 0;

  for (const community of scopedCommunities) {
    const participants = pickDistinctUsers(users, Math.min(5, users.length));
    if (participants.length === 0) continue;

    for (let i = 0; i < 8; i += 1) {
      const sender = participants[i % participants.length];
      documents.push({
        community_id: Number(community.id),
        sender_id: Number(sender.id),
        sender_username: sender.username,
        sender_display_name: sender.display_name || sender.username,
        sender_avatar: sender.avatar_url || '',
        type: 'text',
        content: pick(CHAT_LINES),
        media_url: '',
        reply_to: null,
        reply_preview: null,
        reactions: [],
        deleted_at: null,
        createdAt: new Date(now - (120 - offset) * 60000),
        updatedAt: new Date(now - (120 - offset) * 60000),
      });
      offset += 1;
    }
  }

  let insertedCount = 0;
  if (documents.length > 0) {
    const inserted = await ChatMessage.insertMany(documents);
    insertedCount = inserted.length;

    // Mark one message as a real reply to another inserted message.
    if (inserted.length > 2) {
      const target = inserted[1];
      const reply = inserted[2];
      await ChatMessage.updateOne(
        { _id: reply._id },
        {
          $set: {
            type: 'reply',
            content: 'Replying to that: yes, we tried it and it helped a lot.',
            reply_to: String(target._id),
            reply_preview: String(target.content || '').slice(0, 80),
          },
        }
      );
    }
  }

  return {
    deleted: deletedCount,
    inserted: insertedCount,
  };
}

async function seedUserFollows(connection, users) {
  const [[nikhilUser]] = await connection.query(
    'SELECT id FROM users WHERE email = ? LIMIT 1',
    ['nikhil@gmail.com']
  );

  if (!nikhilUser) return { follows: 0, nikhil_found: false, email: 'nikhil@gmail.com', story_authors: [] };

  let followCount = 0;
  const toFollow = pickDistinctUsers(users, 6, new Set([Number(nikhilUser.id)]));

  for (const user of toFollow) {
    const [result] = await connection.query(
      'INSERT IGNORE INTO follows (follower_id, following_id) VALUES (?, ?)',
      [nikhilUser.id, user.id]
    );
    followCount += Number(result.affectedRows || 0);
  }

  return { follows: followCount, nikhil_found: true, nikhil_id: nikhilUser.id, email: 'nikhil@gmail.com', story_authors: toFollow };
}

async function seedStories(connection, users, storyAuthors) {
  const STORY_IMAGES = [
    'https://api.dicebear.com/7.x/shapes/png?seed=story-dog-1&scale=80',
    'https://api.dicebear.com/7.x/shapes/png?seed=story-dog-2&scale=80',
    'https://api.dicebear.com/7.x/shapes/png?seed=story-cat-1&scale=80',
    'https://api.dicebear.com/7.x/shapes/png?seed=story-cat-2&scale=80',
    'https://api.dicebear.com/7.x/shapes/png?seed=story-dog-3&scale=80',
    'https://api.dicebear.com/7.x/shapes/png?seed=story-cat-3&scale=80',
  ];

  let storyCount = 0;
  const expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000);

  for (let i = 0; i < storyAuthors.length; i += 1) {
    const author = storyAuthors[i];
    const [storyInsert] = await connection.query(
      `INSERT INTO stories (user_id, pet_id, media_url, media_type, expires_at)
       VALUES (?, ?, ?, 'image', ?)`,
      [author.id, author.pet_id || null, STORY_IMAGES[i % STORY_IMAGES.length], expiresAt]
    );
    storyCount += 1;
  }

  return { stories: storyCount };
}

async function main() {
  const connection = await db.getConnection();
  let mongoConnected = false;

  try {
    await connection.beginTransaction();

    const resetCounts = await resetMysqlContent(connection);
    const { users, communities } = await getSeedBaseData(connection);

    if (users.length < 3) {
      throw new Error('Need at least 3 users to seed content. Run: npm run seed:users -- --count=10');
    }
    if (communities.length === 0) {
      throw new Error('No communities found. Initialize schema/seed communities first.');
    }

    const memberCount = await seedCommunityMemberships(connection, users, communities);
    const postCounts = await seedPostsAndComments(connection, users);
    const threadCounts = await seedThreadsAndReplies(connection, users, communities);
    const followCounts = await seedUserFollows(connection, users);
    const storyCounts = await seedStories(connection, users, followCounts.story_authors);

    await connection.commit();

    await initMongo();
    mongoConnected = true;
    const chatCounts = await resetAndSeedCommunityChat(users, communities);

    console.log('Reset complete (MySQL rows deleted):');
    Object.entries(resetCounts).forEach(([table, count]) => {
      console.log(`- ${table}: ${count}`);
    });

    console.log('Seed complete (new content):');
    console.log(`- community_members inserted: ${memberCount}`);
    console.log(`- posts inserted: ${postCounts.posts}`);
    console.log(`- comments inserted: ${postCounts.comments}`);
    console.log(`- post reactions inserted: ${postCounts.post_reactions}`);
    console.log(`- threads inserted: ${threadCounts.threads}`);
    console.log(`- thread replies inserted: ${threadCounts.thread_replies}`);
    console.log(`- thread upvotes inserted: ${threadCounts.thread_upvotes}`);
    if (followCounts.nikhil_found) {
      console.log(`- nikhil@gmail.com follows: ${followCounts.follows}`);
    } else {
      console.log('- nikhil@gmail.com user not found (no follows added)');
    }
    console.log(`- stories inserted: ${storyCounts.stories}`);
    console.log(`- chat messages deleted: ${chatCounts.deleted}`);
    console.log(`- chat messages inserted: ${chatCounts.inserted}`);
  } catch (error) {
    try {
      await connection.rollback();
    } catch {
      // ignore rollback error
    }
    throw error;
  } finally {
    connection.release();

    if (mongoConnected) {
      try {
        await mongoose.disconnect();
      } catch {
        // ignore disconnect errors
      }
    }

    try {
      await db.end();
    } catch {
      // ignore pool close errors
    }
  }
}

main().catch((error) => {
  console.error('Reset/seed failed:', error.message);
  process.exitCode = 1;
});
