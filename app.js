(() => {
  const socket = io({ transports: ['websocket', 'polling'] });

  // Telegram WebApp
  const tg = window.Telegram && window.Telegram.WebApp;
  let tgUser = null;
  if (tg) {
    try {
      tg.ready();
      tg.expand();
      if (tg.setHeaderColor) tg.setHeaderColor('#070b14');
      if (tg.setBackgroundColor) tg.setBackgroundColor('#070b14');
      const u = tg.initDataUnsafe && tg.initDataUnsafe.user;
      if (u) {
        tgUser = {
          id: u.id,
          nickname: (u.username || u.first_name || ('tg_' + u.id)).toString().slice(0, 20),
          avatar: u.photo_url || null,
          first_name: u.first_name || ''
        };
      }
    } catch (e) { console.warn('TG init', e); }
  }

  let me = null;

  // Hard reset UI layers on boot
  function resetLayers() {
    document.querySelectorAll('.modal, .reward-overlay, .matchmaking-overlay').forEach(el => {
      el.classList.remove('active');
    });
  }
  resetLayers();

  let currentRoom = null;
  let chatMode = 'global';
  let isAdminPanel = false;
  let myRole = null;
  let phaseEndsAt = null;
  let timerInterval = null;
  let mmTimer = null;
  let lastRooms = [];

  const $ = (s) => document.querySelector(s);
  const $$ = (s) => document.querySelectorAll(s);

  // ========== SPLASH ==========
  setTimeout(() => {
    $('#screen-splash').classList.remove('active');
    $('#screen-login').classList.add('active');
    setupTelegramLogin();
  }, 2200);

  function toast(msg, type = '') {
    const el = document.createElement('div');
    el.className = `toast ${type}`;
    el.textContent = msg;
    $('#toasts').appendChild(el);
    setTimeout(() => el.remove(), 4000);
  }

  function showScreen(name) {
    ['splash', 'login', 'main'].forEach(n => {
      const el = $(`#screen-${n}`);
      if (el) el.classList.toggle('active', n === name);
    });
  }

  function formatTime(ts) {
    return new Date(ts).toLocaleTimeString('ru', { hour: '2-digit', minute: '2-digit' });
  }

  function escapeHtml(str) {
    return String(str)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  function updateUserUI() {
    if (!me) return;
    $('#user-avatar').src = me.avatar;
    $('#user-nick').textContent = me.nickname;
    $('#user-coins').textContent = me.coins;
    $('#user-rating').textContent = me.rating;
    const badge = $('#user-admin-badge');
    if (me.isAdmin) badge.classList.remove('hidden');
    else badge.classList.add('hidden');
  }

  function showReward(coins, rating, won) {
    const ov = $('#reward-overlay');
    $('#reward-icon').textContent = won ? '🏆' : '🪙';
    $('#reward-title').textContent = won ? 'Победа!' : 'Участие';
    $('#reward-amount').textContent = `+${coins} монет`;
    $('#reward-sub').textContent = rating >= 0 ? `Рейтинг +${rating}` : `Рейтинг ${rating}`;
    ov.classList.add('active');
    setTimeout(() => ov.classList.remove('active'), 3200);
  }

  // ========== LOGIN ==========
  function doLogin(nickname, avatar) {
    nickname = (nickname || '').trim();
    if (nickname.length < 2) return toast('Ник слишком короткий', 'error');
    socket.emit('auth:login', { nickname, avatar: avatar || null });
  }

  $('#btn-login').onclick = () => {
    if (tgUser) {
      doLogin(tgUser.nickname, tgUser.avatar);
      return;
    }
    const nickname = $('#input-nickname').value.trim();
    const avatar = $('#input-avatar').value.trim() || null;
    doLogin(nickname, avatar);
  };
  $('#input-nickname').onkeydown = (e) => { if (e.key === 'Enter') $('#btn-login').click(); };

  // After splash: if Telegram — show profile + auto-fill, optional auto-login
  function setupTelegramLogin() {
    if (!tgUser) return;
    const manual = $('#manual-login');
    const profile = $('#tg-profile');
    const hint = $('#login-hint');
    if (manual) manual.classList.add('hidden');
    if (profile) {
      profile.classList.remove('hidden');
      const img = $('#tg-avatar-preview');
      const name = $('#tg-name-preview');
      if (img) {
        img.src = tgUser.avatar || ('https://api.dicebear.com/9.x/avataaars/svg?seed=' + encodeURIComponent(tgUser.nickname));
      }
      if (name) name.textContent = tgUser.nickname;
    }
    if (hint) hint.textContent = 'Вход через Telegram — ник и аватар уже подтянуты';
    const btn = $('#btn-login');
    if (btn) btn.textContent = 'Войти как ' + tgUser.nickname;
  }

  let dailyLeftSec = 0;
  let dailyTimer = null;

  function formatCountdown(sec) {
    if (sec <= 0) return 'Забрать';
    const h = Math.floor(sec / 3600);
    const m = Math.floor((sec % 3600) / 60);
    const s = sec % 60;
    if (h > 0) return `${h}ч ${String(m).padStart(2,'0')}м`;
    return `${m}:${String(s).padStart(2,'0')}`;
  }

  function updateDailyUI() {
    const btn = $('#btn-daily');
    const label = $('#daily-label');
    if (!btn || !label) return;
    if (dailyLeftSec <= 0) {
      label.textContent = 'Забрать';
      btn.disabled = false;
      btn.classList.add('ready');
    } else {
      label.textContent = formatCountdown(dailyLeftSec);
      btn.disabled = true;
      btn.classList.remove('ready');
    }
  }

  function startDailyCountdown(left) {
    dailyLeftSec = Math.max(0, left | 0);
    updateDailyUI();
    clearInterval(dailyTimer);
    if (dailyLeftSec <= 0) return;
    dailyTimer = setInterval(() => {
      dailyLeftSec--;
      if (dailyLeftSec <= 0) {
        clearInterval(dailyTimer);
        dailyLeftSec = 0;
      }
      updateDailyUI();
    }, 1000);
  }

  socket.on('auth:success', (user) => {
    me = user;
    updateUserUI();
    showScreen('main');
    loadShop();
    loadLeaderboard();
    toast(`Добро пожаловать, ${user.nickname}!`, 'success');

    if (user.welcomeBonus && user.welcomeBonus > 0) {
      setTimeout(() => {
        showReward(user.welcomeBonus, 0, true);
        const t = $('#reward-title');
        const i = $('#reward-icon');
        if (t) t.textContent = 'Приветственный бонус!';
        if (i) i.textContent = '🎁';
        const sub = $('#reward-sub');
        if (sub) sub.textContent = 'Один раз при первом входе';
      }, 600);
    }

    startDailyCountdown(user.dailyReady ? 0 : (user.dailyLeft || 0));
  });
  socket.on('auth:error', (msg) => toast(msg, 'error'));
  socket.on('auth:kicked', (msg) => {
    toast(msg, 'error');
    setTimeout(() => location.reload(), 2000);
  });
  socket.on('user:update', (user) => {
    if (me && user.id === me.id) {
      me = { ...me, ...user, isAdmin: !!user.is_admin || !!user.isAdmin };
      updateUserUI();
    }
  });

  // ========== ONLINE ==========
  socket.on('online:update', ({ count, list }) => {
    $('#online-num').textContent = count;
    if (isAdminPanel) renderAdminOnline(list);
  });

  // ========== TABS ==========
  $$('.tab').forEach(tab => {
    tab.onclick = () => {
      $$('.tab').forEach(t => t.classList.remove('active'));
      $$('.tab-content').forEach(c => c.classList.remove('active'));
      tab.classList.add('active');
      $(`#tab-${tab.dataset.tab}`).classList.add('active');
      if (tab.dataset.tab === 'leaderboard') loadLeaderboard();
      if (tab.dataset.tab === 'shop') loadShop();
    };
  });

  // ========== ROOMS + QUICK MATCH ==========
  socket.on('rooms:list', (rooms) => {
    lastRooms = rooms || [];
    const list = $('#rooms-list');
    if (!lastRooms.length) {
      list.innerHTML = '<p style="color:var(--text2);font-size:13px;text-align:center;padding:16px">Нет открытых комнат — создай свою!</p>';
      return;
    }
    list.innerHTML = lastRooms.map(r => `
      <div class="room-card" data-id="${r.id}">
        <div class="name">${escapeHtml(r.name)}</div>
        <div class="meta">
          <span>👥 ${r.players}/${r.maxPlayers}</span>
          <span>${escapeHtml(r.host)}</span>
        </div>
      </div>
    `).join('');
    list.querySelectorAll('.room-card').forEach(card => {
      card.onclick = () => socket.emit('room:join', { roomId: card.dataset.id });
    });
  });

  $('#btn-create-room').onclick = () => {
    const name = prompt('Название комнаты:', `Комната ${me?.nickname || ''}`);
    if (name !== null) socket.emit('room:create', { name: name.slice(0, 30) || undefined });
  };

  // Quick match: join any lobby with free slots, or create
  $('#btn-quick-match').onclick = () => {
    if (!me) return;
    $('#matchmaking-overlay').classList.add('active');
    $('#mm-status').textContent = 'Ищем свободную комнату...';

    const tryJoin = () => {
      const free = lastRooms.find(r => r.players < r.maxPlayers);
      if (free) {
        $('#mm-status').textContent = `Входим в «${free.name}»...`;
        socket.emit('room:join', { roomId: free.id });
        setTimeout(() => {
          $('#matchmaking-overlay').classList.remove('active');
        }, 800);
        return true;
      }
      return false;
    };

    if (tryJoin()) return;

    // Refresh list and retry a few times
    let attempts = 0;
    mmTimer = setInterval(() => {
      attempts++;
      socket.emit('rooms:list');
      setTimeout(() => {
        if (tryJoin() || attempts >= 4) {
          clearInterval(mmTimer);
          if (attempts >= 4 && !currentRoom) {
            $('#mm-status').textContent = 'Создаём новую комнату...';
            socket.emit('room:create', { name: `Быстрая · ${me.nickname}` });
            setTimeout(() => $('#matchmaking-overlay').classList.remove('active'), 1000);
          }
        }
      }, 400);
    }, 1200);
  };

  $('#btn-mm-cancel').onclick = () => {
    clearInterval(mmTimer);
    $('#matchmaking-overlay').classList.remove('active');
  };

  socket.on('room:joined', (state) => {
    clearInterval(mmTimer);
    $('#matchmaking-overlay').classList.remove('active');
    currentRoom = state;
    showRoomView();
    renderRoom(state);
    $('#chat-tab-room').disabled = false;
    toast('Вы в комнате!', 'success');
  });

  socket.on('room:update', (state) => {
    currentRoom = state;
    renderRoom(state);
  });

  socket.on('room:left', () => {
    currentRoom = null;
    myRole = null;
    showLobbyView();
    $('#chat-tab-room').disabled = true;
    switchChat('global');
  });

  socket.on('room:error', (msg) => {
    toast(msg, 'error');
    $('#matchmaking-overlay').classList.remove('active');
  });

  function showRoomView() {
    $('#view-lobby').classList.remove('active');
    $('#view-room').classList.add('active');
    if (window.innerWidth <= 900) {
      const sidebar = $('#sidebar');
      const chat = $('#chat-panel');
      const center = document.querySelector('.center');
      if (sidebar) { sidebar.classList.remove('mobile-show'); sidebar.style.display = 'none'; }
      if (chat) { chat.classList.remove('mobile-show'); chat.style.display = 'none'; }
      if (center) { center.classList.add('mobile-show'); center.style.display = 'flex'; }
    }
  }
  function showLobbyView() {
    $('#view-room').classList.remove('active');
    $('#view-lobby').classList.add('active');
    if (window.innerWidth <= 900) {
      showMobilePanel('play');
    }
  }

  function renderRoom(state) {
    $('#room-name').textContent = state.name;
    const phaseNames = {
      lobby: 'Лобби',
      night: `Ночь ${state.dayNumber}`,
      day: `День ${state.dayNumber}`,
      voting: 'Голосование',
      ended: 'Конец'
    };
    $('#room-phase').textContent = phaseNames[state.phase] || state.phase;

    if (state.phaseEndsAt) {
      phaseEndsAt = state.phaseEndsAt;
      startTimer();
    } else {
      $('#room-timer').textContent = '';
      clearInterval(timerInterval);
    }

    const grid = $('#room-players');
    grid.innerHTML = state.players.map(p => {
      const isMe = p.userId === me.id;
      const isHost = p.userId === state.hostId;
      let roleHtml = '';
      if (p.role) {
        roleHtml = `<div class="role-badge" style="background:${getRoleColor(p.role)}22;color:${getRoleColor(p.role)}">${getRoleName(p.role)}</div>`;
      }
      return `
        <div class="player-card ${p.alive === false ? 'dead' : ''} ${p.ready ? 'ready' : ''} ${isHost ? 'host' : ''}" data-uid="${p.userId}">
          <img src="${p.avatar}" alt="" />
          <div class="nick">${escapeHtml(p.nickname)}${isMe ? ' (вы)' : ''}</div>
          ${roleHtml}
        </div>
      `;
    }).join('');

    const isHost = state.hostId === me.id;
    const amIReady = state.players.find(p => p.userId === me.id)?.ready;
    $('#btn-ready').textContent = amIReady ? 'Не готов' : 'Готов';
    $('#btn-ready').classList.toggle('hidden', state.phase !== 'lobby');
    $('#btn-start').classList.toggle('hidden', !(isHost && state.phase === 'lobby'));
    renderGameActions(state);
  }

  function getRoleName(id) {
    const map = {
      civilian: 'Мирный', mafia: 'Мафия', don: 'Дон', doctor: 'Доктор',
      sheriff: 'Шериф', maniac: 'Маньяк', prostitute: 'Красотка',
      lawyer: 'Адвокат', journalist: 'Журналист', bodyguard: 'Телохранитель'
    };
    return map[id] || id;
  }
  function getRoleColor(id) {
    const map = {
      civilian: '#94a3b8', mafia: '#ef4444', don: '#dc2626', doctor: '#22c55e',
      sheriff: '#3b82f6', maniac: '#a855f7', prostitute: '#ec4899',
      lawyer: '#f59e0b', journalist: '#06b6d4', bodyguard: '#64748b'
    };
    return map[id] || '#94a3b8';
  }

  $('#btn-ready').onclick = () => {
    const amIReady = currentRoom?.players.find(p => p.userId === me.id)?.ready;
    socket.emit('room:ready', { ready: !amIReady });
  };
  $('#btn-start').onclick = () => socket.emit('room:start');
  $('#btn-leave-room').onclick = () => socket.emit('room:leave');

  // ========== GAME ==========
  socket.on('game:role', ({ role, info }) => {
    myRole = role;
    const card = $('#game-role');
    card.classList.remove('hidden');
    card.innerHTML = `
      <div class="icon">${info.icon}</div>
      <div class="name" style="color:${info.color}">${info.name}</div>
      <div class="desc">${info.description}</div>
    `;
  });

  socket.on('game:phase', ({ phase, day, endsAt }) => {
    phaseEndsAt = endsAt;
    startTimer();
    if (currentRoom) {
      currentRoom.phase = phase;
      currentRoom.dayNumber = day;
      renderRoom(currentRoom);
    }
  });

  socket.on('game:nightResult', ({ killed }) => {
    if (killed.length) toast(`Ночью убит(ы): ${killed.length}`, 'error');
    else toast('Ночь прошла спокойно', 'success');
  });

  socket.on('game:voteResult', ({ lynched }) => {
    if (lynched) toast('Игрок казнён', 'error');
    else toast('Ничья — никто не казнён');
  });

  socket.on('game:end', ({ winner, state }) => {
    const names = { town: 'Мирные', mafia: 'Мафия', maniac: 'Маньяк' };
    toast(`Победа: ${names[winner] || winner}!`, 'success');
    currentRoom = state;
    renderRoom(state);
    $('#game-role').classList.add('hidden');
    $('#game-actions').classList.add('hidden');
  });

  socket.on('game:reward', ({ coins, rating, won }) => {
    showReward(coins, rating, won);
  });

  function renderGameActions(state) {
    const box = $('#game-actions');
    box.innerHTML = '';
    box.classList.add('hidden');
    if (!myRole || !state) return;
    const mePlayer = state.players.find(p => p.userId === me.id);
    if (!mePlayer || !mePlayer.alive) return;
    const alive = state.players.filter(p => p.alive && p.userId !== me.id);

    if (state.phase === 'night') {
      box.classList.remove('hidden');
      if (['mafia', 'don', 'maniac'].includes(myRole)) {
        box.innerHTML = '<p>Выберите жертву:</p>';
        alive.forEach(p => {
          const btn = document.createElement('button');
          btn.className = 'btn btn-accent';
          btn.textContent = p.nickname;
          btn.onclick = () => {
            socket.emit('game:nightAction', { kill: p.userId });
            toast(`Жертва: ${p.nickname}`);
            box.innerHTML = '<p style="color:var(--success)">Выбрано</p>';
          };
          box.appendChild(btn);
        });
      } else if (myRole === 'doctor') {
        box.innerHTML = '<p>Кого вылечить:</p>';
        [...alive, mePlayer].forEach(p => {
          const btn = document.createElement('button');
          btn.className = 'btn btn-primary';
          btn.textContent = p.userId === me.id ? 'Себя' : p.nickname;
          btn.onclick = () => {
            socket.emit('game:nightAction', { heal: p.userId });
            toast('Лечение выбрано');
            box.innerHTML = '<p style="color:var(--success)">Готово</p>';
          };
          box.appendChild(btn);
        });
      } else if (myRole === 'sheriff') {
        box.innerHTML = '<p>Кого проверить:</p>';
        alive.forEach(p => {
          const btn = document.createElement('button');
          btn.className = 'btn btn-primary';
          btn.textContent = p.nickname;
          btn.onclick = () => {
            socket.emit('game:nightAction', { check: p.userId });
            toast(`Проверка: ${p.nickname}`);
            box.innerHTML = '<p style="color:var(--success)">Отправлено</p>';
          };
          box.appendChild(btn);
        });
      } else if (myRole === 'prostitute') {
        box.innerHTML = '<p>Кого заблокировать:</p>';
        alive.forEach(p => {
          const btn = document.createElement('button');
          btn.className = 'btn btn-primary';
          btn.textContent = p.nickname;
          btn.onclick = () => {
            socket.emit('game:nightAction', { block: p.userId });
            toast('Блок выбран');
            box.innerHTML = '<p style="color:var(--success)">Готово</p>';
          };
          box.appendChild(btn);
        });
      }
    }

    if (state.phase === 'voting') {
      box.classList.remove('hidden');
      box.innerHTML = '<p>За кого голосуете:</p>';
      alive.forEach(p => {
        const btn = document.createElement('button');
        btn.className = 'btn btn-accent';
        btn.textContent = p.nickname;
        btn.onclick = () => {
          socket.emit('game:vote', { targetId: p.userId });
          toast(`Голос за ${p.nickname}`);
          box.querySelectorAll('button').forEach(b => b.disabled = true);
        };
        box.appendChild(btn);
      });
    }
  }

  function startTimer() {
    clearInterval(timerInterval);
    const el = $('#room-timer');
    timerInterval = setInterval(() => {
      if (!phaseEndsAt) return;
      const left = Math.max(0, Math.ceil((phaseEndsAt - Date.now()) / 1000));
      el.textContent = left > 0 ? `${left}с` : '';
      if (left <= 0) clearInterval(timerInterval);
    }, 200);
  }

  // ========== CHAT ==========
  $$('.chat-tab').forEach(tab => {
    tab.onclick = () => { if (!tab.disabled) switchChat(tab.dataset.chat); };
  });

  function switchChat(mode) {
    chatMode = mode;
    $$('.chat-tab').forEach(t => t.classList.toggle('active', t.dataset.chat === mode));
    $('#chat-messages').innerHTML = '';
  }

  function addChatMessage(data, isRoom = false) {
    if ((isRoom && chatMode !== 'room') || (!isRoom && chatMode !== 'global')) return;
    const box = $('#chat-messages');
    const div = document.createElement('div');
    div.className = 'chat-msg';
    const adminPrefix = data.isAdmin ? '<span class="admin-prefix">АДМИН</span>' : '';
    div.innerHTML = `
      <img src="${data.avatar || ''}" alt="" onerror="this.style.display='none'" />
      <div class="body">
        <span class="nick ${data.isAdmin ? 'admin' : ''}">${adminPrefix}${escapeHtml(data.nickname)}</span>
        <span class="time">${formatTime(data.time || Date.now())}</span>
        <div class="text">${escapeHtml(data.message)}</div>
      </div>
    `;
    box.appendChild(div);
    box.scrollTop = box.scrollHeight;
  }

  socket.on('chat:history', (msgs) => {
    const box = $('#chat-messages');
    box.innerHTML = '';
    msgs.forEach(m => addChatMessage({
      nickname: m.nickname,
      message: m.message,
      time: m.created_at * 1000,
      avatar: `https://api.dicebear.com/9.x/avataaars/svg?seed=${encodeURIComponent(m.nickname)}`,
      isAdmin: false
    }));
  });

  socket.on('chat:message', (data) => addChatMessage(data, false));
  socket.on('chat:roomMessage', (data) => addChatMessage(data, true));

  $('#btn-send-chat').onclick = sendChat;
  $('#chat-input').onkeydown = (e) => { if (e.key === 'Enter') sendChat(); };

  function sendChat() {
    const input = $('#chat-input');
    const msg = input.value.trim();
    if (!msg) return;
    if (chatMode === 'global') socket.emit('chat:global', msg);
    else socket.emit('chat:room', msg);
    input.value = '';
  }

  // ========== SHOP ==========
  function loadShop() {
    fetch('/api/shop').then(r => r.json()).then(items => {
      const list = $('#shop-list');
      list.innerHTML = items.map(item => `
        <div class="shop-item">
          <div class="icon">${item.icon || '📦'}</div>
          <div class="info">
            <div class="name">${escapeHtml(item.name)}</div>
            <div class="desc">${escapeHtml(item.description || '')}</div>
          </div>
          <button class="btn btn-accent" data-id="${item.id}" style="padding:6px 10px;font-size:12px">
            🪙 ${item.price}
          </button>
        </div>
      `).join('');
      list.querySelectorAll('button').forEach(btn => {
        btn.onclick = () => socket.emit('shop:buy', { itemId: btn.dataset.id });
      });
    }).catch(() => {});
  }

  socket.on('shop:success', ({ coins }) => {
    if (me) me.coins = coins;
    updateUserUI();
    toast('Покупка успешна!', 'success');
  });
  socket.on('shop:error', (msg) => toast(msg, 'error'));

  // ========== LEADERBOARD ==========
  function loadLeaderboard() {
    fetch('/api/leaderboard').then(r => r.json()).then(top => {
      $('#leaderboard-list').innerHTML = top.map((u, i) => `
        <div class="lb-item">
          <div class="rank">${i + 1}</div>
          <img class="avatar" src="${u.avatar}" alt="" />
          <div class="info">
            <div class="nick">${escapeHtml(u.nickname)}</div>
            <div class="stats">⭐ ${u.rating} · 🏆 ${u.wins} · 🪙 ${u.coins}</div>
          </div>
        </div>
      `).join('');
    }).catch(() => {});
  }

  // ========== DAILY BONUS ==========
  $('#btn-daily').onclick = () => {
    if (dailyLeftSec > 0) return;
    socket.emit('bonus:claimDaily');
  };

  socket.on('bonus:daily', ({ amount, coins, dailyLeft }) => {
    if (me) me.coins = coins;
    updateUserUI();
    showReward(amount, 0, amount >= 50);
    const t = $('#reward-title');
    const i = $('#reward-icon');
    if (t) t.textContent = 'Ежедневный бонус!';
    if (i) i.textContent = '🎁';
    const sub = $('#reward-sub');
    if (sub) sub.textContent = 'Следующий через 24 часа';
    startDailyCountdown(dailyLeft || 24 * 3600);
    toast(`+${amount} монет!`, 'success');
  });

  socket.on('bonus:error', ({ message, left }) => {
    toast(message || 'Подождите', 'error');
    if (left) startDailyCountdown(left);
  });

  // ========== ADMIN ==========
  let allAdminUsers = [];

  function openAdminPanel() {
    // Already admin → open without password
    if (me && me.isAdmin) {
      socket.emit('admin:login', { password: '' });
      return;
    }
    $('#modal-admin-login').classList.add('active');
    $('#admin-password').value = '';
    setTimeout(() => $('#admin-password').focus(), 80);
  }

  $('#logo-click').onclick = openAdminPanel;
  $('#logo-click-main').onclick = openAdminPanel;

  $('#btn-admin-cancel').onclick = () => $('#modal-admin-login').classList.remove('active');
  $('#btn-admin-enter').onclick = () => {
    socket.emit('admin:login', { password: $('#admin-password').value });
  };
  $('#admin-password').onkeydown = (e) => { if (e.key === 'Enter') $('#btn-admin-enter').click(); };

  socket.on('admin:success', () => {
    $('#modal-admin-login').classList.remove('active');
    isAdminPanel = true;
    me.isAdmin = true;
    updateUserUI();
    $('#modal-admin').classList.add('active');
    socket.emit('admin:getUsers');
    toast('Админ-панель открыта', 'success');
  });

  socket.on('admin:error', (msg) => toast(msg, 'error'));
  socket.on('admin:ok', (msg) => toast(msg, 'success'));

  socket.on('admin:promoted', ({ by }) => {
    me.isAdmin = true;
    updateUserUI();
    const panel = $('#user-panel');
    panel.classList.add('promoted');
    setTimeout(() => panel.classList.remove('promoted'), 1400);
    toast(`${by || 'Админ'} назначил вас администратором!`, 'success');
  });

  socket.on('admin:demoted', ({ by }) => {
    me.isAdmin = false;
    updateUserUI();
    toast(`${by || 'Админ'} снял с вас права администратора`, 'error');
  });

  socket.on('admin:logout', () => {
    isAdminPanel = false;
    $('#modal-admin').classList.remove('active');
  });

  $('#btn-admin-exit').onclick = () => {
    isAdminPanel = false;
    $('#modal-admin').classList.remove('active');
    socket.emit('admin:logout');
  };

  // Search filter
  document.addEventListener('input', (e) => {
    if (e.target && e.target.id === 'admin-search') {
      renderAdminUsers(allAdminUsers, e.target.value);
    }
  });

  socket.on('admin:users', (users) => {
    allAdminUsers = users || [];
    const search = ($('#admin-search') || {}).value || '';
    renderAdminUsers(allAdminUsers, search);
    // stats
    const onlineEl = $('#astat-online');
    const usersEl = $('#astat-users');
    const adminsEl = $('#astat-admins');
    if (usersEl) usersEl.textContent = allAdminUsers.length;
    if (adminsEl) adminsEl.textContent = allAdminUsers.filter(u => u.is_admin).length;
  });

  function renderAdminUsers(users, query) {
    const list = $('#admin-users-list');
    if (!list) return;
    const q = (query || '').trim().toLowerCase();
    const filtered = q
      ? users.filter(u => (u.nickname || '').toLowerCase().includes(q))
      : users;

    list.innerHTML = filtered.map(u => {
      const isMe = me && u.id === me.id;
      return `
      <div class="admin-user" data-id="${u.id}">
        <img src="${u.avatar}" alt="" />
        <div class="info">
          <b>${escapeHtml(u.nickname)}</b>
          ${u.is_admin ? ' <span class="admin-badge">АДМИН</span>' : ''}
          ${u.is_banned ? ' <span style="color:var(--accent);font-size:10px;font-weight:700">БАН</span>' : ''}
          ${isMe ? ' <span style="color:var(--text2);font-size:10px">(вы)</span>' : ''}
          <div class="meta">⭐ ${u.rating} · 🪙 ${u.coins} · 🏆 ${u.wins || 0}</div>
        </div>
        <div class="actions">
          <button class="btn btn-admin-gold" data-act="coins" data-id="${u.id}" title="Выдать монеты">+🪙</button>
          <button class="btn btn-admin-blue" data-act="admin" data-id="${u.id}" data-val="${u.is_admin ? 0 : 1}" title="${u.is_admin ? 'Снять админ' : 'Назначить админ'}">
            ${u.is_admin ? '−Админ' : '+Админ'}
          </button>
          <button class="btn btn-admin-danger" data-act="kick" data-id="${u.id}" title="Кикнуть">Кик</button>
          ${u.is_banned
            ? `<button class="btn btn-admin-ok" data-act="unban" data-id="${u.id}" title="Разбанить">Разбан</button>`
            : `<button class="btn btn-admin-danger" data-act="ban" data-id="${u.id}" title="Забанить">Бан</button>`
          }
        </div>
      </div>`;
    }).join('') || '<p style="color:var(--text2);font-size:13px;padding:12px;text-align:center">Никого не найдено</p>';

    list.querySelectorAll('button').forEach(btn => {
      btn.onclick = () => {
        const id = btn.dataset.id;
        const act = btn.dataset.act;
        if (act === 'coins') {
          const amount = prompt('Сколько монет выдать? (можно отрицательное число)', '100');
          if (amount !== null && amount !== '') {
            socket.emit('admin:giveCoins', { userId: id, amount: parseInt(amount, 10) });
          }
        } else if (act === 'admin') {
          const make = +btn.dataset.val === 1;
          if (!confirm(make ? 'Назначить администратором? Префикс АДМИН появится сразу.' : 'Снять права администратора?')) return;
          socket.emit('admin:setAdmin', { userId: id, value: make ? 1 : 0 });
        } else if (act === 'kick') {
          if (!confirm('Кикнуть игрока с сервера?')) return;
          socket.emit('admin:kick', { userId: id });
        } else if (act === 'ban') {
          const reason = prompt('Причина бана:', 'Нарушение правил');
          if (reason !== null) socket.emit('admin:ban', { userId: id, reason });
        } else if (act === 'unban') {
          socket.emit('admin:unban', { userId: id });
        }
      };
    });
  }

  function renderAdminOnline(list) {
    const el = $('#admin-online-list');
    if (!el) return;
    const astat = $('#astat-online');
    if (astat) astat.textContent = (list || []).length;
    el.innerHTML = (list || []).map(u => `
      <div class="admin-online-chip">
        <img src="${u.avatar}" alt="" />
        ${escapeHtml(u.nickname)}
        ${u.isAdmin ? '<span class="admin-badge">АДМИН</span>' : ''}
      </div>
    `).join('') || '<span style="color:var(--text2);font-size:13px">Никого нет</span>';
  }

  socket.on('room:kicked', ({ reason }) => {
    toast(reason || 'Вас выгнали из комнаты', 'error');
  });

  // ========== MOBILE NAV ==========
  function showMobilePanel(panel) {
    const sidebar = $('#sidebar');
    const chat = $('#chat-panel');
    const center = document.querySelector('.center');
    [sidebar, chat, center].forEach(el => {
      if (el) {
        el.classList.remove('mobile-show');
        el.style.display = '';
      }
    });
    document.querySelectorAll('.mnav').forEach(b => b.classList.remove('active'));
    const btn = document.querySelector('.mnav[data-panel="' + panel + '"]');
    if (btn) btn.classList.add('active');

    if (panel === 'play') {
      if (sidebar) { sidebar.classList.add('mobile-show'); sidebar.style.display = 'flex'; }
      // switch to rooms tab
      document.querySelectorAll('.tab').forEach(t => t.classList.toggle('active', t.dataset.tab === 'rooms'));
      document.querySelectorAll('.tab-content').forEach(c => c.classList.remove('active'));
      const tr = $('#tab-rooms');
      if (tr) tr.classList.add('active');
    } else if (panel === 'chat') {
      if (chat) { chat.classList.add('mobile-show'); chat.style.display = 'flex'; }
    } else if (panel === 'shop') {
      if (sidebar) { sidebar.classList.add('mobile-show'); sidebar.style.display = 'flex'; }
      document.querySelectorAll('.tab').forEach(t => t.classList.toggle('active', t.dataset.tab === 'shop'));
      document.querySelectorAll('.tab-content').forEach(c => c.classList.remove('active'));
      const ts = $('#tab-shop');
      if (ts) ts.classList.add('active');
      loadShop();
    } else if (panel === 'top') {
      if (sidebar) { sidebar.classList.add('mobile-show'); sidebar.style.display = 'flex'; }
      document.querySelectorAll('.tab').forEach(t => t.classList.toggle('active', t.dataset.tab === 'leaderboard'));
      document.querySelectorAll('.tab-content').forEach(c => c.classList.remove('active'));
      const tl = $('#tab-leaderboard');
      if (tl) tl.classList.add('active');
      loadLeaderboard();
    }
  }

  document.querySelectorAll('.mnav').forEach(btn => {
    btn.onclick = () => showMobilePanel(btn.dataset.panel);
  });

  // On mobile when entering room — show center
  const _origShowRoom = typeof showRoomView === 'function' ? null : null;

})();
