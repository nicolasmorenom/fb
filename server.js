const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { URL } = require('url');

const PORT = Number(process.env.PORT || 3000);
const PASSWORD = 'MAcondo2026.';
const DATA_FILE = path.join(__dirname, 'budget-data.json');
const SESSION_COOKIE = 'familyBudgetSession';
const sessions = new Map();

function createId() {
  if (typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  return crypto.randomBytes(16).toString('hex');
}

function getDefaultData() {
  return {
    categories: [
      { id: createId(), name: 'Housing', icon: '🏠', color: '#9b6b43', budget: 2000 },
      { id: createId(), name: 'Groceries', icon: '🛒', color: '#7d9b5f', budget: 600 },
      { id: createId(), name: 'Transport', icon: '🚗', color: '#5e81ac', budget: 400 },
      { id: createId(), name: 'Utilities', icon: '⚡', color: '#c18c2e', budget: 200 },
      { id: createId(), name: 'Dining Out', icon: '🍽️', color: '#b35c44', budget: 300 },
      { id: createId(), name: 'Healthcare', icon: '💊', color: '#7d6db3', budget: 150 }
    ],
    transactions: []
  };
}

function ensureDataFile() {
  if (!fs.existsSync(DATA_FILE)) {
    fs.writeFileSync(DATA_FILE, JSON.stringify(getDefaultData(), null, 2));
  }
}

function readData() {
  ensureDataFile();
  try {
    const parsed = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
    return {
      categories: Array.isArray(parsed.categories) ? parsed.categories : getDefaultData().categories,
      transactions: Array.isArray(parsed.transactions) ? parsed.transactions : []
    };
  } catch {
    const fallback = getDefaultData();
    fs.writeFileSync(DATA_FILE, JSON.stringify(fallback, null, 2));
    return fallback;
  }
}

function writeData(data) {
  fs.writeFileSync(DATA_FILE, JSON.stringify(data, null, 2));
}

function parseCookies(req) {
  const header = req.headers.cookie || '';
  return header.split(';').reduce((acc, part) => {
    const trimmed = part.trim();
    if (!trimmed) return acc;
    const eqIndex = trimmed.indexOf('=');
    const key = eqIndex >= 0 ? trimmed.slice(0, eqIndex) : trimmed;
    const value = eqIndex >= 0 ? trimmed.slice(eqIndex + 1) : '';
    acc[key] = decodeURIComponent(value);
    return acc;
  }, {});
}

function getSession(req) {
  const cookies = parseCookies(req);
  const token = cookies[SESSION_COOKIE];
  if (!token) return null;
  return sessions.get(token) ? token : null;
}

function sendJson(res, statusCode, payload, headers = {}) {
  res.writeHead(statusCode, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    ...headers
  });
  res.end(JSON.stringify(payload));
}

function sendText(res, statusCode, body, headers = {}) {
  res.writeHead(statusCode, {
    'Content-Type': 'text/plain; charset=utf-8',
    ...headers
  });
  res.end(body);
}

function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    let raw = '';
    req.on('data', (chunk) => {
      raw += chunk;
      if (raw.length > 1_000_000) {
        reject(new Error('Payload too large'));
        req.destroy();
      }
    });
    req.on('end', () => {
      if (!raw) {
        resolve({});
        return;
      }
      try {
        resolve(JSON.parse(raw));
      } catch {
        reject(new Error('Invalid JSON body'));
      }
    });
    req.on('error', reject);
  });
}

function requireAuth(req, res) {
  if (getSession(req)) return true;
  sendJson(res, 401, { error: 'Unauthorized' });
  return false;
}

function validateCategory(payload) {
  const name = String(payload.name || '').trim();
  const icon = String(payload.icon || '').trim();
  const color = String(payload.color || '').trim();
  const budget = Number(payload.budget);
  if (!name) return 'Category name is required.';
  if (!icon) return 'Category icon is required.';
  if (!/^#[0-9a-fA-F]{6}$/.test(color)) return 'Category color must be a hex value.';
  if (!Number.isFinite(budget) || budget < 0) return 'Category budget must be a non-negative number.';
  return null;
}

function validateTransaction(payload) {
  const description = String(payload.description || '').trim();
  const amount = Number(payload.amount);
  const type = String(payload.type || '').trim();
  const date = String(payload.date || '').trim();
  const member = String(payload.member || '').trim();
  if (!description) return 'Transaction description is required.';
  if (!Number.isFinite(amount) || amount < 0) return 'Transaction amount must be a non-negative number.';
  if (!['income', 'expense'].includes(type)) return 'Transaction type must be income or expense.';
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return 'Transaction date must use YYYY-MM-DD format.';
  if (!member) return 'Family member name is required.';
  return null;
}

function serveStatic(req, res, pathname) {
  const target = pathname === '/' ? 'index.html' : pathname.slice(1);
  const filePath = path.join(__dirname, target);
  if (!filePath.startsWith(__dirname)) {
    sendText(res, 403, 'Forbidden');
    return;
  }
  fs.readFile(filePath, (err, content) => {
    if (err) {
      sendText(res, 404, 'Not found');
      return;
    }
    const ext = path.extname(filePath);
    const types = {
      '.html': 'text/html; charset=utf-8',
      '.js': 'application/javascript; charset=utf-8',
      '.json': 'application/json; charset=utf-8',
      '.css': 'text/css; charset=utf-8'
    };
    res.writeHead(200, { 'Content-Type': types[ext] || 'application/octet-stream' });
    res.end(content);
  });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const { pathname } = url;

  if (pathname === '/api/session' && req.method === 'GET') {
    sendJson(res, 200, { authenticated: Boolean(getSession(req)) });
    return;
  }

  if (pathname === '/api/login' && req.method === 'POST') {
    try {
      const body = await readJsonBody(req);
      if (body.password !== PASSWORD) {
        sendJson(res, 401, { error: 'Incorrect password' });
        return;
      }
      const token = createId();
      sessions.set(token, true);
      sendJson(res, 200, { authenticated: true }, {
        'Set-Cookie': `${SESSION_COOKIE}=${encodeURIComponent(token)}; HttpOnly; Path=/; SameSite=Lax`
      });
    } catch (error) {
      sendJson(res, 400, { error: error.message });
    }
    return;
  }

  if (pathname === '/api/logout' && req.method === 'POST') {
    const token = getSession(req);
    if (token) sessions.delete(token);
    sendJson(res, 200, { authenticated: false }, {
      'Set-Cookie': `${SESSION_COOKIE}=; HttpOnly; Path=/; SameSite=Lax; Max-Age=0`
    });
    return;
  }

  if (pathname === '/api/data' && req.method === 'GET') {
    if (!requireAuth(req, res)) return;
    sendJson(res, 200, readData());
    return;
  }

  if (pathname === '/api/categories' && req.method === 'POST') {
    if (!requireAuth(req, res)) return;
    try {
      const payload = await readJsonBody(req);
      const error = validateCategory(payload);
      if (error) {
        sendJson(res, 400, { error });
        return;
      }
      const data = readData();
      const category = {
        id: createId(),
        name: String(payload.name).trim(),
        icon: String(payload.icon).trim(),
        color: String(payload.color).trim(),
        budget: Number(payload.budget)
      };
      data.categories.push(category);
      writeData(data);
      sendJson(res, 201, category);
    } catch (error) {
      sendJson(res, 400, { error: error.message });
    }
    return;
  }

  if (pathname.startsWith('/api/categories/') && req.method === 'PUT') {
    if (!requireAuth(req, res)) return;
    try {
      const id = pathname.split('/').pop();
      const payload = await readJsonBody(req);
      const error = validateCategory(payload);
      if (error) {
        sendJson(res, 400, { error });
        return;
      }
      const data = readData();
      const index = data.categories.findIndex((item) => item.id === id);
      if (index === -1) {
        sendJson(res, 404, { error: 'Category not found.' });
        return;
      }
      const category = {
        id,
        name: String(payload.name).trim(),
        icon: String(payload.icon).trim(),
        color: String(payload.color).trim(),
        budget: Number(payload.budget)
      };
      data.categories[index] = category;
      writeData(data);
      sendJson(res, 200, category);
    } catch (error) {
      sendJson(res, 400, { error: error.message });
    }
    return;
  }

  if (pathname.startsWith('/api/categories/') && req.method === 'DELETE') {
    if (!requireAuth(req, res)) return;
    const id = pathname.split('/').pop();
    const data = readData();
    data.categories = data.categories.filter((item) => item.id !== id);
    data.transactions = data.transactions.map((item) => item.categoryId === id ? { ...item, categoryId: '' } : item);
    writeData(data);
    sendJson(res, 200, { success: true });
    return;
  }

  if (pathname === '/api/transactions' && req.method === 'POST') {
    if (!requireAuth(req, res)) return;
    try {
      const payload = await readJsonBody(req);
      const error = validateTransaction(payload);
      if (error) {
        sendJson(res, 400, { error });
        return;
      }
      const data = readData();
      const transaction = {
        id: createId(),
        description: String(payload.description).trim(),
        amount: Number(payload.amount),
        type: String(payload.type).trim(),
        categoryId: String(payload.categoryId || ''),
        date: String(payload.date).trim(),
        member: String(payload.member).trim()
      };
      data.transactions.push(transaction);
      writeData(data);
      sendJson(res, 201, transaction);
    } catch (error) {
      sendJson(res, 400, { error: error.message });
    }
    return;
  }

  if (pathname.startsWith('/api/transactions/') && req.method === 'PUT') {
    if (!requireAuth(req, res)) return;
    try {
      const id = pathname.split('/').pop();
      const payload = await readJsonBody(req);
      const error = validateTransaction(payload);
      if (error) {
        sendJson(res, 400, { error });
        return;
      }
      const data = readData();
      const index = data.transactions.findIndex((item) => item.id === id);
      if (index === -1) {
        sendJson(res, 404, { error: 'Transaction not found.' });
        return;
      }
      const transaction = {
        id,
        description: String(payload.description).trim(),
        amount: Number(payload.amount),
        type: String(payload.type).trim(),
        categoryId: String(payload.categoryId || ''),
        date: String(payload.date).trim(),
        member: String(payload.member).trim()
      };
      data.transactions[index] = transaction;
      writeData(data);
      sendJson(res, 200, transaction);
    } catch (error) {
      sendJson(res, 400, { error: error.message });
    }
    return;
  }

  if (pathname.startsWith('/api/transactions/') && req.method === 'DELETE') {
    if (!requireAuth(req, res)) return;
    const id = pathname.split('/').pop();
    const data = readData();
    data.transactions = data.transactions.filter((item) => item.id !== id);
    writeData(data);
    sendJson(res, 200, { success: true });
    return;
  }

  if (req.method === 'GET') {
    serveStatic(req, res, pathname);
    return;
  }

  sendText(res, 404, 'Not found');
});

server.listen(PORT, () => {
  ensureDataFile();
  console.log(`Family Budget server listening on http://localhost:${PORT}`);
});
