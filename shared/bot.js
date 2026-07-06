// Bot AI. Produces {dir, bomb} inputs for a player each tick.
// Priorities: flee danger -> grab power-ups -> bomb boxes/enemies (with an
// escape) -> hunt boxes -> chase enemies -> wander. It always keeps moving.

import { EMPTY, WALL, BOX } from './constants.js';

function key(x, y) { return `${x},${y}`; }

function bombCellSet(state) {
  const s = new Set();
  for (const b of state.bombs) s.add(key(b.x, b.y));
  return s;
}

function passable(state, x, y, bombCells) {
  if (y < 0 || y >= state.height || x < 0 || x >= state.width) return false;
  if (state.map[y][x] !== EMPTY) return false;
  if (bombCells && bombCells.has(key(x, y))) return false;
  return true;
}

// Cells on fire now, or that will be when a bomb (or a hypothetical one) blows.
function buildDanger(state, extraBomb = null) {
  const danger = new Set();
  for (const e of state.explosions) danger.add(key(e.x, e.y));
  const bombs = extraBomb ? [...state.bombs, extraBomb] : state.bombs;
  for (const b of bombs) {
    danger.add(key(b.x, b.y));
    for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      for (let i = 1; i <= b.range; i++) {
        const cx = b.x + dx * i;
        const cy = b.y + dy * i;
        if (cy < 0 || cy >= state.height || cx < 0 || cx >= state.width) break;
        const t = state.map[cy][cx];
        if (t === WALL) break;
        danger.add(key(cx, cy));
        if (t === BOX) break;
      }
    }
  }
  return danger;
}

// Flood fill from (sx,sy). Returns parent map + BFS order (nearest first).
function bfsField(state, sx, sy, avoid, bombCells) {
  const prev = new Map();
  const seen = new Set([key(sx, sy)]);
  const order = [];
  const q = [{ x: sx, y: sy }];
  let head = 0;
  while (head < q.length) {
    const cur = q[head++];
    order.push(cur);
    for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      const nx = cur.x + dx;
      const ny = cur.y + dy;
      const k = key(nx, ny);
      if (seen.has(k)) continue;
      if (!passable(state, nx, ny, bombCells)) continue;
      if (avoid && avoid.has(k)) continue;
      seen.add(k);
      prev.set(k, cur);
      q.push({ x: nx, y: ny });
    }
  }
  return { prev, order };
}

function reconstruct(field, sx, sy, cell) {
  const path = [];
  let c = cell;
  while (c && !(c.x === sx && c.y === sy)) {
    path.unshift(c);
    c = field.prev.get(key(c.x, c.y));
  }
  return path;
}

// Nearest cell (excluding start) satisfying pred, with the path to it.
function pathToPred(field, sx, sy, pred) {
  for (const c of field.order) {
    if (c.x === sx && c.y === sy) continue;
    if (pred(c.x, c.y)) return reconstruct(field, sx, sy, c);
  }
  return null;
}

function stepDir(bot, cell) {
  const tx = cell.x + 0.5;
  const ty = cell.y + 0.5;
  if (Math.abs(tx - bot.x) > 0.06) return tx < bot.x ? 'left' : 'right';
  if (Math.abs(ty - bot.y) > 0.06) return ty < bot.y ? 'up' : 'down';
  return null;
}

function adjacentToBox(state, x, y) {
  for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
    const nx = x + dx;
    const ny = y + dy;
    if (ny < 0 || ny >= state.height || nx < 0 || nx >= state.width) continue;
    if (state.map[ny][nx] === BOX) return true;
  }
  return false;
}

function enemyAtCell(state, bot, x, y) {
  for (const p of Object.values(state.players)) {
    if (!p.alive || p.id === bot.id) continue;
    if (Math.floor(p.x) === x && Math.floor(p.y) === y) return true;
  }
  return false;
}

// Enemy sits in the straight-line blast of a bomb dropped at (x,y).
function enemyInBlast(state, bot, x, y) {
  for (const p of Object.values(state.players)) {
    if (!p.alive || p.id === bot.id) continue;
    const px = Math.floor(p.x);
    const py = Math.floor(p.y);
    if (px === x && Math.abs(py - y) <= bot.range) return true;
    if (py === y && Math.abs(px - x) <= bot.range) return true;
  }
  return false;
}

// Would a bomb at (x,y) still leave the bot a way out?
function hasEscape(state, bot, x, y, bombCells) {
  const danger2 = buildDanger(state, { x, y, range: bot.range });
  const field = bfsField(state, x, y, null, bombCells);
  const path = pathToPred(field, x, y, (cx, cy) => !danger2.has(key(cx, cy)));
  return !!(path && path.length <= bot.range + 4);
}

function firstMoveDir(state, bot, avoid, bombCells) {
  const cx = Math.floor(bot.x);
  const cy = Math.floor(bot.y);
  const opts = [['up', 0, -1], ['down', 0, 1], ['left', -1, 0], ['right', 1, 0]];
  for (const [dir, dx, dy] of opts) {
    if (passable(state, cx + dx, cy + dy, bombCells) && !(avoid && avoid.has(key(cx + dx, cy + dy)))) return dir;
  }
  for (const [dir, dx, dy] of opts) {
    if (passable(state, cx + dx, cy + dy, bombCells)) return dir;
  }
  return null;
}

export function computeBotInput(state, botId) {
  const bot = state.players[botId];
  if (!bot || !bot.alive) return { dir: null, bomb: false };
  if (!bot.mem) bot.mem = { path: null, repath: 0 };

  const cx = Math.floor(bot.x);
  const cy = Math.floor(bot.y);
  const bombCells = bombCellSet(state);
  const danger = buildDanger(state);

  // 1) In danger -> escape to the nearest safe cell (may pass through danger).
  if (danger.has(key(cx, cy))) {
    bot.mem.path = null;
    const field = bfsField(state, cx, cy, null, bombCells);
    const path = pathToPred(field, cx, cy, (x, y) => !danger.has(key(x, y)));
    if (path && path.length) {
      const d = stepDir(bot, path[0]);
      if (d) return { dir: d, bomb: false };
    }
    return { dir: firstMoveDir(state, bot, danger, bombCells) || firstMoveDir(state, bot, null, bombCells), bomb: false };
  }

  const centered = Math.abs(bot.x - (cx + 0.5)) < 0.2 && Math.abs(bot.y - (cy + 0.5)) < 0.2;

  // Safe navigation field (avoids danger + bombs).
  const safe = bfsField(state, cx, cy, danger, bombCells);

  // 2) Grab a reachable power-up (high value, cheap detour).
  if (state.powerups.length) {
    const path = pathToPred(safe, cx, cy, (x, y) => state.powerups.some((pu) => pu.x === x && pu.y === y));
    if (path && path.length) {
      const d = stepDir(bot, path[0]);
      if (d) { bot.mem.path = null; return { dir: d, bomb: false }; }
    }
  }

  // 3) Drop a bomb when it helps and we can survive it.
  if (centered && bot.activeBombs < bot.maxBombs) {
    const worth = adjacentToBox(state, cx, cy) || enemyInBlast(state, bot, cx, cy);
    if (worth && hasEscape(state, bot, cx, cy, bombCells)) {
      bot.mem.path = null;
      return { dir: null, bomb: true };
    }
  }

  // Follow an existing plan if it's still safe & valid.
  bot.mem.repath -= 1;
  if (bot.mem.path && bot.mem.path.length && bot.mem.repath > 0) {
    while (bot.mem.path.length) {
      const next = bot.mem.path[0];
      if (!passable(state, next.x, next.y, bombCells) || danger.has(key(next.x, next.y))) {
        bot.mem.path = null;
        break;
      }
      const d = stepDir(bot, next);
      if (d === null) { bot.mem.path.shift(); continue; }
      return { dir: d, bomb: false };
    }
  }

  // Replan: head toward a box, then an enemy, then wander somewhere new.
  bot.mem.repath = 18;
  let path = pathToPred(safe, cx, cy, (x, y) => adjacentToBox(state, x, y));
  if (!path) path = pathToPred(safe, cx, cy, (x, y) => enemyAtCell(state, bot, x, y));
  if (!path) {
    // Wander: pick a reasonably far reachable safe cell so the bot keeps roaming.
    const reachable = safe.order.filter((c) => !(c.x === cx && c.y === cy));
    if (reachable.length) {
      const far = reachable.slice(Math.floor(reachable.length / 2));
      const target = far[Math.floor(Math.random() * far.length)] || reachable[reachable.length - 1];
      path = reconstruct(safe, cx, cy, target);
    }
  }

  bot.mem.path = path;
  if (path && path.length) {
    const d = stepDir(bot, path[0]);
    if (d) return { dir: d, bomb: false };
  }

  // Last resort: any legal step so it never freezes.
  return { dir: firstMoveDir(state, bot, danger, bombCells) || firstMoveDir(state, bot, null, bombCells), bomb: false };
}
