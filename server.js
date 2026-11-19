/**
 * Danger Close Shelter – multiplayer relay server
 *
 * Rooms are identified by short codes (e.g. "abc12").
 * One player is elected host (lowest join timestamp among ready lobby players).
 * Host is authoritative for gunship state, building collapses and mission shots.
 * Presence is polled by clients; events are broadcast to the room.
 *
 * Run:  npm install && npm start
 * Default port 3000 (or $PORT).
 */

const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');

const app = express();
app.use(cors());
app.get('/', (_req, res) => {
  res.type('text').send(
    'Danger Close multiplayer server is running.\n' +
    'Point the game at this origin (see SERVER_URL in the HTML).\n' +
    'Healthy.'
  );
});
app.get('/health', (_req, res) => res.json({ ok: true, rooms: rooms.size }));

const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: '*', methods: ['GET', 'POST'] },
  transports: ['websocket', 'polling'],
  pingInterval: 8000,
  pingTimeout: 12000,
});

/** @type {Map<string, Room>} */
const rooms = new Map();

function codeFrom(raw) {
  return String(raw || '')
    .toLowerCase()
    .replace(/[^a-z0-9]/g, '')
    .slice(0, 8);
}

class Room {
  constructor(code) {
    this.code = code;
    this.players = new Map(); // socketId -> player
    this.created = Date.now();
  }

  add(socket, name, isCreator) {
    const p = {
      id: socket.id,
      name: (name || 'Runner').slice(0, 14),
      joinAt: Date.now(),
      creator: !!isCreator,
      presence: {
        n: (name || 'Runner').slice(0, 14),
        r: false,
        j: Date.now(),
        c: isCreator ? 1 : 0,
        st: 'lobby',
        k: 0,
      },
      updatedAt: Date.now(),
    };
    this.players.set(socket.id, p);
    socket.join(this.code);
    return p;
  }

  remove(socketId) {
    this.players.delete(socketId);
  }

  /** Host = earliest join among players still in lobby (or any if all in round). */
  hostId() {
    let best = null;
    let bestKey = null;
    for (const p of this.players.values()) {
      const pr = p.presence;
      // Prefer lobby players that are ready or host; skip very stale
      if (Date.now() - p.updatedAt > 15000) continue;
      const key = [pr.st === 'lobby' ? 0 : 1, pr.c ? 0 : 1, +pr.j || p.joinAt, p.id];
      if (
        !best ||
        key[0] < bestKey[0] ||
        (key[0] === bestKey[0] &&
          (key[1] < bestKey[1] ||
            (key[1] === bestKey[1] &&
              (key[2] < bestKey[2] || (key[2] === bestKey[2] && key[3] < bestKey[3])))))
      ) {
        best = p;
        bestKey = key;
      }
    }
    return best ? best.id : null;
  }

  roster() {
    return [...this.players.values()].map((p) => ({
      peer: p.id,
      sameTab: false, // filled client-side
      kind: 'viewer',
      presence: { ...p.presence },
      updatedAt: p.updatedAt,
      guest: false,
    }));
  }

  broadcastPresence() {
    const list = this.roster();
    io.to(this.code).emit('peers', list);
  }
}

function getOrCreate(code) {
  let r = rooms.get(code);
  if (!r) {
    r = new Room(code);
    rooms.set(code, r);
  }
  return r;
}

function cleanupEmpty() {
  for (const [code, room] of rooms) {
    if (room.players.size === 0 && Date.now() - room.created > 60000) {
      rooms.delete(code);
    }
  }
}
setInterval(cleanupEmpty, 30000);

io.on('connection', (socket) => {
  let currentCode = null;

  socket.on('join', (payload, ack) => {
    const code = codeFrom(payload && payload.code);
    const name = String((payload && payload.name) || 'Runner')
      .replace(/[^\w \-.]/g, '')
      .trim()
      .slice(0, 14) || 'Runner';
    const create = !!(payload && payload.create);

    if (code.length < 3) {
      if (typeof ack === 'function') ack({ ok: false, error: 'Code must be at least 3 characters' });
      return;
    }

    // Leave previous room
    if (currentCode) {
      const prev = rooms.get(currentCode);
      if (prev) {
        prev.remove(socket.id);
        socket.leave(currentCode);
        prev.broadcastPresence();
        if (prev.players.size === 0) rooms.delete(currentCode);
      }
    }

    const room = getOrCreate(code);
    if (room.players.size >= 8) {
      if (typeof ack === 'function') ack({ ok: false, error: 'Squad is full (max 8)' });
      return;
    }

    const player = room.add(socket, name, create);
    currentCode = code;

    if (typeof ack === 'function') {
      ack({
        ok: true,
        peer: socket.id,
        code,
        host: room.hostId(),
      });
    }

    room.broadcastPresence();
    console.log(`[${code}] ${name} joined (${room.players.size} in room)`);
  });

  socket.on('presence', (data) => {
    if (!currentCode) return;
    const room = rooms.get(currentCode);
    if (!room) return;
    const p = room.players.get(socket.id);
    if (!p) return;
    // Merge presence (client sends partial updates)
    Object.assign(p.presence, data || {});
    p.updatedAt = Date.now();
    // Light throttle: only broadcast every ~80ms per room via next tick batching
    if (!room._presTimer) {
      room._presTimer = setTimeout(() => {
        room._presTimer = null;
        room.broadcastPresence();
      }, 80);
    }
  });

  // Relay game events (host-authoritative ones are still checked client-side)
  const relay = (type) => {
    socket.on(type, (data) => {
      if (!currentCode) return;
      socket.to(currentCode).emit(type, { peer: socket.id, data: data || {} });
    });
  };
  ['go', 'sh', 'g', 'sm', 'dd', 'rd'].forEach(relay);

  socket.on('leave', () => {
    if (!currentCode) return;
    const room = rooms.get(currentCode);
    if (room) {
      room.remove(socket.id);
      room.broadcastPresence();
      if (room.players.size === 0) rooms.delete(currentCode);
    }
    socket.leave(currentCode);
    console.log(`[${currentCode}] left`);
    currentCode = null;
  });

  socket.on('disconnect', () => {
    if (!currentCode) return;
    const room = rooms.get(currentCode);
    if (room) {
      room.remove(socket.id);
      room.broadcastPresence();
      if (room.players.size === 0) rooms.delete(currentCode);
    }
    console.log(`disconnect ${socket.id}`);
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`Danger Close MP server listening on :${PORT}`);
  console.log(`Health: http://localhost:${PORT}/health`);
});
