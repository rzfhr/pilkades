const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const session = require('express-session');
const bcrypt = require('bcryptjs');
const path = require('path');
const fs = require('fs');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

const PORT = process.env.PORT || 3000;
const DATA_FILE = path.join(__dirname, 'data.json');
const UPLOAD_DIR = path.join(__dirname, 'public', 'uploads');

// Pastikan folder uploads ada
if (!fs.existsSync(UPLOAD_DIR)) {
  fs.mkdirSync(UPLOAD_DIR, { recursive: true });
}

// ====== STATE ======
let state = {
  desa: 'Desa Sukamaju',
  jumlahTps: 5,
  kandidat: [], // {nama, warna, foto}
  dataTps: [],  // {no, dpt, suara:[], tidakSah, lokasi, waktu}
  users: {},    // { username: {pass, role, tpsNo} }
  log: []
};

function loadData() {
  try {
    if (fs.existsSync(DATA_FILE)) {
      state = { ...state, ...JSON.parse(fs.readFileSync(DATA_FILE, 'utf8')) };
    }
  } catch (e) { console.error('Load gagal:', e); }
  
  // Buat admin default jika belum ada user
  if (!state.users || Object.keys(state.users).length === 0) {
    state.users = {
      admin: { pass: bcrypt.hashSync('admin123', 10), role: 'admin' }
    };
  }
}

function saveData() {
  try { fs.writeFileSync(DATA_FILE, JSON.stringify(state, null, 2)); }
  catch (e) { console.error('Save gagal:', e); }
}

loadData();

// ====== MIDDLEWARE ======
app.use(express.json({ limit: '10mb' })); 
app.use(session({
  secret: 'pilkades-secret-v6-' + Math.random(),
  resave: false,
  saveUninitialized: false,
  cookie: { maxAge: 12 * 60 * 60 * 1000 }
}));

function requireAdmin(req, res, next) {
  if (req.session && req.session.role === 'admin') return next();
  return res.status(401).json({ error: 'Akses ditolak. Hanya Admin.' });
}

function requirePetugas(req, res, next) {
  if (req.session && (req.session.role === 'admin' || req.session.role === 'petugas')) return next();
  return res.status(401).json({ error: 'Silakan login dulu' });
}

app.use(express.static(path.join(__dirname, 'public')));

// ====== AUTH API ======
app.post('/api/login', (req, res) => {
  const { username, password } = req.body;
  const user = state.users[username];
  if (!user || !bcrypt.compareSync(password, user.pass))
    return res.status(401).json({ error: 'Username atau password salah' });
  
  req.session.login = true;
  req.session.username = username;
  req.session.role = user.role;
  req.session.tpsNo = user.tpsNo || null;
  
  res.json({ ok: true, role: user.role, tpsNo: user.tpsNo });
});

app.post('/api/logout', (req, res) => {
  req.session.destroy(() => res.json({ ok: true }));
});

app.get('/api/session', (req, res) => {
  res.json({
    login: !!(req.session && req.session.login),
    username: req.session?.username || null,
    role: req.session?.role || null,
    tpsNo: req.session?.tpsNo || null
  });
});

// ====== DATA API ======
app.get('/api/state', (req, res) => {
  const { users, ...safe } = state;
  res.json(safe);
});

// ====== API UPLOAD FOTO ======
app.post('/api/upload', requireAdmin, (req, res) => {
  const { image, ext } = req.body;
  if (!image) return res.status(400).json({ error: 'Gambar kosong' });
  
  const base64Data = image.replace(/^data:image\/\w+;base64,/, "");
  const filename = `kandidat_${Date.now()}.${ext || 'jpg'}`;
  const filepath = path.join(UPLOAD_DIR, filename);
  
  fs.writeFile(filepath, base64Data, 'base64', (err) => {
    if (err) return res.status(500).json({ error: 'Gagal simpan file' });
    res.json({ ok: true, url: `/uploads/${filename}` });
  });
});

// ====== API ADMIN ======
app.post('/api/konfigurasi', requireAdmin, (req, res) => {
  const { desa, jumlahTps, kandidat } = req.body;
  if (desa) state.desa = desa;
  if (jumlahTps) state.jumlahTps = parseInt(jumlahTps);
  if (Array.isArray(kandidat)) state.kandidat = kandidat;
  saveData();
  io.emit('state', safeState());
  res.json({ ok: true });
});

// API USER MANAGEMENT
app.get('/api/users', requireAdmin, (req, res) => {
  const list = {};
  for (const u in state.users) {
    list[u] = { role: state.users[u].role, tpsNo: state.users[u].tpsNo };
  }
  res.json(list);
});

app.post('/api/users', requireAdmin, (req, res) => {
  const { username, password, tpsNo } = req.body;
  if (!username || !password || !tpsNo) return res.status(400).json({ error: 'Data tidak lengkap' });
  if (state.users[username]) return res.status(400).json({ error: 'Username sudah dipakai' });

  state.users[username] = {
    pass: bcrypt.hashSync(password, 10),
    role: 'petugas',
    tpsNo: parseInt(tpsNo)
  };
  saveData();
  res.json({ ok: true });
});

app.delete('/api/users/:username', requireAdmin, (req, res) => {
  if (req.params.username === 'admin') return res.status(400).json({ error: 'Tidak bisa hapus admin utama' });
  delete state.users[req.params.username];
  saveData();
  res.json({ ok: true });
});

// ====== API INPUT TPS ======
app.post('/api/tps', requirePetugas, (req, res) => {
  let { no, dpt, suara, tidakSah, lokasi } = req.body;
  no = parseInt(no);

  if (req.session.role === 'petugas' && req.session.tpsNo !== no) {
    return res.status(403).json({ error: `Anda hanya bisa input TPS ${req.session.tpsNo}` });
  }

  if (!no || no < 1) return res.status(400).json({ error: 'Nomor TPS tidak valid' });
  if (isNaN(dpt) || dpt < 0) return res.status(400).json({ error: 'DPT tidak valid' });
  
  suara = suara.map(s => parseInt(s) || 0);
  tidakSah = parseInt(tidakSah) || 0;

  if (suara.length !== state.kandidat.length)
    return res.status(400).json({ error: 'Jumlah suara tidak sesuai kandidat' });

  const totalSah = suara.reduce((a, b) => a + b, 0);
  if ((totalSah + tidakSah) > dpt) 
    return res.status(400).json({ error: 'Total suara (sah + tidak sah) melebihi DPT' });

  const waktu = new Date().toISOString();
  const data = { no, dpt, suara, tidakSah, lokasi: lokasi || null, waktu };
  
  const idx = state.dataTps.findIndex(t => t.no === no);
  if (idx >= 0) state.dataTps[idx] = data;
  else state.dataTps.push(data);
  state.dataTps.sort((a, b) => a.no - b.no);

  state.log.push({ waktu, aksi: `${req.session.username} ${idx >= 0 ? 'EDIT' : 'INPUT'} TPS ${no}` });
  if (state.log.length > 500) state.log = state.log.slice(-500);

  saveData();
  io.emit('state', safeState());
  res.json({ ok: true });
});

app.delete('/api/tps/:no', requireAdmin, (req, res) => {
  state.dataTps = state.dataTps.filter(t => t.no !== parseInt(req.params.no));
  saveData();
  io.emit('state', safeState());
  res.json({ ok: true });
});

app.delete('/api/reset', requireAdmin, (req, res) => {
  state.dataTps = [];
  state.log = [];
  saveData();
  io.emit('state', safeState());
  res.json({ ok: true });
});

function safeState() {
  const { users, ...s } = state;
  return s;
}

io.on('connection', (socket) => {
  socket.emit('state', safeState());
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`✅ Server jalan di http://localhost:${PORT}`);
});