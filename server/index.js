import express from 'express';
import { createServer } from 'http';
import { Server } from 'socket.io';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

import { createGame, updateGame, setInput, serializeState } from '../shared/engine.js';
import { computeBotInput } from '../shared/bot.js';
import { MAP_SIZES, getCharacter } from '../shared/constants.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');

const app = express();
// Avoid serving stale JS after edits (game logic lives in /shared and /public).
app.use((req, res, next) => {
  res.set('Cache-Control', 'no-cache, no-store, must-revalidate');
  next();
});
app.use(express.static(join(ROOT, 'public'), { etag: false, lastModified: false }));
app.use('/shared', express.static(join(ROOT, 'shared'), { etag: false, lastModified: false }));

const httpServer = createServer(app);
const io = new Server(httpServer);

const MAX_PLAYERS = 8;
const TICK_HZ = 30;
const rooms = new Map(); // code -> room

function makeCode() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let code;
  do {
    code = Array.from({ length: 4 }, () => chars[Math.floor(Math.random() * chars.length)]).join('');
  } while (rooms.has(code));
  return code;
}

function roomPublic(room) {
  return {
    code: room.code,
    hostId: room.hostId,
    mapSize: room.mapSize,
    status: room.status,
    maxPlayers: MAX_PLAYERS,
    players: room.members.map((m) => ({
      id: m.id, name: m.name, char: m.char, color: m.color,
      isBot: m.isBot, connected: m.connected !== false,
    })),
  };
}

function broadcastRoom(room) {
  io.to(room.code).emit('roomUpdate', roomPublic(room));
}

function addBotToRoom(room) {
  if (room.members.length >= MAX_PLAYERS) return;
  const botChars = ['robot', 'alien', 'ghost', 'dragon', 'octopus', 'panda', 'tiger', 'unicorn'];
  const n = room.members.filter((m) => m.isBot).length + 1;
  const charId = botChars[(n - 1) % botChars.length];
  const ch = getCharacter(charId);
  room.members.push({
    id: `bot_${room.code}_${Date.now()}_${n}`,
    name: `Máy ${n}`, char: charId, color: ch.color, isBot: true, connected: true,
  });
}

function startLoop(room) {
  const size = MAP_SIZES[room.mapSize] || MAP_SIZES.big;
  const playersInit = room.members.map((m) => ({
    id: m.id, name: m.name, char: m.char, color: m.color, isBot: m.isBot,
  }));
  room.state = createGame({ width: size.w, height: size.h, players: playersInit });
  room.status = 'playing';
  broadcastRoom(room);
  io.to(room.code).emit('gameStart', serializeState(room.state));

  const dt = 1 / TICK_HZ;
  let overAt = null;
  room.loop = setInterval(() => {
    const st = room.state;
    if (!st) return;
    // Bot inputs.
    for (const p of Object.values(st.players)) {
      if (p.isBot && p.alive) {
        const inp = computeBotInput(st, p.id);
        p.input.dir = inp.dir;
        if (inp.bomb) p.input.bomb = true;
      }
    }
    updateGame(st, dt);
    io.to(room.code).emit('gameState', serializeState(st));

    if (st.status === 'over') {
      if (overAt === null) overAt = Date.now();
      else if (Date.now() - overAt > 4000) {
        clearInterval(room.loop);
        room.loop = null;
        room.status = 'lobby';
        room.state = null;
        broadcastRoom(room);
      }
    }
  }, 1000 / TICK_HZ);
}

function leaveRoom(socket) {
  const code = socket.data.roomCode;
  if (!code) return;
  const room = rooms.get(code);
  if (!room) return;
  const idx = room.members.findIndex((m) => m.id === socket.id);
  if (idx >= 0) {
    if (room.status === 'playing' && room.state && room.state.players[socket.id]) {
      // Mark dead so the round can resolve.
      room.state.players[socket.id].alive = false;
      room.members[idx].connected = false;
    } else {
      room.members.splice(idx, 1);
    }
  }
  socket.leave(code);
  socket.data.roomCode = null;

  const humans = room.members.filter((m) => !m.isBot && m.connected !== false);
  if (humans.length === 0) {
    if (room.loop) clearInterval(room.loop);
    rooms.delete(code);
    return;
  }
  if (room.hostId === socket.id) room.hostId = humans[0].id;
  broadcastRoom(room);
}

io.on('connection', (socket) => {
  socket.on('createRoom', ({ name, char }, cb) => {
    const code = makeCode();
    const ch = getCharacter(char);
    const room = {
      code, hostId: socket.id, mapSize: 'big', status: 'lobby',
      members: [{ id: socket.id, name: sanitize(name), char, color: ch.color, isBot: false, connected: true }],
      state: null, loop: null,
    };
    rooms.set(code, room);
    socket.join(code);
    socket.data.roomCode = code;
    cb && cb({ ok: true, room: roomPublic(room) });
    broadcastRoom(room);
  });

  socket.on('joinRoom', ({ code, name, char }, cb) => {
    code = (code || '').toUpperCase().trim();
    const room = rooms.get(code);
    if (!room) return cb && cb({ ok: false, error: 'Không tìm thấy phòng.' });
    if (room.status === 'playing') return cb && cb({ ok: false, error: 'Phòng đang chơi rồi.' });
    if (room.members.length >= MAX_PLAYERS) return cb && cb({ ok: false, error: 'Phòng đã đầy.' });
    const ch = getCharacter(char);
    room.members.push({ id: socket.id, name: sanitize(name), char, color: ch.color, isBot: false, connected: true });
    socket.join(code);
    socket.data.roomCode = code;
    cb && cb({ ok: true, room: roomPublic(room) });
    broadcastRoom(room);
  });

  socket.on('addBot', () => {
    const room = rooms.get(socket.data.roomCode);
    if (!room || room.hostId !== socket.id || room.status !== 'lobby') return;
    addBotToRoom(room);
    broadcastRoom(room);
  });

  socket.on('removeBot', ({ id }) => {
    const room = rooms.get(socket.data.roomCode);
    if (!room || room.hostId !== socket.id || room.status !== 'lobby') return;
    const idx = room.members.findIndex((m) => m.id === id && m.isBot);
    if (idx >= 0) room.members.splice(idx, 1);
    broadcastRoom(room);
  });

  socket.on('setMapSize', ({ size }) => {
    const room = rooms.get(socket.data.roomCode);
    if (!room || room.hostId !== socket.id || room.status !== 'lobby') return;
    if (MAP_SIZES[size]) room.mapSize = size;
    broadcastRoom(room);
  });

  socket.on('startGame', () => {
    const room = rooms.get(socket.data.roomCode);
    if (!room || room.hostId !== socket.id || room.status !== 'lobby') return;
    if (room.members.length < 2) return;
    startLoop(room);
  });

  socket.on('rematch', () => {
    const room = rooms.get(socket.data.roomCode);
    if (!room || room.hostId !== socket.id || room.status !== 'lobby') return;
    if (room.members.length < 2) return;
    startLoop(room);
  });

  socket.on('input', (input) => {
    const room = rooms.get(socket.data.roomCode);
    if (!room || !room.state) return;
    setInput(room.state, socket.id, input);
  });

  socket.on('leaveRoom', () => leaveRoom(socket));
  socket.on('disconnect', () => leaveRoom(socket));
});

function sanitize(name) {
  return String(name || 'Người chơi').slice(0, 16).trim() || 'Người chơi';
}

const PORT = process.env.PORT || 3000;
httpServer.listen(PORT, () => {
  console.log(`\n  IT Nhiều Chuyện - Đặt Boom đang chạy tại: http://localhost:${PORT}\n`);
});
