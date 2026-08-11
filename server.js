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
const DATA_FILE_NOTES = path.join(DATA_DIR, 'notes.json');
const UPLOAD_DIR = path.join(DATA_DIR, 'uploads');

const STATUSES = ['inbox', 'this_week', 'in_progress', 'done'];
const PRIORITIES = ['高', '中', '低'];
const MAX_UPLOAD = 8 * 1024 * 1024; // 单张图片上限 8MB
const UPLOAD_EXT = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/gif': 'gif', 'image/webp': 'webp' };

if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
if (!fs.existsSync(UPLOAD_DIR)) fs.mkdirSync(UPLOAD_DIR, { recursive: true });
if (!fs.existsSync(DATA_FILE)) fs.writeFileSync(DATA_FILE, JSON.stringify([], null, 2));
if (!fs.existsSync(DATA_FILE_NOTES)) fs.writeFileSync(DATA_FILE_NOTES, JSON.stringify([], null, 2));

// 兼容旧字段：把单字段 date 迁移为 dateStart（日期范围）
function normalizeItem(it) {
  if (it && it.date && !it.dateStart) {
    it.dateStart = it.date;
    if (it.dateEnd === undefined) it.dateEnd = '';
    delete it.date;
  }
  if (it && it.dateStart === undefined) it.dateStart = '';
  if (it && it.dateEnd === undefined) it.dateEnd = '';
  if (it && !Array.isArray(it.images)) it.images = [];
  return it;
}

function readItems() {
  try {
    const data = fs.readFileSync(DATA_FILE, 'utf8');
    const parsed = JSON.parse(data);
    const arr = Array.isArray(parsed) ? parsed : [];
    return arr.map(normalizeItem);
  } catch {
    return [];
  }
}

function writeItems(items) {
  fs.writeFileSync(DATA_FILE, JSON.stringify(items, null, 2));
}

function readNotes() {
  try {
    const data = fs.readFileSync(DATA_FILE_NOTES, 'utf8');
    const parsed = JSON.parse(data);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function writeNotes(notes) {
  fs.writeFileSync(DATA_FILE_NOTES, JSON.stringify(notes, null, 2));
}

// 判断 maybeDescId 是否为 ancestorId 的后代（用于防止父子关系成环）
function isDescendant(notes, maybeDescId, ancestorId) {
  const byId = {};
  notes.forEach((n) => { byId[n.id] = n; });
  const seen = new Set();
  let cur = byId[maybeDescId];
  while (cur && cur.parent) {
    if (cur.parent === ancestorId) return true;
    if (seen.has(cur.id)) return false; // 已有环，安全退出
    seen.add(cur.id);
    cur = byId[cur.parent];
  }
  return false;
}

// 校验 parent：必须是已存在且无环的笔记 id，否则返回 null
function resolveParent(notes, pid, selfId) {
  if (!pid) return null;
  pid = String(pid);
  if (pid === selfId) return null;
  if (!notes.some((n) => n.id === pid)) return null;
  if (isDescendant(notes, pid, selfId)) return null; // pid 是 selfId 的后代 → 成环
  return pid;
}

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
};

function sendJSON(res, code, data) {
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(data));
}

// 图片上传：接收原始二进制，按 Content-Type 落盘到 UPLOAD_DIR
function handleUpload(req, res) {
  const ct = String(req.headers['content-type'] || '').split(';')[0].trim().toLowerCase();
  const ext = UPLOAD_EXT[ct];
  if (!ext) return sendJSON(res, 400, { error: 'unsupported type' });
  const chunks = [];
  let size = 0;
  let aborted = false;
  req.on('data', (c) => {
    if (aborted) return;
    size += c.length;
    if (size > MAX_UPLOAD) {
      aborted = true;
      res.writeHead(413, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ error: 'too large' }));
      req.destroy();
      return;
    }
    chunks.push(c);
  });
  req.on('end', () => {
    if (aborted) return;
    const buf = Buffer.concat(chunks);
    const name = 'img_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8) + '.' + ext;
    try {
      fs.writeFileSync(path.join(UPLOAD_DIR, name), buf);
      return sendJSON(res, 201, { url: '/uploads/' + name, name });
    } catch (e) {
      return sendJSON(res, 500, { error: e.message });
    }
  });
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
    // 图片上传（二进制，单独处理，不能走字符串 body）
    if (req.method === 'POST' && pathname === '/api/upload') {
      return handleUpload(req, res);
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
            person: String(item.person || '').trim(),
            attribution: String(item.attribution || '').trim(),
            dateStart: String(item.dateStart || '').trim(),
            dateEnd: String(item.dateEnd || '').trim(),
            summary: String(item.summary || '').trim(),
            result: String(item.result || '').trim(),
            images: Array.isArray(item.images) ? item.images.slice(0, 20).map(String) : [],
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
          const allowed = ['source', 'summary', 'priority', 'status', 'person', 'attribution', 'dateStart', 'dateEnd', 'result', 'images'];
          for (const k of allowed) {
            if (patch[k] === undefined) continue;
            if (k === 'priority' && !PRIORITIES.includes(patch[k])) continue;
            if (k === 'status' && !STATUSES.includes(patch[k])) continue;
            if (k === 'images') {
              if (!Array.isArray(patch[k])) continue;
              items[idx][k] = patch[k].map(String).slice(0, 20);
              continue;
            }
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

        // 笔记：列出全部
        if (req.method === 'GET' && pathname === '/api/notes') {
          return sendJSON(res, 200, readNotes());
        }

        // 笔记：新增
        if (req.method === 'POST' && pathname === '/api/notes') {
          const note = JSON.parse(body || '{}');
          const notes = readNotes();
          const now = new Date().toISOString();
          const newNote = {
            id: 'nt_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
            title: String(note.title || '').trim(),
            body: String(note.body || ''),
            parent: resolveParent(notes, note.parent, null),
            createdAt: now,
            updatedAt: now,
          };
          notes.push(newNote);
          writeNotes(notes);
          return sendJSON(res, 201, newNote);
        }

        // 笔记：更新
        if (req.method === 'PUT' && pathname.startsWith('/api/notes/')) {
          const id = decodeURIComponent(pathname.split('/').pop());
          const patch = JSON.parse(body || '{}');
          const notes = readNotes();
          const idx = notes.findIndex((n) => n.id === id);
          if (idx === -1) return sendJSON(res, 404, { error: 'not found' });
          const allowed = ['title', 'body', 'parent'];
          for (const k of allowed) {
            if (patch[k] === undefined) continue;
            if (k === 'parent') {
              notes[idx].parent = resolveParent(notes, patch[k], id);
              continue;
            }
            notes[idx][k] = k === 'title' ? String(patch[k]).trim() : String(patch[k]);
          }
          notes[idx].updatedAt = new Date().toISOString();
          writeNotes(notes);
          return sendJSON(res, 200, notes[idx]);
        }

        // 笔记：删除
        if (req.method === 'DELETE' && pathname.startsWith('/api/notes/')) {
          const id = decodeURIComponent(pathname.split('/').pop());
          const notes = readNotes();
          const before = notes.length;
          const del = notes.find((n) => n.id === id);
          const next = notes.filter((n) => n.id !== id);
          if (next.length === before) return sendJSON(res, 404, { error: 'not found' });
          // 删除父笔记时，其子笔记上移一级（挂到被删笔记的父级），避免孤儿
          if (del) {
            const liftTo = del.parent || null;
            next.forEach((n) => { if (n.parent === id) n.parent = liftTo; });
          }
          writeNotes(next);
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
  // 上传的图片：从 UPLOAD_DIR 提供（带路径穿越防护）
  if (pathname.startsWith('/uploads/')) {
    const rel = decodeURIComponent(pathname.slice('/uploads/'.length));
    if (rel.includes('..') || rel.startsWith('/')) {
      res.writeHead(403);
      return res.end('Forbidden');
    }
    const uPath = path.join(UPLOAD_DIR, rel);
    if (!uPath.startsWith(UPLOAD_DIR)) {
      res.writeHead(403);
      return res.end('Forbidden');
    }
    fs.readFile(uPath, (err, data) => {
      if (err) { res.writeHead(404); return res.end('Not Found'); }
      const ext = path.extname(uPath).toLowerCase();
      res.writeHead(200, {
        'Content-Type': MIME[ext] || 'application/octet-stream',
        'Cache-Control': 'public, max-age=31536000, immutable',
      });
      res.end(data);
    });
    return;
  }

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
