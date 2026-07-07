// Pure game logic for the "dat boom" (Bomberman-style) game.
// Framework agnostic so it runs identically on the Node server (authoritative
// multiplayer) and in the browser (offline single-player vs bots).

import {
  EMPTY, WALL, BOX,
  BOMB_TIMER, EXPLOSION_TIME, POWERUP_CHANCE,
  P_HALF, START_BOMBS, START_RANGE, START_SPEED,
  START_LIVES, HIT_INVULN,
  MAX_RANGE, MAX_BOMBS, MAX_SPEED, POWERUPS,
} from './constants.js';

// ----- Map generation ---------------------------------------------------

export function generateMap(w, h, seed = Math.random) {
  const rnd = typeof seed === 'function' ? seed : mulberry32(seed);
  const map = [];
  for (let y = 0; y < h; y++) {
    const row = [];
    for (let x = 0; x < w; x++) {
      if (x === 0 || y === 0 || x === w - 1 || y === h - 1) row.push(WALL);
      else if (x % 2 === 0 && y % 2 === 0) row.push(WALL);
      else row.push(EMPTY);
    }
    map.push(row);
  }

  const spawns = [
    { x: 1, y: 1 },
    { x: w - 2, y: h - 2 },
    { x: w - 2, y: 1 },
    { x: 1, y: h - 2 },
    { x: Math.floor(w / 2), y: 1 },
    { x: Math.floor(w / 2), y: h - 2 },
    { x: 1, y: Math.floor(h / 2) },
    { x: w - 2, y: Math.floor(h / 2) },
  ];

  const safe = new Set();
  for (const s of spawns) {
    for (const [dx, dy] of [[0, 0], [1, 0], [-1, 0], [0, 1], [0, -1]]) {
      safe.add(`${s.x + dx},${s.y + dy}`);
    }
  }

  for (let y = 1; y < h - 1; y++) {
    for (let x = 1; x < w - 1; x++) {
      if (map[y][x] !== EMPTY) continue;
      if (safe.has(`${x},${y}`)) continue;
      if (rnd() < 0.78) map[y][x] = BOX;
    }
  }
  return { map, spawns };
}

function mulberry32(a) {
  return function () {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// ----- Game creation ----------------------------------------------------

export function createGame({ width, height, players, seed }) {
  const { map, spawns } = generateMap(width, height, seed);
  const state = {
    width, height, map,
    players: {},
    bombs: [],
    explosions: [],
    powerups: [],
    nextId: 1,
    time: 0,
    status: 'playing', // 'playing' | 'over'
    winner: null,
    ended: false,
  };

  players.forEach((p, i) => {
    const spawn = spawns[i % spawns.length];
    state.players[p.id] = {
      id: p.id,
      name: p.name,
      char: p.char,
      color: p.color,
      isBot: !!p.isBot,
      x: spawn.x + 0.5,
      y: spawn.y + 0.5,
      spawnX: spawn.x,
      spawnY: spawn.y,
      dir: 'down',
      input: { dir: null, bomb: false },
      maxBombs: START_BOMBS,
      activeBombs: 0,
      range: START_RANGE,
      speed: START_SPEED,
      lives: START_LIVES,
      maxLives: START_LIVES,
      invuln: 0,
      alive: true,
      kills: 0,
      wins: 0,
      mem: null, // used by bot AI
    };
  });
  return state;
}

// ----- Helpers ----------------------------------------------------------

function bombAt(state, cx, cy) {
  return state.bombs.find((b) => b.x === cx && b.y === cy && !b.exploded);
}

function coversCell(p, cx, cy) {
  const x0 = Math.floor(p.x - P_HALF + 1e-4);
  const x1 = Math.floor(p.x + P_HALF - 1e-4);
  const y0 = Math.floor(p.y - P_HALF + 1e-4);
  const y1 = Math.floor(p.y + P_HALF - 1e-4);
  return cx >= x0 && cx <= x1 && cy >= y0 && cy <= y1;
}

function isSolidForPlayer(state, cx, cy, p) {
  if (cy < 0 || cy >= state.height || cx < 0 || cx >= state.width) return true;
  const t = state.map[cy][cx];
  if (t === WALL || t === BOX) return true;
  const b = bombAt(state, cx, cy);
  if (b) {
    if (p && b.pass.has(p.id)) return false;
    return true;
  }
  return false;
}

// ----- Movement ---------------------------------------------------------

function snapAxis(p, axis, step) {
  const center = Math.floor(p[axis]) + 0.5;
  const d = center - p[axis];
  if (Math.abs(d) <= step) p[axis] = center;
  else p[axis] += Math.sign(d) * step;
}

function tryMove(state, p, dx, dy) {
  const h = P_HALF;
  if (dx !== 0) {
    let nx = p.x + dx;
    const edge = dx > 0 ? nx + h : nx - h;
    const cx = Math.floor(edge);
    const cy0 = Math.floor(p.y - h + 1e-4);
    const cy1 = Math.floor(p.y + h - 1e-4);
    if (isSolidForPlayer(state, cx, cy0, p) || isSolidForPlayer(state, cx, cy1, p)) {
      nx = dx > 0 ? cx - h - 1e-3 : cx + 1 + h + 1e-3;
    }
    p.x = nx;
  }
  if (dy !== 0) {
    let ny = p.y + dy;
    const edge = dy > 0 ? ny + h : ny - h;
    const cy = Math.floor(edge);
    const cx0 = Math.floor(p.x - h + 1e-4);
    const cx1 = Math.floor(p.x + h - 1e-4);
    if (isSolidForPlayer(state, cx0, cy, p) || isSolidForPlayer(state, cx1, cy, p)) {
      ny = dy > 0 ? cy - h - 1e-3 : cy + 1 + h + 1e-3;
    }
    p.y = ny;
  }
}

function movePlayer(state, p, dt) {
  if (!p.alive) return;
  const dir = p.input.dir;
  if (!dir) return;
  p.dir = dir;
  const s = p.speed * dt;
  if (dir === 'left' || dir === 'right') {
    snapAxis(p, 'y', s * 2.4);
    tryMove(state, p, dir === 'left' ? -s : s, 0);
  } else if (dir === 'up' || dir === 'down') {
    snapAxis(p, 'x', s * 2.4);
    tryMove(state, p, 0, dir === 'up' ? -s : s);
  }
}

// ----- Bombs & explosions ----------------------------------------------

function placeBomb(state, p) {
  if (!p.alive) return;
  if (p.activeBombs >= p.maxBombs) return;
  const cx = Math.floor(p.x);
  const cy = Math.floor(p.y);
  if (state.map[cy][cx] !== EMPTY) return;
  if (bombAt(state, cx, cy)) return;
  const pass = new Set();
  for (const pl of Object.values(state.players)) {
    if (pl.alive && coversCell(pl, cx, cy)) pass.add(pl.id);
  }
  pass.add(p.id);
  state.bombs.push({
    id: state.nextId++, x: cx, y: cy, owner: p.id,
    timer: BOMB_TIMER, range: p.range, pass, exploded: false,
  });
  p.activeBombs++;
}

function maybeSpawnPowerup(state, cx, cy, rnd) {
  if ((rnd ? rnd() : Math.random()) < POWERUP_CHANCE) {
    const type = POWERUPS[Math.floor((rnd ? rnd() : Math.random()) * POWERUPS.length)];
    state.powerups.push({ x: cx, y: cy, type, spawnTime: state.time });
  }
}

function explodeBomb(state, b) {
  b.exploded = true;
  const owner = state.players[b.owner];
  if (owner) owner.activeBombs = Math.max(0, owner.activeBombs - 1);

  const cells = [{ x: b.x, y: b.y }];
  const dirs = [[1, 0], [-1, 0], [0, 1], [0, -1]];
  for (const [dx, dy] of dirs) {
    for (let i = 1; i <= b.range; i++) {
      const cx = b.x + dx * i;
      const cy = b.y + dy * i;
      if (cy < 0 || cy >= state.height || cx < 0 || cx >= state.width) break;
      const t = state.map[cy][cx];
      if (t === WALL) break;
      if (t === BOX) {
        state.map[cy][cx] = EMPTY;
        cells.push({ x: cx, y: cy });
        maybeSpawnPowerup(state, cx, cy);
        break;
      }
      cells.push({ x: cx, y: cy });
      const ob = bombAt(state, cx, cy);
      if (ob && !ob.exploded) ob.timer = 0; // chain reaction
    }
  }

  for (const c of cells) {
    state.explosions.push({ x: c.x, y: c.y, timer: EXPLOSION_TIME, owner: b.owner, startTime: state.time });
  }
}

// ----- Main update ------------------------------------------------------

export function updateGame(state, dt) {
  if (state.status !== 'playing') return;
  state.time += dt;

  // Tick down invulnerability frames.
  for (const p of Object.values(state.players)) {
    if (p.invuln > 0) p.invuln = Math.max(0, p.invuln - dt);
  }

  // Refresh bomb pass-through sets (players stop passing once they leave).
  for (const b of state.bombs) {
    for (const id of [...b.pass]) {
      const pl = state.players[id];
      if (!pl || !coversCell(pl, b.x, b.y)) b.pass.delete(id);
    }
  }

  // Movement + bomb placement.
  for (const p of Object.values(state.players)) {
    movePlayer(state, p, dt);
    if (p.input.bomb) {
      placeBomb(state, p);
      p.input.bomb = false;
    }
  }

  // Bomb timers + chained explosions.
  for (const b of state.bombs) b.timer -= dt;
  let pending = state.bombs.filter((b) => b.timer <= 0 && !b.exploded);
  let guard = 0;
  while (pending.length && guard++ < 1000) {
    for (const b of pending) explodeBomb(state, b);
    pending = state.bombs.filter((b) => b.timer <= 0 && !b.exploded);
  }
  state.bombs = state.bombs.filter((b) => !b.exploded);

  // Explosion lifetime.
  for (const e of state.explosions) e.timer -= dt;

  // Destroy power-ups caught in flames (except the blast that revealed them).
  if (state.explosions.length) {
    state.powerups = state.powerups.filter((pu) => !state.explosions.some(
      (e) => e.x === pu.x && e.y === pu.y && e.startTime > pu.spawnTime
    ));
    // Flames take a heart (with brief invulnerability so one blast != 3 hearts).
    for (const p of Object.values(state.players)) {
      if (!p.alive || p.invuln > 0) continue;
      for (const e of state.explosions) {
        if (coversCell(p, e.x, e.y)) {
          p.lives -= 1;
          p.invuln = HIT_INVULN;
          if (p.lives <= 0) {
            p.lives = 0;
            p.alive = false;
            const killer = state.players[e.owner];
            if (killer && killer.id !== p.id) killer.kills++;
          }
          break;
        }
      }
    }
  }
  state.explosions = state.explosions.filter((e) => e.timer > 0);

  // Power-up pickups.
  for (const p of Object.values(state.players)) {
    if (!p.alive) continue;
    state.powerups = state.powerups.filter((pu) => {
      if (coversCell(p, pu.x, pu.y)) {
        applyPowerup(p, pu.type);
        return false;
      }
      return true;
    });
  }

  // Win / draw detection.
  const alive = Object.values(state.players).filter((p) => p.alive);
  const total = Object.keys(state.players).length;
  if (total >= 2 && alive.length <= 1) {
    state.status = 'over';
    state.winner = alive.length === 1 ? alive[0].id : null;
    if (alive.length === 1) alive[0].wins++;
  } else if (total === 1 && alive.length === 0) {
    state.status = 'over';
    state.winner = null;
  }
}

function applyPowerup(p, type) {
  if (type === 'bomb') p.maxBombs = Math.min(MAX_BOMBS, p.maxBombs + 1);
  else if (type === 'range') p.range = Math.min(MAX_RANGE, p.range + 1);
  else if (type === 'speed') p.speed = Math.min(MAX_SPEED, p.speed + 0.7);
}

// ----- Input ------------------------------------------------------------

export function setInput(state, playerId, input) {
  const p = state.players[playerId];
  if (!p || !p.alive) return;
  if (input.dir !== undefined) p.input.dir = input.dir;
  if (input.bomb) p.input.bomb = true;
}

// ----- Serialization (for network) --------------------------------------

export function serializeState(state) {
  return {
    width: state.width,
    height: state.height,
    map: state.map,
    players: Object.values(state.players).map((p) => ({
      id: p.id, name: p.name, char: p.char, color: p.color, isBot: p.isBot,
      x: +p.x.toFixed(3), y: +p.y.toFixed(3), dir: p.dir,
      maxBombs: p.maxBombs, range: p.range, speed: +p.speed.toFixed(2),
      lives: p.lives, maxLives: p.maxLives, invuln: +p.invuln.toFixed(2),
      alive: p.alive, kills: p.kills, wins: p.wins,
    })),
    bombs: state.bombs.map((b) => ({
      id: b.id, x: b.x, y: b.y, range: b.range,
      timer: +b.timer.toFixed(2), owner: b.owner,
    })),
    explosions: state.explosions.map((e) => ({ x: e.x, y: e.y, timer: +e.timer.toFixed(2) })),
    powerups: state.powerups.map((pu) => ({ x: pu.x, y: pu.y, type: pu.type })),
    status: state.status,
    winner: state.winner,
    time: +state.time.toFixed(1),
  };
}
