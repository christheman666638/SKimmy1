/**
 * Drop-in replacement for Claude's room API.
 * Load this script BEFORE the game <script>, or paste at the top of the game script.
 *
 * Usage:
 *   window.DC_SERVER = "https://your-server.example"; // optional, default localhost:3000
 *   // then the existing MP code will use the adapter automatically
 */
(function () {
  'use strict';

  const SERVER = (typeof window !== 'undefined' && window.DC_SERVER) ||
    (location.protocol === 'https:' ? null : 'http://localhost:3000');

  if (!SERVER) {
    console.warn('[DC MP] No DC_SERVER set and page is HTTPS – multiplayer disabled until you set window.DC_SERVER');
  }

  // Load Socket.io client from CDN if not present
  function loadSocketIO(cb) {
    if (window.io) return cb();
    const s = document.createElement('script');
    s.src = 'https://cdn.socket.io/4.8.0/socket.io.min.js';
    s.onload = cb;
    s.onerror = () => console.error('[DC MP] Failed to load Socket.io client');
    document.head.appendChild(s);
  }

  class FakeRoom {
    constructor(ns, code) {
      this.ns = ns;
      this.code = code;
      this._peers = [];
      this._presence = {};
      this._handlers = {};
      this._peerId = null;
      this._socket = null;
    }

    async _connect(name, create) {
      return new Promise((resolve, reject) => {
        loadSocketIO(() => {
          const socket = window.io(SERVER, {
            transports: ['websocket', 'polling'],
            autoConnect: true,
          });
          this._socket = socket;

          socket.on('connect', () => {
            socket.emit('join', { code: this.code, name, create }, (res) => {
              if (!res || !res.ok) {
                reject(new Error((res && res.error) || 'join failed'));
                return;
              }
              this._peerId = res.peer;
              resolve(this);
            });
          });

          socket.on('connect_error', (err) => reject(err));

          socket.on('peers', (list) => {
            this._peers = (list || []).map((p) => ({
              ...p,
              sameTab: p.peer === this._peerId,
            }));
            (this._handlers['peers'] || []).forEach((fn) => fn());
          });

          // Relay game events into the same shape the original code expects
          ['go', 'sh', 'g', 'sm', 'dd', 'rd'].forEach((type) => {
            socket.on(type, (msg) => {
              const handlers = this._handlers[type] || [];
              handlers.forEach((fn) =>
                fn({
                  peer: msg.peer,
                  sameTab: msg.peer === this._peerId,
                  data: msg.data,
                })
              );
            });
          });
        });
      });
    }

    on(type, fn) {
      if (!this._handlers[type]) this._handlers[type] = [];
      this._handlers[type].push(fn);
      return () => {
        this._handlers[type] = (this._handlers[type] || []).filter((f) => f !== fn);
      };
    }

    onPeers(fn) {
      return this.on('peers', fn);
    }

    emit(type, data) {
      if (this._socket && this._socket.connected) {
        this._socket.emit(type, data);
      }
      return Promise.resolve();
    }

    presence(data) {
      Object.assign(this._presence, data || {});
      if (this._socket && this._socket.connected) {
        this._socket.emit('presence', this._presence);
      }
      return Promise.resolve();
    }

    peers() {
      return this._peers.slice();
    }

    leave() {
      if (this._socket) {
        this._socket.emit('leave');
        this._socket.disconnect();
        this._socket = null;
      }
    }
  }

  class FakeNS {
    constructor() {
      this._rooms = new Map();
    }

    async join(roomName) {
      // roomName is "dc-XXXX"
      const code = String(roomName || '').replace(/^dc-/, '');
      const room = new FakeRoom(this, code);
      // The real join happens later when we have the name; we stash and complete in mpJoinCode
      room._pending = true;
      this._rooms.set(code, room);
      return room;
    }

    peers() {
      // Used only for the open-squads list; we leave it empty (no global discovery without a directory)
      return [];
    }

    presence() {
      // no-op for open-squad discovery
    }

    onPeers() {
      return () => {};
    }
  }

  // Expose a Claude-compatible facade so the original game code keeps working
  if (typeof window !== 'undefined') {
    window.claude = window.claude || {};
    window.claude.use = function (name) {
      if (name !== 'room') return Promise.reject(new Error('unsupported'));
      if (!SERVER) return Promise.reject(new Error('no server'));
      return Promise.resolve(new FakeNS());
    };

    // Helper the game can call after creating the room object
    window.__dcFinishJoin = async function (room, name, create) {
      if (room && room._pending) {
        await room._connect(name, create);
        room._pending = false;
      }
      return room;
    };
  }
})();
