// Bot AI. Produces {dir, bomb} inputs for a player each tick.
//
// The dodging is time-aware: it computes WHEN each tile will catch fire (taking
// chain reactions between bombs into account), then only walks through a tile if
// it can fully cross before that tile ignites, and only stops on a tile that no
// bomb can reach. This makes it reliably dodge its own AND the player's bombs.
//
// Behaviour priority: flee -> grab power-up -> bomb (box/enemy, with a proven
// escape) -> dig toward the player -> hunt -> wander. It never freezes.

import { EMPTY, WALL, BOX, BOMB_TIMER, P_HALF } from './constants.js';

const DIRS = [[1, 0], [-1, 0], [0, 1], [0, -1]];
const SAFE_MARGIN = 0.18; // seconds of buffer when crossing a soon-to-blow tile

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

// Tiles hit by a bomb at (x,y): the cell itself + arms in 4 directions, stopped
// by walls, stopping at (and including) the first box.
function blastCells(state, x, y, range) {
  const cells = [{ x, y }];
  for (const [dx, dy] of DIRS) {
    for (let i = 1; i <= range; i++) {
      const cx = x + dx * i;
      const cy = y + dy * i;
      if (cy < 0 || cy >= state.height || cx < 0 || cx >= state.width) break;
      const t = state.map[cy][cx];
      if (t === WALL) break;
      cells.push({ x: cx, y: cy });
      if (t === BOX) break;
    }
  }
  return cells;
}

// Map: tile-key -> earliest time (seconds from now) that tile catches fire.
// Absent key means the tile is never reached by any current bomb. Chain
// reactions are resolved so a bomb inside another bomb's blast detonates early.
function buildFlameTimes(state, extraBomb = null) {
  const bombs = state.bombs.map((b) => ({ x: b.x, y: b.y, range: b.range, timer: b.timer }));
  if (extraBomb) bombs.push({ x: extraBomb.x, y: extraBomb.y, range: extraBomb.range, timer: BOMB_TIMER });

  const cellsPer = bombs.map((b) => blastCells(state, b.x, b.y, b.range));
  const times = bombs.map((b) => Math.max(0, b.timer));

  // Chain propagation until stable.
  for (let it = 0; it <= bombs.length; it++) {
    let changed = false;
    for (let i = 0; i < bombs.length; i++) {
      for (let j = 0; j < bombs.length; j++) {
        if (i === j) continue;
        if (times[i] < times[j] &&
            cellsPer[i].some((c) => c.x === bombs[j].x && c.y === bombs[j].y)) {
          times[j] = times[i];
          changed = true;
        }
      }
    }
    if (!changed) break;
  }

  const flame = new Map();
  const setMin = (k, v) => { const e = flame.get(k); if (e === undefined || v < e) flame.set(k, v); };
  for (const e of state.explosions) setMin(key(e.x, e.y), 0);
  for (let i = 0; i < bombs.length; i++) {
    for (const c of cellsPer[i]) setMin(key(c.x, c.y), times[i]);
  }
  return flame;
}

// Flood fill (avoiding solids + `avoid` tiles). Returns parent map + BFS order.
function bfsField(state, sx, sy, avoid, bombCells) {
  const prev = new Map();
  const seen = new Set([key(sx, sy)]);
  const order = [];
  const q = [{ x: sx, y: sy }];
  let head = 0;
  while (head < q.length) {
    const cur = q[head++];
    order.push(cur);
    for (const [dx, dy] of DIRS) {
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

// Time-aware escape. BFS by steps; entering a tile is only allowed if we can
// fully cross it before it ignites. Prefers the nearest never-ignite tile;
// falls back to the reachable tile that stays safe longest.
function safeEscape(state, sx, sy, flame, stepTime, bombCells) {
  const prev = new Map();
  const depth = new Map([[key(sx, sy), 0]]);
  const seen = new Set([key(sx, sy)]);
  const q = [{ x: sx, y: sy }];
  let head = 0;
  let bestSafe = null;
  let delayCell = null;
  let delayT = -1;

  while (head < q.length) {
    const cur = q[head++];
    const ck = key(cur.x, cur.y);
    const cd = depth.get(ck);
    if (!(cur.x === sx && cur.y === sy)) {
      const fs = flame.get(ck);
      if (fs === undefined) { bestSafe = cur; break; } // nearest fully-safe tile
      if (fs > delayT) { delayT = fs; delayCell = cur; }
    }
    for (const [dx, dy] of DIRS) {
      const nx = cur.x + dx;
      const ny = cur.y + dy;
      const nk = key(nx, ny);
      if (seen.has(nk)) continue;
      if (!passable(state, nx, ny, bombCells)) continue;
      const nd = cd + 1;
      const nfs = flame.get(nk);
      // Must be able to arrive and leave before this tile ignites.
      if (nfs !== undefined && nfs < (nd + 1) * stepTime + SAFE_MARGIN) continue;
      seen.add(nk);
      prev.set(nk, cur);
      depth.set(nk, nd);
      q.push({ x: nx, y: ny });
    }
  }

  const goal = bestSafe || delayCell;
  if (!goal) return null;
  const path = [];
  let c = goal;
  while (c && !(c.x === sx && c.y === sy)) {
    path.unshift(c);
    c = prev.get(key(c.x, c.y));
  }
  return path.length ? path : null;
}

// Direction from the bot's CURRENT cell toward `cell`. We move along the axis
// with the larger cell-distance and let the engine auto-snap the perpendicular
// axis. Crucially we never try to "fix" a small sub-tile offset by stepping
// sideways (that used to jam the bot against a wall when it needed to go up/down).
function stepDir(bot, cell) {
  const cx = Math.floor(bot.x);
  const cy = Math.floor(bot.y);
  const dx = cell.x - cx;
  const dy = cell.y - cy;
  if (dx === 0 && dy === 0) return null; // already on this cell
  if (Math.abs(dx) >= Math.abs(dy)) return dx < 0 ? 'left' : 'right';
  return dy < 0 ? 'up' : 'down';
}

// Nudge toward the exact centre of the bot's own cell. 0.12 is tight enough that
// once centred the whole hitbox (half-size 0.35) fits inside this single tile,
// so it never gets clipped by a blast in the neighbouring tile.
function centerDir(bot, cx, cy) {
  const tx = cx + 0.5;
  const ty = cy + 0.5;
  if (Math.abs(tx - bot.x) > 0.12) return tx < bot.x ? 'left' : 'right';
  if (Math.abs(ty - bot.y) > 0.12) return ty < bot.y ? 'up' : 'down';
  return null;
}

function adjacentToBox(state, x, y) {
  for (const [dx, dy] of DIRS) {
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

function clearLine(state, x, y, dx, dy, n) {
  for (let i = 1; i <= n; i++) {
    const cx = x + dx * i;
    const cy = y + dy * i;
    if (cy < 0 || cy >= state.height || cx < 0 || cx >= state.width) return false;
    if (state.map[cy][cx] === WALL) return false;
  }
  return true;
}

function enemyInBlast(state, bot, x, y, range) {
  for (const p of Object.values(state.players)) {
    if (!p.alive || p.id === bot.id) continue;
    const px = Math.floor(p.x);
    const py = Math.floor(p.y);
    if (px === x && Math.abs(py - y) <= range && clearLine(state, x, y, 0, Math.sign(py - y) || 1, Math.abs(py - y))) return true;
    if (py === y && Math.abs(px - x) <= range && clearLine(state, x, y, Math.sign(px - x) || 1, 0, Math.abs(px - x))) return true;
  }
  return false;
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

function pickBoxCell(state, field, cx, cy, enemy) {
  let target = null;
  let best = Infinity;
  for (const c of field.order) {
    if (c.x === cx && c.y === cy) continue;
    if (!adjacentToBox(state, c.x, c.y)) continue;
    if (!enemy) return c;
    const d = Math.abs(c.x - enemy.x) + Math.abs(c.y - enemy.y);
    if (d < best) { best = d; target = c; }
  }
  return target;
}

// Every tile the bot's body (hitbox) currently overlaps. Matches the engine's
// coversCell(), so the bot's danger view is exactly what actually kills it.
function coveredCells(bot) {
  const x0 = Math.floor(bot.x - P_HALF + 1e-4);
  const x1 = Math.floor(bot.x + P_HALF - 1e-4);
  const y0 = Math.floor(bot.y - P_HALF + 1e-4);
  const y1 = Math.floor(bot.y + P_HALF - 1e-4);
  const cells = [];
  for (let y = y0; y <= y1; y++) {
    for (let x = x0; x <= x1; x++) cells.push({ x, y });
  }
  return cells;
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
  if (!bot.mem) bot.mem = { path: null, repath: 0, fleePath: null, recent: [] };

  const cx = Math.floor(bot.x);
  const cy = Math.floor(bot.y);
  const bombCells = bombCellSet(state);
  const flame = buildFlameTimes(state);
  const danger = new Set(flame.keys());
  const stepTime = 1 / Math.max(0.1, bot.speed);

  // Anti-stuck watchdog: only fires when the bot is OSCILLATING between 2-3
  // tiles (a real loop). Standing still on a single safe tile is allowed
  // (that's how it hides from bombs), so we exclude the 1-unique-tile case.
  const cellKey = key(cx, cy);
  bot.mem.recent.push(cellKey);
  if (bot.mem.recent.length > 40) bot.mem.recent.shift();
  const uniqRecent = new Set(bot.mem.recent).size;
  const bored = bot.mem.recent.length >= 40
    && uniqRecent >= 2 && uniqRecent <= 3
    && !danger.has(cellKey);

  // 1) In a blast lane -> ESCAPE. Danger is checked against the whole hitbox
  //    (every tile the body overlaps), so straddling a blast tile still counts.
  const covered = coveredCells(bot);
  const inDanger = covered.some((c) => danger.has(key(c.x, c.y)));
  if (inDanger) {
    bot.mem.path = null;
    // Our own tile is safe and we're only clipping a blast tile because we're
    // off-centre -> pull fully into our tile and hide there (one whole cell).
    if (!danger.has(cellKey)) {
      bot.mem.fleePath = null;
      return { dir: centerDir(bot, cx, cy), bomb: false };
    }
    let fp = bot.mem.fleePath;
    const valid = fp && fp.length
      && fp.every((c) => passable(state, c.x, c.y, bombCells))
      && !danger.has(key(fp[fp.length - 1].x, fp[fp.length - 1].y));
    if (!valid) { fp = safeEscape(state, cx, cy, flame, stepTime, bombCells); bot.mem.fleePath = fp; }
    if (fp && fp.length) {
      while (fp.length) {
        const next = fp[0];
        const d = stepDir(bot, next);
        if (d === null) { fp.shift(); continue; }
        return { dir: d, bomb: false };
      }
    }
    return { dir: firstMoveDir(state, bot, danger, bombCells) || firstMoveDir(state, bot, null, bombCells), bomb: false };
  }

  bot.mem.fleePath = null;

  // 2) Bomb a box / enemy, but only if a proven escape to a truly safe tile
  //    exists. Centre first, then plant and commit to the escape route.
  if (bot.activeBombs < bot.maxBombs) {
    const worth = adjacentToBox(state, cx, cy) || enemyInBlast(state, bot, cx, cy, bot.range);
    if (worth) {
      const flame2 = buildFlameTimes(state, { x: cx, y: cy, range: bot.range });
      const escape = safeEscape(state, cx, cy, flame2, stepTime, bombCells);
      const last = escape && escape.length ? escape[escape.length - 1] : null;
      if (last && !flame2.has(key(last.x, last.y))) {
        bot.mem.path = null;
        const cd = centerDir(bot, cx, cy);
        if (cd) return { dir: cd, bomb: false };
        bot.mem.fleePath = escape;
        return { dir: null, bomb: true };
      }
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

  // Follow the committed travel plan while it stays valid & safe.
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

  // Watchdog kicked in: jump to a fresh random tile to break the loop.
  if (bored) {
    bot.mem.recent.length = 0;
    bot.mem.path = null;
    const reachable = safe.order.filter((c) => !(c.x === cx && c.y === cy));
    if (reachable.length) {
      const t = reachable[Math.floor(Math.random() * reachable.length)];
      const p = reconstruct(safe, cx, cy, t);
      bot.mem.path = p;
      bot.mem.repath = 24;
      if (p && p.length) { const d = stepDir(bot, p[0]); if (d) return { dir: d, bomb: false }; }
    }
  }

  // 4) Replan: reach the player if possible, else dig toward them, else hunt,
  //    else roam toward them.
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
    // Can't safely reach anything right now. If bombs are ticking on the board,
    // hide on our safe tile and wait them out instead of wandering into danger.
    // Centre up first so the whole body sits inside one cell (never straddling).
    if (flame.size > 0) {
      bot.mem.path = null;
      return { dir: centerDir(bot, cx, cy), bomb: false };
    }
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

  return { dir: firstMoveDir(state, bot, danger, bombCells) || firstMoveDir(state, bot, null, bombCells), bomb: false };
}
