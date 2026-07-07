// Bot AI. Produces {dir, bomb} inputs for a player each tick.
//
// Behaviour, in priority order:
//   1. If it is standing on a lethal tile -> run to the nearest safe tile.
//   2. Grab a reachable power-up.
//   3. Drop a bomb when it hits a box or an enemy AND a real escape exists.
//   4. Walk to the nearest box to blow it up.
//   5. Hunt the nearest enemy.
//   6. Wander so it never stands still.

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

// Every tile that is on fire now, or will be when a (real or hypothetical) bomb
// detonates. Blast is blocked by walls and stops at the first box.
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

// An enemy sits in the straight-line blast of a bomb dropped at (x,y).
function enemyInBlast(state, bot, x, y, range) {
  for (const p of Object.values(state.players)) {
    if (!p.alive || p.id === bot.id) continue;
    const px = Math.floor(p.x);
    const py = Math.floor(p.y);
    if (px === x && Math.abs(py - y) <= range && clearLine(state, x, y, 0, Math.sign(py - y), Math.abs(py - y))) return true;
    if (py === y && Math.abs(px - x) <= range && clearLine(state, x, y, Math.sign(px - x), 0, Math.abs(px - x))) return true;
  }
  return false;
}

// True if the straight line from (x,y) to n steps in (dx,dy) is not blocked by a wall.
function clearLine(state, x, y, dx, dy, n) {
  for (let i = 1; i <= n; i++) {
    const cx = x + dx * i;
    const cy = y + dy * i;
    if (cy < 0 || cy >= state.height || cx < 0 || cx >= state.width) return false;
    if (state.map[cy][cx] === WALL) return false;
  }
  return true;
}

// Would a bomb at (x,y) still leave the bot a way out?
function hasEscape(state, bot, x, y, bombCells) {
  const danger2 = buildDanger(state, { x, y, range: bot.range });
  const field = bfsField(state, x, y, null, bombCells);
  const path = pathToPred(field, x, y, (cx, cy) => !danger2.has(key(cx, cy)));
  return !!(path && path.length <= bot.range + 4);
}

// Direction to move toward the centre of the bot's own (empty) cell.
function centerDir(bot, cx, cy) {
  const tx = cx + 0.5;
  const ty = cy + 0.5;
  // 0.2 keeps the bomb in this cell while being loose enough to avoid jitter
  // at high speeds.
  if (Math.abs(tx - bot.x) > 0.2) return tx < bot.x ? 'left' : 'right';
  if (Math.abs(ty - bot.y) > 0.2) return ty < bot.y ? 'up' : 'down';
  return null;
}

function nearestEnemyCell(state, bot, cx, cy) {
  let best = null;
  let bd = Infinity;
  for (const p of Object.values(state.players)) {
    if (!p.alive || p.id === bot.id) continue;
    const ex = Math.floor(p.x);
    const ey = Math.floor(p.y);
    const d = Math.abs(ex - cx) + Math.abs(ey - cy);
    if (d < bd) { bd = d; best = { x: ex, y: ey }; }
  }
  return best;
}

// Among reachable safe cells that touch a box, pick the one closest to the
// enemy so the bot digs a tunnel toward the player. Falls back to the nearest.
function pickBoxCell(state, field, cx, cy, enemy) {
  let target = null;
  let best = Infinity;
  for (const c of field.order) {
    if (c.x === cx && c.y === cy) continue;
    if (!adjacentToBox(state, c.x, c.y)) continue;
    if (!enemy) return c; // order is nearest-first
    const d = Math.abs(c.x - enemy.x) + Math.abs(c.y - enemy.y);
    if (d < best) { best = d; target = c; }
  }
  return target;
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
  const isSafe = (x, y) => !danger.has(key(x, y));

  // 1) Standing in danger -> escape RIGHT NOW. Prefer a route that avoids other
  //    blasts, fall back to cutting straight through if that's the only way out.
  if (danger.has(key(cx, cy))) {
    bot.mem.path = null;
    let path = pathToPred(bfsField(state, cx, cy, danger, bombCells), cx, cy, isSafe);
    if (!path) path = pathToPred(bfsField(state, cx, cy, null, bombCells), cx, cy, isSafe);
    if (path && path.length) {
      const d = stepDir(bot, path[0]);
      if (d) return { dir: d, bomb: false };
    }
    return { dir: firstMoveDir(state, bot, danger, bombCells) || firstMoveDir(state, bot, null, bombCells), bomb: false };
  }

  // 2) If the current cell is a good bomb spot, CENTRE then DROP the bomb.
  //    (This is the key fix: never walk away from a box that is right next to us.)
  if (bot.activeBombs < bot.maxBombs) {
    const worth = adjacentToBox(state, cx, cy) || enemyInBlast(state, bot, cx, cy, bot.range);
    if (worth && hasEscape(state, bot, cx, cy, bombCells)) {
      bot.mem.path = null;
      const cd = centerDir(bot, cx, cy);
      if (cd) return { dir: cd, bomb: false }; // align onto the cell first
      return { dir: null, bomb: true };         // centred -> plant it
    }
  }

  const safe = bfsField(state, cx, cy, danger, bombCells);

  // 3) Grab a reachable power-up.
  if (state.powerups.length) {
    const path = pathToPred(safe, cx, cy, (x, y) => state.powerups.some((pu) => pu.x === x && pu.y === y));
    if (path && path.length) {
      const d = stepDir(bot, path[0]);
      if (d) { bot.mem.path = null; return { dir: d, bomb: false }; }
    }
  }

  // Follow a committed plan while it stays safe & valid.
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

  // 4) Replan. If the player is directly reachable, hunt them down. Otherwise
  //    dig toward the player by bombing the box closest to them.
  bot.mem.repath = 16;
  const enemy = nearestEnemyCell(state, bot, cx, cy);

  let path = pathToPred(safe, cx, cy, (x, y) => {
    for (const p of Object.values(state.players)) {
      if (!p.alive || p.id === bot.id) continue;
      if (Math.abs(Math.floor(p.x) - x) + Math.abs(Math.floor(p.y) - y) <= 1) return true;
    }
    return false;
  });

  if (!path) {
    const boxCell = pickBoxCell(state, safe, cx, cy, enemy);
    if (boxCell) path = reconstruct(safe, cx, cy, boxCell);
  }

  if (!path) path = pathToPred(safe, cx, cy, (x, y) => enemyAtCell(state, bot, x, y));

  if (!path) {
    // Nothing to do here: roam toward the player, or somewhere new.
    const reachable = safe.order.filter((c) => !(c.x === cx && c.y === cy));
    if (reachable.length) {
      let target;
      if (enemy) {
        target = reachable.reduce((a, b) =>
          (Math.abs(b.x - enemy.x) + Math.abs(b.y - enemy.y) < Math.abs(a.x - enemy.x) + Math.abs(a.y - enemy.y)) ? b : a);
      } else {
        const far = reachable.slice(Math.floor(reachable.length / 2));
        target = far[Math.floor(Math.random() * far.length)] || reachable[reachable.length - 1];
      }
      path = reconstruct(safe, cx, cy, target);
    }
  }

  bot.mem.path = path;
  if (path && path.length) {
    const d = stepDir(bot, path[0]);
    if (d) return { dir: d, bomb: false };
  }

  // Never freeze.
  return { dir: firstMoveDir(state, bot, danger, bombCells) || firstMoveDir(state, bot, null, bombCells), bomb: false };
}
