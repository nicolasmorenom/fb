const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { URL } = require('url');
const { DatabaseSync } = require('node:sqlite');

const PORT = Number(process.env.PORT || 3000);
const DB_FILE = path.join(__dirname, 'budget.db');

function createId() {
  if (typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  return crypto.randomBytes(16).toString('hex');
}

const defaultCategories = [
  { name: 'Housing', color: '#9b6b43', budget: 2000 },
  { name: 'Groceries', color: '#7d9b5f', budget: 600 },
  { name: 'Transport', color: '#5e81ac', budget: 400 },
  { name: 'Utilities', color: '#c18c2e', budget: 200 },
  { name: 'Dining Out', color: '#b35c44', budget: 300 },
  { name: 'Healthcare', color: '#7d6db3', budget: 150 }
];

const db = new DatabaseSync(DB_FILE);

function setupDatabase() {
  db.exec(`
    PRAGMA journal_mode = WAL;
    CREATE TABLE IF NOT EXISTS categories (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      color TEXT NOT NULL,
      budget REAL NOT NULL CHECK (budget >= 0)
    );
    CREATE TABLE IF NOT EXISTS transactions (
      id TEXT PRIMARY KEY,
      description TEXT NOT NULL,
      amount REAL NOT NULL CHECK (amount >= 0),
      type TEXT NOT NULL CHECK (type IN ('income','expense')),
      category_id TEXT NOT NULL DEFAULT '',
      date TEXT NOT NULL,
      member TEXT NOT NULL
    );
  `);

  const categoryCount = db.prepare('SELECT COUNT(*) AS count FROM categories').get().count;
  if (!categoryCount) {
    const insertCategory = db.prepare(`
      INSERT INTO categories (id, name, color, budget)
      VALUES (?, ?, ?, ?)
    `);
    defaultCategories.forEach((category) => {
      insertCategory.run(createId(), category.name, category.color, category.budget);
    });
  }
}

function listCategories() {
  return db.prepare(`
    SELECT id, name, color, budget
    FROM categories
    ORDER BY rowid ASC
  `).all();
}

function listTransactions() {
  return db.prepare(`
    SELECT
      id,
      description,
      amount,
      type,
      category_id AS categoryId,
      date,
      member
    FROM transactions
    ORDER BY date DESC, rowid DESC
  `).all();
}

function getAllData() {
  return {
    categories: listCategories(),
    transactions: listTransactions()
  };
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

function validateCategory(payload) {
  const name = String(payload.name || '').trim();
  const color = String(payload.color || '').trim();
  const budget = Number(payload.budget);
  if (!name) return 'Category name is required.';
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

  if (pathname === '/api/data' && req.method === 'GET') {
    sendJson(res, 200, getAllData());
    return;
  }

  if (pathname === '/api/categories' && req.method === 'POST') {
    try {
      const payload = await readJsonBody(req);
      const error = validateCategory(payload);
      if (error) {
        sendJson(res, 400, { error });
        return;
      }
      const category = {
        id: createId(),
        name: String(payload.name).trim(),
        color: String(payload.color).trim(),
        budget: Number(payload.budget)
      };
      db.prepare(`
        INSERT INTO categories (id, name, color, budget)
        VALUES (?, ?, ?, ?)
      `).run(category.id, category.name, category.color, category.budget);
      sendJson(res, 201, category);
    } catch (error) {
      sendJson(res, 400, { error: error.message });
    }
    return;
  }

  if (pathname.startsWith('/api/categories/') && req.method === 'PUT') {
    try {
      const id = pathname.split('/').pop();
      const payload = await readJsonBody(req);
      const error = validateCategory(payload);
      if (error) {
        sendJson(res, 400, { error });
        return;
      }
      const exists = db.prepare('SELECT id FROM categories WHERE id = ?').get(id);
      if (!exists) {
        sendJson(res, 404, { error: 'Category not found.' });
        return;
      }
      const category = {
        id,
        name: String(payload.name).trim(),
        color: String(payload.color).trim(),
        budget: Number(payload.budget)
      };
      db.prepare(`
        UPDATE categories
        SET name = ?, color = ?, budget = ?
        WHERE id = ?
      `).run(category.name, category.color, category.budget, id);
      sendJson(res, 200, category);
    } catch (error) {
      sendJson(res, 400, { error: error.message });
    }
    return;
  }

  if (pathname.startsWith('/api/categories/') && req.method === 'DELETE') {
    const id = pathname.split('/').pop();
    db.prepare('DELETE FROM categories WHERE id = ?').run(id);
    db.prepare("UPDATE transactions SET category_id = '' WHERE category_id = ?").run(id);
    sendJson(res, 200, { success: true });
    return;
  }

  if (pathname === '/api/transactions' && req.method === 'POST') {
    try {
      const payload = await readJsonBody(req);
      const error = validateTransaction(payload);
      if (error) {
        sendJson(res, 400, { error });
        return;
      }
      const transaction = {
        id: createId(),
        description: String(payload.description).trim(),
        amount: Number(payload.amount),
        type: String(payload.type).trim(),
        categoryId: String(payload.categoryId || ''),
        date: String(payload.date).trim(),
        member: String(payload.member).trim()
      };
      db.prepare(`
        INSERT INTO transactions (id, description, amount, type, category_id, date, member)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `).run(
        transaction.id,
        transaction.description,
        transaction.amount,
        transaction.type,
        transaction.categoryId,
        transaction.date,
        transaction.member
      );
      sendJson(res, 201, transaction);
    } catch (error) {
      sendJson(res, 400, { error: error.message });
    }
    return;
  }

  if (pathname.startsWith('/api/transactions/') && req.method === 'PUT') {
    try {
      const id = pathname.split('/').pop();
      const payload = await readJsonBody(req);
      const error = validateTransaction(payload);
      if (error) {
        sendJson(res, 400, { error });
        return;
      }
      const exists = db.prepare('SELECT id FROM transactions WHERE id = ?').get(id);
      if (!exists) {
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
      db.prepare(`
        UPDATE transactions
        SET description = ?, amount = ?, type = ?, category_id = ?, date = ?, member = ?
        WHERE id = ?
      `).run(
        transaction.description,
        transaction.amount,
        transaction.type,
        transaction.categoryId,
        transaction.date,
        transaction.member,
        id
      );
      sendJson(res, 200, transaction);
    } catch (error) {
      sendJson(res, 400, { error: error.message });
    }
    return;
  }

  if (pathname.startsWith('/api/transactions/') && req.method === 'DELETE') {
    const id = pathname.split('/').pop();
    db.prepare('DELETE FROM transactions WHERE id = ?').run(id);
    sendJson(res, 200, { success: true });
    return;
  }

  if (req.method === 'GET') {
    serveStatic(req, res, pathname);
    return;
  }

  sendText(res, 404, 'Not found');
});

setupDatabase();

server.listen(PORT, () => {
  console.log(`Family Budget server listening on http://localhost:${PORT}`);
  console.log(`Using SQLite database at ${DB_FILE}`);
});
