// StokKu GitHub-backed storage for Vercel.
// Data files are committed to the configured GitHub repository as produk.js, user.js and chat.js.

const API = 'https://api.github.com';
const FILES = {
  products: process.env.GITHUB_PRODUCTS_PATH || 'produk.js',
  users: process.env.GITHUB_USERS_PATH || 'user.js',
  chats: process.env.GITHUB_CHATS_PATH || 'chat.js'
};
const THIRTY_DAYS_MS = 30 * 24 * 60 * 60 * 1000;

function githubConfig() {
  const token = process.env.GITHUB_TOKEN;
  const owner = process.env.GITHUB_OWNER;
  const repo = process.env.GITHUB_REPO;
  const branch = process.env.GITHUB_BRANCH || 'main';
  if (!token || !owner || !repo) {
    throw new Error('Konfigurasi GitHub belum lengkap. Isi GITHUB_TOKEN, GITHUB_OWNER, dan GITHUB_REPO di Vercel.');
  }
  return { token, owner, repo, branch };
}

function githubHeaders(token) {
  return {
    Authorization: `Bearer ${token}`,
    Accept: 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
    'Content-Type': 'application/json'
  };
}

function getMonthKey(ts = Date.now()) {
  const d = new Date(ts);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
}
function formatTimeWIB(ts = Date.now()) {
  const d = new Date(ts);
  const dateStr = d.toLocaleDateString('id-ID', { day: '2-digit', month: 'short', timeZone: 'Asia/Jakarta' });
  const timeStr = d.toLocaleTimeString('id-ID', { hour: '2-digit', minute: '2-digit', timeZone: 'Asia/Jakarta' });
  return `${dateStr} ${timeStr}`;
}
function roundDec(num) { return Math.round((Number(num) + Number.EPSILON) * 1000) / 1000; }
function cleanChatMessages(messages) {
  if (!Array.isArray(messages)) return [];
  const now = Date.now();
  return messages.filter((msg) => {
    const ts = Number(msg.timestamp) || 0;
    return now - ts < THIRTY_DAYS_MS && (msg.monthKey || getMonthKey(ts)) === getMonthKey(now);
  });
}
function createInitialState() {
  const timeStr = formatTimeWIB();
  return {
    users: [{ id: 'usr-admin-default', name: 'Administrator', username: 'admin', password: 'admin123', role: 'admin', createdAt: 'Default Sistem' }],
    products: [{
      id: 'prod-sample-1', name: 'Beras Premium', qty: 10, unit: 'pcs', updatedBy: 'Administrator', updatedAt: timeStr,
      lastCalc: 'Stok awal: 10 pcs', lastType: 'add',
      history: [{ calc: 'Stok awal: 10 pcs', user: 'Administrator', time: timeStr, type: 'add' }]
    }],
    chats: []
  };
}

function parseJsData(content, fallback) {
  if (!content) return fallback;
  const source = Buffer.from(content, 'base64').toString('utf8').trim();
  const match = source.match(/^export\s+default\s+([\s\S]*);?\s*$/);
  if (!match) throw new Error('Format file data GitHub tidak valid. File harus berisi export default {...};');
  return JSON.parse(match[1].replace(/;\s*$/, ''));
}
function encodeJsData(data) {
  return Buffer.from(`export default ${JSON.stringify(data, null, 2)};\n`, 'utf8').toString('base64');
}

async function getGitHubFile(path) {
  const { token, owner, repo, branch } = githubConfig();
  const url = `${API}/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/contents/${path.split('/').map(encodeURIComponent).join('/')}?ref=${encodeURIComponent(branch)}`;
  const response = await fetch(url, { headers: githubHeaders(token), cache: 'no-store' });
  if (response.status === 404) return { data: null, sha: null };
  if (!response.ok) throw new Error(`Gagal membaca ${path} dari GitHub (${response.status}).`);
  const file = await response.json();
  return { data: parseJsData(file.content, null), sha: file.sha };
}

async function putGitHubFile(path, data, sha, message) {
  const { token, owner, repo, branch } = githubConfig();
  const url = `${API}/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/contents/${path.split('/').map(encodeURIComponent).join('/')}`;
  const body = { message, content: encodeJsData(data), branch };
  if (sha) body.sha = sha;
  const response = await fetch(url, { method: 'PUT', headers: githubHeaders(token), body: JSON.stringify(body) });
  if (response.status === 409 || response.status === 422) {
    throw new Error(`Konflik saat memperbarui ${path}. Ada perubahan bersamaan di GitHub; muat ulang lalu coba lagi.`);
  }
  if (!response.ok) {
    const detail = await response.json().catch(() => ({}));
    throw new Error(`Gagal menyimpan ${path} ke GitHub (${response.status}): ${detail.message || 'periksa izin token dan branch'}`);
  }
}

async function loadState() {
  const [productsFile, usersFile, chatsFile] = await Promise.all([
    getGitHubFile(FILES.products), getGitHubFile(FILES.users), getGitHubFile(FILES.chats)
  ]);
  const defaults = createInitialState();
  const state = {
    products: Array.isArray(productsFile.data) ? productsFile.data : defaults.products,
    users: Array.isArray(usersFile.data) ? usersFile.data : defaults.users,
    chats: cleanChatMessages(Array.isArray(chatsFile.data) ? chatsFile.data : [])
  };
  if (!state.users.some((u) => String(u.username || '').toLowerCase() === 'admin')) state.users.unshift(defaults.users[0]);
  if (!productsFile.sha) await putGitHubFile(FILES.products, state.products, null, 'Initialize StokKu products');
  if (!usersFile.sha) await putGitHubFile(FILES.users, state.users, null, 'Initialize StokKu users');
  if (!chatsFile.sha) await putGitHubFile(FILES.chats, state.chats, null, 'Initialize StokKu chats');
  return { state, files: { products: productsFile, users: usersFile, chats: chatsFile } };
}

async function saveState(state, files, changed) {
  // Save only the file(s) affected by this action, keeping products and accounts separate.
  const jobs = [];
  if (changed.includes('products')) jobs.push(putGitHubFile(FILES.products, state.products, files.products.sha, 'Update StokKu products'));
  if (changed.includes('users')) jobs.push(putGitHubFile(FILES.users, state.users, files.users.sha, 'Update StokKu users'));
  if (changed.includes('chats')) jobs.push(putGitHubFile(FILES.chats, state.chats, files.chats.sha, 'Update StokKu chats'));
  await Promise.all(jobs);
  return true;
}

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store, max-age=0');
  try {
    const { state, files } = await loadState();
    if (req.method === 'GET') return res.status(200).json({ ok: true, persistent: true, storage: 'github', state });
    if (req.method !== 'POST') return res.status(405).json({ ok: false, error: 'Method tidak diizinkan' });

    const body = typeof req.body === 'string' ? JSON.parse(req.body) : req.body || {};
    const { action, payload = {} } = body;
    const now = Date.now();
    const timeNow = formatTimeWIB(now);
    const changed = [];

    switch (action) {
      case 'ADD_PRODUCT': {
        const name = String(payload.name || '').trim();
        const addQty = roundDec(parseFloat(payload.qty));
        const unit = String(payload.unit || 'pcs').trim();
        const userName = String(payload.userName || 'User').trim();
        if (!name || isNaN(addQty) || addQty <= 0) return res.status(400).json({ ok: false, error: 'Data produk tidak valid' });
        const idx = state.products.findIndex((p) => p.name.trim().toLowerCase() === name.toLowerCase() && p.unit === unit);
        if (idx !== -1) {
          const p = state.products[idx]; const oldQty = p.qty; const newQty = roundDec(oldQty + addQty);
          const calcStr = `${oldQty} + ${addQty} = ${newQty} ${unit}`;
          Object.assign(p, { qty: newQty, updatedBy: userName, updatedAt: timeNow, lastCalc: calcStr, lastType: 'add' });
          p.history = p.history || []; p.history.unshift({ calc: calcStr, user: userName, time: timeNow, type: 'add' });
          state.products.unshift(state.products.splice(idx, 1)[0]);
        } else {
          const calcStr = `Stok awal: ${addQty} ${unit}`;
          state.products.unshift({ id: 'prod-' + now + '-' + Math.random().toString(36).slice(2, 6), name, qty: addQty, unit, updatedBy: userName, updatedAt: timeNow, lastCalc: calcStr, lastType: 'add', history: [{ calc: calcStr, user: userName, time: timeNow, type: 'add' }] });
        }
        changed.push('products'); break;
      }
      case 'ADJUST_STOCK': {
        const { id, delta, userName = 'User' } = payload;
        const p = state.products.find((item) => item.id === id);
        if (!p) return res.status(404).json({ ok: false, error: 'Produk tidak ditemukan' });
        const amount = Number(delta);
        if (!Number.isFinite(amount) || amount === 0) return res.status(400).json({ ok: false, error: 'Perubahan stok tidak valid' });
        const newQty = roundDec(p.qty + amount);
        if (newQty < 0) return res.status(400).json({ ok: false, error: 'Stok tidak boleh kurang dari 0' });
        const absVal = Math.abs(roundDec(amount)); const sign = amount >= 0 ? '+' : '-';
        const calcStr = `${p.qty} ${sign} ${absVal} = ${newQty} ${p.unit}`; const type = amount >= 0 ? 'add' : 'sub';
        Object.assign(p, { qty: newQty, updatedBy: userName, updatedAt: timeNow, lastCalc: calcStr, lastType: type });
        p.history = p.history || []; p.history.unshift({ calc: calcStr, user: userName, time: timeNow, type });
        changed.push('products'); break;
      }
      case 'RESET_ALL_STOCK': {
        const userName = String(payload.userName || 'User').trim();
        state.products = state.products.map((p) => {
          const calcStr = `Reset stok: ${p.qty} → 0 ${p.unit}`; const history = Array.isArray(p.history) ? p.history : [];
          history.unshift({ calc: calcStr, user: userName, time: timeNow, type: 'sub' });
          return { ...p, qty: 0, updatedBy: userName, updatedAt: timeNow, lastCalc: calcStr, lastType: 'sub', history };
        });
        changed.push('products'); break;
      }
      case 'DELETE_PRODUCT': state.products = state.products.filter((p) => p.id !== payload.id); changed.push('products'); break;
      case 'DELETE_ALL_PRODUCTS': state.products = []; changed.push('products'); break;
      case 'SEND_CHAT': {
        const text = String(payload.text || '').trim();
        if (!text) return res.status(400).json({ ok: false, error: 'Pesan kosong' });
        state.chats.push({ id: 'chat-' + now + '-' + Math.random().toString(36).slice(2, 6), userId: payload.userId || 'unknown', userName: payload.userName || 'User', userRole: payload.userRole || 'user', text: text.slice(0, 1000), timestamp: now, monthKey: getMonthKey(now), timeLabel: timeNow });
        state.chats = cleanChatMessages(state.chats); changed.push('chats'); break;
      }
      case 'CLEAR_CHAT': state.chats = []; changed.push('chats'); break;
      case 'CREATE_USER': {
        const name = String(payload.name || '').trim(); const username = String(payload.username || '').trim();
        const password = String(payload.password || '').trim(); const role = payload.role === 'admin' ? 'admin' : 'user';
        if (!name || !username || password.length < 4) return res.status(400).json({ ok: false, error: 'Data user tidak lengkap' });
        if (state.users.some((u) => String(u.username).toLowerCase() === username.toLowerCase())) return res.status(400).json({ ok: false, error: 'Username sudah terdaftar' });
        state.users.push({ id: 'usr-' + now + '-' + Math.random().toString(36).slice(2, 6), name, username, password, role, createdAt: timeNow });
        changed.push('users'); break;
      }
      case 'DELETE_USER': {
        const target = state.users.find((u) => u.id === payload.id);
        if (target && String(target.username).toLowerCase() !== 'admin') { state.users = state.users.filter((u) => u.id !== payload.id); changed.push('users'); }
        break;
      }
      default: return res.status(400).json({ ok: false, error: 'Aksi tidak dikenal' });
    }

    await saveState(state, files, changed);
    return res.status(200).json({ ok: true, persistent: true, storage: 'github', state });
  } catch (err) {
    return res.status(500).json({ ok: false, error: err.message || 'Terjadi kesalahan server' });
  }
}
