# 06 · 部署到线上

目标：从 `git clone` 到"朋友能点开链接玩"，大约 5 分钟。

---

## 0. 前置

- Node.js 18+（`node -v` 确认）
- 一个 Cloudflare 账号（免费即可，不用绑卡）
- 本套件默认不需要数据库、不需要域名

---

## 1. 装依赖并登录

```bash
npm install
npx wrangler login
```

`wrangler login` 会打开浏览器。**OAuth 窗口只有 120 秒**，超时会报
`Timed out waiting for authorization code`。

> 如果失败，不要连着点两次登录：浏览器里留着一个过期的授权页，
> 第二次提交会把旧 code 发给新会话，报 `OAuth error: request_forbidden`。
> 关掉旧标签页，重新发起一次，立刻点 Allow。

---

## 2. 本地跑起来

```bash
npm run dev
```

打开 `http://localhost:8787`，开两个**不同的浏览器**（或一个正常窗口 + 一个无痕窗口）
测联机 —— 同一个浏览器会共享 localStorage 里的 token，两个标签页会被认成同一个人。

### 如果 `wrangler dev` 起不来

某些 Windows 机器上 `wrangler dev` 会报 `spawn EFTYPE`（workerd 二进制与本机环境不兼容）。
这**不影响部署**，因为 `wrangler deploy` 不需要 workerd。

替代方案：

- 直接部署到线上测（免费额度足够）
- 用 `npm test` 跑房间逻辑的单元测试（见 [08-testing](08-testing.md)）

---

## 3. 部署

```bash
npm run deploy
```

成功输出：

```
Uploaded turn-based-online-kit
Deployed turn-based-online-kit triggers
  https://turn-based-online-kit.<你的子域>.workers.dev
Current Version ID: xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx
```

拿到 `workers.dev` 地址就能发给朋友了（国内访问 `workers.dev` 可能不稳定，见第 5 节）。

---

## 4. 部署后必须验四件事

| 检查 | 期望 |
|---|---|
| `https://.../` | 200，能看到首页 |
| `POST /api/room` | 200，返回 `{ok:true, code:"XXXXX"}` |
| `/r/<刚才的 code>` | 200，内容同首页（**这条最容易坏**，见 [07-pitfalls](07-pitfalls.md)） |
| `/ws`（不带升级头） | 426 |

最后一条最容易漏：**开两个浏览器，用邀请链接真的打一局**。自动化测试覆盖不到
"静态资源 + WebSocket + DO" 三者串起来的真实链路。

```bash
# 快速冒烟（PowerShell / curl 都行）
curl -X POST https://你的地址/api/room
curl -s https://你的地址/api/room?room=XXXXX
```

---

## 5. 绑自己的域名（可选，但推荐）

`workers.dev` 在国内会被 DNS 污染，时通时不通。用自己的域名彻底解决。

1. 域名 NS 指向 Cloudflare（在域名注册商改，等生效）
2. Cloudflare 控制台 → **Workers & Pages** → 你的 Worker → **Settings → Domains & Routes**
3. **Add → Custom domain**，填 `game.example.com`（或根域名）
4. Cloudflare 自动建 DNS 记录 + 签证书，等 1-2 分钟

**不要**在 `wrangler.jsonc` 里另写 `routes` —— 面板和配置文件同时配容易打架。

绑定后 `https://game.example.com/r/AB3CD` 就是你的邀请链接。

---

## 6. 缓存：改了代码但用户还是旧的

浏览器和 CDN 都会缓存 `app.js` / `style.css`。改完部署，朋友打开还是老版本 ——
这个坑几乎每个 web 项目都会踩一次。

最省事的做法是给静态资源加版本号：

```html
<link rel="stylesheet" href="style.css?v=20261021" />
<script src="app.js?v=20261021"></script>
```

每次部署前把 `?v=` 换成当天日期（或者一个自增数字）。本套件的 `index.html` 里就是这个写法。

更工程化的做法：

- 用构建工具生成内容哈希文件名（`app.3f9a2c.js`）
- 或者在 Worker 里给 HTML 响应加 `Cache-Control: no-cache`，JS/CSS 加长缓存

但对"无构建"的小项目，`?v=` 的性价比最高。

> 别忘了 `index.html` 本身也要不被缓存，否则用户连新的 `?v=` 都看不到。
> Cloudflare 静态资源默认会给 HTML 较短的缓存，通常够用；要求严格就自己加 header。

---

## 7. 花不花饯

到写作时（2026-10）的免费额度大致是：

| 项 | 免费额度 | 说明 |
|---|---|---|
| Worker 请求 | 10 万 / 天 | 静态文件请求**不计入** |
| Durable Object 请求 | 有独立免费额度 | WebSocket 每条消息算一次 |
| DO 存储 | 5 GB | 一个房间几十 KB |
| 静态资源 | 不限量 | 只有 `run_worker_first` 里的路径走脚本 |

一局（2 人 × 3 回合）大约 20-30 个请求：建房 1、两次握手 2、十来条动作、几次心跳。
**10 万/天 ≈ 三千多局/天**，朋友局完全用不完。

精确数字以 [Cloudflare Pricing](https://developers.cloudflare.com/workers/platform/pricing/) 为准 ——
免费额度会调整，别把本文当合同。

> 注意 DO 免费计划的硬限制：**必须用 SQLite 后端**（`new_sqlite_classes`）。
> 写成 `new_classes` 会在部署时直接失败。

---

## 8. 回滚

```bash
npx wrangler deployments list
npx wrangler rollback <版本ID>
```

每次 deploy 都会打印 `Current Version ID`，记下来就能随时退。

---

## 9. 自动部署（可选）

`.github/workflows/deploy.yml` 已经放好了，只在 push 到 `main` 且改到 `worker/ public/ wrangler.jsonc package.json` 时跑（也能在 Actions 页面手动触发）。

**没配下面两个 Secret 时它不会失败**，只会跳过部署并在日志里留一条提示——这样别人 fork 你的仓库，首页不会挂一个红叉。

需要在 GitHub 仓库里加两个 Secret：

| Secret | 从哪拿 |
|---|---|
| `CLOUDFLARE_API_TOKEN` | Cloudflare 控制台 → My Profile → API Tokens → 创建（模板选 "Edit Cloudflare Workers"） |
| `CLOUDFLARE_ACCOUNT_ID` | 控制台右侧栏 / `npx wrangler whoami` |

**不要把 token 写进仓库**，也不要用 `.env` 提交。

---

## 10. 上线前 checklist

- [ ] `npm test` 全绿
- [ ] `npm run check` 语法全过
- [ ] 换过 `?v=` 版本号
- [ ] 两个浏览器真打一局（创建 → 邀请链接 → 出招 → 结算 → 再来一局）
- [ ] 刷新页面能坐回原位
- [ ] 关掉一个浏览器再打开，对手看到"掉线"然后"回来"
- [ ] `/r/<code>` 直接打开正常（不是白板、地址栏没被弹回 `/`）

下一步：[07 · 踩坑清单](07-pitfalls.md)
