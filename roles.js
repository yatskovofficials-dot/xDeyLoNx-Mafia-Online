const ROLES = {
  civilian: {
    id: 'civilian',
    name: 'Мирный житель',
    team: 'town',
    description: 'Обычный горожанин. Днём голосует, ночью спит.',
    icon: '👤',
    color: '#94a3b8',
    price: 0,
    unlocked: true
  },
  mafia: {
    id: 'mafia',
    name: 'Мафия',
    team: 'mafia',
    description: 'Ночью вместе с командой выбирает жертву.',
    icon: '🔫',
    color: '#ef4444',
    price: 0,
    unlocked: true
  },
  don: {
    id: 'don',
    name: 'Дон',
    team: 'mafia',
    description: 'Глава мафии. Может проверять игроков ночью.',
    icon: '👑',
    color: '#dc2626',
    price: 500,
    unlocked: false
  },
  doctor: {
    id: 'doctor',
    name: 'Доктор',
    team: 'town',
    description: 'Ночью может вылечить одного игрока (включая себя).',
    icon: '💉',
    color: '#22c55e',
    price: 300,
    unlocked: false
  },
  sheriff: {
    id: 'sheriff',
    name: 'Шериф',
    team: 'town',
    description: 'Ночью проверяет игрока: мафия или мирный.',
    icon: '🔍',
    color: '#3b82f6',
    price: 400,
    unlocked: false
  },
  maniac: {
    id: 'maniac',
    name: 'Маньяк',
    team: 'neutral',
    description: 'Играет сам за себя. Ночью убивает любого.',
    icon: '🔪',
    color: '#a855f7',
    price: 800,
    unlocked: false
  },
  prostitute: {
    id: 'prostitute',
    name: 'Красотка',
    team: 'town',
    description: 'Ночью блокирует действие выбранного игрока.',
    icon: '💋',
    color: '#ec4899',
    price: 450,
    unlocked: false
  },
  lawyer: {
    id: 'lawyer',
    name: 'Адвокат',
    team: 'mafia',
    description: 'Может оправдать мафиози при дневном голосовании.',
    icon: '⚖️',
    color: '#f59e0b',
    price: 600,
    unlocked: false
  },
  journalist: {
    id: 'journalist',
    name: 'Журналист',
    team: 'town',
    description: 'Может один раз за игру узнать роль игрока днём.',
    icon: '📰',
    color: '#06b6d4',
    price: 350,
    unlocked: false
  },
  bodyguard: {
    id: 'bodyguard',
    name: 'Телохранитель',
    team: 'town',
    description: 'Защищает игрока ценой своей жизни.',
    icon: '🛡️',
    color: '#64748b',
    price: 550,
    unlocked: false
  }
};

const SHOP_ITEMS = {
  ...ROLES,
  coin_pack_small: {
    id: 'coin_pack_small',
    name: '100 монет',
    type: 'coins',
    amount: 100,
    price: 0, // only via admin or wins
    icon: '🪙'
  },
  avatar_frame_gold: {
    id: 'avatar_frame_gold',
    name: 'Золотая рамка',
    type: 'cosmetic',
    description: 'Золотая рамка вокруг аватара',
    price: 200,
    icon: '🖼️'
  },
  chat_color_red: {
    id: 'chat_color_red',
    name: 'Красный ник',
    type: 'cosmetic',
    description: 'Красный цвет ника в чате',
    price: 150,
    icon: '🔴'
  },
  title_boss: {
    id: 'title_boss',
    name: 'Титул «Босс»',
    type: 'title',
    description: 'Отображается рядом с ником',
    price: 1000,
    icon: '💼'
  }
};

function getRoleDistribution(playerCount) {
  // Classic balanced distribution
  if (playerCount < 4) return { civilian: playerCount };
  if (playerCount <= 5) return { mafia: 1, civilian: playerCount - 1 };
  if (playerCount <= 7) return { mafia: 1, doctor: 1, civilian: playerCount - 2 };
  if (playerCount <= 9) return { mafia: 2, doctor: 1, sheriff: 1, civilian: playerCount - 4 };
  if (playerCount <= 12) return { mafia: 2, don: 1, doctor: 1, sheriff: 1, civilian: playerCount - 5 };
  return { mafia: 3, don: 1, doctor: 1, sheriff: 1, maniac: 1, civilian: playerCount - 7 };
}

module.exports = { ROLES, SHOP_ITEMS, getRoleDistribution };