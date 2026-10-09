# CitiFileGet MOD by DSV4

城通网盘直连解析工具 [qinlili23333/ctfileGet](https://github.com/qinlili23333/ctfileGet) 的修复 / 增强版。

原版网页版在 2026 年 10 月起会报错：

```
Uncaught (in promise) SyntaxError: Unexpected end of JSON input
    at JSON.parse (<anonymous>)
    at Object.getByID (ctget.js:88:38)
```

本仓库修复了该问题，并额外提供一个**零依赖的本地运行版**。

---

## 一、问题根因

城通网盘的 WebAPI **换了接口**，原版仍在调用已废弃的旧接口：

| 接口 | 结果 |
| --- | --- |
| `getfile.php` | ✅ 正常，返回文件元信息（`file_chk` / `start_time` 等） |
| `get_file_url.php?app=0&acheck=2`（原版在用） | ❌ **HTTP 200 + 空 body** → 前端 `JSON.parse("")` 抛 `SyntaxError: Unexpected end of JSON input` |
| `get_down_url.php` + **`start_time`**（新） | ✅ 返回 `{ "code": 200, "downurl": "...", "file_size": ..., "file_name": "..." }` |

也就是说：**报错与风控、跨域、登录状态都无关，纯粹是接口废弃了。**

正确的两步流程：

```
1) GET https://webapi.ctfile.com/getfile.php?path=f&f=<filekey>&passcode=<pass>&r=<ts>&ref=&url=<pageurl>
   → file_id / userid / file_chk / start_time / wait_seconds      （code 423 = 需要提取码）

2) GET https://webapi.ctfile.com/get_down_url.php?uid=&fid=&file_chk=&start_time=&wait_seconds=&rd=
   → { code: 200, downurl, file_size, file_name }
```

另外两个下载侧的坑（原版和常见工具都没处理）：

- 直链请求**必须带 `Range` 头**，否则数据 CDN 返回 503 反盗链页（0 字节）；
- 单条直链的满速额度约 **15.9 MB**，之后被限速到 ~100 KB/s —— 需要按 ~15 MB 分片、**每片重新换取一条新直链**、串行下载。

> 顺带说明：报错里那一堆 `static.cloudflareinsights.com` 与 `sw.js:32 TypeError: Failed to fetch`
> 是**噪音** —— 第三方统计脚本被广告拦截 / 网络策略拦下，Service Worker 的
> `else { event.respondWith(fetch(event.request)) }` 把 rejected promise 冒泡成了未捕获错误，与解析失败无关。

---

## 二、改动内容

### 1. `ctget.js` —— 网页版核心补丁

直接覆盖到 ctfileGet 站点根目录即可。

- **改用新接口** `get_down_url.php`，并带上 `start_time` / `wait_seconds`（这是修复报错的关键）；
- 新增 `requestJSON()` 统一封装：先校验 HTTP 状态、再校验响应体是否为空、再校验是否为合法 JSON，**不再对空字符串调用 `JSON.parse`**；
- `getByID()` 整体包上 `try/catch`，任何异常都返回 `{ success: false, errormsg }` 结构化结果，不再向控制台抛未捕获异常；
- 顺手修掉几个坑：
  - `passcode=undefined`（未传密码时 URL 里会拼出 `undefined`）
  - `jsonText.file.message` 在 `file` 为空时二次抛错
  - `token = ctfile.buildToken()` 在 main 分支未定义
  - `document` 未判空，在 Node 环境下会 `ReferenceError`
  - 识别 `code 423`（需要提取码）并给出可读提示

### 2. `sw.js` —— Service Worker 补丁

同样覆盖到站点根目录。把 `VERSION` 改成新版本号（如 `2.4.6`）可强制刷新旧缓存。

- 非缓存请求**直接 `return`** 交给浏览器默认处理，消除 `event.respondWith(fetch(event.request))` 在第三方请求被拦截时冒泡出的 `Uncaught (in promise) TypeError: Failed to fetch`；
- 缓存链路补上 `.catch()` 兜底，任何一环失败都退回真实网络请求。

### 3. `local-runner/` —— 零依赖本地运行版（新增）

请求由 Node 服务端发出，可自由设置 `Referer` / `Cookie`（在浏览器里 `Referer` / `Origin` 属于**禁止 JS 设置**的请求头），因此不受跨域与来源校验限制，比网页版更稳。

```bash
cd local-runner
node server.js          # 需 Node 18+，零第三方依赖
# 浏览器打开 http://localhost:8787
```

功能：

- 解析**分享链接**或**裸文件 ID**
- 自动识别 `/f/ /d/ /l/ /s/` 链接类型，并自动提取提取码（`?p=` / `?password=` / `?passcode=`）
- 支持可选 Cookie（`rest.ctfile.com` 客户端 API 场景用不到，WebAPI 场景一般也不需要）
- 展示文件名 / 大小 / 直链，一键复制
- **15 MB 分片流式下载**：每片重新换一条直链，规避 CDN 限速；浏览器侧就是普通下载进度条

### 4. 未改动的部分

本仓库**没有**修改 `getfile.php` 的调用方式、也没有引入任何第三方 API 中转，全部逻辑仍直连城通官方接口。

---

## 三、快速开始

### 方式 A：本地运行版（推荐）

```bash
git clone https://github.com/KimGuo/CitiFileGetMODbyDSV4.git
cd CitiFileGetMODbyDSV4/local-runner
node server.js
```

### 方式 B：给已有 ctfileGet 站点打补丁

把本仓库根目录的 `ctget.js` 与 `sw.js` 覆盖到你的 ctfileGet 部署目录，并把 `sw.js` 里的 `VERSION` 改个新号即可。

---

## 四、免责声明

本项目仅供学习交流使用，无任何盈利 / 售卖行为，请勿用于非法用途，否则后果自负。
请遵守城通网盘的服务条款与相关版权规定。

---

## 声明

本次问题排查与全部改动由 **WorkBuddy** 配合 **DeepSeek V4.1** 完成。
