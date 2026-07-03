// Bot AI. Produces {dir, bomb} inputs for a player each tick.
// Strategy: build a danger map -> flee if unsafe -> otherwise bomb boxes/enemies
// when an escape exists -> otherwise path toward the nearest target.

import { EMPTY, WALL, BOX } from './constants.js';

function key(x, y) { return `${x},${y}`; }

function passable(state, x, y) {
  if (y < 0 || y >= state.height || x < 0 || x >= state.width) return false;
  return state.map[y][x] === EMPTY;
}

// Cells that are on fire now, or will be when a placed bomb detonates.
function buildDanger(state, extraBomb = null) {
  const danger = new Set();
  for (const e of state.explosions) danger.add(key(e.x, e.y));
  const bombs = extraBomb ? [...state.bombs, extraBomb] : state.bombs;
  for (const b of bombs) {
    danger.add(key(b.x, b.y));
    const dirs = [[1, 0], [-1, 0], [0, 1], [0, -1]];
    for (const [dx, dy] of dirs) {
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

// BFS returning the path (list of {x,y}) from start to the first cell matching
// `isGoal`. Cells in `avoid` are impassable. Returns null if none reachable.
function bfs(state, sx, sy, isGoal, avoid) {
  const q = [{ x: sx, y: sy }];
  const prev = new Map();
  const seen = new Set([key(sx, sy)]);
  while (q.length) {
    const cur = q.shift();
    if (isGoal(cur.x, cur.y) && !(cur.x === sx && cur.y === sy)) {
      const path = [];
      let c = cur;
      while (c && !(c.x === sx && c.y === sy)) {
        path.unshift(c);
        c = prev.get(key(c.x, c.y));
      }
      return path;
    }
    for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      const nx = cur.x + dx;
      const ny = cur.y + dy;
      const k = key(nx, ny);
      if (seen.has(k)) continue;
      if (!passable(state, nx, ny)) continue;
      if (avoid && avoid.has(k)) continue;
      seen.add(k);
      prev.set(k, cur);
      q.push({ x: nx, y: ny });
    }
  }
  return null;
}

function stepDir(bot, cell) {
  const bx = bot.x;
  const by = bot.y;
  const tx = cell.x + 0.5;
  const ty = cell.y + 0.5;
  if (Math.abs(tx - bx) > 0.06) return tx < bx ? 'left' : 'right';
  if (Math.abs(ty - by) > 0.06) return ty < by ? 'up' : 'down';
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

// Can the bot survive after dropping a bomb here? true if a safe cell is reachable.
function hasEscape(state, bot, x, y) {
  const fakeBomb = { x, y, range: bot.range };
  const danger = buildDanger(state, fakeBomb);
  const safe = bfs(state, x, y, (cx, cy) => !danger.has(key(cx, cy)), null);
  return !!safe;
}

export function computeBotInput(state, botId) {
  const bot = state.players[botId];
  if (!bot || !bot.alive) return { dir: null, bomb: false };
  if (!bot.mem) bot.mem = { path: null, repath: 0, wander: null };

  const cx = Math.floor(bot.x);
  const cy = Math.floor(bot.y);
  const danger = buildDanger(state);

  // 1) In danger -> run to nearest safe cell immediately.
  if (danger.has(key(cx, cy))) {
    const path = bfs(state, cx, cy, (x, y) => !danger.has(key(x, y)), null);
    bot.mem.path = null;
    if (path && path.length) {
      const dir = stepDir(bot, path[0]);
      return { dir: dir || firstMoveDir(state, bot, danger), bomb: false };
    }
    // No known escape: try any adjacent non-danger move.
    return { dir: firstMoveDir(state, bot, danger), bomb: false };
  }

  // 2) Consider dropping a bomb (only when centered on the cell).
  const centered = Math.abs(bot.x - (cx + 0.5)) < 0.12 && Math.abs(bot.y - (cy + 0.5)) < 0.12;
  if (centered && bot.activeBombs < bot.maxBombs) {
    const worthIt = adjacentToBox(state, cx, cy) || enemyInBlast(state, bot, cx, cy);
    if (worthIt && hasEscape(state, bot, cx, cy)) {
      bot.mem.path = null;
      return { dir: null, bomb: true };
    }
  }

  // 3) Head toward a target: adjacent-to-box cell, or an enemy.
  bot.mem.repath -= 1;
  const needPath = !bot.mem.path || bot.mem.path.length === 0 || bot.mem.repath <= 0;
  if (needPath) {
    bot.mem.repath = 14;
    let path = bfs(state, cx, cy,
      (x, y) => adjacentToBox(state, x, y) && !danger.has(key(x, y)), danger);
    if (!path) {
      // Chase an enemy.
      path = bfs(state, cx, cy, (x, y) => {
        for (const p of Object.values(state.players)) {
          if (!p.alive || p.id === bot.id) continue;
          if (Math.floor(p.x) === x && Math.floor(p.y) === y) return true;
        }
        return false;
      }, danger);
    }
    if (!path) {
      // Wander somewhere random and safe.
      path = bfs(state, cx, cy,
        (x, y) => (x !== cx || y !== cy) && Math.random() < 0.08 && !danger.has(key(x, y)),
        danger);
    }
    bot.mem.path = path;
  }

  if (bot.mem.path && bot.mem.path.length) {
    // Drop reached cells.
    while (bot.mem.path.length) {
      const next = bot.mem.path[0];
      const d = stepDir(bot, next);
      if (d === null) { bot.mem.path.shift(); continue; }
      // Avoid stepping into fresh danger.
      if (danger.has(key(next.x, next.y))) { bot.mem.path = null; break; }
      return { dir: d, bomb: false };
    }
  }
  return { dir: null, bomb: false };
}

function firstMoveDir(state, bot, danger) {
  const cx = Math.floor(bot.x);
  const cy = Math.floor(bot.y);
  const opts = [['up', 0, -1], ['down', 0, 1], ['left', -1, 0], ['right', 1, 0]];
  // Prefer a safe neighbour.
  for (const [dir, dx, dy] of opts) {
    if (passable(state, cx + dx, cy + dy) && !danger.has(key(cx + dx, cy + dy))) return dir;
  }
  for (const [dir, dx, dy] of opts) {
    if (passable(state, cx + dx, cy + dy)) return dir;
  }
  return null;
}
