const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');
const cors = require('cors');
const { v4: uuidv4 } = require('uuid');
const db = require('./db');
const { GameManager } = require('./game');
const { ROLES, SHOP_ITEMS } = require('./roles');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: '*', methods: ['GET', 'POST'] },
  pingTimeout: 60000,
  pingInterval: 25000
});

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, '../client/public')));

const gameManager = new GameManager();
const onlineUsers = new Map(); // socketId -> user data
const ADMIN_PASSWORD = '9944191q';

// ============ HELPERS ============
function getUser(id) {
  return db.getUser(id);
}

function updateUser(id, fields) {
  return db.updateUser(id, fields);
}

function broadcastOnline() {
  const count = onlineUsers.size;
  const list = [...onlineUsers.values()].map(u => ({
    id: u.id,
    nickname: u.nickname,
    avatar: u.avatar,
    rating: u.rating,
    isAdmin: !!u.is_admin
  }));
  io.emit('online:update', { count, list });
}

function saveChat(userId, nickname, message, type = 'global') {
  db.saveChat(userId, nickname, message, type);
}

// ============ API ============
app.get('/api/health', (_, res) => res.json({ ok: true, online: onlineUsers.size }));

app.get('/api/leaderboard', (_, res) => {
  res.json(db.getLeaderboard(50));
});

app.get('/api/shop', (_, res) => {
  res.json(Object.values(SHOP_ITEMS).filter(i => i.price > 0));
});

// ============ SOCKET ============
io.on('connection', (socket) => {
  let currentUser = null;

  // ---- AUTH / LOGIN ----
  socket.on('auth:login', ({ nickname, avatar }) => {
    nickname = (nickname || '').trim().slice(0, 20);
    if (!nickname || nickname.length < 2) {
      return socket.emit('auth:error', 'Никнейм от 2 до 20 символов');
    }
    if (!/^[a-zA-Zа-яА-ЯёЁ0-9_\- ]+$/.test(nickname)) {
      return socket.emit('auth:error', 'Ник содержит недопустимые символы');
    }

    let user = db.getUserByNick(nickname);

    if (!user) {
      const id = uuidv4();
      const av = avatar || `https://api.dicebear.com/9.x/avataaars/svg?seed=${encodeURIComponent(nickname)}&backgroundColor=b6e3f4,c0aede,d1d4f9`;
      user = db.createUser({
        id,
        nickname,
        avatar: av,
        coins: 10000, // welcome bonus
        rating: 1000,
        wins: 0,
        games: 0,
        is_admin: 0,
        is_banned: 0,
        ban_reason: null,
        welcome_claimed: 1,
        daily_claim_at: 0,
        created_at: Math.floor(Date.now() / 1000),
        last_seen: Math.floor(Date.now() / 1000)
      });
      // flag for client toast
      user._welcomeBonus = 10000;
    } else {
      if (user.is_banned) {
        return socket.emit('auth:error', `Вы забанены. Причина: ${user.ban_reason || 'не указана'}`);
      }
      if (avatar && avatar !== user.avatar) {
        updateUser(user.id, { avatar });
        user.avatar = avatar;
      }
      // One-time welcome bonus for older accounts
      if (!user.welcome_claimed) {
        const newCoins = (user.coins || 0) + 10000;
        updateUser(user.id, { coins: newCoins, welcome_claimed: 1 });
        user = getUser(user.id);
        user._welcomeBonus = 10000;
      } else {
        updateUser(user.id, {});
        user = getUser(user.id);
      }
    }

    // Disconnect previous session if any
    for (const [sid, u] of onlineUsers) {
      if (u.id === user.id && sid !== socket.id) {
        io.to(sid).emit('auth:kicked', 'Вход с другого устройства');
        io.sockets.sockets.get(sid)?.disconnect(true);
        onlineUsers.delete(sid);
      }
    }

    currentUser = user;
    onlineUsers.set(socket.id, user);
    socket.join('global');
    const dailyAt = user.daily_claim_at || 0;
    const nowSec = Math.floor(Date.now() / 1000);
    const dailyReady = nowSec >= dailyAt + 24 * 3600;
    const dailyLeft = dailyReady ? 0 : (dailyAt + 24 * 3600 - nowSec);

    socket.emit('auth:success', {
      id: user.id,
      nickname: user.nickname,
      avatar: user.avatar,
      coins: user.coins,
      rating: user.rating,
      wins: user.wins,
      games: user.games,
      isAdmin: !!user.is_admin,
      welcomeBonus: user._welcomeBonus || 0,
      dailyReady,
      dailyLeft
    });

    // Last chat messages
    const history = db.getChatHistory(50);
    socket.emit('chat:history', history);

    broadcastOnline();
    socket.emit('rooms:list', gameManager.getPublicRooms());
  });

  // ---- GLOBAL CHAT ----
  socket.on('chat:global', (msg) => {
    if (!currentUser) return;
    msg = (msg || '').trim().slice(0, 300);
    if (!msg) return;
    // Always fresh from DB so admin prefix is instant after promote
    const fresh = getUser(currentUser.id) || currentUser;
    if (fresh.is_banned) return;
    currentUser.is_admin = fresh.is_admin;
    currentUser.avatar = fresh.avatar;
    currentUser.coins = fresh.coins;
    currentUser.rating = fresh.rating;

    saveChat(currentUser.id, currentUser.nickname, msg, 'global');
    io.to('global').emit('chat:message', {
      nickname: currentUser.nickname,
      avatar: currentUser.avatar,
      message: msg,
      isAdmin: !!fresh.is_admin,
      time: Date.now()
    });
  });

  // ---- ROOMS ----
  socket.on('rooms:list', () => {
    socket.emit('rooms:list', gameManager.getPublicRooms());
  });

  socket.on('room:create', ({ name }) => {
    if (!currentUser) return;
    const room = gameManager.createRoom(currentUser.id, name);
    const joined = gameManager.joinRoom(room.id, socket.id, currentUser);
    if (joined) {
      socket.join(`room:${room.id}`);
      socket.emit('room:joined', room.getPublicState(currentUser.id));
      io.emit('rooms:list', gameManager.getPublicRooms());
    }
  });

  socket.on('room:join', ({ roomId }) => {
    if (!currentUser) return;
    // leave previous
    gameManager.leaveRoom(socket.id, currentUser.id);
    const room = gameManager.joinRoom(roomId, socket.id, currentUser);
    if (room) {
      socket.join(`room:${room.id}`);
      io.to(`room:${room.id}`).emit('room:update', room.getPublicState());
      socket.emit('room:joined', room.getPublicState(currentUser.id));
      io.emit('rooms:list', gameManager.getPublicRooms());
    } else {
      socket.emit('room:error', 'Не удалось войти в комнату');
    }
  });

  socket.on('room:leave', () => {
    if (!currentUser) return;
    const roomId = gameManager.userToRoom.get(currentUser.id);
    gameManager.leaveRoom(socket.id, currentUser.id);
    if (roomId) {
      socket.leave(`room:${roomId}`);
      const room = gameManager.getRoom(roomId);
      if (room) io.to(`room:${roomId}`).emit('room:update', room.getPublicState());
      io.emit('rooms:list', gameManager.getPublicRooms());
    }
    socket.emit('room:left');
  });

  // Host or admin kicks player from room
  socket.on('room:kick', ({ userId }) => {
    if (!currentUser) return;
    const roomId = gameManager.userToRoom.get(currentUser.id);
    const room = gameManager.getRoom(roomId);
    if (!room) return;
    const isHost = room.hostId === currentUser.id;
    if (!isHost && !currentUser.is_admin) return;
    for (const [sid, p] of room.players) {
      if (p.userId === userId) {
        gameManager.leaveRoom(sid, userId);
        io.to(sid).emit('room:kicked', { reason: 'Вас выгнали из комнаты' });
        io.to(sid).emit('room:left');
        const s = io.sockets.sockets.get(sid);
        if (s) s.leave(`room:${roomId}`);
        break;
      }
    }
    const updated = gameManager.getRoom(roomId);
    if (updated) io.to(`room:${roomId}`).emit('room:update', updated.getPublicState());
    io.emit('rooms:list', gameManager.getPublicRooms());
  });

  socket.on('room:ready', ({ ready }) => {
    if (!currentUser) return;
    const roomId = gameManager.userToRoom.get(currentUser.id);
    const room = gameManager.getRoom(roomId);
    if (!room || room.phase !== 'lobby') return;
    room.setReady(socket.id, !!ready);
    io.to(`room:${roomId}`).emit('room:update', room.getPublicState());
  });

  socket.on('room:start', () => {
    if (!currentUser) return;
    const roomId = gameManager.userToRoom.get(currentUser.id);
    const room = gameManager.getRoom(roomId);
    if (!room || room.hostId !== currentUser.id) return;
    if (room.players.size < 4) {
      return socket.emit('room:error', 'Минимум 4 игрока');
    }
    if (!room.start()) return;

    // Give private roles
    for (const p of room.players.values()) {
      io.to(p.socketId).emit('game:role', {
        role: p.role,
        info: ROLES[p.role]
      });
    }

    room.phase = 'night';
    room.dayNumber = 1;
    room.phaseEndsAt = Date.now() + 45000; // 45 sec night
    io.to(`room:${roomId}`).emit('room:update', room.getPublicState());
    io.to(`room:${roomId}`).emit('game:phase', { phase: 'night', day: 1, endsAt: room.phaseEndsAt });

    // Auto phase timer
    clearTimeout(room.timer);
    room.timer = setTimeout(() => advancePhase(roomId), 45000);
  });

  function advancePhase(roomId) {
    const room = gameManager.getRoom(roomId);
    if (!room) return;

    if (room.phase === 'night') {
      const killed = room.processNight();
      io.to(`room:${roomId}`).emit('game:nightResult', { killed });

      const win = room.checkWin();
      if (win) {
        endGame(room, win);
        return;
      }

      room.phase = 'day';
      room.phaseEndsAt = Date.now() + 60000;
      io.to(`room:${roomId}`).emit('room:update', room.getPublicState());
      io.to(`room:${roomId}`).emit('game:phase', { phase: 'day', day: room.dayNumber, endsAt: room.phaseEndsAt });
      room.timer = setTimeout(() => advancePhase(roomId), 60000);
    } else if (room.phase === 'day') {
      room.phase = 'voting';
      room.votes = {};
      for (const p of room.players.values()) p.voted = null;
      room.phaseEndsAt = Date.now() + 30000;
      io.to(`room:${roomId}`).emit('room:update', room.getPublicState());
      io.to(`room:${roomId}`).emit('game:phase', { phase: 'voting', day: room.dayNumber, endsAt: room.phaseEndsAt });
      room.timer = setTimeout(() => advancePhase(roomId), 30000);
    } else if (room.phase === 'voting') {
      const lynched = room.processVote();
      io.to(`room:${roomId}`).emit('game:voteResult', { lynched });

      const win = room.checkWin();
      if (win) {
        endGame(room, win);
        return;
      }

      room.dayNumber++;
      room.phase = 'night';
      room.nightActions = {};
      room.phaseEndsAt = Date.now() + 45000;
      io.to(`room:${roomId}`).emit('room:update', room.getPublicState());
      io.to(`room:${roomId}`).emit('game:phase', { phase: 'night', day: room.dayNumber, endsAt: room.phaseEndsAt });
      room.timer = setTimeout(() => advancePhase(roomId), 45000);
    }
  }

  function endGame(room, winner) {
    room.phase = 'ended';
    clearTimeout(room.timer);
    const state = room.getPublicState();
    io.to(`room:${room.id}`).emit('game:end', { winner, state });

    // Rewards
    for (const p of room.players.values()) {
      const role = room.roles.get(p.userId);
      const isMafia = role === 'mafia' || role === 'don' || role === 'lawyer';
      const isTown = !isMafia && role !== 'maniac';
      const won =
        (winner === 'mafia' && isMafia) ||
        (winner === 'town' && isTown) ||
        (winner === 'maniac' && role === 'maniac');

      const coinsGain = won ? 50 + Math.floor(Math.random() * 30) : 10;
      const ratingGain = won ? 25 : -10;

      const u = getUser(p.userId);
      if (u) {
        updateUser(p.userId, {
          coins: u.coins + coinsGain,
          rating: Math.max(100, u.rating + ratingGain),
          wins: u.wins + (won ? 1 : 0),
          games: u.games + 1
        });
        const updated = getUser(p.userId);
        io.to(p.socketId).emit('user:update', updated);
        io.to(p.socketId).emit('game:reward', {
          coins: coinsGain,
          rating: ratingGain,
          won
        });
      }
    }

    // Reset to lobby after 15s
    setTimeout(() => {
      room.phase = 'lobby';
      room.dayNumber = 0;
      for (const p of room.players.values()) {
        p.ready = false;
        p.alive = true;
        p.role = null;
        p.voted = null;
      }
      room.alive.clear();
      io.to(`room:${room.id}`).emit('room:update', room.getPublicState());
      io.emit('rooms:list', gameManager.getPublicRooms());
    }, 15000);
  }

  // Night action
  socket.on('game:nightAction', (data) => {
    if (!currentUser) return;
    const roomId = gameManager.userToRoom.get(currentUser.id);
    const room = gameManager.getRoom(roomId);
    if (!room || room.phase !== 'night') return;
    if (!room.alive.has(currentUser.id)) return;

    room.nightActions[currentUser.id] = data;
  });

  // Vote
  socket.on('game:vote', ({ targetId }) => {
    if (!currentUser) return;
    const roomId = gameManager.userToRoom.get(currentUser.id);
    const room = gameManager.getRoom(roomId);
    if (!room || room.phase !== 'voting') return;
    const p = room.players.get(socket.id);
    if (!p || !p.alive) return;
    p.voted = targetId;
    io.to(`room:${roomId}`).emit('room:update', room.getPublicState());
  });

  // Room chat
  socket.on('chat:room', (msg) => {
    if (!currentUser) return;
    const roomId = gameManager.userToRoom.get(currentUser.id);
    if (!roomId) return;
    msg = (msg || '').trim().slice(0, 300);
    if (!msg) return;
    const fresh = getUser(currentUser.id) || currentUser;
    io.to(`room:${roomId}`).emit('chat:roomMessage', {
      nickname: currentUser.nickname,
      avatar: currentUser.avatar,
      message: msg,
      isAdmin: !!fresh.is_admin,
      time: Date.now()
    });
  });

  // ============ SHOP ============
  socket.on('shop:buy', ({ itemId }) => {
    if (!currentUser) return;
    const item = SHOP_ITEMS[itemId];
    if (!item || !item.price) return socket.emit('shop:error', 'Товар не найден');

    const user = getUser(currentUser.id);
    if (user.coins < item.price) return socket.emit('shop:error', 'Недостаточно монет');

    // Check if already owned (for roles/cosmetics)
    if (db.hasItem(user.id, itemId) && item.type !== 'coins') return socket.emit('shop:error', 'Уже куплено');

    updateUser(user.id, { coins: user.coins - item.price });
    db.addInventory(user.id, itemId);

    currentUser = getUser(user.id);
    onlineUsers.set(socket.id, currentUser);
    socket.emit('shop:success', { itemId, coins: currentUser.coins });
    socket.emit('user:update', currentUser);
  });

  // ============ DAILY BONUS ============
  socket.on('bonus:claimDaily', () => {
    if (!currentUser) return;
    const u = getUser(currentUser.id);
    if (!u) return;
    const now = Math.floor(Date.now() / 1000);
    const last = u.daily_claim_at || 0;
    if (now < last + 24 * 3600) {
      const left = last + 24 * 3600 - now;
      return socket.emit('bonus:error', { message: 'Ещё рано', left });
    }
    const amount = 1 + Math.floor(Math.random() * 100); // 1..100
    updateUser(u.id, {
      coins: (u.coins || 0) + amount,
      daily_claim_at: now
    });
    const updated = getUser(u.id);
    currentUser.coins = updated.coins;
    onlineUsers.set(socket.id, { ...currentUser, coins: updated.coins });
    socket.emit('bonus:daily', {
      amount,
      coins: updated.coins,
      dailyLeft: 24 * 3600
    });
    socket.emit('user:update', { ...updated, isAdmin: !!updated.is_admin });
  });

  // ============ ADMIN ============
  socket.on('admin:login', ({ password }) => {
    if (!currentUser) return;
    // Already admin — open panel without password
    if (currentUser.is_admin) {
      socket.emit('admin:success', { isAdmin: true });
      socket.emit('user:update', { ...currentUser, isAdmin: true });
      return;
    }
    if (password !== ADMIN_PASSWORD) {
      return socket.emit('admin:error', 'Неверный пароль');
    }
    // Master password — promote to admin
    updateUser(currentUser.id, { is_admin: 1 });
    currentUser.is_admin = 1;
    onlineUsers.set(socket.id, currentUser);
    socket.emit('admin:success', { isAdmin: true });
    socket.emit('user:update', { ...currentUser, isAdmin: true, is_admin: 1 });
    broadcastOnline();
  });

  socket.on('admin:logout', () => {
    // Just client-side hide, keep is_admin flag
    socket.emit('admin:logout');
  });

  socket.on('admin:setAdmin', ({ userId, value }) => {
    if (!currentUser?.is_admin) return;
    if (userId === currentUser.id && !value) {
      return socket.emit('admin:error', 'Нельзя снять админку с себя');
    }
    updateUser(userId, { is_admin: value ? 1 : 0 });
    const updated = getUser(userId);
    for (const [sid, u] of onlineUsers) {
      if (u.id === userId) {
        u.is_admin = value ? 1 : 0;
        onlineUsers.set(sid, { ...u, is_admin: value ? 1 : 0 });
        io.to(sid).emit('user:update', {
          ...updated,
          isAdmin: !!value,
          is_admin: value ? 1 : 0
        });
        if (value) {
          io.to(sid).emit('admin:promoted', { by: currentUser.nickname });
        } else {
          io.to(sid).emit('admin:demoted', { by: currentUser.nickname });
        }
      }
    }
    broadcastOnline();
    socket.emit('admin:ok', value ? 'Админ назначен — префикс появится сразу' : 'Админ снят');
    socket.emit('admin:users', db.getAllUsers(100));
  });

  socket.on('admin:giveCoins', ({ userId, amount }) => {
    if (!currentUser?.is_admin) return;
    amount = parseInt(amount) || 0;
    if (amount === 0) return;
    const u = getUser(userId);
    if (!u) return;
    updateUser(userId, { coins: Math.max(0, u.coins + amount) });
    for (const [sid, ou] of onlineUsers) {
      if (ou.id === userId) {
        io.to(sid).emit('user:update', getUser(userId));
      }
    }
    socket.emit('admin:ok', `Выдано ${amount} монет`);
  });

  socket.on('admin:ban', ({ userId, reason }) => {
    if (!currentUser?.is_admin) return;
    if (userId === currentUser.id) return;
    updateUser(userId, { is_banned: 1, ban_reason: (reason || 'Нарушение правил').slice(0, 100) });
    for (const [sid, u] of onlineUsers) {
      if (u.id === userId) {
        io.to(sid).emit('auth:kicked', `Вы забанены: ${reason || 'Нарушение'}`);
        io.sockets.sockets.get(sid)?.disconnect(true);
        onlineUsers.delete(sid);
      }
    }
    broadcastOnline();
    socket.emit('admin:ok', 'Пользователь забанен');
    socket.emit('admin:users', db.getAllUsers(100));
  });

  socket.on('admin:unban', ({ userId }) => {
    if (!currentUser?.is_admin) return;
    updateUser(userId, { is_banned: 0, ban_reason: null });
    socket.emit('admin:ok', 'Бан снят');
    socket.emit('admin:users', db.getAllUsers(100));
  });

  socket.on('admin:kick', ({ userId }) => {
    if (!currentUser?.is_admin) return;
    for (const [sid, u] of onlineUsers) {
      if (u.id === userId) {
        io.to(sid).emit('auth:kicked', 'Вас кикнул администратор');
        io.sockets.sockets.get(sid)?.disconnect(true);
        onlineUsers.delete(sid);
        gameManager.leaveRoom(sid, userId);
      }
    }
    broadcastOnline();
    socket.emit('admin:ok', 'Игрок кикнут');
  });

  socket.on('admin:getUsers', () => {
    if (!currentUser?.is_admin) return;
    socket.emit('admin:users', db.getAllUsers(100));
  });

  // ---- DISCONNECT ----
  socket.on('disconnect', () => {
    if (currentUser) {
      gameManager.leaveRoom(socket.id, currentUser.id);
      onlineUsers.delete(socket.id);
      broadcastOnline();
      // Update rooms list
      io.emit('rooms:list', gameManager.getPublicRooms());
    }
  });
});

// Serve SPA
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, '../client/public/index.html'));
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`\n🎮 xDeyLoNx Mafia запущена на порту ${PORT}`);
  console.log(`   Открой http://localhost:${PORT}\n`);
});