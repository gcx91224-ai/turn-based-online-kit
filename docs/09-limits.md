# 09 · 限制与扩展

这套东西是**为"两个朋友、回合制、房间码"设计的**。超出这个范围，有些地方要改。
提前知道边界，比上线后推倒重来便宜。

---

## 现在的硬限制

| 限制 | 值 | 想改的话 |
|---|---|---|
| 每房间人数 | 2 | 改 `SEATS`，结算逻辑要支持多人同时结算 |
| 房间数 | 无限（一个码一个 DO） | 不需要改 |
| 回合时限 | 30 秒 | `TURN_MS` |
| 房间码长度 | 5 位 | `CODE_LEN`（越长越难念） |
| 单局状态 | 存在 DO 的 SQLite 里 | — |
| 观战 | 不支持 | 见下 |
| 房间列表 | 不支持 | 见下 |

---

## 想做公开房间列表

> 注意别和**匹配队列**搞混：匹配队列（`extras/ladder.js`）是"帮两个人互相找到"，
> 匹配完就退出，它不维护"现在有哪些房间可以加入"。下面是房间列表。

加一个**全局单例** DO 当索引：

```jsonc
// wrangler.jsonc
"durable_objects": {
  "bindings": [
    { "name": "ROOMS", "class_name": "Room" },
    { "name": "INDEX", "class_name": "RoomIndex" }   // 新增
  ]
},
"migrations": [
  { "tag": "v1", "new_sqlite_classes": ["Room"] },
  { "tag": "v2", "new_sqlite_classes": ["RoomIndex"] }   // 新 tag
]
```

```js
// 房间里有人/状态变化时上报
env.INDEX.get(env.INDEX.idFromName('__index__'))
  .fetch('https://index/upsert', { method: 'POST', body: JSON.stringify({ code, players, phase }) });
```

全局索引只有一个实例，所有房间都往它写 —— **这是唯一会成为瓶颈的地方**。
朋友局规模无所谓；如果房间上千，要加节流（比如状态变化才写，不要每条消息都写）。

---

## 想做排行榜 / 账号

同样的套路：再加一个 `Players` DO（全局单例），按设备 token 存分数。

**现成的实现和测试在 [`extras/players.js`](../extras/players.js)**，
设计说明（三层身份、短号、好友表、排行榜脱敏、结算归属）在
[10 · 身份、好友与权限](10-identity-and-social.md) 和 [11 · 排位与匹配](11-rank-and-match.md)。

⚠️ 但要注意：**设备 token 不是账号**。清了缓存就换人，换设备就丢分。
要做真排行榜，必须先做真登录（邮箱验证码 / 第三方 OAuth），token 只能当"游客 id"。

---

## 想加观战

不改人数上限，而是让第三个连接进入"观众"角色：

```js
let seat = seatOfToken(st, token);
if (!seat) {
  seat = freeSeat(st);
  if (!seat) {
    const pair = new WebSocketPair();
    this.ctx.acceptWebSocket(pair[1]);
    pair[1].serializeAttachment({ spectator: true });
    pair[1].send(JSON.stringify(this.spectatorView()));
    return new Response(null, { status: 101, webSocket: pair[0] });
  }
}
```

观众视图要更狠地裁剪：只能看**已结算**的结果，不能看当前回合未公开的动作。
否则观众可以把信息传给场上的人（语音/另一个窗口），等于帮人作弊。

---

## 什么时候该换技术栈

| 你的需求 | 现在这套 | 建议 |
|---|---|---|
| 2-8 人回合制 | ✅ 够用 | 留着 |
| 实时动作（60fps） | ❌ | 需要客户端预测 + 服务器 tick，换 Colyseus / 自建 |
| 万人同服 MMO | ❌ | 单 DO 是单点，需要分片 + 共享存储 |
| 需要复杂 SQL 查询/报表 | ❌ | DO 的 SQLite 是"每个房间一小块"，不适合分析 |
| 需要长期存档、跨设备 | ⚠️ | 加账号系统 + 外部数据库（见 [10](10-identity-and-social.md)） |
| 完全不想绑 Cloudflare | — | 房间层只有几百行，迁到 Node + ws 也就一两天 |

**迁移成本最低的部分**是 `worker/game.js`（纯规则）和 `public/`（纯前端）。
真正绑平台的是 `room.js` 里的 `ctx.storage` / `acceptWebSocket` / `setAlarm` 三个 API。

---

## 一个诚实的成本上限

免费额度用完会怎样？Cloudflare 会**拒绝请求**（不是自动扣费，除非你开了付费）。
朋友局不会碰到；但如果你的链接被发到某个群里，一天几千局是有可能的。

真要做大：

1. 开 Workers Paid（$5/月起），额度大幅提升
2. 加限流（每个 IP / 每个 token 每分钟最多建几个房）
3. 房间加过期清理，避免无用的 DO 存储堆积

---

## 最后：这类项目的真正难点

不是 WebSocket，也不是 Durable Object。是这些：

1. **朋友点开链接能不能进**（路由、缓存、相对路径）
2. **刷新之后还在不在**（token + 座位恢复）
3. **对手掉线了怎么办**（不卡死、能回来）
4. **有没有人能看到不该看的信息**（视图裁剪）

代码量都不大，但每一条都需要想到。这个套件把这些问题都填过了，
你换游戏的时候，尽量别把它们改坏。
