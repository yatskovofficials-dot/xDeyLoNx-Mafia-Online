const { v4: uuidv4 } = require('uuid');
const { ROLES, getRoleDistribution } = require('./roles');

class GameRoom {
  constructor(id, hostId, name = 'Комната', maxPlayers = 12) {
    this.id = id;
    this.name = name;
    this.hostId = hostId;
    this.maxPlayers = maxPlayers;
    this.players = new Map(); // socketId -> player
    this.phase = 'lobby'; // lobby | night | day | voting | results | ended
    this.dayNumber = 0;
    this.nightActions = {};
    this.votes = {};
    this.alive = new Set();
    this.roles = new Map(); // userId -> roleId
    this.timer = null;
    this.phaseEndsAt = null;
    this.chat = [];
    this.createdAt = Date.now();
  }

  addPlayer(socketId, user) {
    if (this.players.size >= this.maxPlayers) return false;
    if ([...this.players.values()].some(p => p.userId === user.id)) return false;

    this.players.set(socketId, {
      socketId,
      userId: user.id,
      nickname: user.nickname,
      avatar: user.avatar,
      ready: false,
      alive: true,
      role: null,
      voted: null
    });
    return true;
  }

  removePlayer(socketId) {
    const p = this.players.get(socketId);
    if (!p) return;
    this.players.delete(socketId);
    this.alive.delete(p.userId);
    if (this.hostId === p.userId && this.players.size > 0) {
      this.hostId = [...this.players.values()][0].userId;
    }
  }

  setReady(socketId, ready) {
    const p = this.players.get(socketId);
    if (p) p.ready = ready;
  }

  allReady() {
    if (this.players.size < 4) return false;
    return [...this.players.values()].every(p => p.ready);
  }

  start() {
    if (this.players.size < 4) return false;
    const dist = getRoleDistribution(this.players.size);
    const rolePool = [];
    for (const [roleId, count] of Object.entries(dist)) {
      for (let i = 0; i < count; i++) rolePool.push(roleId);
    }
    // shuffle
    for (let i = rolePool.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [rolePool[i], rolePool[j]] = [rolePool[j], rolePool[i]];
    }

    let idx = 0;
    this.roles.clear();
    this.alive.clear();
    for (const p of this.players.values()) {
      const role = rolePool[idx++] || 'civilian';
      p.role = role;
      p.alive = true;
      p.ready = false;
      p.voted = null;
      this.roles.set(p.userId, role);
      this.alive.add(p.userId);
    }

    this.dayNumber = 0;
    this.phase = 'night';
    this.nightActions = {};
    this.votes = {};
    return true;
  }

  getPublicState(forUserId = null) {
    const players = [...this.players.values()].map(p => ({
      userId: p.userId,
      nickname: p.nickname,
      avatar: p.avatar,
      ready: p.ready,
      alive: p.alive,
      role: (forUserId === p.userId || this.phase === 'ended' || this.phase === 'results')
        ? p.role
        : (p.alive ? null : p.role) // show role of dead
    }));

    return {
      id: this.id,
      name: this.name,
      hostId: this.hostId,
      phase: this.phase,
      dayNumber: this.dayNumber,
      maxPlayers: this.maxPlayers,
      players,
      phaseEndsAt: this.phaseEndsAt,
      aliveCount: this.alive.size
    };
  }

  getPrivateRole(userId) {
    return this.roles.get(userId) || null;
  }

  processNight() {
    // Resolve actions
    const kills = new Set();
    let heal = null;
    let block = null;

    // Mafia kill (majority or first)
    const mafiaVotes = {};
    for (const [uid, action] of Object.entries(this.nightActions)) {
      const role = this.roles.get(uid);
      if (!this.alive.has(uid)) continue;
      if ((role === 'mafia' || role === 'don') && action.kill) {
        mafiaVotes[action.kill] = (mafiaVotes[action.kill] || 0) + 1;
      }
      if (role === 'doctor' && action.heal) heal = action.heal;
      if (role === 'prostitute' && action.block) block = action.block;
      if (role === 'maniac' && action.kill) kills.add(action.kill);
    }

    let mafiaTarget = null;
    let maxVotes = 0;
    for (const [t, v] of Object.entries(mafiaVotes)) {
      if (v > maxVotes) {
        maxVotes = v;
        mafiaTarget = t;
      }
    }
    if (mafiaTarget) kills.add(mafiaTarget);

    // Apply heal
    if (heal) kills.delete(heal);

    // Apply kills
    const killed = [];
    for (const uid of kills) {
      if (this.alive.has(uid) && uid !== heal) {
        this.alive.delete(uid);
        const p = [...this.players.values()].find(x => x.userId === uid);
        if (p) p.alive = false;
        killed.push(uid);
      }
    }

    this.nightActions = {};
    return killed;
  }

  processVote() {
    const voteCount = {};
    for (const p of this.players.values()) {
      if (p.alive && p.voted) {
        voteCount[p.voted] = (voteCount[p.voted] || 0) + 1;
      }
    }
    let max = 0;
    let target = null;
    let tie = false;
    for (const [uid, cnt] of Object.entries(voteCount)) {
      if (cnt > max) {
        max = cnt;
        target = uid;
        tie = false;
      } else if (cnt === max) {
        tie = true;
      }
    }
    if (tie || !target || max === 0) return null;

    this.alive.delete(target);
    const p = [...this.players.values()].find(x => x.userId === target);
    if (p) p.alive = false;
    return target;
  }

  checkWin() {
    const alivePlayers = [...this.players.values()].filter(p => p.alive);
    const mafiaAlive = alivePlayers.filter(p => {
      const r = this.roles.get(p.userId);
      return r === 'mafia' || r === 'don' || r === 'lawyer';
    }).length;
    const townAlive = alivePlayers.length - mafiaAlive;
    const maniacAlive = alivePlayers.some(p => this.roles.get(p.userId) === 'maniac');

    if (maniacAlive && alivePlayers.length === 1) return 'maniac';
    if (mafiaAlive === 0) return 'town';
    if (mafiaAlive >= townAlive) return 'mafia';
    return null;
  }
}

class GameManager {
  constructor() {
    this.rooms = new Map();
    this.userToRoom = new Map(); // userId -> roomId
  }

  createRoom(hostId, name) {
    const id = uuidv4().slice(0, 8);
    const room = new GameRoom(id, hostId, name || `Комната ${id}`);
    this.rooms.set(id, room);
    return room;
  }

  getRoom(id) {
    return this.rooms.get(id);
  }

  joinRoom(roomId, socketId, user) {
    const room = this.rooms.get(roomId);
    if (!room) return null;
    if (room.phase !== 'lobby') return null;
    if (room.addPlayer(socketId, user)) {
      this.userToRoom.set(user.id, roomId);
      return room;
    }
    return null;
  }

  leaveRoom(socketId, userId) {
    const roomId = this.userToRoom.get(userId);
    if (!roomId) return;
    const room = this.rooms.get(roomId);
    if (room) {
      room.removePlayer(socketId);
      if (room.players.size === 0) {
        this.rooms.delete(roomId);
      }
    }
    this.userToRoom.delete(userId);
  }

  getPublicRooms() {
    return [...this.rooms.values()]
      .filter(r => r.phase === 'lobby')
      .map(r => ({
        id: r.id,
        name: r.name,
        players: r.players.size,
        maxPlayers: r.maxPlayers,
        host: [...r.players.values()].find(p => p.userId === r.hostId)?.nickname || '—'
      }));
  }
}

module.exports = { GameManager, GameRoom };