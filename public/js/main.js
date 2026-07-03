import { createGame, updateGame, serializeState } from '../../shared/engine.js';
import { computeBotInput } from '../../shared/bot.js';
import { CHARACTERS, getCharacter, MAP_SIZES } from '../../shared/constants.js';
import { createRenderer } from './render.js';

// ----- App state --------------------------------------------------------
const App = {
  profile: { name: '', char: CHARACTERS[0].id },
  mode: null, // 'offline' | 'online'
  localId: null,
  offline: null, // { state, botIds }
  net: { socket: null, latest: null, display: {}, room: null },
  lastSolo: { bots: 1, size: 'big' },
  running: false,
};

const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => document.querySelectorAll(sel);

// ----- Screen helpers ---------------------------------------------------
function showScreen(id) {
  $$('.screen').forEach((s) => s.classList.remove('active'));
  $(`#${id}`).classList.add('active');
}
function openModal(id) { $(`#${id}`).classList.add('active'); }
function closeModal(id) { $(`#${id}`).classList.remove('active'); }

// ----- Profile / character selection ------------------------------------
function buildCharGrid() {
  const grid = $('#char-grid');
  grid.innerHTML = '';
  CHARACTERS.forEach((c) => {
    const cell = document.createElement('div');
    cell.className = 'char-cell' + (c.id === App.profile.char ? ' selected' : '');
    cell.dataset.char = c.id;
    cell.innerHTML = `<span class="emoji">${c.emoji}</span><span class="cname">${c.name}</span>`;
    cell.style.setProperty('--c', c.color);
    cell.addEventListener('click', () => {
      App.profile.char = c.id;
      $$('.char-cell').forEach((x) => x.classList.remove('selected'));
      cell.classList.add('selected');
      save();
    });
    grid.appendChild(cell);
  });
}

function save() {
  App.profile.name = $('#name-input').value.trim();
  localStorage.setItem('boom_profile', JSON.stringify(App.profile));
}
function load() {
  try {
    const p = JSON.parse(localStorage.getItem('boom_profile'));
    if (p && p.name) App.profile.name = p.name;
    if (p && p.char && getCharacter(p.char)) App.profile.char = p.char;
  } catch { /* ignore */ }
  $('#name-input').value = App.profile.name;
}

function validateProfile() {
  save();
  if (!App.profile.name) {
    $('#home-error').textContent = '⚠️ Bạn phải nhập tên để chơi!';
    $('#name-input').focus();
    return false;
  }
  if (!App.profile.char) {
    $('#home-error').textContent = '⚠️ Hãy chọn một nhân vật!';
    return false;
  }
  $('#home-error').textContent = '';
  return true;
}

// ----- Renderer + input -------------------------------------------------
const canvas = $('#game-canvas');
const renderer = createRenderer(canvas);

const input = {
  keyStack: [],
  touchDir: null,
  lastDir: null,
  onChange: null,
  onBomb: null,
  bombQueued: false,
  current() { return this.touchDir || this.keyStack[this.keyStack.length - 1] || null; },
  poll() {
    const d = this.current();
    if (d !== this.lastDir) {
      this.lastDir = d;
      if (this.onChange) this.onChange(d);
    }
  },
  bomb() {
    this.bombQueued = true;
    if (this.onBomb) this.onBomb();
  },
};

const KEYMAP = {
  ArrowUp: 'up', ArrowDown: 'down', ArrowLeft: 'left', ArrowRight: 'right',
  w: 'up', s: 'down', a: 'left', d: 'right',
  W: 'up', S: 'down', A: 'left', D: 'right',
};

window.addEventListener('keydown', (e) => {
  if (!App.running) return;
  if (e.key === ' ' || e.code === 'Space') { e.preventDefault(); input.bomb(); return; }
  const dir = KEYMAP[e.key];
  if (dir) {
    e.preventDefault();
    if (!input.keyStack.includes(dir)) input.keyStack.push(dir);
    input.poll();
  }
});
window.addEventListener('keyup', (e) => {
  const dir = KEYMAP[e.key];
  if (dir) {
    input.keyStack = input.keyStack.filter((d) => d !== dir);
    input.poll();
  }
});

// Touch controls.
$$('.dbtn').forEach((btn) => {
  const dir = btn.dataset.dir;
  const set = (e) => { e.preventDefault(); input.touchDir = dir; input.poll(); };
  const clear = (e) => { e.preventDefault(); if (input.touchDir === dir) { input.touchDir = null; input.poll(); } };
  btn.addEventListener('pointerdown', set);
  btn.addEventListener('pointerup', clear);
  btn.addEventListener('pointerleave', clear);
  btn.addEventListener('pointercancel', clear);
});
$('#bomb-btn').addEventListener('pointerdown', (e) => { e.preventDefault(); input.bomb(); });

// Detect touch capability to hide/show on-screen controls.
if (!matchMedia('(pointer: coarse)').matches) document.body.classList.add('no-touch');

// ----- Game loop --------------------------------------------------------
let lastTs = 0;
function frame(ts) {
  if (!App.running) return;
  const dt = Math.min(0.05, (ts - lastTs) / 1000 || 0);
  lastTs = ts;

  let renderState = null;
  if (App.mode === 'offline') {
    renderState = stepOffline(dt);
  } else if (App.mode === 'online') {
    renderState = stepOnline();
  }

  if (renderState) {
    renderer.draw(renderState, App.localId);
    updateHud(renderState);
    if (renderState.status === 'over') onGameOver(renderState);
  }
  requestAnimationFrame(frame);
}

function stepOffline(dt) {
  const st = App.offline.state;
  const me = st.players[App.localId];
  if (me && me.alive) {
    me.input.dir = input.current();
    if (input.bombQueued) { me.input.bomb = true; }
  }
  input.bombQueued = false;
  for (const p of Object.values(st.players)) {
    if (p.isBot && p.alive) {
      const inp = computeBotInput(st, p.id);
      p.input.dir = inp.dir;
      if (inp.bomb) p.input.bomb = true;
    }
  }
  updateGame(st, dt);
  return serializeState(st);
}

function stepOnline() {
  const latest = App.net.latest;
  if (!latest) return null;
  // Interpolate player positions for smoothness.
  const disp = App.net.display;
  const players = latest.players.map((p) => {
    let d = disp[p.id];
    if (!d) { d = { x: p.x, y: p.y }; disp[p.id] = d; }
    d.x += (p.x - d.x) * 0.35;
    d.y += (p.y - d.y) * 0.35;
    if (Math.abs(p.x - d.x) < 0.01) d.x = p.x;
    if (Math.abs(p.y - d.y) < 0.01) d.y = p.y;
    return { ...p, x: d.x, y: d.y };
  });
  return { ...latest, players };
}

// ----- HUD --------------------------------------------------------------
function updateHud(state) {
  $('#hud-timer').textContent = `${state.time.toFixed(1)}s`;
  const wrap = $('#hud-players');
  wrap.innerHTML = '';
  for (const p of state.players) {
    const ch = getCharacter(p.char);
    const el = document.createElement('div');
    el.className = 'hud-player' + (p.alive ? '' : ' dead');
    el.innerHTML = `<span class="hp-emoji">${ch.emoji}</span>
      <span>${p.name}</span>
      <span class="hp-stats">💣${p.maxBombs} 🔥${p.range}</span>`;
    wrap.appendChild(el);
  }
}

// ----- Game over --------------------------------------------------------
let gameOverShown = false;
function onGameOver(state) {
  if (gameOverShown) return;
  gameOverShown = true;

  const winner = state.players.find((p) => p.id === state.winner);
  const title = $('#go-title');
  if (!state.winner) title.textContent = '🤝 Hoà! Không ai sống sót';
  else if (state.winner === App.localId) title.textContent = '🏆 Chiến thắng!';
  else title.textContent = `💀 Bạn thua · ${winner ? winner.name : ''} thắng!`;

  const scores = $('#go-scores');
  scores.innerHTML = '';
  const ranked = [...state.players].sort((a, b) => {
    if (a.id === state.winner) return -1;
    if (b.id === state.winner) return 1;
    return b.kills - a.kills;
  });
  ranked.forEach((p, i) => {
    const ch = getCharacter(p.char);
    const row = document.createElement('div');
    row.className = 'go-row';
    const medal = p.id === state.winner ? '👑' : `${i + 1}`;
    row.innerHTML = `<span class="go-rank">${medal}</span>
      <span style="font-size:20px">${ch.emoji}</span>
      <span class="go-name">${p.name}</span>
      <span class="go-kills">☠️ ${p.kills}</span>`;
    scores.appendChild(row);
  });

  // Rematch button visibility.
  const rematchBtn = $('#btn-rematch');
  if (App.mode === 'online') {
    rematchBtn.style.display = document.body.classList.contains('is-host') ? '' : 'none';
  } else {
    rematchBtn.style.display = '';
  }
  $('#game-over').classList.add('active');
}

function hideGameOver() {
  gameOverShown = false;
  $('#game-over').classList.remove('active');
}

// ----- Start / stop games ----------------------------------------------
function startOffline(botCount, size) {
  const s = MAP_SIZES[size] || MAP_SIZES.big;
  const ch = getCharacter(App.profile.char);
  const players = [{ id: 'you', name: App.profile.name, char: App.profile.char, color: ch.color }];
  const botPool = ['robot', 'alien', 'ghost', 'dragon', 'octopus', 'tiger'];
  for (let i = 0; i < botCount; i++) {
    const bc = getCharacter(botPool[i % botPool.length]);
    players.push({ id: `bot${i + 1}`, name: `Máy ${i + 1}`, char: bc.id, color: bc.color, isBot: true });
  }
  App.offline = { state: createGame({ width: s.w, height: s.h, players }) };
  App.mode = 'offline';
  App.localId = 'you';
  App.lastSolo = { bots: botCount, size };
  beginGame();
  bindOfflineInput();
}

function bindOfflineInput() {
  input.onChange = null; // offline reads input.current() directly
  input.onBomb = null;
}

function bindOnlineInput() {
  input.onChange = (dir) => App.net.socket.emit('input', { dir });
  input.onBomb = () => App.net.socket.emit('input', { bomb: true });
}

function beginGame() {
  hideGameOver();
  showScreen('screen-game');
  input.keyStack = [];
  input.touchDir = null;
  input.lastDir = null;
  App.running = true;
  lastTs = performance.now();
  renderer.resize();
  requestAnimationFrame(frame);
}

function stopGame() {
  App.running = false;
  hideGameOver();
}

// ----- Networking (online rooms) ---------------------------------------
function ensureSocket() {
  if (App.net.socket) return App.net.socket;
  const socket = io();
  App.net.socket = socket;

  socket.on('roomUpdate', (room) => {
    App.net.room = room;
    App.localId = socket.id;
    document.body.classList.toggle('is-host', room.hostId === socket.id);
    renderLobby(room);
    // If a game we were in ended and server reset to lobby, go back.
    if (room.status === 'lobby' && $('#screen-game').classList.contains('active')) {
      stopGame();
      showScreen('screen-lobby');
    }
  });

  socket.on('gameStart', (state) => {
    App.net.latest = state;
    App.net.display = {};
    App.mode = 'online';
    App.localId = socket.id;
    bindOnlineInput();
    beginGame();
  });

  socket.on('gameState', (state) => {
    App.net.latest = state;
  });

  return socket;
}

function renderLobby(room) {
  $('#room-code').textContent = room.code;
  $('#player-count').textContent = room.players.length;
  const wrap = $('#lobby-players');
  wrap.innerHTML = '';
  const isHost = room.hostId === App.net.socket.id;
  room.players.forEach((p) => {
    const ch = getCharacter(p.char);
    const el = document.createElement('div');
    el.className = 'lobby-player';
    let badges = '';
    if (p.id === room.hostId) badges += '<span class="lp-badge badge-host">👑 Chủ phòng</span>';
    if (p.id === App.net.socket.id) badges += '<span class="lp-badge badge-you">Bạn</span>';
    if (p.isBot) badges += '<span class="lp-badge badge-bot">🤖 Máy</span>';
    const kick = (isHost && p.isBot)
      ? `<button class="lp-kick" data-kick="${p.id}">✕</button>` : '';
    el.innerHTML = `<span class="lp-emoji">${ch.emoji}</span>
      <span class="lp-name">${p.name}</span>${badges}${kick}`;
    wrap.appendChild(el);
  });
  wrap.querySelectorAll('[data-kick]').forEach((b) => {
    b.addEventListener('click', () => App.net.socket.emit('removeBot', { id: b.dataset.kick }));
  });
  // Sync map-size pills.
  $$('#lobby-map-group .pill').forEach((pill) => {
    pill.classList.toggle('active', pill.dataset.size === room.mapSize);
  });
  // Start button enabled only with >= 2 players.
  $('#btn-start-room').disabled = room.players.length < 2;
}

// ----- Wire up UI -------------------------------------------------------
function initUI() {
  buildCharGrid();
  load();

  $('#name-input').addEventListener('input', () => { save(); $('#home-error').textContent = ''; });

  // Solo mode.
  $('#btn-solo').addEventListener('click', () => { if (validateProfile()) openModal('modal-solo'); });
  $('#bot-count-group').addEventListener('click', (e) => {
    if (!e.target.dataset.bots) return;
    $$('#bot-count-group .pill').forEach((p) => p.classList.remove('active'));
    e.target.classList.add('active');
  });
  $('#solo-map-group').addEventListener('click', (e) => {
    if (!e.target.dataset.size) return;
    $$('#solo-map-group .pill').forEach((p) => p.classList.remove('active'));
    e.target.classList.add('active');
  });
  $('#btn-start-solo').addEventListener('click', () => {
    const bots = +$('#bot-count-group .pill.active').dataset.bots;
    const size = $('#solo-map-group .pill.active').dataset.size;
    closeModal('modal-solo');
    startOffline(bots, size);
  });

  // Create room.
  $('#btn-create').addEventListener('click', () => {
    if (!validateProfile()) return;
    const socket = ensureSocket();
    socket.emit('createRoom', { name: App.profile.name, char: App.profile.char }, (res) => {
      if (res && res.ok) { App.net.room = res.room; showScreen('screen-lobby'); }
    });
  });

  // Join room.
  $('#btn-join').addEventListener('click', () => { if (validateProfile()) openModal('modal-join'); });
  $('#btn-do-join').addEventListener('click', () => {
    const code = $('#join-code').value.trim().toUpperCase();
    if (code.length < 4) { $('#join-error').textContent = 'Nhập đủ 4 ký tự mã phòng.'; return; }
    const socket = ensureSocket();
    socket.emit('joinRoom', { code, name: App.profile.name, char: App.profile.char }, (res) => {
      if (res && res.ok) { App.net.room = res.room; closeModal('modal-join'); $('#join-error').textContent = ''; showScreen('screen-lobby'); }
      else $('#join-error').textContent = (res && res.error) || 'Không vào được phòng.';
    });
  });

  // Modal close buttons.
  $$('[data-close-modal]').forEach((b) => b.addEventListener('click', () => {
    b.closest('.modal').classList.remove('active');
  }));

  // Lobby controls.
  $('#btn-copy-code').addEventListener('click', () => {
    const code = $('#room-code').textContent;
    navigator.clipboard?.writeText(code);
    $('#btn-copy-code').textContent = '✅ Đã copy';
    setTimeout(() => ($('#btn-copy-code').textContent = '📋 Copy mã'), 1500);
  });
  $('#btn-add-bot').addEventListener('click', () => App.net.socket.emit('addBot'));
  $('#lobby-map-group').addEventListener('click', (e) => {
    if (!e.target.dataset.size) return;
    App.net.socket.emit('setMapSize', { size: e.target.dataset.size });
  });
  $('#btn-start-room').addEventListener('click', () => App.net.socket.emit('startGame'));
  $('#btn-leave-lobby').addEventListener('click', () => {
    App.net.socket?.emit('leaveRoom');
    showScreen('screen-home');
  });

  // In-game buttons.
  $('#btn-quit-game').addEventListener('click', quitToHome);
  $('#btn-back-home').addEventListener('click', quitToHome);
  $('#btn-rematch').addEventListener('click', () => {
    if (App.mode === 'offline') {
      startOffline(App.lastSolo.bots, App.lastSolo.size);
    } else {
      App.net.socket.emit('rematch');
      hideGameOver();
    }
  });
}

function quitToHome() {
  stopGame();
  if (App.mode === 'online') App.net.socket?.emit('leaveRoom');
  App.mode = null;
  showScreen('screen-home');
}

initUI();
