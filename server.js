'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');

const HOST = process.env.HOST || '0.0.0.0';
const PORT = process.env.PORT || 3000;
const API_TOKEN = process.env.API_TOKEN || '';
const ROOT = __dirname;
const PUBLIC_DIR = path.join(ROOT, 'public');
const DATA_DIR = path.join(ROOT, 'data');
const DATA_FILE = path.join(DATA_DIR, 'items.json');

const STATUSES = ['inbox', 'this_week', 'in_progress', 'done'];
const PRIORITIES = ['高', '中', '低'];

if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
if (!fs.existsSync(DATA_FILE)) fs.writeFileSync(DATA_FILE, JSON.stringify([], null, 2));

function readItems() {
  try {
    const data = fs.readFileSync(DATA_FILE, 'utf8');
    const parsed = JSON.parse(data);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function writeItems(items) {
  fs.writeFileSync(DATA_FILE, JSON.stringify(items, null, 2));
}

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
};

function sendJSON(res, code, data) {
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(data));
}

// 应用层令牌鉴权：未配置 API_TOKEN 时关闭（开发模式）
function authOk(req) {
  if (!API_TOKEN) return true;
  const h = req.headers['authorization'] || '';
  return h === 'Bearer ' + API_TOKEN;
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  const pathname = url.pathname;

  // ---------- API ----------
  if (pathname.startsWith('/api/')) {
    // 公开配置：前端据此决定是否展示登录页
    if (pathname === '/api/config') {
      return sendJSON(res, 200, { authRequired: !!API_TOKEN });
    }
    // 应用层令牌鉴权
    if (API_TOKEN && !authOk(req)) {
      return sendJSON(res, 401, { error: 'unauthorized' });
    }
    let body = '';
    req.on('data', (chunk) => (body += chunk));
    req.on('end', () => {
      try {
        // 列出全部
        if (req.method === 'GET' && pathname === '/api/items') {
          return sendJSON(res, 200, readItems());
        }

        // 新增
        if (req.method === 'POST' && pathname === '/api/items') {
          const item = JSON.parse(body || '{}');
          const items = readItems();
          const now = new Date().toISOString();
          const newItem = {
            id: 'id_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
            source: String(item.source || '').trim(),
            summary: String(item.summary || '').trim(),
            priority: PRIORITIES.includes(item.priority) ? item.priority : '中',
            status: STATUSES.includes(item.status) ? item.status : 'inbox',
            createdAt: now,
            updatedAt: now,
          };
          items.push(newItem);
          writeItems(items);
          return sendJSON(res, 201, newItem);
        }

        // 更新
        if (req.method === 'PUT' && pathname.startsWith('/api/items/')) {
          const id = decodeURIComponent(pathname.split('/').pop());
          const patch = JSON.parse(body || '{}');
          const items = readItems();
          const idx = items.findIndex((i) => i.id === id);
          if (idx === -1) return sendJSON(res, 404, { error: 'not found' });
          const allowed = ['source', 'summary', 'priority', 'status'];
          for (const k of allowed) {
            if (patch[k] === undefined) continue;
            if (k === 'priority' && !PRIORITIES.includes(patch[k])) continue;
            if (k === 'status' && !STATUSES.includes(patch[k])) continue;
            items[idx][k] = patch[k];
          }
          items[idx].updatedAt = new Date().toISOString();
          writeItems(items);
          return sendJSON(res, 200, items[idx]);
        }

        // 删除
        if (req.method === 'DELETE' && pathname.startsWith('/api/items/')) {
          const id = decodeURIComponent(pathname.split('/').pop());
          const items = readItems();
          const before = items.length;
          const next = items.filter((i) => i.id !== id);
          if (next.length === before) return sendJSON(res, 404, { error: 'not found' });
          writeItems(next);
          return sendJSON(res, 200, { ok: true });
        }

        return sendJSON(res, 404, { error: 'unknown endpoint' });
      } catch (e) {
        return sendJSON(res, 500, { error: e.message });
      }
    });
    return;
  }

  // ---------- 静态文件 ----------
  let filePath = pathname === '/' ? path.join(PUBLIC_DIR, 'index.html') : path.join(PUBLIC_DIR, pathname);
  if (!filePath.startsWith(PUBLIC_DIR)) {
    res.writeHead(403);
    return res.end('Forbidden');
  }
  fs.readFile(filePath, (err, data) => {
    if (err) {
      res.writeHead(404);
      return res.end('Not Found');
    }
    const ext = path.extname(filePath);
    res.writeHead(200, { 'Content-Type': MIME[ext] || 'application/octet-stream' });
    res.end(data);
  });
});

server.listen(PORT, HOST, () => {
  console.log(`需求与问题池看板已启动: http://${HOST}:${PORT}`);
});
