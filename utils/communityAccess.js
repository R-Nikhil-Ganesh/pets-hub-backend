const db = require('../config/db');

function requiredSpeciesForCommunity(name) {
  const normalized = String(name || '').trim().toLowerCase();
  if (normalized === 'dog lovers') return 'dog';
  if (normalized === 'cat owners') return 'cat';
  return null;
}

async function getUserSpeciesSet(userId) {
  const [rows] = await db.query(
    'SELECT DISTINCT species FROM pet_profiles WHERE user_id = ? AND species IN (\'dog\', \'cat\')',
    [userId]
  );
  return new Set(rows.map((row) => String(row.species).toLowerCase()));
}

function canAccessCommunityByName(communityName, speciesSet) {
  const required = requiredSpeciesForCommunity(communityName);
  if (!required) return true;
  return speciesSet.has(required);
}

async function canUserAccessCommunity(userId, communityId) {
  const [[community]] = await db.query('SELECT id, name FROM communities WHERE id = ?', [communityId]);
  if (!community) {
    return { exists: false, allowed: false, requiredSpecies: null };
  }

  const requiredSpecies = requiredSpeciesForCommunity(community.name);
  if (!requiredSpecies) {
    return { exists: true, allowed: true, requiredSpecies: null, community };
  }

  const speciesSet = await getUserSpeciesSet(userId);
  const allowed = speciesSet.has(requiredSpecies);
  return { exists: true, allowed, requiredSpecies, community };
}

module.exports = {
  getUserSpeciesSet,
  canAccessCommunityByName,
  canUserAccessCommunity,
};
