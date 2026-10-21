# 05 · 连接、心跳与重连

## 为什么是 WebSocket

| 方案 | 延迟 | 服务器推送 | 复杂度 |
|---|---|---|---|
| 轮询（每秒 GET） | 差 | 假推送 | 低 |
| SSE | 中 | 单向 | 低 |
| **WebSocket** | 好 | 双向 | 中 |

回合制游戏其实"每次操作一个 HTTP 请求"也能跑，但你需要**服务器主动告诉你对手出招了**，
轮询会让"等对手"这段时间变成一堆空请求。WebSocket 是这类场景的标准答案。

---

## 连接的生命周期

```
idle ──connect()──▶ connecting ──onopen──▶ open
                        │                    │
                        │ onerror            │ onclose（网络断、服务重启、手机切后台）
                        ▼                    ▼
                     closed ◀──────────── closed
                        │
                        └─ 退避 0.8s → 1.6s → 3.2s → 6.4s → 8s（最多 5 次）
```

前端实现（`public/app.js` 的简化版）：

```js
function connect() {
  if (S.ws && (S.ws.readyState === 0 || S.ws.readyState === 1)) return;  // 别重复连

  var proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
  var ws = new WebSocket(proto + '//' + location.host + '/ws?room=' + room +
    '&token=' + token + '&name=' + encodeURIComponent(name));

  ws.onopen = function () { S.tries = 0; startPing(); };
  ws.onmessage = function (ev) { /* 处理 state */ };
  ws.onclose = function () { S.ws = null; stopPing(); scheduleRetry(); };
  ws.onerror = function () { /* onclose 一定会跟上来，不用重复处理 */ };
  S.ws = ws;
}
```

**`onerror` 里不要写重连逻辑**。浏览器在 `onerror` 之后一定会触发 `onclose`，
两处都写会导致双倍重连，最后开出一堆连接。

---

## 心跳：为什么必须要

NAT、负载均衡、手机运营商网关都会清理"长时间没有数据"的连接。表现是：

- 页面上什么也没发生
- 你发消息，`send()` 不报错
- 但服务器永远收不到

这叫**僵尸连接**：`readyState` 还是 1，实际已经死了。

```js
setInterval(function () {
  if (ws.readyState === 1) ws.send(JSON.stringify({ type: 'ping' }));
}, 20000);
```

服务器收到 `ping` 回一个 `pong`。**关键不是发，是等回音**：

```js
// 发了 ping，10 秒内没见到 pong，就主动 close 触发重连
if (!pongTimer) {
  pongTimer = setTimeout(function () {
    pongTimer = null;
    ws.close();
  }, 10000);
}
```

只发不等，等于给自己发"我还活着"的安慰剂。

---

## 重连之后，怎么恢复？

这是"权威服务器"模型最省事的一点：

```
重连 → 带上同一个 token → 服务器按 token 找到你的座位 → 广播一次完整 state
```

**不需要客户端补发任何操作**，因为状态一直在服务器上。

前端只要保证：

1. token 存在 localStorage，刷新/重连都不变
2. 重连用的是同一个 `room` + `token`
3. 收到 state 就整屏重绘（不要试图做增量）

### 什么时候必须补发队列

如果你改成**确定性锁步**（服务器只转发操作、不存状态），就必须做可靠队列：

```js
send(obj, reliable) {
  if (this._raw(obj)) return true;
  if (reliable) {
    this.queue.push(obj);        // 断线期间攒着
    if (this.queue.length > 64) this.queue.shift();   // 别无限攒
    this.connect();
  }
  return false;
}
```

因为操作丢失 = 那一手永久消失，两端算出的局面就分叉了。**这是锁步架构必须付的代价。**

本套件用权威服务器，所以队列只在"等重连"时用来保证 `pick` 不丢：

```js
// 可选：把断线期间点的动作排队，连上后补发
pick(move) {
  if (!ws || ws.readyState !== 1) {
    pending.push({ type: 'pick', move });   // 重连后 flush
    return toast('断线了，恢复后自动提交');
  }
  ws.send(...);
}
```

> 注意：`pick` 是幂等的（服务器只认第一条），所以补发重复也没关系。
> 如果你的消息不幂等（比如"抽一张牌"），补发前必须想清楚重复会怎样。

---

## Durable Object 的两套 WebSocket API

| | 经典 `server.accept()` | Hibernation `ctx.acceptWebSocket()` |
|---|---|---|
| 事件 | `ws.addEventListener('message')` | 类的 `webSocketMessage()` 方法 |
| DO 能否休眠 | ❌ 连接在内存里，DO 一直醒着 | ✅ 可以休眠，有消息再唤醒 |
| 计费 | 空转也烧 duration | 空闲几乎不花钱 |
| 连接对象 | 可以自己存 | **不要长期持有**，用 `ctx.getWebSockets()` 现取 |

本套件用 Hibernation。代价是写法受限：

```js
export class Room {
  async webSocketMessage(ws, raw) { ... }     // 方法，不是事件监听
  async webSocketClose(ws) { ... }
  async webSocketError(ws) { ... }
}
```

还有一点：**连接上的自定义数据要放 attachment**，因为 DO 休眠后内存对象会重建：

```js
ws.serializeAttachment({ seat, token });     // 存（小数据）
const at = ws.deserializeAttachment();        // 取
```

不要 `ws.mySeat = seat` —— 睡一觉就没了。

---

## 消息格式约定

保持极简，一个字段区分类型：

```js
{ type: 'pick', move: 'rock' }
{ type: 'again' }
{ type: 'ping' }
```

服务端 → 客户端只有一种正式消息：

```js
{ type: 'state', ... }     // 完整快照，客户端整屏重绘
```

**为什么只发完整快照，不做增量？**

- 增量消息要处理"顺序错乱 / 丢一条 / 重复"三种情况，复杂度爆炸
- 回合制状态很小（几百字节），全量发送成本可以忽略
- 客户端逻辑简单：收到就重绘，不会有"局部状态不一致"

只有实时游戏（每秒几十次更新）才需要增量或二进制协议。

### 一定要校验

```js
let msg = null;
try { msg = JSON.parse(raw); } catch { return; }
if (!msg || typeof msg.type !== 'string') return;
```

客户端发来的东西**永远不可信**：可能是 `null`、可能是 10MB 字符串、可能是
`{"type":"pick","move":{"toString":...}}`。每一层都要有类型校验。

---

## 服务端也需要超时

客户端有心跳，服务端也要有"这个房间已经没人了"的判断。两种做法：

1. 靠 `webSocketClose` 把座位标离线（本套件用这个，座位保留）
2. 加一个清理 alarm：超过 N 小时没有任何连接 → 重置房间状态

如果不清理，房间 DO 会带着旧状态一直躺着。对免费额度来说问题不大（存储很便宜），
但用户重新打开一个旧房间码时，会看到"上一局的残局"。

下一步：[06 · 部署到线上](06-deploy.md)
