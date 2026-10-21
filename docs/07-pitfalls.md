# 07 · 踩坑清单

每一条都真的踩过。按"症状 → 原因 → 解法"写，出问题时可以直接对照搜索。

---

## 1. 邀请链接打开是白板（没样式、没脚本）

**症状**：访问 `/r/AB3CD`，HTML 有内容但一片空白，控制台一堆 404：
`/r/style.css`、`/r/app.js`。

**原因**：页面挂在 `/r/<码>` 下，HTML 里的相对路径被解析成 `/r/style.css`；
而 `/r/*` 在 Worker 里是房间码路由，直接 400。

**解法**：内联同步脚本钉住基址。

```html
<script>
  if (location.protocol !== 'file:') document.write('<base href="/">');
</script>
```

必须**内联**且**同步**：外部脚本或 `defer` 都会在资源开始加载之后才执行，来不及。

---

## 2. 邀请链接一打开就跳回首页，房间码没了

**症状**：发给朋友的 `/r/AB3CD` 打开后地址栏变成 `/`，前端提示"没有房间码"。

**原因**：Worker 内部去取 `/index.html`，Cloudflare 静态资源的
`auto-trailing-slash` 规则把 `/index.html` **307** 到 `/`。

```
GET /            → 200
GET /index.html  → 307 Location: /
```

**解法**：内部请求 `/`。

```js
return serveAsset(env, request, '/');   // 不要 '/index.html'
```

---

## 3. Worker 里 `env.ASSETS` 是 undefined

**症状**：首页正常，但 `/r/<码>` 返回 503，日志里说 `env.ASSETS` 不存在。

**原因**：`wrangler.jsonc` 里只写了 `assets.directory`，没写 `binding`。
没有 binding 时静态文件依然能直出（所以首页看着正常），但**脚本里拿不到 ASSETS 对象**。

**解法**：

```jsonc
"assets": {
  "directory": "./public",
  "binding": "ASSETS",
  "run_worker_first": ["/ws", "/api/*", "/r/*"]
}
```

---

## 4. 部署失败：Durable Object 不能用 `new_classes`

**症状**：`wrangler deploy` 报错，提到 migrations / SQLite。

**原因**：Cloudflare 免费计划只支持 **SQLite 后端**的 Durable Object。

**解法**：

```jsonc
"migrations": [
  { "tag": "v1", "new_sqlite_classes": ["Room"] }
]
```

加新的 DO 类时，**必须追加一条新 tag** 的 migration，tag 不能重复：

```jsonc
{ "tag": "v2", "new_sqlite_classes": ["RoomIndex"] }
```

---

## 5. 代码改了、也部署了，用户看到的还是旧版

**症状**：你本地正常，朋友那边行为不对；让他强刷才好。

**原因**：浏览器/CDN 缓存了 `app.js`、`style.css`。HTML 更新了，但它引用的还是旧文件名。

**解法**：静态资源加版本号，每次部署前换掉。

```html
<script src="app.js?v=20261021"></script>
```

判断线上跑的是不是最新：看 Network 面板里 `app.js?v=` 的值，和本地 HTML 里的是否一致。

---

## 6. Durable Object 的 `setTimeout` 不会触发

**症状**：30 秒超时逻辑，本地测得好好的，线上永远不执行；对局卡在"等对方出招"。

**原因**：DO 会被休眠，进程内的定时器随之消失。**内存态也一样会丢**。

**解法**：

- 定时用 `ctx.storage.setAlarm()` + `alarm()` 方法
- 状态用 `ctx.storage.put()` 落盘，不要只放 `this.xxx`

```js
await this.ctx.storage.setAlarm(Date.now() + 30000);
async alarm() { /* 到点自动唤醒 */ }
```

---

## 7. 对手还没出招，但我已经知道他出了什么

**症状**：抓包能看到对方的选择；或者玩家反馈"这人怎么总能克我"。

**原因**：广播时直接把整个 `state` 发出去了，里面带着 `picks`。

**解法**：按座位裁剪视图，对方未公开的字段一律不发。

```js
viewFor(seat) {
  return {
    myPick: st.picks[seat] || null,
    oppReady: !!st.picks[opp],     // 只给布尔
    // 没有 oppPick
  };
}
```

**前端看不到 ≠ 用户看不到。** WebSocket 帧在 DevTools 里是明文。

---

## 8. 玩家可以"看到对方没出，再改自己的"

**症状**：明明同时出招，总有人能后手克制。

**原因**：服务器对同一玩家的 `pick` 做了覆盖，最后一次生效。

**解法**：只认第一条。

```js
if (st.picks[seat]) return;
st.picks[seat] = msg.move;
```

顺便解决重复提交、连点、网络重发。

---

## 9. 刷新一下，对手看到我"掉线"闪一下

**症状**：在线状态在刷新时抖动，对手看到"掉线 → 在线"。

**原因**：把 `online` 存成了状态字段，`onclose` 写 false、新连接写 true，中间隔着几百毫秒。

**解法**：在线状态**实时算**，不存字段。

```js
isOnline(seat) {
  for (const ws of this.ctx.getWebSockets()) {
    const at = ws.deserializeAttachment();
    if (at && at.seat === seat) return true;
  }
  return false;
}
```

刷新时旧连接关闭、新连接建立的间隔极短，视图里几乎看不到抖动。

---

## 10. `/ws` 通，但 `/r/<码>` 进了 Worker 却没走脚本

**症状**：邀请链接返回的是原始文件或 404，不是 Worker 处理后的结果。

**原因**：`run_worker_first` 漏了 `/r/*`，请求被静态资源直接接管。

**解法**：

```jsonc
"run_worker_first": ["/ws", "/api/*", "/r/*"]
```

这条配置决定了"哪些路径先走脚本"。漏一条，那条路由就永远不生效。

---

## 11. 本地测试里 `new Request(..., { headers: { Upgrade: 'websocket' } })` 拿不到 header

**症状**：单元测试里 `request.headers.get('Upgrade')` 返回 `null`，永远走不进 WebSocket 分支。

**原因**：`Upgrade` 是 Fetch 规范的 **forbidden header**，`Request` 构造器会静默丢弃它。

**解法**：测试里用最小伪对象，不要用原生 `Request`。

```js
const req = {
  url: 'https://room/ws?room=AB3CD&token=...',
  headers: { get: (k) => k.toLowerCase() === 'upgrade' ? 'websocket' : null }
};
```

---

## 12. Node 里 `new Response(null, { status: 101 })` 直接抛错

**症状**：单元测试跑 DO 的 `fetch` 时报 `invalid status code`。

**原因**：`Response` 构造器只接受 200-599，101（Switching Protocols）不在范围内。
浏览器环境里是 Cloudflare 运行时特批的。

**解法**：测试里换一个最小 `Response` 桩（见 [08-testing](08-testing.md)），
不要试图绕过——你测的是逻辑，不是 HTTP 实现。

---

## 13. 线上能开，国内朋友打不开

**症状**：你自己（或挂代理时）正常，朋友直连超时 / DNS 解析失败。

**原因**：`*.workers.dev` 在国内会被间歇性 DNS 污染。

**解法**：绑自定义域名（见 [06-deploy](06-deploy.md#5-绑自己的域名可选但推荐)）。
这不是服务器挂了，换域名就好。

---

## 14. WebSocket 消息发太快被断

**症状**：连续快速操作后连接被关闭。

**原因**：单条消息有大小上限，短时间大量消息也可能触发限制。

**解法**：

- 消息保持小（本文的 state 只有几百字节）
- 客户端对高频操作做节流
- 不要把整个游戏存档塞进一条消息

---

## 15. 两个标签页被认成同一个人

**症状**：想开两个窗口自己测，结果第二个窗口顶掉了第一个。

**原因**：token 存在 localStorage，同源的所有标签页共享。

**解法**：测联机用**不同浏览器**或**一个正常窗口 + 一个无痕窗口**。
这也说明 token 的设计是对的：它标识"设备"，不是"标签页"。

---

## 16. 房间码明明对，却提示不合法

**症状**：用户输入 `ab3cd` 或 `AB3CD `（带空格）被拒。

**原因**：校验只认大写、无空白。

**解法**：客户端和服务端都先归一化。

```js
normalizeCode(input) { return String(input).trim().toUpperCase(); }
```

用户永远会输入小写和空格。这不是"用户错了"，是产品该处理的事。

下一步：[08 · 没有本地运行时怎么测](08-testing.md)
