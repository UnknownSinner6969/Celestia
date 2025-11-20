// server.js
const http = require("http");
const path = require("path");
const express = require("express");
const { Server } = require("socket.io");

const app = express();

app.get("/", (_req, res) => res.send("Signaling server running"));

const server = http.createServer(app);
const io = new Server(server, { cors: { origin: "*" } });
const rooms = {};
const peers = {};

// ephemeral whiteboard store per room
// structure: { roomName: { pages: [ [strokes], ... ], currentPage: 0 } }
const whiteboards = {};

// --- Game constants ---
const GAME_TICK_RATE = 45; // 20 updates per second
const GAME_DT = 1 / GAME_TICK_RATE;
const MAP_WIDTH = 1250;
const MAP_HEIGHT = 650;

// --- Game Rooms ---
const gameRooms = new Map(); // roomName -> GameRoom

// ==========================================
// 🔥 GAME ROOM CLASS (Robust Ready / Timer / Rankings)
// ==========================================
class GameRoom {
  constructor(name, io) {
    this.name = name;
    this.io = io;
    this.players = new Map(); // socketId -> player { ready:boolean, ... }
    this.bullets = new Map();
    this.seq = 0;
    this.map = this.generateMap();

    // match control
    this.matchDuration = 65; // seconds
    this.timeLeft = this.matchDuration;
    this.matchRunning = false; // wait for ready
    this.timerInterval = null;

    // main tick runs always but does nothing if not running
    this.interval = setInterval(() => this.tick(), 1000 / GAME_TICK_RATE);
  }

  // --- Map generation (unchanged logic)
  generateMap() {
    const walls = [];

    const MAX_TRIES = 100; // prevents infinite loops if too many walls
    const WALL_COUNT = 8; // number of walls
    // Helper: check if two rectangles overlap
  const isOverlapping = (a, b) => {
    return (
      a.x < b.x + b.w &&
      a.x + a.w > b.x &&
      a.y < b.y + b.h &&
      a.y + a.h > b.y
    );
  };

  // --- Generate non-overlapping, corridor-style walls ---
  let tries = 0;
  while (walls.length < WALL_COUNT && tries < MAX_TRIES) {
    tries++;

    // Randomly decide if the wall is horizontal or vertical
    const isHorizontal = Math.random() > 0.5;
    const w = isHorizontal
      ? 150 + Math.random() * 150 // long horizontal wall
      : 50 + Math.random() * 40; // thin vertical
    const h = isHorizontal
      ? 50 + Math.random() * 40 // thin height for horizontal wall
      : 100 + Math.random() * 100; // long vertical wall

    const x = Math.random() * (MAP_WIDTH - w - 20);
    const y = Math.random() * (MAP_HEIGHT - h - 20);

    const newWall = { x, y, w, h };

    // Only add if it doesn't overlap existing walls
    const overlaps = walls.some((wall) => isOverlapping(wall, newWall));
    if (!overlaps) {
      walls.push(newWall);
    }
  }

    const pillars = [];
    for (let i = 0; i < 6; i++) {
      pillars.push({
        x: Math.random() * MAP_WIDTH,
        y: Math.random() * MAP_HEIGHT,
        r: 40 + Math.random() * 30,
      });
    }
    return { walls, pillars, width: MAP_WIDTH, height: MAP_HEIGHT };
  }

  // --- Collision helper (unchanged)
  collidesWithObstacles(x, y, radius = 15) {
    const { walls, pillars } = this.map;
    for (const w of walls) {
      if (x + radius > w.x && x - radius < w.x + w.w && y + radius > w.y && y - radius < w.y + w.h) return true;
    }
    for (const p of pillars) {
      const dx = x - p.x, dy = y - p.y;
      if (dx * dx + dy * dy < (radius + p.r) ** 2) return true;
    }
    return false;
  }

  // --- Safe random spawn (unchanged)
  getSafeSpawn() {
    let tries = 0, x, y;
    do {
      x = Math.random() * MAP_WIDTH;
      y = Math.random() * MAP_HEIGHT;
      tries++;
      if (tries > 1000) break;
    } while (this.collidesWithObstacles(x, y, 20));
    return { x, y };
  }

  // --- Add / remove players
  addPlayer(socket, name = "Player") {
    const { x, y } = this.getSafeSpawn();

    // If a player with same id already exists (unlikely), preserve kills
    const prev = this.players.get(socket.id);
    const kills = prev ? (prev.kills || 0) : 0;

    this.players.set(socket.id, {
      id: socket.id,
      name,
      x,
      y,
      a: Math.random() * Math.PI * 2,
      vx: 0,
      vy: 0,
      hp: 100,
      kills,
      inputs: [],
      lastInputSeq: 0,
      ready: false, // must click READY to start
    });

    // send updated list to everyone
    this.broadcastPlayerList();
  }

  removePlayer(socketId) {
    const existed = this.players.delete(socketId);
    if (existed) {
      this.broadcast("player-left", socketId);
      this.broadcastPlayerList();

      // If no players left, cleanup timers/room
      if (this.players.size === 0) {
        clearInterval(this.interval);
        this.stopTimer();
        gameRooms.delete(this.name);
      } else {
        // If after removal everyone remaining is ready, start the match
        const allReady = Array.from(this.players.values()).every(pl => !!pl.ready);
        if (allReady && !this.matchRunning) {
          this.startMatch();
        }
      }
    }
  }

  // receive input only when match running (unchanged)
  receiveInput(socketId, input) {
    const p = this.players.get(socketId);
    if (!p || !this.matchRunning) return;
    p.inputs.push(input);
  }

  spawnBullet(owner, x, y, angle) {
    const id = `${owner}-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
    const speed = 400;
    const vx = Math.cos(angle) * speed;
    const vy = Math.sin(angle) * speed;
    this.bullets.set(id, { id, x, y, vx, vy, owner, life: 2.5 });
  }

  broadcast(event, data) {
    this.io.to(this.name).emit(event, data);
  }

  // compact players + ready state
  broadcastPlayerList() {
    const arr = Array.from(this.players.values()).map(p => ({
      id: p.id, name: p.name, x: +p.x.toFixed(2), y: +p.y.toFixed(2), a: +p.a.toFixed(2),
      hp: p.hp, kills: p.kills || 0, ready: !!p.ready
    }));
    this.broadcast("players-list", arr);
  }

  // --- READY handling (client sends player-ready)
  setPlayerReady(socketId, ready) {
    const p = this.players.get(socketId);
    if (!p) return;
    p.ready = !!ready;

    // Broadcast single-player update so UI can reflect instantly
    this.broadcast("player-ready-update", { id: socketId, ready: p.ready });
    // Also send full list to keep clients fully in sync
    this.broadcastPlayerList();

    // If everyone ready and >0 players, start match
    const total = this.players.size;
    if (total > 0) {
      const allReady = Array.from(this.players.values()).every(pl => !!pl.ready);
      if (allReady) {
        this.startMatch();
      }
    }
  }

  // start match: reset positions/hp, clear bullets, reset kills to 0, clear ready flags
  startMatch() {
    if (this.matchRunning) return;

    for (const p of this.players.values()) {
      p.hp = 100;
      p.vx = 0; p.vy = 0;
      const { x, y } = this.getSafeSpawn();
      p.x = x; p.y = y;
      p.kills = 0;
      p.inputs = [];
      p.lastInputSeq = 0;
      p.ready = false; // clear ready flags after starting
    }

    this.bullets.clear();
    this.timeLeft = this.matchDuration;
    this.matchRunning = true;

    // start shared timer
    this.stopTimer();
    this.timerInterval = setInterval(() => this.updateTimer(), 1000);

    // notify clients
    this.io.to(this.name).emit("match-started", { matchDuration: this.matchDuration });
    this.broadcastPlayerList();
  }

  stopTimer() {
    if (this.timerInterval) {
      clearInterval(this.timerInterval);
      this.timerInterval = null;
    }
  }

  updateTimer() {
    if (!this.matchRunning) return;
    this.timeLeft--;
    this.io.to(this.name).emit("timer-update", this.timeLeft);
    if (this.timeLeft <= 0) this.endMatch();
  }

  // --- End of match: compute rankings and correct winner/draw/no-winner handling
  endMatch() {
    if (!this.matchRunning) return;
    this.matchRunning = false;
    this.stopTimer();

    // Produce rankings sorted desc by kills
    const rankings = Array.from(this.players.values())
      .map(p => ({ id: p.id, name: p.name, kills: p.kills || 0 }))
      .sort((a, b) => b.kills - a.kills);

    // Determine winner / draw / no-winner
    let winner = null;
    if (rankings.length === 0) {
      winner = null;
    } else {
      const topKills = rankings[0].kills;
      // If all zero kills -> no winner (null)
      const allZero = rankings.every(r => r.kills === 0);
      if (allZero) {
        winner = null;
      } else {
        // If more than one player share topKills -> draw
        const topCount = rankings.filter(r => r.kills === topKills).length;
        if (topCount > 1) {
          winner = { id: null, name: "Draw", kills: topKills };
        } else {
          winner = rankings[0];
        }
      }
    }

    // clear ready flags so clients must ready again to restart
    for (const p of this.players.values()) p.ready = false;

    // broadcast match end + fresh player list (with ready reset)
    this.io.to(this.name).emit("match-ended", { rankings, winner });
    this.broadcastPlayerList();
    // NOTE: no auto-restart. Clients must ready->server will start when all ready.
  }

  // Manual restart wrapper (server admin can call). Typically clients will set ready,
  // and startMatch() will be triggered once all players ready.
  restartMatch() {
    if (!this.matchRunning) this.startMatch();
  }

  // Main tick: runs but does nothing when match not running
  tick() {
    if (!this.matchRunning) return;
    const dt = GAME_DT;
    this.seq++;

    // Process inputs
    for (const [id, p] of this.players.entries()) {
      while (p.inputs.length > 0) {
        const input = p.inputs.shift();
        p.lastInputSeq = input.seq;

        const turnSpeed = 8.0;
        const accel = 700;
        const maxSpeed = 600;

        p.a += (input.turn || 0) * turnSpeed * dt;
        const thrust = input.thrust || 0;
        p.vx += Math.cos(p.a) * thrust * accel * dt;
        p.vy += Math.sin(p.a) * thrust * accel * dt;

        // Clamp speed
        const spd = Math.hypot(p.vx, p.vy);
        if (spd > maxSpeed) {
          const ratio = maxSpeed / spd;
          p.vx *= ratio; p.vy *= ratio;
        }

        if (input.fire) {
          this.spawnBullet(id, p.x + Math.cos(p.a) * 20, p.y + Math.sin(p.a) * 20, p.a);
        }
      }
    }

    // Move players with obstacle collision
    for (const p of this.players.values()) {
      const oldX = p.x, oldY = p.y;
      p.x += p.vx * dt; p.y += p.vy * dt;
      p.vx *= 0.95; p.vy *= 0.95;
      if (this.collidesWithObstacles(p.x, p.y, 20)) { p.x = oldX; p.y = oldY; p.vx = 0; p.vy = 0; }
      p.x = Math.max(0, Math.min(MAP_WIDTH, p.x));
      p.y = Math.max(0, Math.min(MAP_HEIGHT, p.y));
    }

    // Move bullets & collisions
    for (const [bid, b] of this.bullets.entries()) {
      b.x += b.vx * dt; b.y += b.vy * dt; b.life -= dt;
      if (b.life <= 0) { this.bullets.delete(bid); continue; }
      if (this.collidesWithObstacles(b.x, b.y, 2)) {
  this.broadcast("game-event", {
    type: "hit",
    target: null,
    by: b.owner,
    obstacle: true,
    x: b.x,
    y: b.y,
  });
  this.bullets.delete(bid);
  continue;
}

      for (const [pid, p] of this.players.entries()) {
        if (p.id === b.owner) continue;
        const dx = b.x - p.x, dy = b.y - p.y;
        if (dx * dx + dy * dy <= 20 * 20) {
          p.hp -= 20;
          this.bullets.delete(bid);
          if (p.hp <= 0) {
            const killer = this.players.get(b.owner);
            if (killer) killer.kills = (killer.kills || 0) + 1;
            p.hp = 100;
            const { x, y } = this.getSafeSpawn();
            p.x = x; p.y = y;
             this.broadcast("game-event", {
    type: "killed",
    target: pid,
    by: b.owner,
    x: p.x,
    y: p.y,
  });
          } else {
            this.broadcast("game-event", {
    type: "hit",
    target: pid,
    by: b.owner,
    x: p.x,
    y: p.y,
  });
          }
          break;
        }
      }
    }

    // Broadcast snapshot (players include ready & kills)
    const playersArr = Array.from(this.players.values()).map(p => ({
      id: p.id, x: +p.x.toFixed(2), y: +p.y.toFixed(2), a: +p.a.toFixed(2),
      hp: p.hp, name: p.name, kills: p.kills || 0, ready: !!p.ready
    }));
    const bulletsArr = Array.from(this.bullets.values()).map(b => ({
  id: b.id,
  x: +b.x.toFixed(2),
  y: +b.y.toFixed(2),
  vx: +b.vx.toFixed(2),
  vy: +b.vy.toFixed(2),
}));


    this.broadcast("game-state", {
      t: Date.now(), seq: this.seq, players: playersArr, bullets: bulletsArr, obstacles: this.map, timeLeft: this.timeLeft
    });
  }
}




io.on("connection", (socket) => {
  console.log("Client connected:", socket.id);

  socket.on("join", ({ room, name }) => {
    if (!rooms[room]) rooms[room] = new Set();

    // Check max participants
    if (rooms[room].size >= 5) {
      socket.emit("room-full", { message: "Room is full (max 5 participants)" });
      return;
    }

    // send existing peers to the newcomer BEFORE adding them
    const existing = Array.from(rooms[room]).map((id) => ({
      id,
      name: peers[id]?.name || id,
    }));
    socket.emit("existingPeers", { peers: existing });

    // store the peer's name
    peers[socket.id] = { name, room };

    // add newcomer to room
    rooms[room].add(socket.id);
    socket.join(room);

    // ensure whiteboard store exists for this room
    if (!whiteboards[room]) {
      whiteboards[room] = { pages: [[]], currentPage: 0 };
    }

    // notify others that a new peer joined
    socket.to(room).emit("peer-joined", { id: socket.id, name });
    console.log(`${socket.id} added to ${room}; existing peers:`, existing);
  });

  socket.on("offer", ({ to, sdp }) => {
    console.log(`${socket.id} -> OFFER -> ${to}`);
    io.to(to).emit("offer", { from: socket.id, sdp });
  });

  socket.on("answer", ({ to, sdp }) => {
    console.log(`${socket.id} -> ANSWER -> ${to}`);
    io.to(to).emit("answer", { from: socket.id, sdp });
  });

  socket.on("ice-candidate", ({ to, candidate }) => {
    if (to) {
      io.to(to).emit("ice-candidate", { from: socket.id, candidate });
    }
  });

  // --- Whiteboard handlers ---

  // New peer requests full whiteboard sync for the room
  socket.on("whiteboard-request-sync", ({ room }) => {
    const wb = whiteboards[room] || { pages: [[]], currentPage: 0 };
    // Send a snapshot (pages arrays are plain JS arrays of strokes)
    socket.emit("whiteboard-sync", { pages: wb.pages, currentPage: wb.currentPage });
  });

  // Receive a stroke (or clear marker) from a peer
  socket.on("whiteboard-stroke", ({ room, page, stroke }) => {
    if (!whiteboards[room]) whiteboards[room] = { pages: [[]], currentPage: 0 };
    // ensure page exists
    if (!whiteboards[room].pages[page]) whiteboards[room].pages[page] = [];

    // special-case clear: if stroke has { clear: true } then wipe page
    if (stroke && stroke.clear) {
      whiteboards[room].pages[page] = [];
      // broadcast the clear stroke so peers can react consistently
      socket.to(room).emit("whiteboard-stroke", { from: socket.id, page, stroke });
      return;
    }

    // otherwise store stroke and broadcast to others in the room
    whiteboards[room].pages[page].push(stroke);
    socket.to(room).emit("whiteboard-stroke", { from: socket.id, page, stroke });
  });

  // Add a new (empty) page to the whiteboard
  socket.on("whiteboard-add-page", ({ room }) => {
    if (!whiteboards[room]) whiteboards[room] = { pages: [[]], currentPage: 0 };
    whiteboards[room].pages.push([]); // new empty page
    const idx = whiteboards[room].pages.length - 1;
    io.to(room).emit("whiteboard-page-added", { index: idx });
  });

  // Remove a page (by index) from the whiteboard
  socket.on("whiteboard-remove-page", ({ room, index }) => {
    if (!whiteboards[room]) return;
    if (index >= 0 && index < whiteboards[room].pages.length) {
      whiteboards[room].pages.splice(index, 1);
      io.to(room).emit("whiteboard-page-removed", { index });
      // adjust currentPage if needed
      if (whiteboards[room].currentPage >= whiteboards[room].pages.length) {
        whiteboards[room].currentPage = Math.max(0, whiteboards[room].pages.length - 1);
      }
    }
  });

  // Set current page for the room (peer changed page)
  socket.on("whiteboard-set-page", ({ room, index }) => {
    if (!whiteboards[room]) whiteboards[room] = { pages: [[]], currentPage: 0 };
    if (index >= 0 && index < whiteboards[room].pages.length) {
      whiteboards[room].currentPage = index;
      socket.to(room).emit("whiteboard-set-page", { index });
    }
  });

  // --- End whiteboard handlers ---

  socket.on("disconnect", () => {
    console.log("Client disconnected:", socket.id);
    const peerData = peers[socket.id];
    if (peerData) {
      const { room } = peerData;
      rooms[room]?.delete(socket.id);
      socket.to(room).emit("peer-left", { id: socket.id, name: peerData.name });
      delete peers[socket.id];
      if (rooms[room]?.size === 0) {
        delete rooms[room];
        // cleanup whiteboard memory for this room
        if (whiteboards[room]) delete whiteboards[room];
      }
    }
  });

  socket.on("chat-message", ({ room, message }) => {
    const fromName = peers[socket.id]?.name || message.from;
    socket.to(room).emit("chat-message", { from: fromName, text: message.text });
  });

  socket.on("mic-toggle", ({ room, enabled }) => {
    socket.to(room).emit("mic-toggle", { from: socket.id, enabled });
  });

  socket.on("cam-toggle", ({ room, enabled }) => {
    socket.to(room).emit("cam-toggle", { from: socket.id, enabled });
  });

  socket.on("screen-share-start", ({ room }) => {
    socket.to(room).emit("screen-share-start", { from: socket.id });
  });

  socket.on("screen-share-stop", ({ room }) => {
    socket.to(room).emit("screen-share-stop", { from: socket.id });
  });

  socket.on("game-join", ({ room, name }) => {
    const key = room.trim().toLowerCase();
    if (!gameRooms.has(key)) {
      gameRooms.set(key, new GameRoom(key, io));
      console.log("Created new room:", key);
    }
    const g = gameRooms.get(key);
    g.addPlayer(socket, name);
    socket.join(key);
    socket.emit("game-joined", { ok: true });
  });

  socket.on("game-leave", ({ room }) => {
    const key = room.trim().toLowerCase();
    const g = gameRooms.get(key);
    if (g) g.removePlayer(socket.id);
    socket.leave(key);
  });

  socket.on("game-input", ({ room, input }) => {
    const key = room.trim().toLowerCase();
    const g = gameRooms.get(key);
    if (!g) return;
    g.receiveInput(socket.id, input);
  });

  socket.on("disconnect", () => {
    console.log("🔴 Disconnected:", socket.id);
    for (const [name, g] of gameRooms.entries()) {
      if (g.players.has(socket.id)) {
        g.removePlayer(socket.id);
      }
    }
  });
  socket.on("player-ready", ({ room, ready }) => {
  const key = room.trim().toLowerCase();
  const g = gameRooms.get(key);
  if (!g) return;
  g.setPlayerReady(socket.id, !!ready);
});

// Allow server/admin to force restart (optional)
socket.on("request-restart", ({ room }) => {
  const key = room.trim().toLowerCase();
  const g = gameRooms.get(key);
  if (!g) return;
  // mark this player ready -> same as player-ready true
  g.setPlayerReady(socket.id, true);
});

});

const PORT = process.env.PORT || 4000;  // use Render's assigned port, fallback to 4000 locally
server.listen(PORT, "0.0.0.0", () =>
  console.log("HTTP signaling server running on port", PORT)
);

