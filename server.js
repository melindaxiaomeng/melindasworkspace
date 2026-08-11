'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');

const HOST = process.env.HOST || '0.0.0.0';
const PORT = process.env.PORT || 3000;
const API_TOKEN = process.env.API_TOKEN || '';
// AI 配置（只读环境变量，不写死密钥）
const AI_API_KEY = process.env.AI_API_KEY || '';
const AI_BASE_URL = (process.env.AI_BASE_URL || 'https://api.deepseek.com/v1').replace(/\/$/, '');
const AI_MODEL = process.env.AI_MODEL || 'deepseek-chat';
// embedding：DeepSeek 无 embedding 模型，建议填 SiliconFlow/Jina/OpenAI；留空则本地 TF-IDF 兜底
const AI_EMBED_API_KEY = process.env.AI_EMBED_API_KEY || AI_API_KEY;
const AI_EMBED_BASE_URL = (process.env.AI_EMBED_BASE_URL || '').replace(/\/$/, '');
const AI_EMBED_MODEL = process.env.AI_EMBED_MODEL || '';
const AI_MOCK = process.env.AI_MOCK === '1';
const ROOT = __dirname;
const PUBLIC_DIR = path.join(ROOT, 'public');
const DATA_DIR = path.join(ROOT, 'data');
const DATA_FILE_EMBED = path.join(DATA_DIR, 'embeddings.json');
const DATA_FILE = path.join(DATA_DIR, 'items.json');
const DATA_FILE_NOTES = path.join(DATA_DIR, 'notes.json');
const DATA_FILE_REPORTS = path.join(DATA_DIR, 'reports.json');
const UPLOAD_DIR = path.join(DATA_DIR, 'uploads');

const STATUSES = ['inbox', 'this_week', 'in_progress', 'done'];
const PRIORITIES = ['高', '中', '低'];
const MAX_UPLOAD = 8 * 1024 * 1024; // 单张图片上限 8MB
const UPLOAD_EXT = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/gif': 'gif', 'image/webp': 'webp' };

if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
if (!fs.existsSync(UPLOAD_DIR)) fs.mkdirSync(UPLOAD_DIR, { recursive: true });
if (!fs.existsSync(DATA_FILE)) fs.writeFileSync(DATA_FILE, JSON.stringify([], null, 2));
if (!fs.existsSync(DATA_FILE_NOTES)) fs.writeFileSync(DATA_FILE_NOTES, JSON.stringify([], null, 2));
if (!fs.existsSync(DATA_FILE_REPORTS)) fs.writeFileSync(DATA_FILE_REPORTS, JSON.stringify([], null, 2));

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

function readReports() { try { return JSON.parse(fs.readFileSync(DATA_FILE_REPORTS, 'utf8')); } catch (e) { return []; } }
function writeReports(reports) { fs.writeFileSync(DATA_FILE_REPORTS, JSON.stringify(reports, null, 2)); }

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

// ===================== AI 模块（RAG 异常诊断 + 自动摘要）=====================
// 轻量 RAG：本地 TF-IDF 兜底（零依赖）+ 可选外部 embedding；cosine 检索 top-k；LLM 生成结构化结果
const crypto = require('crypto');

function aiChat(system, user, opts) {
  opts = opts || {};
  if (AI_MOCK) return Promise.resolve('__MOCK__');
  if (!AI_API_KEY) throw new Error('AI_API_KEY 未配置');
  return fetch(AI_BASE_URL + '/chat/completions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + AI_API_KEY },
    body: JSON.stringify({
      model: AI_MODEL,
      messages: [
        { role: 'system', content: system },
        { role: 'user', content: user },
      ],
      temperature: opts.temperature != null ? opts.temperature : 0.3,
      response_format: opts.json ? { type: 'json_object' } : undefined,
    }),
  })
    .then((r) => {
      if (!r.ok) return r.text().then((t) => Promise.reject(new Error('LLM ' + r.status + ': ' + t.slice(0, 200))));
      return r.json();
    })
    .then((j) => j.choices && j.choices[0] && j.choices[0].message ? j.choices[0].message.content || '' : '');
}

function aiEmbed(text) {
  if (!AI_EMBED_MODEL) return Promise.resolve(null);
  if (!AI_EMBED_API_KEY) throw new Error('AI_EMBED_API_KEY 未配置');
  if (!AI_EMBED_BASE_URL) throw new Error('AI_EMBED_BASE_URL 未配置');
  return fetch(AI_EMBED_BASE_URL + '/embeddings', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + AI_EMBED_API_KEY },
    body: JSON.stringify({ model: AI_EMBED_MODEL, input: text }),
  })
    .then((r) => {
      if (!r.ok) return r.text().then((t) => Promise.reject(new Error('Embed ' + r.status + ': ' + t.slice(0, 200))));
      return r.json();
    })
    .then((j) => (j.data && j.data[0] ? j.data[0].embedding || null : null));
}

// 本地 TF-IDF（零依赖兜底）
function tokenize(text) {
  const t = String(text || '').toLowerCase();
  const toks = [];
  const en = t.match(/[a-z0-9]+/g) || [];
  toks.push.apply(toks, en);
  const zh = t.replace(/[^\u4e00-\u9fff]/g, '');
  for (let i = 0; i < zh.length; i++) {
    toks.push(zh[i]);
    if (i < zh.length - 1) toks.push(zh.slice(i, i + 2));
  }
  return toks;
}
function tfidfVecs(docs) {
  const df = {};
  const tokDocs = docs.map((d) => {
    const tf = {};
    tokenize(d.text).forEach((t) => (tf[t] = (tf[t] || 0) + 1));
    Object.keys(tf).forEach((t) => (df[t] = (df[t] || 0) + 1));
    return tf;
  });
  const N = docs.length || 1;
  return tokDocs.map((tf) => {
    const vec = {};
    let norm = 0;
    for (const t in tf) {
      const idf = Math.log((N + 1) / (df[t] + 1)) + 1;
      const w = (1 + Math.log(tf[t])) * idf;
      vec[t] = w;
      norm += w * w;
    }
    norm = Math.sqrt(norm) || 1;
    for (const t in vec) vec[t] /= norm;
    return vec;
  });
}
function cosine(a, b) {
  let dot = 0;
  for (const k in a) dot += (a[k] || 0) * (b[k] || 0);
  return dot;
}

// 语料：已完成卡片（summary+result）+ 笔记（title+body）
function buildCorpus() {
  const items = readItems();
  const notes = readNotes();
  const docs = [];
  for (const it of items) {
    if (it.status !== 'done') continue;
    const text = [it.summary, it.result].filter(Boolean).join('\n');
    if (text.trim()) docs.push({ id: it.id, type: 'item', text: text, title: it.summary, source: it.source, result: it.result });
  }
  for (const n of notes) {
    const text = [n.title, n.body].filter(Boolean).join('\n');
    if (text.trim()) docs.push({ id: n.id, type: 'note', text: text, title: n.title, source: '', result: n.body });
  }
  return docs;
}

// 取向量：外部 embedding 带缓存；本地 TF-IDF 实时算
async function getVectors(corpus) {
  if (AI_EMBED_MODEL && AI_EMBED_BASE_URL) {
    const hash = crypto.createHash('md5').update(corpus.map((c) => c.id + ':' + c.text).join('|')).digest('hex');
    let cache = {};
    try { cache = JSON.parse(fs.readFileSync(DATA_FILE_EMBED, 'utf8')); } catch (e) {}
    if (cache.hash === hash && Array.isArray(cache.vectors)) return cache.vectors;
    const vectors = [];
    for (const c of corpus) {
      const v = await aiEmbed(c.text);
      vectors.push({ id: c.id, vec: v });
    }
    try { fs.writeFileSync(DATA_FILE_EMBED, JSON.stringify({ hash: hash, vectors: vectors })); } catch (e) {}
    return vectors;
  }
  const vecs = tfidfVecs(corpus);
  return corpus.map((c, i) => ({ id: c.id, vec: vecs[i] }));
}

async function retrieveTopK(queryText, k) {
  const corpus = buildCorpus();
  if (!corpus.length) return { corpus: corpus, refs: [] };
  const vectors = await getVectors(corpus);
  const qVec = AI_EMBED_MODEL && AI_EMBED_BASE_URL
    ? (await aiEmbed(queryText))
    : tfidfVecs([{ text: queryText }])[0];
  if (!qVec) return { corpus: corpus, refs: [] };
  const scored = corpus
    .map((c, i) => ({ c: c, score: cosine(qVec, vectors[i].vec) }))
    .sort((a, b) => b.score - a.score)
    .slice(0, k);
  const refs = scored.filter((s) => s.score > 0.02).map((s) => ({
    source: s.c.type === 'item' ? ('历史卡片' + (s.c.source ? '·' + s.c.source : '')) : '笔记/技术文档',
    title: s.c.title || '',
    result: s.c.result || '',
    score: Number(s.score.toFixed(3)),
  }));
  return { corpus: corpus, refs: refs };
}

function mockDiagnose(item, refs) {
  const checklist = [
    '确认报错/超时的复现条件与影响范围（环境、时间段、数据量级）',
    '拉取服务端/客户端日志，定位超时或 500 发生的具体环节',
    '检查网络波动、网关/负载均衡、DNS 解析是否异常',
    '排查数据库慢查询、锁等待、连接池是否打满',
    '确认分布式/异步任务状态与切片策略是否合理',
    '必要时临时降级或切片（如 15min 临时切片）并观察指标',
  ];
  const refText = refs.length
    ? refs.map((r, i) => (i + 1) + '. [' + r.source + '] ' + r.title + ' → 处理结论：' + r.result).join('\n')
    : '（暂无历史类似记录可参考）';
  return {
    mock: true,
    references: refs,
    analysis: '【Mock 模式】已基于本地检索找到 ' + refs.length + ' 条相似记录。当前问题疑似与数据量/超时或下游服务异常相关，建议优先排查拉取链路的超时与切片策略。',
    checklist: checklist,
    suggestion: '可参考已有处理经验：\n' + refText + '\n\n如仍无法解决，建议按上述 Checklist 逐项排查并向相关同学同步进展。',
  };
}
function mockSummarize(item) {
  const s = String(item.summary || '').slice(0, 30);
  return { mock: true, summary: '【Mock】已处理「' + s + '」相关问题，定位为数据拉取超时，已通过调整切片策略与检查任务状态完成恢复。（配置 AI_API_KEY 后获取真实摘要）' };
}

async function diagnose(item) {
  const text = [item.summary, item.result, item.body].filter(Boolean).join('\n');
  const top = await retrieveTopK(text, 5);
  const refs = top.refs;
  if (AI_MOCK) return mockDiagnose(item, refs);
  if (!AI_API_KEY) return { error: 'AI_API_KEY 未配置', references: refs, checklist: [], analysis: '', suggestion: '' };
  const refText = refs.length
    ? refs.map((r, i) => (i + 1) + '. [' + r.source + '] ' + r.title + '\n   处理结论：' + r.result).join('\n')
    : '（无历史类似记录）';
  const sys = '你是资深 SRE / 技术支持专家，擅长根因分析与故障排查。只输出中文，结构清晰。';
  const user =
    '【当前问题】\n' + (item.summary || '') + '\n' + (item.body || '') + '\n\n' +
    '【历史类似问题参考（已按相关度排序）】\n' + refText + '\n\n' +
    '请输出 JSON：{ "analysis": "对当前问题的初步判断（2-3 句）", "checklist": ["排查步骤1","排查步骤2"], "suggestion": "给一线同学的处理建议（含可参考的历史经验）" }';
  let raw;
  try { raw = await aiChat(sys, user, { json: true }); } catch (e) { return { error: e.message, references: refs, checklist: [], analysis: '', suggestion: '' }; }
  let parsed = {};
  try { parsed = JSON.parse(raw); } catch (e) { parsed = { analysis: raw }; }
  return {
    references: refs,
    analysis: parsed.analysis || '',
    checklist: Array.isArray(parsed.checklist) ? parsed.checklist : [],
    suggestion: parsed.suggestion || '',
  };
}

async function summarize(item) {
  const text = [item.summary, item.result, item.body].filter(Boolean).join('\n');
  const top = await retrieveTopK(text, 3);
  const refs = top.refs;
  if (AI_MOCK) return mockSummarize(item);
  if (!AI_API_KEY) return { error: 'AI_API_KEY 未配置' };
  const refText = refs.length ? '历史类似：' + refs.map((r) => r.title).join('；') : '';
  const sys = '你是技术支持复盘助手。用一句话中文概括问题解决结果，不超过 60 字，不解释、不加引号。';
  const user = '问题：' + (item.summary || '') + '\n处理过程/上下文：' + (item.result || item.body || '') + '\n' + refText + '\n\n输出一句话结果摘要：';
  let raw;
  try { raw = await aiChat(sys, user, { temperature: 0.2 }); } catch (e) { return { error: e.message }; }
  return { summary: String(raw || '').trim().replace(/^["'】]+|["'】]+$/g, '') };
}

/* —— AI 生成日报 / 周报 —— */
async function generateReport(opts) {
  const type = String(opts.type || 'daily'); // 'daily' | 'weekly'
  const dateStr = String(opts.date || '');   // 'YYYY-MM-DD'
  if (!dateStr) return { error: '缺少 date 参数' };

  const d = new Date(dateStr + 'T00:00:00');
  if (isNaN(d.getTime())) return { error: '日期格式无效，需 YYYY-MM-DD' };

  // 确定时间范围
  let rangeStart, rangeEnd, title;
  if (type === 'weekly') {
    // 周报：取该日期所在周的周一 ~ 周日
    const day = d.getDay() || 7; // 周日=7
    rangeStart = new Date(d); rangeStart.setDate(d.getDate() - day + 1);
    rangeStart.setHours(0,0,0,0);
    rangeEnd = new Date(rangeStart); rangeEnd.setDate(rangeStart.getDate() + 6);
    rangeEnd.setHours(23,59,59,999);
    const wn = getWeekNum(d);
    title = `第${wn}周需求与问题解决周报（${fmtDateShort(rangeStart)} ~ ${fmtDateShort(rangeEnd)}）`;
  } else {
    // 日报：当天
    rangeStart = new Date(d); rangeStart.setHours(0,0,0,0);
    rangeEnd = new Date(d); rangeEnd.setHours(23,59,59,999);
    title = `${fmtDateShort(d)} 日报`;
  }

  // 筛选该时间段内 status=done 的卡片
  const allItems = readItems();
  const doneItems = allItems.filter((it) => {
    if (it.status !== 'done') return false;
    const updated = new Date(it.updatedAt || it.createdAt || '');
    return updated >= rangeStart && updated <= rangeEnd;
  });

  // 按来源分组
  const bySource = {};
  for (const it of doneItems) {
    const src = it.source || '未分类';
    if (!bySource[src]) bySource[src] = [];
    bySource[src].push(it);
  }

  // Mock 模式
  if (AI_MOCK) {
    const content = buildMockReportContent(type, dateStr, title, doneItems, bySource);
    const report = saveReport({ type, date: dateStr, title, content, summary: `共 ${doneItems.length} 条已完成`, mock: true });
    return report;
  }

  if (!AI_API_KEY) return { error: 'AI_API_KEY 未配置' };

  // 构建给 LLM 的上下文
  const itemsText = Object.entries(bySource).map(([src, items]) =>
    `## ${src}（${items.length} 条）\n` +
    items.map((it, i) =>
      `${i+1}. **${it.summary || '（无标题）'}**\n` +
      `   - 优先级：${it.priority || '-'} | 负责人：${it.person || '-'}\n` +
      (it.result ? `   - 处理结果：${it.result}` : '') +
      (it.dateStart ? `   - 时间：${it.dateStart}${it.dateEnd ? ' ~ ' + it.dateEnd : ''}` : '')
    ).join('\n')
  ).join('\n\n');

  const sysPrompt = `你是一位资深技术项目经理。根据以下「已完成事项」数据，生成一份结构化的${type === 'weekly' ? '周' : '日'}报告。

要求：
1. 用 Markdown 格式输出
2. 包含以下章节：
   - 📊 概览（完成数量、主要领域分布）
   - ✅ 已完成事项汇总（按来源分组列出）
   - 🔍 技术亮点 / 关键进展
   - ⚠️ 遗留问题 / 待跟进项
   - 📈 下一步计划建议
3. 数据驱动，不要编造信息；如果某类数据为空就写"本周无"
4. 语言简洁专业，适合向管理层汇报
5. 总字数控制在 500~1200 字`;

  const userPrompt = `报告标题：${title}\n\n已完成事项数据：\n${itemsText}\n\n请生成${type === 'weekly' ? '周' : '日'}报告：`;

  let raw;
  try { raw = await aiChat(sysPrompt, userPrompt, { temperature: 0.3 }); } catch (e) { return { error: e.message }; }
  const content = String(raw || '').trim();

  const report = saveReport({
    type, date: dateStr, title,
    content,
    summary: `共 ${doneItems.length} 条已完成，涉及 ${Object.keys(bySource).length} 个来源`,
    mock: false,
  });
  return report;
}

function saveReport(data) {
  const reports = readReports();
  const now = new Date().toISOString();
  const report = {
    id: 'rp_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
    type: data.type || 'daily',
    date: data.date || '',
    title: data.title || '',
    content: data.content || '',
    summary: data.summary || '',
    mock: !!data.mock,
    createdAt: now,
    updatedAt: now,
  };
  reports.push(report);
  writeReports(reports);
  return report;
}

function buildMockReportContent(type, dateStr, title, items, bySource) {
  const lines = [`# ${title}`, '', `> Mock 模式生成的示例报告（未连接真实 LLM）`, '', '---', '', '## 📊 概览'];
  lines.push(`- 报告周期：${type === 'weekly' ? '本周' : '今天'}`);
  lines.push(`- 已完成事项：**${items.length} 条**`);
  lines.push(`- 涉及来源：${Object.keys(bySource).join('、') || '无'}`);
  lines.push('', '## ✅ 已完成事项汇总');
  if (!Object.keys(bySource).length) {
    lines.push('本周期暂无已完成的条目。');
  } else {
    for (const [src, list] of Object.entries(bySource)) {
      lines.push(`\n### ${src}（${list.length} 条）`);
      for (const it of list) {
        lines.push(`- **${escapeHtml(it.summary)}** ${it.result ? `— ${escapeHtml(it.result.slice(0, 80))}` : ''}`);
      }
    }
  }
  lines.push('', '## 🔍 关键进展', '- （Mock 模式下无真实分析）', '', '## ⚠️ 遗留问题', '- （Mock 模式下无真实分析）', '', '## 📈 下一步计划', '- （Mock 模式下无真实建议）');
  return lines.join('\n');
}

function getWeekNum(d) {
  const firstDay = new Date(d.getFullYear(), 0, 1);
  const pastDays = Math.floor((d - firstDay) / 86400000);
  return Math.ceil((pastDays + firstDay.getDay() + 1) / 7);
}
function fmtDateShort(d) {
  if (!(d instanceof Date)) d = new Date(d);
  return d.getFullYear() + '-' + String(d.getMonth()+1).padStart(2,'0') + '-' + String(d.getDate()).padStart(2,'0');
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
      return sendJSON(res, 200, { authRequired: !!API_TOKEN, aiEnabled: !!(AI_API_KEY || AI_MOCK) });
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
        // ===== AI：异常诊断 + 自动摘要（异步，内部独立 catch）=====
        if (req.method === 'POST' && pathname === '/api/ai/diagnose') {
          (async () => {
            try {
              const item = JSON.parse(body || '{}');
              const r = await diagnose({ summary: item.summary || '', result: item.result || '', body: item.body || '' });
              sendJSON(res, 200, r);
            } catch (e) { sendJSON(res, 502, { error: e.message }); }
          })();
          return;
        }
        if (req.method === 'POST' && pathname === '/api/ai/summarize') {
          (async () => {
            try {
              const item = JSON.parse(body || '{}');
              const r = await summarize({ summary: item.summary || '', result: item.result || '', body: item.body || '' });
              sendJSON(res, 200, r);
            } catch (e) { sendJSON(res, 502, { error: e.message }); }
          })();
          return;
        }

        // —— AI 生成报告（日报 / 周报）——
        if (req.method === 'POST' && pathname === '/api/ai/report') {
          (async () => {
            try {
              const opts = JSON.parse(body || '{}');
              const r = await generateReport(opts);
              sendJSON(res, 200, r);
            } catch (e) { sendJSON(res, 502, { error: e.message }); }
          })();
          return;
        }

        // —— 报告列表 CRUD ——
        if (pathname === '/api/reports') {
          if (req.method === 'GET') return sendJSON(res, 200, readReports());
          // POST 由 AI 报告接口内部调用，不单独暴露
          return;
        }

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
