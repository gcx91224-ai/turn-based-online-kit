# 08 · 没有本地运行时，怎么测服务端

## 问题

联机逻辑最怕的不是写错，是**改错了没人发现**：

- 广播时多带了一个字段 → 泄漏对手动作
- 结算顺序改了一行 → 比分算错
- 重连没接上 → 刷新就丢座位

这些都不会报错，只会在真实对局里以"这游戏怪怪的"的形式出现。

而 `wrangler dev` 依赖本地运行时（workerd），某些机器上根本起不来。
**不能因此就不测服务端。**

---

## 思路：把 Cloudflare 换成桩

Durable Object 的代码只依赖很少的几个东西：

| 它要的 | 桩给什么 |
|---|---|
| `ctx.storage.get/put/delete` | 一个 Map + `structuredClone` |
| `ctx.storage.setAlarm/deleteAlarm` | 记一个时间戳 |
| `ctx.acceptWebSocket / getWebSockets` | 一个数组 |
| `ctx.blockConcurrencyWhile` | 存下 Promise，测试里 await |
| `WebSocketPair` | 两个假 socket |
| `Response` | 最小的假 Response（原生不接受 101） |

```js
// tests/helpers.mjs
export function makeCtx() {
  const store = new Map();
  const sockets = [];
  const ctx = {
    alarmAt: null,
    ready: null,
    storage: {
      async get(k) { return store.has(k) ? structuredClone(store.get(k)) : undefined; },
      async put(k, v) { store.set(k, structuredClone(v)); },
      async delete(k) { store.delete(k); },
      async setAlarm(ts) { ctx.alarmAt = ts; },
      async deleteAlarm() { ctx.alarmAt = null; }
    },
    getWebSockets() { return sockets; },
    acceptWebSocket(ws) { sockets.push(ws); },
    blockConcurrencyWhile(fn) { ctx.ready = fn(); }
  };
  return ctx;
}
```

`structuredClone` 是重点：它模拟"存储是序列化的"，能抓出"存了函数/循环引用"这类问题。

---

## 驱动一个房间

DO 的入口就是 `fetch` 和三个 WebSocket 回调，所以测试可以直接调它们：

```js
const ctx = makeCtx();
const room = new Room(ctx, {});
await ctx.ready;                         // 等构造函数里的初始化

// 第一个人连上
await room.fetch(wsRequest('AB3CD', 'token-aaaa-1111', '阿A'));
const wsA = ctx.getWebSockets()[0];

// 第二个人连上
await room.fetch(wsRequest('AB3CD', 'token-bbbb-2222', '阿B'));
const wsB = ctx.getWebSockets()[1];

// 模拟出招
await room.webSocketMessage(wsA, JSON.stringify({ type: 'pick', move: 'rock' }));

// 断言：B 的视图里不能出现 A 的动作
const view = wsB.last();
assert.equal(view.oppReady, true);
assert.ok(!JSON.stringify(view).includes('rock'));
```

没有网络、没有 workerd、没有浏览器，`node --test` 不到一秒跑完 52 个断言。

---

## 必须测的那些（按重要性）

| # | 测什么 | 为什么 |
|---|---|---|
| 1 | **视图不留隐藏信息** | 泄漏了游戏就废了，而且肉眼看不出来 |
| 2 | **只认第一条动作** | 防"后手改招"的唯一防线 |
| 3 | **结算与比分** | 算错分是最容易被发现的 bug |
| 4 | **满员拒绝** | 第三个人进来会把座位搞乱 |
| 5 | **重连坐回原位** | 刷新丢座位是最常见的投诉 |
| 6 | **超时自动推进** | 不测的话线上会永久卡局 |
| 7 | **落盘** | DO 重启后还能接着打 |
| 8 | **非法输入不崩** | `null`、乱码、超长字符串 |

第 1 条值得单独说：它不是"功能测试"，是**安全断言**。
写成 `assert.ok(!JSON.stringify(view).includes('rock'))` 这种形式，
以后谁往视图里加字段，只要带上了对手的动作，测试立刻红。

---

## 测不了的部分，别假装测了

| 测不了 | 替代 |
|---|---|
| 真实 WebSocket 握手 | 部署后两个浏览器手动打一局 |
| Cloudflare 的缓存/路由行为 | 上线后按 [06-deploy](06-deploy.md#4-部署后必须验四件事) 的四条验 |
| DO 的休眠与唤醒 | 只能线上观察；逻辑上保证"状态都在 storage 里" |
| 移动端浏览器的连接行为 | 真机 |

诚实地说：**单元测试保证"逻辑对"，不保证"线上能跑"**。两件事都要做。

---

## CI

`.github/workflows/ci.yml` 只做两件事：语法检查 + 跑测试。不需要装 wrangler。

```yaml
- run: npm run check
- run: npm test
```

为什么不在 CI 里跑 `wrangler deploy --dry-run`：它会下载 workerd，慢且容易受网络影响，
而它验证的东西（配置合法性）在真正 deploy 时一定会暴露。**部署交给部署流程。**

---

## 前端的测试

本套件没给前端写自动化测试。理由：

- 前端是纯渲染 + 转发消息，逻辑已经被服务端测试覆盖
- DOM 测试的维护成本比收益高（改个按钮文案就红一片）
- 真正要验的是"两个浏览器能不能打一局"，这个只能手动

如果你要做，推荐 Playwright：开两个 browser context（各自独立的 localStorage），
一个建房、一个点邀请链接，然后断言两边都看到"第 1 回合"。

下一步：[09 · 限制与扩展](09-limits.md)
