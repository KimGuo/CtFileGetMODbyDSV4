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
1) GET https://webapi.ctfile.com/getfile.php?path=f&f=<filekey>&passcode=<pass>&token=<token>&r=<ts>&ref=<来源>
   → file_id / userid / file_chk / start_time / wait_seconds      （code 423 = 需要提取码）

2) GET https://webapi.ctfile.com/get_down_url.php?uid=&fid=&file_chk=&start_time=&wait_seconds=&token=<token>&rd=
   → { code: 200, downurl, file_size, file_name }
```

> `ref` 必须填**真实访问来源**，官方明确说过不填会被拦截。

### ⚠️ 第二个坑：token 必须传给 `get_down_url.php`

**这是决定下载速度的关键，且很容易搞错。** 实测（2026-10）四组对照：

| # | getfile 带 token | **getdown 带 token** | 直链域名 | `spd×limit` | 实际限速 |
| --- | --- | --- | --- | --- | --- |
| ① | ✗ | ✗ | `90-cucc-data.tv002.com` | `100000×1` | **0.10 MB/s** |
| ② | ✗ | ✓ | `group1-ctc-data.tv002.com` | `1200000×1` | **1.14 MB/s** |
| ③ | ✓ | ✗ | `90-cucc-data.tv002.com` | `100000×1` | **0.10 MB/s** |
| ④ | ✓ | ✓ | `group1-ctc-data.tv002.com` | `1200000×1` | **1.14 MB/s** |

- 对比 ① 和 ③：**只在 `getfile.php` 带 token 完全没用**，仍是 0.10 MB/s
- 对比 ① 和 ②：**只在 `get_down_url.php` 带 token 就够了**，直接 1.14 MB/s
- 提速约 **11 倍**

`token` 传给 `getfile.php` 的作用是识别登录态（`my_uid` / `my_username` / `is_accelerated` / 档位标签），以及让 VIP 账号拿到 `is_vip` 与 `vip_*_url`；**但它不决定速度**。

另外两个下载侧的坑（原版和常见工具都没处理）：

- 直链请求**必须带 `Range` 头**，否则数据 CDN 返回 503 反盗链页（0 字节）；
- 单条直链的满速额度约 **15.9 MB**，之后被限速 —— 需要按 ~15 MB 分片、**每片重新换取一条新直链**、串行下载。

### 顺带发现：限速可以从直链里读出来

直链的 query 里带 `spd` 和 `limit`，`spd × limit` 就是这条链的限速，与官方页面显示口径一致：

| 场景 | `spd` | 限速 |
| --- | --- | --- |
| 未登录 | `100000` | 100 KB/s |
| 带 token | `1200000` | 1.14 MB/s |

`getfile.php` 还会返回官方档位描述：`free_speed` / `free_speed_badge` / `software_speed` / `vip_speed` / `is_accelerated` / `wait_seconds`，其中 **`is_accelerated` 可以直接当"token 是否生效"的指示灯**。

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

#### v2.1 功能

**登录与 Token**

- 页面上直接点「**登录城通网盘获取 Token**」→ 跳到城通官网登录 → 自动跳回本页并填入 Token（无需再去第三方站点取）
- 拿到 `auth_code` 后先由浏览器直连换取 `session_id`，失败则回落到本地服务端代换
- 「验证」按钮可确认 Token 是否被城通识别，并显示账号名
- Token / Cookie / Referer / 节点均存 `localStorage`，刷新不丢

**单个解析**

- 解析**分享链接**或**裸文件 ID**
- 自动识别 `/f/ /d/ /l/ /s/` 链接类型，并自动提取提取码（`?p=` / `?password=` / `?passcode=`）
- 展示文件名 / 大小 / 日期 / **加速状态** / **限速** / **预计耗时** / 官方档位标签
- 一键复制直链、直接打开直链、通过本地中转下载

**批量解析**

- 多行输入，每行一个 ID 或链接，行尾可用空格跟提取码
- **全部串行执行**（默认间隔 0.4 s，可用环境变量 `BATCH_DELAY` 调整），避免城通高频请求返回空响应
- 服务端以 **NDJSON 流式**逐条推送，前端边解析边出表格，带进度条
- 可随时「停止」，已完成的条目结果保留
- 同一时刻只允许一个批量任务（并发时返回 409）

**导出（解决 aria2 丢文件名的问题）**

- **导出 aria2 列表**：每条都写入 `out=真实文件名`，避免 aria2 从直链推断文件名导致丢名字；同时带 `dir=` / `header=User-Agent` / `header=Referer` / `max-connection-per-server=1`
  ```bash
  aria2c -i ctfile-aria2-<时间戳>.txt
  ```
- **导出 CSV**：序号 / 文件名 / 大小 / 字节数 / 日期 / 加速 / 限速 / 预计耗时 / 直链（带 BOM，Excel 直接打开不乱码）
- **复制全部直链**：一行一条，可直接喂给 IDM 等工具

**下载**

- **15 MB 分片流式下载**：每片重新换一条直链（带 token），规避单链额度；浏览器侧就是普通下载进度条
- VIP 账号（`is_vip=1`）时直接使用 `vip_*_url`，分片复用同一条高速直链

**接口一览**

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/api/parse?id=&pass=&token=&cookie=&ref=&node=` | 解析单个文件 |
| GET | `/api/download?id=&pass=&token=&cookie=&ref=&node=&name=` | 分片流式下载 |
| POST | `/api/parse-batch` | 批量解析，NDJSON 流式返回 |
| POST | `/api/login` | `auth_code` → `session_id`（服务端代换，兜底用） |
| GET | `/api/whoami?token=` | 校验 Token 并返回账号名 |

**环境变量**

| 变量 | 默认 | 说明 |
| --- | --- | --- |
| `PORT` | `8787` | 监听端口 |
| `BATCH_DELAY` | `400` | 批量解析每条之间的间隔（毫秒） |

### 4. 未改动的部分

本仓库**没有**修改城通接口的参数语义、没有引入任何第三方 API 中转，全部逻辑仍直连城通官方接口。

---

## 三、快速开始

### 方式 A：本地运行版（推荐）

```bash
git clone https://github.com/KimGuo/CtFileGetMODbyDSV4.git
cd CtFileGetMODbyDSV4/local-runner
node server.js
```

### 方式 B：给已有 ctfileGet 站点打补丁

把本仓库根目录的 `ctget.js` 与 `sw.js` 覆盖到你的 ctfileGet 部署目录，并把 `sw.js` 里的 `VERSION` 改个新号即可。

---

## 四、更新日志

### v2.1（2026-10-10）

- **修复 token 不生效**：`local-runner` 此前完全没有读取和转发 `token` 参数。补上后，把 token 同时传给 `getfile.php` 与 **`get_down_url.php`**，下载速度从 **0.10 MB/s → 1.14 MB/s（约 11 倍）**。
- **修复 `ref` 传空值**，并移除城通不认的 `url=` 参数。
- **新增页面内登录获取 Token**：点按钮跳城通官网登录，回跳后自动换取并填入 Token，无需再去第三方站点。
- **新增 `/api/whoami`** 校验 Token 并显示账号名。
- **新增限速 / 预计耗时显示**（读直链的 `spd × limit`）与**加速状态指示灯**（读 `is_accelerated`）。
- **新增批量解析**：串行 + 间隔执行，NDJSON 流式出结果，带进度条与停止按钮。
- **新增导出**：aria2 列表（带 `out=真实文件名`，避免丢文件名）、CSV、复制全部直链。
- **新增节点选择**（电信 / 移动 / 联通 / 北美）与 VIP 直链分支（`is_vip` → `vip_*_url`）。
- 前端偏好（Token / Cookie / Referer / 节点）持久化到 `localStorage`。

### v2.0

- 修复 `JSON.parse("")` 报错（改用新接口 `get_down_url.php` + `start_time`）
- 新增零依赖本地运行版 `local-runner/`
- 补丁版 `ctget.js` / `sw.js`

---

## 五、免责声明

本项目仅供学习交流使用，无任何盈利 / 售卖行为，请勿用于非法用途，否则后果自负。
请遵守城通网盘的服务条款与相关版权规定。

---

## 声明

本次问题排查与全部改动由 **WorkBuddy** 配合 **DeepSeek V4.1** 完成。
