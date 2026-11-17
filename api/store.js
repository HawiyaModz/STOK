// api/store.js — Vercel Serverless Backend untuk StokKu
const DB_KEY = 'STOKKU_CLOUD_DB_V1';
const THIRTY_DAYS_MS = 30 * 24 * 60 * 60 * 1000;

function getMonthKey(ts = Date.now()) {
  const d = new Date(ts);
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  return `${y}-${m}`;
}

function formatTimeWIB(ts = Date.now()) {
  const d = new Date(ts);
  const dateStr = d.toLocaleDateString('id-ID', {
    day: '2-digit',
    month: 'short',
    timeZone: 'Asia/Jakarta'
  });
  const timeStr = d.toLocaleTimeString('id-ID', {
    hour: '2-digit',
    minute: '2-digit',
    timeZone: 'Asia/Jakarta'
  });
  return `${dateStr} ${timeStr}`;
}

function roundDec(num) {
  return Math.round((Number(num) + Number.EPSILON) * 1000) / 1000;
}

function cleanChatMessages(messages) {
  if (!Array.isArray(messages)) return [];
  const now = Date.now();
  const currentMonth = getMonthKey(now);
  return messages.filter((msg) => {
    const ts = Number(msg.timestamp) || 0;
    const within30Days = now - ts < THIRTY_DAYS_MS;
    const sameMonth = (msg.monthKey || getMonthKey(ts)) === currentMonth;
    return within30Days && sameMonth;
  });
}

function createInitialState() {
  const now = Date.now();
  const timeStr = formatTimeWIB(now);
  return {
    users: [
      {
        id: 'usr-admin-default',
        name: 'Administrator',
        username: 'admin',
        password: 'admin123',
        role: 'admin',
        createdAt: 'Default Sistem'
      }
    ],
    products: [
      {
        id: 'prod-sample-1',
        name: 'Beras Premium',
        qty: 10,
        unit: 'pcs',
        updatedBy: 'Administrator',
        updatedAt: timeStr,
        lastCalc: 'Stok awal: 10 pcs',
        lastType: 'add',
        history: [{ calc: 'Stok awal: 10 pcs', user: 'Administrator', time: timeStr, type: 'add' }]
      }
    ],
    chats: []
  };
}

// Koneksi ke Upstash Redis / Vercel KV via REST API (tanpa dependensi npm)
async function redisCommand(commandArray) {
  const url = process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN;
  if (!url || !token) return { configured: false, result: null };

  const res = await fetch(url, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify(commandArray)
  });

  if (!res.ok) {
    throw new Error(`Redis error: ${res.status}`);
  }
  const data = await res.json();
  return { configured: true, result: data.result };
}

async function loadState() {
  const { configured, result } = await redisCommand(['GET', DB_KEY]);
  let state = null;

  if (configured) {
    if (result) {
      try {
        state = JSON.parse(result);
      } catch {
        state = null;
      }
    }
    if (!state) {
      state = createInitialState();
      await redisCommand(['SET', DB_KEY, JSON.stringify(state)]);
    }
  } else {
    if (!globalThis.__STOKKU_MEM_STATE) {
      globalThis.__STOKKU_MEM_STATE = createInitialState();
    }
    state = globalThis.__STOKKU_MEM_STATE;
  }

  if (!Array.isArray(state.users)) state.users = [];
  if (!state.users.some((u) => u.username.toLowerCase() === 'admin')) {
    state.users.unshift(createInitialState().users[0]);
  }
  if (!Array.isArray(state.products)) state.products = [];

  const beforeLen = Array.isArray(state.chats) ? state.chats.length : 0;
  state.chats = cleanChatMessages(state.chats);
  if (state.chats.length !== beforeLen) {
    await saveState(state);
  }

  return { state, persistent: configured };
}

async function saveState(state) {
  state.chats = cleanChatMessages(state.chats);
  const { configured } = await redisCommand(['SET', DB_KEY, JSON.stringify(state)]);
  if (!configured) {
    globalThis.__STOKKU_MEM_STATE = state;
  }
  return configured;
}

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store, max-age=0');

  try {
    const { state, persistent } = await loadState();

    if (req.method === 'GET') {
      return res.status(200).json({ ok: true, persistent, state });
    }

    if (req.method === 'POST') {
      const body = typeof req.body === 'string' ? JSON.parse(req.body) : req.body || {};
      const { action, payload = {} } = body;
      const now = Date.now();
      const timeNow = formatTimeWIB(now);

      switch (action) {
        case 'ADD_PRODUCT': {
          const name = String(payload.name || '').trim();
          const addQty = roundDec(parseFloat(payload.qty));
          const unit = String(payload.unit || 'pcs').trim();
          const userName = String(payload.userName || 'User').trim();

          if (!name || isNaN(addQty) || addQty <= 0) {
            return res.status(400).json({ ok: false, error: 'Data produk tidak valid' });
          }

          const idx = state.products.findIndex(
            (p) => p.name.trim().toLowerCase() === name.toLowerCase() && p.unit === unit
          );

          if (idx !== -1) {
            const oldQty = state.products[idx].qty;
            const newQty = roundDec(oldQty + addQty);
            const calcStr = `${oldQty} + ${addQty} = ${newQty} ${unit}`;

            state.products[idx].qty = newQty;
            state.products[idx].updatedBy = userName;
            state.products[idx].updatedAt = timeNow;
            state.products[idx].lastCalc = calcStr;
            state.products[idx].lastType = 'add';
            state.products[idx].history = state.products[idx].history || [];
            state.products[idx].history.unshift({
              calc: calcStr,
              user: userName,
              time: timeNow,
              type: 'add'
            });

            const updated = state.products.splice(idx, 1)[0];
            state.products.unshift(updated);
          } else {
            const calcStr = `Stok awal: ${addQty} ${unit}`;
            state.products.unshift({
              id: 'prod-' + now + '-' + Math.random().toString(36).slice(2, 6),
              name,
              qty: addQty,
              unit,
              updatedBy: userName,
              updatedAt: timeNow,
              lastCalc: calcStr,
              lastType: 'add',
              history: [{ calc: calcStr, user: userName, time: timeNow, type: 'add' }]
            });
          }
          break;
        }

        case 'ADJUST_STOCK': {
          const { id, delta, userName = 'User' } = payload;
          const idx = state.products.findIndex((p) => p.id === id);
          if (idx === -1) return res.status(404).json({ ok: false, error: 'Produk tidak ditemukan' });

          const p = state.products[idx];
          const newQty = roundDec(p.qty + Number(delta));
          if (newQty < 0) {
            return res.status(400).json({ ok: false, error: 'Stok tidak boleh kurang dari 0' });
          }

          const absVal = Math.abs(roundDec(delta));
          const sign = Number(delta) >= 0 ? '+' : '-';
          const calcStr = `${p.qty} ${sign} ${absVal} = ${newQty} ${p.unit}`;
          const type = Number(delta) >= 0 ? 'add' : 'sub';

          p.qty = newQty;
          p.updatedBy = userName;
          p.updatedAt = timeNow;
          p.lastCalc = calcStr;
          p.lastType = type;
          p.history = p.history || [];
          p.history.unshift({ calc: calcStr, user: userName, time: timeNow, type });
          break;
        }

        case 'RESET_ALL_STOCK': {
          const userName = String(payload.userName || 'User').trim();
          state.products = state.products.map((p) => {
            const calcStr = `Reset stok: ${p.qty} → 0 ${p.unit}`;
            const hist = Array.isArray(p.history) ? p.history : [];
            hist.unshift({ calc: calcStr, user: userName, time: timeNow, type: 'sub' });
            return {
              ...p,
              qty: 0,
              updatedBy: userName,
              updatedAt: timeNow,
              lastCalc: calcStr,
              lastType: 'sub',
              history: hist
            };
          });
          break;
        }

        case 'DELETE_PRODUCT': {
          state.products = state.products.filter((p) => p.id !== payload.id);
          break;
        }

        case 'DELETE_ALL_PRODUCTS': {
          state.products = [];
          break;
        }

        case 'SEND_CHAT': {
          const text = String(payload.text || '').trim();
          if (!text) return res.status(400).json({ ok: false, error: 'Pesan kosong' });

          state.chats.push({
            id: 'chat-' + now + '-' + Math.random().toString(36).slice(2, 6),
            userId: payload.userId || 'unknown',
            userName: payload.userName || 'User',
            userRole: payload.userRole || 'user',
            text: text.slice(0, 1000),
            timestamp: now,
            monthKey: getMonthKey(now),
            timeLabel: timeNow
          });
          break;
        }

        case 'CLEAR_CHAT': {
          state.chats = [];
          break;
        }

        case 'CREATE_USER': {
          const name = String(payload.name || '').trim();
          const username = String(payload.username || '').trim();
          const password = String(payload.password || '').trim();
          const role = payload.role === 'admin' ? 'admin' : 'user';

          if (!name || !username || password.length < 4) {
            return res.status(400).json({ ok: false, error: 'Data user tidak lengkap' });
          }
          if (state.users.some((u) => u.username.toLowerCase() === username.toLowerCase())) {
            return res.status(400).json({ ok: false, error: 'Username sudah terdaftar' });
          }

          state.users.push({
            id: 'usr-' + now + '-' + Math.random().toString(36).slice(2, 6),
            name,
            username,
            password,
            role,
            createdAt: timeNow
          });
          break;
        }

        case 'DELETE_USER': {
          const target = state.users.find((u) => u.id === payload.id);
          if (target && target.username.toLowerCase() !== 'admin') {
            state.users = state.users.filter((u) => u.id !== payload.id);
          }
          break;
        }

        default:
          return res.status(400).json({ ok: false, error: 'Aksi tidak dikenal' });
      }

      const isPersistent = await saveState(state);
      return res.status(200).json({ ok: true, persistent: isPersistent, state });
    }

    return res.status(405).json({ ok: false, error: 'Method tidak diizinkan' });
  } catch (err) {
    return res.status(500).json({ ok: false, error: err.message || 'Terjadi kesalahan server' });
  }
}
