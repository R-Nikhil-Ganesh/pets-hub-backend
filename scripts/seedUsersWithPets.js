const path = require('path');
const bcrypt = require('bcryptjs');

require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

const db = require('../config/db');

const DOG_BREEDS = [
  'Labrador Retriever',
  'German Shepherd',
  'Golden Retriever',
  'Bulldog',
  'Beagle',
  'Poodle',
  'Rottweiler',
  'Dachshund',
  'Shih Tzu',
  'Siberian Husky',
  'Corgi',
  'Pug',
  'Doberman',
  'Boxer',
  'Maltese',
  'Border Collie',
  'Chihuahua',
  'Great Dane',
  'Samoyed',
  'Australian Shepherd',
];

const CAT_BREEDS = [
  'Persian',
  'Maine Coon',
  'Siamese',
  'British Shorthair',
  'Ragdoll',
  'Sphynx',
  'Bengal',
  'Abyssinian',
  'Russian Blue',
  'Scottish Fold',
  'Birman',
  'Norwegian Forest Cat',
  'Turkish Angora',
  'American Shorthair',
  'Oriental Shorthair',
  'Devon Rex',
  'Bombay',
  'Tonkinese',
  'Balinese',
  'Burmese',
];

const DOG_NAMES = [
  'Max',
  'Buddy',
  'Charlie',
  'Cooper',
  'Rocky',
  'Milo',
  'Duke',
  'Teddy',
  'Leo',
  'Oliver',
  'Bailey',
  'Bruno',
  'Bentley',
  'Finn',
  'Koda',
  'Ziggy',
  'Rex',
  'Murphy',
  'Odin',
  'Buster',
];

const CAT_NAMES = [
  'Luna',
  'Milo',
  'Bella',
  'Simba',
  'Nala',
  'Oliver',
  'Loki',
  'Kitty',
  'Cleo',
  'Coco',
  'Mochi',
  'Shadow',
  'Willow',
  'Nova',
  'Pepper',
  'Mimi',
  'Sushi',
  'Poppy',
  'Hazel',
  'Ivy',
];

const FIRST_NAMES = [
  'Ava',
  'Noah',
  'Emma',
  'Liam',
  'Mia',
  'Ethan',
  'Sophia',
  'Lucas',
  'Isla',
  'Mason',
  'Aria',
  'Logan',
  'Zoe',
  'James',
  'Nora',
  'Elijah',
  'Lily',
  'Henry',
  'Ella',
  'Jacob',
];

const LAST_NAMES = [
  'Smith',
  'Johnson',
  'Williams',
  'Brown',
  'Jones',
  'Garcia',
  'Miller',
  'Davis',
  'Wilson',
  'Anderson',
  'Taylor',
  'Thomas',
  'Moore',
  'Martin',
  'Jackson',
  'Thompson',
  'White',
  'Harris',
  'Clark',
  'Lewis',
];

function randomItem(list) {
  return list[Math.floor(Math.random() * list.length)];
}

function randomInt(min, max) {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

function parseCount(argv) {
  const valueFromFlag = argv.find((arg) => arg.startsWith('--count='));
  if (valueFromFlag) {
    return Number(valueFromFlag.split('=')[1]);
  }

  const firstPositional = argv.find((arg) => /^\d+$/.test(arg));
  if (firstPositional) {
    return Number(firstPositional);
  }

  return 25;
}

async function seedOneUser({ index, passwordHash, runId }) {
  const connection = await db.getConnection();

  try {
    await connection.beginTransaction();

    const firstName = randomItem(FIRST_NAMES);
    const lastName = randomItem(LAST_NAMES);
    const displayName = `${firstName} ${lastName}`;

    const usernameBase = `${firstName}${lastName}`
      .toLowerCase()
      .replace(/[^a-z0-9_]/g, '')
      .slice(0, 15);

    const uniqueSuffix = `${runId}${String(index).padStart(3, '0')}`;
    const username = `${usernameBase}_${uniqueSuffix}`.slice(0, 30);
    const email = `seed_${uniqueSuffix}@pawprint.local`;

    const [userInsert] = await connection.query(
      `INSERT INTO users (email, username, display_name, password_hash, avatar_url)
       VALUES (?, ?, ?, ?, ?)` ,
      [
        email,
        username,
        displayName,
        passwordHash,
        `https://api.dicebear.com/7.x/pixel-art/png?seed=user-${username}`,
      ]
    );

    const userId = Number(userInsert.insertId);

    const species = Math.random() < 0.5 ? 'dog' : 'cat';
    const breed = species === 'dog' ? randomItem(DOG_BREEDS) : randomItem(CAT_BREEDS);
    const petName = species === 'dog' ? randomItem(DOG_NAMES) : randomItem(CAT_NAMES);
    const petAge = randomInt(1, 14);

    const petPhotoUrl = species === 'dog'
      ? `https://api.dicebear.com/7.x/shapes/png?seed=dog-${userId}&scale=80`
      : `https://api.dicebear.com/7.x/shapes/png?seed=cat-${userId}&scale=80`;

    await connection.query(
      `INSERT INTO pet_profiles (user_id, name, breed, age, species, photo_url)
       VALUES (?, ?, ?, ?, ?, ?)` ,
      [
        userId,
        petName,
        breed,
        petAge,
        species,
        petPhotoUrl,
      ]
    );

    await connection.query(
      `INSERT INTO user_points (user_id, total_points)
       VALUES (?, ?)
       ON DUPLICATE KEY UPDATE total_points = VALUES(total_points)` ,
      [userId, randomInt(0, 500)]
    );

    await connection.commit();

    return {
      id: userId,
      username,
      email,
      species,
      breed,
      petName,
    };
  } catch (error) {
    await connection.rollback();
    throw error;
  } finally {
    connection.release();
  }
}

async function main() {
  const count = parseCount(process.argv.slice(2));

  if (!Number.isFinite(count) || count <= 0) {
    throw new Error('Count must be a positive number. Example: npm run seed:users -- --count=50');
  }

  const runId = Date.now().toString().slice(-6);
  const passwordHash = await bcrypt.hash('Password123!', 12);

  const created = [];
  for (let i = 1; i <= count; i += 1) {
    const seeded = await seedOneUser({ index: i, passwordHash, runId });
    created.push(seeded);
  }

  console.log(`Seed complete. Created ${created.length} users with mandatory pets.`);
  console.log('Sample users (password: Password123!):');
  created.slice(0, 5).forEach((entry) => {
    console.log(`- ${entry.username} (${entry.email}) -> ${entry.species}/${entry.breed} (${entry.petName})`);
  });
}

main()
  .catch((error) => {
    console.error('Seeding failed:', error.message);
    process.exitCode = 1;
  })
  .finally(async () => {
    try {
      await db.end();
    } catch {
      // ignore pool close errors
    }
  });
