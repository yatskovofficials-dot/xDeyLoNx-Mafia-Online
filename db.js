const fs = require('fs');
const path = require('path');

const dataDir = path.join(__dirname, 'data');
const dbPath = path.join(dataDir, 'mafia.json');
const tmpPath = path.join(dataDir, 'mafia.tmp.json');

if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });

function load() {
  try {
    if (fs.existsSync(dbPath)) {
      const raw = fs.readFileSync(dbPath, 'utf8');
      if (raw && raw.trim()) return JSON.parse(raw);
    }
  } catch (e) {
    console.error('[DB] load error:', e.message);
    // backup corrupt file
    try {
      fs.copyFileSync(dbPath, dbPath + '.bak.' + Date.now());
    } catch (_) {}
  }
  return { users: {}, inventory: {}, chat: [] };
}

function save(data) {
  try {
    const json = JSON.stringify(data);
    fs.writeFileSync(tmpPath, json);
    fs.renameSync(tmpPath, dbPath); // atomic replace
  } catch (e) {
    console.error('[DB] save error:', e.message);
    try {
      fs.writeFileSync(dbPath, JSON.stringify(data));
    } catch (e2) {
      console.error('[DB] fallback save failed:', e2.message);
    }
  }
}

let store = load();

const ownerId = 'owner-xdeylonx';
if (!store.users[ownerId]) {
  store.users[ownerId] = {
    id: ownerId,
    nickname: 'xDeyLoNx',
    avatar: 'https://api.dicebear.com/9.x/avataaars/svg?seed=xDeyLoNx&backgroundColor=b6e3f4',
    coins: 99999,
    rating: 2000,
    wins: 0,
    games: 0,
    is_admin: 1,
    is_banned: 0,
    ban_reason: null,
    welcome_claimed: 1,
    daily_claim_at: 0,
    created_at: Math.floor(Date.now() / 1000),
    last_seen: Math.floor(Date.now() / 1000)
  };
  save(store);
}

let migrated = false;
for (const u of Object.values(store.users)) {
  if (u.welcome_claimed === undefined) { u.welcome_claimed = 0; migrated = true; }
  if (u.daily_claim_at === undefined) { u.daily_claim_at = 0; migrated = true; }
  if (u.coins === undefined) { u.coins = 0; migrated = true; }
  if (u.rating === undefined) { u.rating = 1000; migrated = true; }
}
if (migrated) save(store);

// Auto-save every 30s (safety)
setInterval(() => save(store), 30000);

// Save on process exit
function flush() {
  try { save(store); } catch (_) {}
}
process.on('exit', flush);
process.on('SIGINT', () => { flush(); process.exit(0); });
process.on('SIGTERM', () => { flush(); process.exit(0); });

const db = {
  getUser(id) {
    return store.users[id] ? { ...store.users[id] } : null;
  },

  getUserByNick(nickname) {
    const lower = String(nickname).toLowerCase();
    for (const u of Object.values(store.users)) {
      if (u.nickname && u.nickname.toLowerCase() === lower) return { ...u };
    }
    return null;
  },

  createUser(user) {
    store.users[user.id] = { ...user };
    save(store);
    return { ...user };
  },

  updateUser(id, fields) {
    if (!store.users[id]) return null;
    Object.assign(store.users[id], fields, {
      last_seen: Math.floor(Date.now() / 1000)
    });
    save(store); // persist immediately: coins, rating, wins
    return { ...store.users[id] };
  },

  getLeaderboard(limit) {
    limit = limit || 50;
    return Object.values(store.users)
      .filter(u => !u.is_banned)
      .sort((a, b) => (b.rating || 0) - (a.rating || 0))
      .slice(0, limit)
      .map(u => ({
        nickname: u.nickname,
        avatar: u.avatar,
        rating: u.rating || 1000,
        wins: u.wins || 0,
        games: u.games || 0,
        coins: u.coins || 0
      }));
  },

  getAllUsers(limit) {
    limit = limit || 100;
    return Object.values(store.users)
      .sort((a, b) => (b.rating || 0) - (a.rating || 0))
      .slice(0, limit)
      .map(u => ({ ...u }));
  },

  addInventory(userId, itemId) {
    const key = userId + ':' + itemId;
    if (!store.inventory[key]) {
      store.inventory[key] = { user_id: userId, item_id: itemId, quantity: 1 };
      save(store);
    }
  },

  hasItem(userId, itemId) {
    return !!store.inventory[userId + ':' + itemId];
  },

  saveChat(userId, nickname, message, type) {
    type = type || 'global';
    store.chat.push({
      user_id: userId,
      nickname,
      message: String(message).slice(0, 500),
      type,
      created_at: Math.floor(Date.now() / 1000)
    });
    if (store.chat.length > 500) store.chat = store.chat.slice(-300);
    save(store);
  },

  getChatHistory(limit) {
    limit = limit || 50;
    return store.chat.filter(c => c.type === 'global').slice(-limit);
  }
};

module.exports = db;
