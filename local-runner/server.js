'use strict';
/*
 * ctfileGet 本地运行版  (v2.1)
 * ---------------------------------------------------------------
 * 为什么本地跑能解决问题：
 *   1) 浏览器 fetch 无法设置 Referer/Origin（禁止修改的请求头），也读不了跨域响应；
 *   2) 城通已废弃老接口 get_file_url.php（现在固定返回 HTTP 200 + 空 body），
 *      必须用 get_down_url.php 且必须带 start_time；
 *   3) ★ 关键：token 必须传给 get_down_url.php，否则只能拿到免费低速直链。
 *      实测（2026-10）：不带 token → spd=100000（0.10 MB/s）；
 *                      带 token   → spd=1200000（1.14 MB/s），提速约 11 倍。
 *      只把 token 传给 getfile.php 是【无效】的。
 *
 * 零依赖，仅用 Node 内置模块。启动：node server.js
 */

const http = require('http');
const fs = require('fs');
const path = require('path');
const { URL } = require('url');
const { Readable } = require('stream');
const { pipeline } = require('stream/promises');

const VERSION = '2.1.0';
const PORT = Number(process.env.PORT || 8787);
const PUBLIC_DIR = path.join(__dirname, 'public');
const API = 'https://webapi.ctfile.com';
const HOME = 'https://www.ctfile.com/';

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

// 单个直链的满速额度约 15.9MB，之后被限速；分片略小于它
const CHUNK = 15 * 1024 * 1024;

// 批量解析：串行 + 间隔，避免触发城通风控（高频请求会返回空 body）
const BATCH_DELAY = Number(process.env.BATCH_DELAY || 400);
let batchBusy = false;

// ---------- 基础工具 ----------

const sleep = ms => new Promise(s => setTimeout(s, ms));

function headers(pageUrl, cookie, referer) {
  const h = {
    'User-Agent': UA,
    'Accept': 'application/json, text/javascript, */*; q=0.01',
    'Accept-Language': 'zh-CN,zh;q=0.9',
    'X-Requested-With': 'XMLHttpRequest',
    'Referer': referer || pageUrl || HOME
  };
  if (cookie) h['Cookie'] = cookie;
  return h;
}

async function fetchJSON(url, h) {
  const res = await fetch(url, { headers: h, redirect: 'follow' });
  const text = await res.text();
  let json = null, err = null;
  if (text) { try { json = JSON.parse(text); } catch (e) { err = e.message; } }
  return { status: res.status, text, json, err };
}

async function fetchJSONPost(url, h, body) {
  const res = await fetch(url, { method: 'POST', headers: h, body, redirect: 'follow' });
  const text = await res.text();
  let json = null, err = null;
  if (text) { try { json = JSON.parse(text); } catch (e) { err = e.message; } }
  return { status: res.status, text, json, err };
}

function readBody(req, limit = 2 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', c => {
      size += c.length;
      if (size > limit) { reject(new Error('请求体过大')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

function json(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store'
  });
  res.end(body);
}

function humanSize(bytes) {
  const b = Number(bytes);
  if (!b || b <= 0) return '';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let i = 0, v = b;
  while (v >= 1024 && i < units.length - 1) { v /= 1024; i++; }
  return (i === 0 ? v : v.toFixed(2)) + ' ' + units[i];
}

function secToTime(s) {
  const n = Math.round(Number(s));
  if (!isFinite(n) || n < 0) return '';
  const h = Math.floor(n / 3600), m = Math.floor(n / 60) % 60, ss = n % 60;
  const p = x => String(x).padStart(2, '0');
  return p(h) + ':' + p(m) + ':' + p(ss);
}

/** 从直链的 query 里解析限速（spd × limit，与官方页面显示口径一致） */
function parseSpeed(downurl) {
  try {
    const u = new URL(downurl);
    const spd = Number(u.searchParams.get('spd')) || 0;
    const limit = Number(u.searchParams.get('limit')) || 0;
    return { spd, limit, bps: spd * limit };
  } catch { return { spd: 0, limit: 0, bps: 0 }; }
}

// ---------- 输入解析 ----------

const KNOWN_HOSTS = ['ctfile.com', 'ctfile.net', 'ctfile.cc', 'ctfile.cn', '545c.com'];

/** 解析分享链接或裸 ID，返回 { kind, filekey, pass, pageUrl } */
function parseInput(raw) {
  let s = String(raw || '').trim();
  if (!s) return { kind: 'f', filekey: '', pass: '', pageUrl: '' };
  if (/^ctfile:\/\//i.test(s)) {
    return { error: '这是 App 内分享码（ctfile://），请改用网页分享链接' };
  }
  if (!/:\/\//.test(s)) s = 'https://' + s;

  let u;
  try { u = new URL(s); } catch { return { error: '无法解析该链接' }; }

  const host = u.hostname.toLowerCase().replace(/^www\./, '');
  const hostOk = KNOWN_HOSTS.some(h => host === h || host.endsWith('.' + h));
  if (!hostOk) return { error: '暂不支持该域名 `' + host + '`（仅支持城通网盘分享链接）' };

  const parts = u.pathname.replace(/^\/+|\/+$/g, '').split('/');
  if (parts.length < 2 || !parts[1]) return { error: '无法识别的链接格式（应形如 /f/<文件ID>）' };

  let kind = (parts[0] || '').toLowerCase();
  if (kind.startsWith('f')) kind = 'f';
  else if (kind.startsWith('d')) kind = 'd';
  else if (kind.startsWith('l')) kind = 'l';
  else if (kind.startsWith('s')) kind = 's';
  else return { error: '无法识别的链接类型 `' + parts[0] + '`' };

  const pass = u.searchParams.get('p') || u.searchParams.get('password') || u.searchParams.get('passcode') || '';
  return { kind, filekey: parts[1], pass, pageUrl: u.toString() };
}

/** 直接传裸 ID 时的兜底 */
function bareId(id) {
  return { kind: 'f', filekey: id, pass: '', pageUrl: HOME };
}

function filePath(id) {
  return String(id).split('-').length === 2 ? 'file' : 'f';
}

/** 把用户输入统一成 { link, pass } */
function resolveInput(raw, passOverride) {
  let link = parseInput(raw);
  if (link.error) {
    if (/^[\w-]+$/.test(raw)) link = bareId(raw);
    else return { error: link.error };
  }
  if (link.kind !== 'f') {
    const names = { d: '目录', l: '列表', s: '分享文件夹' };
    return { error: '暂不支持' + names[link.kind] + '链接，请使用具体文件链接（/f/<ID>）' };
  }
  const pass = passOverride || link.pass || '';
  return { link, pass };
}

// ---------- 鉴权参数 ----------

function authOf(u, link) {
  const pageUrl = (link && link.pageUrl) || HOME;
  return {
    cookie: u.searchParams.get('cookie') || '',
    token: u.searchParams.get('token') || '',
    ref: u.searchParams.get('ref') || pageUrl,
    node: (u.searchParams.get('node') || 'dx').toLowerCase()
  };
}

// ---------- 核心：两步换直链 ----------

/** 第 1 步：getfile.php 拿文件元信息（顺带识别登录态 / 加速档位 / VIP 直链） */
async function getFileInfo(link, pass, auth) {
  let url = API + '/getfile.php'
    + '?path=' + filePath(link.filekey)
    + '&f=' + encodeURIComponent(link.filekey)
    + '&passcode=' + encodeURIComponent(pass || '')
    + '&r=' + Date.now()
    + '&ref=' + encodeURIComponent(auth.ref || link.pageUrl || HOME);
  // token 传给 getfile.php 的作用：识别登录态、正确显示 is_accelerated / 档位，
  // 并让 VIP 账号拿到 is_vip / vip_*_url。（提速的关键在 get_down_url.php，见下）
  if (auth.token) url += '&token=' + encodeURIComponent(auth.token);

  const r = await fetchJSON(url, headers(link.pageUrl, auth.cookie, auth.ref));
  if (!r.text) throw new Error('getfile.php 返回空内容 (HTTP ' + r.status + ')：可能被风控或限流，稍后重试');
  if (!r.json) throw new Error('getfile.php 返回的不是 JSON (HTTP ' + r.status + ')：' + (r.err || ''));
  if (r.json.code === 423) throw new Error('NEED_PASSCODE');
  if (r.json.code !== 200 || !r.json.file || !r.json.file.file_id) {
    throw new Error((r.json.file && r.json.file.message) || r.json.message || ('解析失败 (code ' + r.json.code + ')'));
  }
  return r.json.file;
}

/** 第 2 步：get_down_url.php 换一次性直链（必须带 start_time；★ 必须带 token） */
async function getDownUrl(info, link, auth) {
  let url = API + '/get_down_url.php'
    + '?uid=' + encodeURIComponent(info.userid)
    + '&fid=' + encodeURIComponent(info.file_id)
    + '&file_chk=' + encodeURIComponent(info.file_chk)
    + '&start_time=' + (info.start_time || 0)
    + '&wait_seconds=' + (info.wait_seconds || 0)
    + '&rd=' + Date.now();
  // ★ 决定性参数：实测带上后限速由 100000(0.10MB/s) 变为 1200000(1.14MB/s)
  if (auth.token) url += '&token=' + encodeURIComponent(auth.token);

  const r = await fetchJSON(url, headers(link.pageUrl, auth.cookie, auth.ref));
  if (!r.text) throw new Error('get_down_url.php 返回空内容 (HTTP ' + r.status + ')。请确认已带 start_time 参数');
  if (!r.json) throw new Error('get_down_url.php 返回的不是 JSON (HTTP ' + r.status + ')：' + (r.err || ''));
  if (r.json.code !== 200 || !r.json.downurl) {
    throw new Error(r.json.message || ('获取直链失败 (code ' + r.json.code + ')'));
  }
  return r.json;
}

/** VIP 账号：is_vip=1 时直接用 vip_*_url，不再调 get_down_url.php */
function pickVipUrl(info, preferNode) {
  const isVip = info.is_vip === 1 || info.is_vip === '1' || info.is_vip === true;
  if (!isVip) return null;
  const order = {
    dx: ['vip_dx_url', 'vip_yd_url', 'vip_lt_url', 'us_downurl_a'],
    yd: ['vip_yd_url', 'vip_lt_url', 'vip_dx_url', 'us_downurl_a'],
    lt: ['vip_lt_url', 'vip_dx_url', 'vip_yd_url', 'us_downurl_a'],
    us: ['us_downurl_a', 'vip_dx_url', 'vip_yd_url', 'vip_lt_url']
  };
  for (const k of (order[preferNode] || order.dx)) if (info[k]) return { url: info[k], key: k };
  return null;
}

/** 统一出口：VIP 优先，否则走 get_down_url.php */
async function resolveLink(info, link, auth) {
  const vip = pickVipUrl(info, auth.node);
  if (vip) return { url: vip.url, vip: true, node: vip.key, file_size: info.total_size };
  const t = await getDownUrl(info, link, auth);
  return { url: t.downurl, vip: false, node: null, file_size: t.file_size };
}

/** 组装给前端的解析结果 */
function buildResult(info, resolved) {
  const sp = parseSpeed(resolved.url);
  const total = Number(resolved.file_size || info.total_size || 0) || 0;
  const accelerated = resolved.vip || info.is_accelerated === true || info.is_accelerated === 'true' || info.is_accelerated === 1;
  const myUid = Number(info.my_uid) || 0;
  return {
    success: true,
    name: info.file_name,
    size: info.file_size,
    time: info.file_time,
    file_id: info.file_id,
    userid: info.userid,
    total_size: total,
    total_size_text: humanSize(total),
    link: resolved.url,
    // 加速状态
    is_vip: resolved.vip,
    accelerated: !!accelerated,
    node: resolved.node,
    badge: info.free_speed_badge || '',
    // 限速 / 耗时
    spd: sp.spd,
    limit: sp.limit,
    speed_bps: sp.bps,
    speed_text: sp.bps ? humanSize(sp.bps) + '/s' : '无上限',
    eta_text: sp.bps && total ? secToTime(total / sp.bps) : '取决于网速',
    // 官方档位描述
    free_speed: info.free_speed || '',
    software_speed: info.software_speed || '',
    vip_speed: info.vip_speed || '',
    wait_seconds: info.wait_seconds || 0,
    // 登录态
    logged_in: myUid > 0,
    my_uid: myUid,
    my_username: info.my_username || ''
  };
}

/** 解析单个条目（供 /api/parse 与 /api/parse-batch 复用） */
async function parseOne(raw, passOverride, auth) {
  const r = resolveInput(raw, passOverride);
  if (r.error) throw new Error(r.error);
  const info = await getFileInfo(r.link, r.pass, auth);
  const resolved = await resolveLink(info, r.link, auth);
  return buildResult(info, resolved);
}

// ---------- 静态文件 ----------

const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.ico': 'image/x-icon', '.png': 'image/png'
};

function serveStatic(res, p) {
  fs.readFile(p, (err, data) => {
    if (err) { res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }); return res.end('404 Not Found'); }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(p).toLowerCase()] || 'application/octet-stream' });
    res.end(data);
  });
}

// ---------- 分段下载（每片重新换直链，规避限速） ----------

async function segmentedDownload(req, res, info, link, auth, filename, resolved) {
  const size = Number(info.total_size) || 0;
  const head = {
    'Content-Type': 'application/octet-stream',
    'Cache-Control': 'no-store'
  };
  if (filename) head['Content-Disposition'] = "attachment; filename*=UTF-8''" + encodeURIComponent(filename);

  if (!size) {
    // 拿不到总大小就退化成简单中转
    const up = await fetch(resolved.url, { headers: { 'User-Agent': UA, 'Range': 'bytes=0-' } });
    if (!up.ok || !up.body) return json(res, 502, { success: false, errormsg: '上游 HTTP ' + up.status });
    res.writeHead(200, head);
    return pipeline(Readable.fromWeb(up.body), res);
  }

  head['Content-Length'] = size;
  res.writeHead(200, head);

  try {
    for (let start = 0; start < size; start += CHUNK) {
      const end = Math.min(start + CHUNK, size) - 1;
      // VIP 直链可复用；普通/加速链接每片换一条新的，规避单链额度
      let url = resolved.url;
      if (!resolved.vip) {
        const t = await getDownUrl(info, link, auth);
        url = t.downurl;
      }
      const up = await fetch(url, {
        headers: { 'User-Agent': UA, 'Range': 'bytes=' + start + '-' + end }
      });
      if (!up.ok || !up.body) throw new Error('分片 ' + start + ' 上游 HTTP ' + up.status);
      await pipeline(Readable.fromWeb(up.body), res, { end: false });
    }
    res.end();
  } catch (e) {
    // 响应头已发出，只能中断连接
    console.error('下载中断:', e.message);
    res.destroy();
  }
}

// ---------- 路由 ----------

const server = http.createServer(async (req, res) => {
  const u = new URL(req.url, 'http://' + (req.headers.host || 'localhost'));

  // ---- 登录：auth_code → session_id（token） ----
  if (u.pathname === '/api/login' && req.method === 'POST') {
    let code = '';
    try {
      const body = await readBody(req);
      code = (JSON.parse(body).auth_code || '').trim();
    } catch { /* fallthrough */ }
    if (!code) return json(res, 200, { success: false, errormsg: '缺少 auth_code' });

    const r = await fetchJSONPost(
      API + '/api.php?item=account&action=auth_code_exchange',
      Object.assign(headers(HOME, '', HOME), { 'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8' }),
      'auth_code=' + encodeURIComponent(code)
    );
    if (!r.text) return json(res, 200, { success: false, errormsg: '交换接口返回空内容 (HTTP ' + r.status + ')' });
    if (!r.json) return json(res, 200, { success: false, errormsg: '交换接口返回非 JSON：' + (r.err || '') });
    if (r.json.code == 200 && r.json.session_id) return json(res, 200, { success: true, token: r.json.session_id });
    return json(res, 200, { success: false, errormsg: r.json.message || ('交换失败 (code ' + r.json.code + ')') });
  }

  // ---- 校验 token：用一个公开测试文件探测登录态 ----
  if (u.pathname === '/api/whoami') {
    const token = (u.searchParams.get('token') || '').trim();
    if (!token) return json(res, 200, { success: false, errormsg: '缺少 token' });
    const probeId = u.searchParams.get('id') || '8067059-687855402-65ca36';
    const probePass = u.searchParams.get('pass') || '547873715';
    try {
      const r = await fetchJSON(
        API + '/getfile.php?path=' + filePath(probeId)
        + '&f=' + encodeURIComponent(probeId)
        + '&passcode=' + encodeURIComponent(probePass)
        + '&token=' + encodeURIComponent(token)
        + '&r=' + Date.now()
        + '&ref=' + encodeURIComponent(HOME),
        headers(HOME, '', HOME)
      );
      const f = (r.json && r.json.file) || {};
      const uid = Number(f.my_uid) || 0;
      return json(res, 200, {
        success: uid > 0,
        logged_in: uid > 0,
        my_uid: uid,
        my_username: f.my_username || '',
        is_accelerated: f.is_accelerated === true,
        errormsg: uid > 0 ? '' : ((r.json && r.json.message) || '未能识别登录状态，token 可能已失效')
      });
    } catch (e) {
      return json(res, 200, { success: false, errormsg: '校验失败：' + e.message });
    }
  }

  // ---- 批量解析（POST + NDJSON 流式，串行不并发） ----
  if (u.pathname === '/api/parse-batch' && req.method === 'POST') {
    let payload;
    try { payload = JSON.parse(await readBody(req)); }
    catch (e) { return json(res, 400, { success: false, errormsg: '请求体不是合法 JSON：' + e.message }); }

    const items = Array.isArray(payload.items) ? payload.items.slice(0, 500) : [];
    if (!items.length) return json(res, 400, { success: false, errormsg: '没有待解析的条目' });
    if (batchBusy) return json(res, 409, { success: false, errormsg: '已有批量任务正在运行，请等它结束再试' });

    const auth = {
      cookie: payload.cookie || '',
      token: payload.token || '',
      ref: payload.ref || HOME,
      node: (payload.node || 'dx').toLowerCase()
    };

    batchBusy = true;
    res.writeHead(200, {
      'Content-Type': 'application/x-ndjson; charset=utf-8',
      'Cache-Control': 'no-store',
      'X-Accel-Buffering': 'no'
    });
    const send = obj => { try { res.write(JSON.stringify(obj) + '\n'); } catch { /* 客户端已断开 */ } };

    let ok = 0, fail = 0;
    try {
      for (let i = 0; i < items.length; i++) {
        const it = items[i] || {};
        const raw = String(it.id || '').trim();
        const pass = String(it.pass || '').trim();
        send({ type: 'start', index: i, total: items.length, id: raw });

        if (!raw) {
          fail++; send({ type: 'item', index: i, ok: false, id: raw, error: '空条目' });
        } else {
          try {
            const r = await parseOne(raw, pass, auth);
            ok++;
            send({ type: 'item', index: i, ok: true, id: raw, ...r });
          } catch (e) {
            fail++;
            send({
              type: 'item', index: i, ok: false, id: raw,
              need_passcode: e.message === 'NEED_PASSCODE',
              error: e.message === 'NEED_PASSCODE' ? '该文件需要提取码' : e.message
            });
          }
        }
        // 串行 + 间隔，规避城通风控
        if (i < items.length - 1) await sleep(BATCH_DELAY);
      }
    } finally {
      batchBusy = false;
    }
    send({ type: 'done', ok, fail, total: items.length });
    res.end();
    return;
  }

  // ---- 单个解析 ----
  if (u.pathname === '/api/parse') {
    const raw = (u.searchParams.get('id') || '').trim();
    if (!raw) return json(res, 200, { success: false, errormsg: '请填写文件 ID 或分享链接' });

    const r0 = resolveInput(raw, u.searchParams.get('pass') || '');
    if (r0.error) return json(res, 200, { success: false, errormsg: r0.error });

    const auth = authOf(u, r0.link);
    try {
      const result = await parseOne(raw, u.searchParams.get('pass') || '', auth);
      return json(res, 200, result);
    } catch (e) {
      const need = e.message === 'NEED_PASSCODE';
      return json(res, 200, {
        success: false,
        need_passcode: need,
        errormsg: need ? '该文件需要提取码，请填写后重试' : e.message
      });
    }
  }

  // ---- 下载 ----
  if (u.pathname === '/api/download') {
    const raw = (u.searchParams.get('id') || '').trim();
    if (!raw) return json(res, 400, { success: false, errormsg: '缺少 id 参数' });

    const r0 = resolveInput(raw, u.searchParams.get('pass') || '');
    if (r0.error) return json(res, 400, { success: false, errormsg: r0.error });

    const auth = authOf(u, r0.link);
    try {
      const info = await getFileInfo(r0.link, r0.pass, auth);
      const resolved = await resolveLink(info, r0.link, auth);
      info.total_size = resolved.file_size || info.total_size;
      const name = u.searchParams.get('name') || info.file_name || 'download';
      await segmentedDownload(req, res, info, r0.link, auth, name, resolved);
    } catch (e) {
      if (!res.headersSent) return json(res, 502, { success: false, errormsg: e.message });
      res.destroy();
    }
    return;
  }

  // ---- 静态 ----
  if (u.pathname === '/' || u.pathname === '/index.html') {
    return serveStatic(res, path.join(PUBLIC_DIR, 'index.html'));
  }
  const safe = path.normalize(u.pathname).replace(/^(\.\.[/\\])+/, '');
  const target = path.join(PUBLIC_DIR, safe);
  if (!target.startsWith(PUBLIC_DIR)) { res.writeHead(403); return res.end('403'); }
  serveStatic(res, target);
});

server.listen(PORT, () => {
  console.log('');
  console.log('  ctfileGet 本地版 v' + VERSION + ' 已启动');
  console.log('  ➜  http://localhost:' + PORT);
  console.log('');
  console.log('  提示：在页面上点「登录城通网盘」获取 Token，下载速度可从 0.1MB/s 提升到 1MB/s+');
  console.log('  按 Ctrl+C 停止');
  console.log('');
});
