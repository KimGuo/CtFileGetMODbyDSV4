'use strict';
/*
 * ctfileGet 本地运行版
 * ---------------------------------------------------------------
 * 为什么本地跑能解决问题：
 *   1) 浏览器 fetch 无法设置 Referer/Origin（禁止修改的请求头），也读不了跨域响应；
 *   2) 更关键的是：城通已经废弃了老接口 get_file_url.php，现在必须用
 *      get_down_url.php 且必须带 start_time 参数，否则返回 HTTP 200 + 空 body。
 *      线上版 ctfileGet 还在用老接口，于是 JSON.parse("") 抛
 *      "Unexpected end of JSON input"。
 *
 * 本地版：请求由 Node 服务端发出，接口用新的 get_down_url.php，
 * 并按官方的分段策略下载（每个分片重新换一条直链，规避 CDN 限速）。
 *
 * 零依赖，仅用 Node 内置模块。启动：node server.js
 */

const http = require('http');
const fs = require('fs');
const path = require('path');
const { URL } = require('url');
const { Readable } = require('stream');
const { pipeline } = require('stream/promises');

const PORT = Number(process.env.PORT || 8787);
const PUBLIC_DIR = path.join(__dirname, 'public');
const API = 'https://webapi.ctfile.com';

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

// 单个直链的满速额度约 15.9MB，之后被限速；分片略小于它
const CHUNK = 15 * 1024 * 1024;

// ---------- 工具 ----------

function headers(pageUrl, cookie) {
  const h = {
    'User-Agent': UA,
    'Accept': 'application/json, text/javascript, */*; q=0.01',
    'Accept-Language': 'zh-CN,zh;q=0.9',
    'X-Requested-With': 'XMLHttpRequest',
    'Referer': pageUrl || 'https://www.ctfile.com/'
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

function json(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store'
  });
  res.end(body);
}

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
  return { kind: 'f', filekey: id, pass: '', pageUrl: 'https://www.ctfile.com/' };
}

function filePath(id) {
  return String(id).split('-').length === 2 ? 'file' : 'f';
}

// ---------- 核心：两步换直链 ----------

/** 第 1 步：getfile.php 拿文件元信息 */
async function getFileInfo(link, pass, cookie) {
  const url = API + '/getfile.php'
    + '?path=' + filePath(link.filekey)
    + '&f=' + encodeURIComponent(link.filekey)
    + '&passcode=' + encodeURIComponent(pass || '')
    + '&r=' + Date.now()
    + '&ref='
    + '&url=' + encodeURIComponent(link.pageUrl || '');

  const r = await fetchJSON(url, headers(link.pageUrl, cookie));
  if (!r.text) throw new Error('getfile.php 返回空内容 (HTTP ' + r.status + ')：可能被风控或限流，稍后重试');
  if (!r.json) throw new Error('getfile.php 返回的不是 JSON (HTTP ' + r.status + ')：' + (r.err || ''));
  if (r.json.code === 423) throw new Error('NEED_PASSCODE');
  if (r.json.code !== 200 || !r.json.file || !r.json.file.file_id) {
    throw new Error((r.json.file && r.json.file.message) || r.json.message || ('解析失败 (code ' + r.json.code + ')'));
  }
  return r.json.file;
}

/** 第 2 步：get_down_url.php 换一次性直链（必须带 start_time） */
async function getDownUrl(info, link, cookie) {
  const url = API + '/get_down_url.php'
    + '?uid=' + encodeURIComponent(info.userid)
    + '&fid=' + encodeURIComponent(info.file_id)
    + '&file_chk=' + encodeURIComponent(info.file_chk)
    + '&start_time=' + (info.start_time || 0)
    + '&wait_seconds=' + (info.wait_seconds || 0)
    + '&rd=' + Date.now();

  const r = await fetchJSON(url, headers(link.pageUrl, cookie));
  if (!r.text) throw new Error('get_down_url.php 返回空内容 (HTTP ' + r.status + ')。请确认已带 start_time 参数');
  if (!r.json) throw new Error('get_down_url.php 返回的不是 JSON (HTTP ' + r.status + ')：' + (r.err || ''));
  if (r.json.code !== 200 || !r.json.downurl) {
    throw new Error(r.json.message || ('获取直链失败 (code ' + r.json.code + ')'));
  }
  return r.json;
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

async function segmentedDownload(req, res, info, link, cookie, filename) {
  const size = Number(info.total_size) || 0;
  const head = {
    'Content-Type': 'application/octet-stream',
    'Cache-Control': 'no-store'
  };
  if (filename) head['Content-Disposition'] = "attachment; filename*=UTF-8''" + encodeURIComponent(filename);

  if (!size) {
    // 拿不到总大小就退化成简单中转
    const t = await getDownUrl(info, link, cookie);
    const up = await fetch(t.downurl, { headers: { 'User-Agent': UA, 'Range': 'bytes=0-' } });
    if (!up.ok || !up.body) return json(res, 502, { success: false, errormsg: '上游 HTTP ' + up.status });
    res.writeHead(200, head);
    return pipeline(Readable.fromWeb(up.body), res);
  }

  head['Content-Length'] = size;
  res.writeHead(200, head);

  try {
    for (let start = 0; start < size; start += CHUNK) {
      const end = Math.min(start + CHUNK, size) - 1;
      const t = await getDownUrl(info, link, cookie);           // 每个分片换一条新直链
      const up = await fetch(t.downurl, {
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

  // ---- 解析 ----
  if (u.pathname === '/api/parse') {
    const raw = (u.searchParams.get('id') || '').trim();
    const cookie = u.searchParams.get('cookie') || '';
    if (!raw) return json(res, 200, { success: false, errormsg: '请填写文件 ID 或分享链接' });

    let link = parseInput(raw);
    if (link.error) {
      // 可能是裸 ID，兜底
      if (/^[\w-]+$/.test(raw)) link = bareId(raw);
      else return json(res, 200, { success: false, errormsg: link.error });
    }
    const pass = u.searchParams.get('pass') || link.pass || '';
    if (link.kind !== 'f') {
      const names = { d: '目录', l: '列表', s: '分享文件夹' };
      return json(res, 200, { success: false, errormsg: '暂不支持' + names[link.kind] + '链接，请使用具体文件链接（/f/<ID>）' });
    }

    try {
      const info = await getFileInfo(link, pass, cookie);
      const t = await getDownUrl(info, link, cookie);
      return json(res, 200, {
        success: true,
        name: info.file_name,
        size: info.file_size,
        time: info.file_time,
        file_id: info.file_id,
        userid: info.userid,
        total_size: t.file_size,
        link: t.downurl
      });
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
    const cookie = u.searchParams.get('cookie') || '';
    if (!raw) return json(res, 400, { success: false, errormsg: '缺少 id 参数' });

    let link = parseInput(raw);
    if (link.error) { if (/^[\w-]+$/.test(raw)) link = bareId(raw); else return json(res, 400, { success: false, errormsg: link.error }); }
    const pass = u.searchParams.get('pass') || link.pass || '';

    try {
      const info = await getFileInfo(link, pass, cookie);
      const t = await getDownUrl(info, link, cookie);
      info.total_size = t.file_size;
      const name = u.searchParams.get('name') || t.file_name || info.file_name || 'download';
      await segmentedDownload(req, res, info, link, cookie, name);
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
  console.log('  ctfileGet 本地版已启动');
  console.log('  ➜  http://localhost:' + PORT);
  console.log('');
  console.log('  按 Ctrl+C 停止');
  console.log('');
});
