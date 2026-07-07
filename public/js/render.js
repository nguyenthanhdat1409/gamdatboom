// Canvas renderer. Draws a serialized game state with a camera that follows
// the local player, so big maps scroll smoothly.

import { EMPTY, WALL, BOX, getCharacter } from '../../shared/constants.js';

export const TILE = 50;

const POWERUP_ICON = { bomb: '💣', range: '🔥', speed: '👟', heart: '❤️' };

export function createRenderer(canvas) {
  const ctx = canvas.getContext('2d');
  const camera = { x: 0, y: 0 };

  function resize() {
    const dpr = window.devicePixelRatio || 1;
    canvas.width = Math.floor(canvas.clientWidth * dpr);
    canvas.height = Math.floor(canvas.clientHeight * dpr);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }
  resize();
  window.addEventListener('resize', resize);

  function draw(state, localId) {
    if (!state) return;
    const vw = canvas.clientWidth;
    const vh = canvas.clientHeight;
    const mapW = state.width * TILE;
    const mapH = state.height * TILE;

    // Camera follows local player, clamped to the map.
    const me = state.players.find((p) => p.id === localId) || state.players[0];
    if (me) {
      const cx = me.x * TILE;
      const cy = me.y * TILE;
      camera.x = clamp(cx - vw / 2, 0, Math.max(0, mapW - vw));
      camera.y = clamp(cy - vh / 2, 0, Math.max(0, mapH - vh));
      if (mapW < vw) camera.x = (mapW - vw) / 2;
      if (mapH < vh) camera.y = (mapH - vh) / 2;
    }

    ctx.clearRect(0, 0, vw, vh);
    ctx.save();
    ctx.translate(-camera.x, -camera.y);

    // Visible tile range.
    const x0 = Math.max(0, Math.floor(camera.x / TILE));
    const y0 = Math.max(0, Math.floor(camera.y / TILE));
    const x1 = Math.min(state.width - 1, Math.ceil((camera.x + vw) / TILE));
    const y1 = Math.min(state.height - 1, Math.ceil((camera.y + vh) / TILE));

    // Floor + walls + boxes.
    for (let y = y0; y <= y1; y++) {
      for (let x = x0; x <= x1; x++) {
        const px = x * TILE;
        const py = y * TILE;
        const t = state.map[y][x];
        // Floor checkerboard.
        ctx.fillStyle = (x + y) % 2 === 0 ? '#20243a' : '#252a45';
        ctx.fillRect(px, py, TILE, TILE);
        if (t === WALL) drawWall(ctx, px, py);
        else if (t === BOX) drawBox(ctx, px, py);
      }
    }

    // Power-ups.
    for (const pu of state.powerups) {
      drawPowerup(ctx, pu.x * TILE, pu.y * TILE, pu.type);
    }

    // Bombs.
    for (const b of state.bombs) {
      drawBomb(ctx, b);
    }

    // Explosions.
    for (const e of state.explosions) {
      drawExplosion(ctx, e);
    }

    // Players (sorted by y for depth).
    const players = [...state.players].filter((p) => p.alive).sort((a, b) => a.y - b.y);
    for (const p of players) drawPlayer(ctx, p, p.id === localId);

    ctx.restore();
  }

  return { draw, resize, camera };
}

function clamp(v, a, b) { return Math.max(a, Math.min(b, v)); }

function roundRect(ctx, x, y, w, h, r) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

function drawWall(ctx, px, py) {
  const g = ctx.createLinearGradient(px, py, px, py + TILE);
  g.addColorStop(0, '#4a5578');
  g.addColorStop(1, '#2d3350');
  ctx.fillStyle = g;
  roundRect(ctx, px + 2, py + 2, TILE - 4, TILE - 4, 8);
  ctx.fill();
  ctx.fillStyle = 'rgba(255,255,255,0.08)';
  roundRect(ctx, px + 5, py + 5, TILE - 10, (TILE - 10) / 2, 6);
  ctx.fill();
}

function drawBox(ctx, px, py) {
  const g = ctx.createLinearGradient(px, py, px, py + TILE);
  g.addColorStop(0, '#c88a4a');
  g.addColorStop(1, '#9a6330');
  ctx.fillStyle = g;
  roundRect(ctx, px + 3, py + 3, TILE - 6, TILE - 6, 7);
  ctx.fill();
  ctx.strokeStyle = 'rgba(70,40,15,0.6)';
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.moveTo(px + 6, py + TILE / 2);
  ctx.lineTo(px + TILE - 6, py + TILE / 2);
  ctx.moveTo(px + TILE / 2, py + 6);
  ctx.lineTo(px + TILE / 2, py + TILE - 6);
  ctx.stroke();
}

const POWERUP_COLORS = {
  bomb: ['#ff6ec7', '#7873f5'],
  range: ['#ffb347', '#ff5e62'],
  speed: ['#43e97b', '#38f9d7'],
  heart: ['#ff5f6d', '#c40233'],
};

function drawPowerup(ctx, px, py, type) {
  const t = Date.now() / 500;
  const pulse = 1 + Math.sin(t) * 0.06;
  const colors = POWERUP_COLORS[type] || POWERUP_COLORS.bomb;
  ctx.save();
  ctx.translate(px + TILE / 2, py + TILE / 2);
  ctx.scale(pulse, pulse);
  const g = ctx.createLinearGradient(-TILE / 2, -TILE / 2, TILE / 2, TILE / 2);
  g.addColorStop(0, colors[0]);
  g.addColorStop(1, colors[1]);
  ctx.fillStyle = g;
  ctx.shadowColor = colors[0];
  ctx.shadowBlur = 16;
  roundRect(ctx, -TILE / 2 + 6, -TILE / 2 + 6, TILE - 12, TILE - 12, 9);
  ctx.fill();
  ctx.shadowBlur = 0;
  ctx.font = `${Math.floor(TILE * 0.5)}px serif`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(POWERUP_ICON[type] || '⭐', 0, 2);
  ctx.restore();
}

function drawBomb(ctx, b) {
  const px = b.x * TILE + TILE / 2;
  const py = b.y * TILE + TILE / 2;
  const beat = 1 + Math.sin(Date.now() / 90) * 0.09 * (b.timer < 0.9 ? 2 : 1);
  const r = TILE * 0.32 * beat;
  ctx.save();
  ctx.translate(px, py);
  ctx.fillStyle = '#141420';
  ctx.beginPath();
  ctx.arc(0, 0, r, 0, Math.PI * 2);
  ctx.fill();
  ctx.fillStyle = 'rgba(255,255,255,0.35)';
  ctx.beginPath();
  ctx.arc(-r * 0.3, -r * 0.3, r * 0.28, 0, Math.PI * 2);
  ctx.fill();
  // Fuse spark.
  ctx.strokeStyle = '#b98';
  ctx.lineWidth = 3;
  ctx.beginPath();
  ctx.moveTo(0, -r);
  ctx.quadraticCurveTo(r * 0.5, -r * 1.5, r * 0.7, -r * 1.2);
  ctx.stroke();
  ctx.fillStyle = Math.sin(Date.now() / 60) > 0 ? '#ffd23f' : '#ff6b35';
  ctx.beginPath();
  ctx.arc(r * 0.7, -r * 1.2, 4, 0, Math.PI * 2);
  ctx.fill();
  ctx.restore();
}

function drawExplosion(ctx, e) {
  const px = e.x * TILE;
  const py = e.y * TILE;
  const a = Math.min(1, e.timer * 2);
  ctx.save();
  ctx.globalAlpha = a;
  const g = ctx.createRadialGradient(
    px + TILE / 2, py + TILE / 2, 2,
    px + TILE / 2, py + TILE / 2, TILE * 0.7
  );
  g.addColorStop(0, '#fff6c0');
  g.addColorStop(0.4, '#ffd23f');
  g.addColorStop(0.75, '#ff6b35');
  g.addColorStop(1, 'rgba(255,60,20,0)');
  ctx.fillStyle = g;
  roundRect(ctx, px + 1, py + 1, TILE - 2, TILE - 2, 10);
  ctx.fill();
  ctx.restore();
}

function drawPlayer(ctx, p, isLocal) {
  const px = p.x * TILE;
  const py = p.y * TILE;
  const ch = getCharacter(p.char);
  ctx.save();
  ctx.translate(px, py);

  // Blink while invulnerable (just got hit).
  const blinking = p.invuln > 0 && Math.floor(Date.now() / 120) % 2 === 0;

  // Shadow.
  ctx.fillStyle = 'rgba(0,0,0,0.3)';
  ctx.beginPath();
  ctx.ellipse(0, TILE * 0.28, TILE * 0.26, TILE * 0.1, 0, 0, Math.PI * 2);
  ctx.fill();

  if (blinking) ctx.globalAlpha = 0.35;

  // Colored ring.
  ctx.beginPath();
  ctx.arc(0, 0, TILE * 0.34, 0, Math.PI * 2);
  ctx.fillStyle = ch.color;
  ctx.globalAlpha = isLocal ? 0.95 : 0.75;
  ctx.fill();
  ctx.globalAlpha = 1;
  if (isLocal) {
    ctx.strokeStyle = '#fff';
    ctx.lineWidth = 3;
    ctx.stroke();
  }

  // Emoji avatar.
  ctx.font = `${Math.floor(TILE * 0.52)}px serif`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(ch.emoji, 0, 2);

  ctx.globalAlpha = 1;

  // Hearts above the head.
  if (p.maxLives) {
    const hs = 11; // heart spacing
    const total = p.maxLives * hs;
    ctx.font = '11px serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    for (let i = 0; i < p.maxLives; i++) {
      const hx = -total / 2 + hs / 2 + i * hs;
      ctx.globalAlpha = i < p.lives ? 1 : 0.28;
      ctx.fillText(i < p.lives ? '❤️' : '🖤', hx, -TILE * 0.92);
    }
    ctx.globalAlpha = 1;
  }

  // Name tag.
  const name = p.name || '';
  ctx.font = 'bold 12px system-ui, sans-serif';
  const w = ctx.measureText(name).width + 12;
  ctx.fillStyle = 'rgba(0,0,0,0.55)';
  roundRect(ctx, -w / 2, -TILE * 0.72, w, 16, 8);
  ctx.fill();
  ctx.fillStyle = isLocal ? '#ffd23f' : '#fff';
  ctx.fillText(name, 0, -TILE * 0.72 + 8);

  ctx.restore();
}
