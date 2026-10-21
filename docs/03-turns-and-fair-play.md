# 03 · 回合、结算与公平性

## 状态机

```
waiting ──两人到齐──▶ playing ──某人先到 3 分──▶ over
   ▲                    │  ▲                      │
   │                    │  └──结算后 round++──────┘
   └────────两人都点「再来一局」───────────────────┘
```

三个状态就够了。**不要**给每一轮单独建状态（`playing_round_1`、`revealing`……），
轮次是 `playing` 里的一个计数器，不是状态。状态越多，边界情况越多。

---

## 一轮的完整流程

```
① 客户端发 {type:'pick', move:'rock'}
② 服务器：合法性检查 → 存进 picks[seat] → 广播「有人出了」（不说是啥）
③ 另一个客户端也发
④ 服务器：两个 pick 都有 → 结算 → 广播结果 + 新比分 + 下一轮
```

关键点全在 ② 和 ④。

---

## 规则一：只认第一条

```js
if (st.picks[seat]) return;      // ★ 已经出过了，后面的一律忽略
st.picks[seat] = msg.move;
```

看起来只是"防重复提交"，其实它是**同时出招游戏的防作弊底线**。

如果没有这一条，恶意客户端可以：

```
发 rock  → 看服务器广播「对手还没出」
          → 改发 paper → 等对手出 → 赢
```

因为服务器每次都覆盖，最后生效的是他最后一次发的。加上这一条，第一次就是最终答案。

> 这也是幂等性：网络重发、用户连点两次，都不会把状态搞乱。

---

## 规则二：收齐之前，绝不公开

这是本套件最重要的一行设计：

```js
viewFor(seat) {
  return {
    myPick: st.picks[seat] || null,     // 我自己的，可以给
    oppReady: !!st.picks[opp],          // 对方「出没出」，只给布尔
    // ★ 没有 oppPick —— 对方出了什么，结算前谁都不给
  };
}
```

如果图省事写成 `ws.send(JSON.stringify(this.state))`，对方还没出的那一手就随状态一起发过去了。
**前端看不到 ≠ 用户看不到** —— 打开 DevTools 的 Network 面板，WebSocket 帧是明文的。

测试里有一条专门钉这个：

```js
await pick(room, a.ws, 'rock');
const view = b.ws.last();
assert.equal(view.oppReady, true);
assert.ok(!JSON.stringify(view).includes('rock'), '对方未公开的动作泄漏了');
```

这种断言比"我检查过代码了"可靠得多，改坏了会立刻红。

---

## 那还需要「承诺-揭示」吗？

**在权威服务器模型下，通常不需要。**

因为服务器在收齐之前不告诉任何人，客户端根本没有"偷看"的渠道。收齐 + 只认第一条，
已经覆盖了 99% 的同时出招场景。

承诺-揭示（commit-reveal）解决的是**另一个问题**：让参与方在"还没看到别人选择"的前提下
先把自己锁死，并且**可以验证对方没有中途改**。

它真正有用的两种场景：

### 场景一：服务器不该知道你的选择（确定性锁步）

如果服务器只转发操作、不存状态，那它就没法用"收齐再广播"来保护你 ——
它转发的就是明文操作。这时需要：

```
① 客户端生成随机盐 salt
② commit = SHA-256(`v1|${room}|${round}|${seat}|${move}|${salt}`)
③ 发 commit（服务器只看到一串哈希）
④ 双方 commit 都到齐 → 服务器广播"可以揭示了"
⑤ 发 {move, salt} → 任何人重算哈希都能验证你没改
```

```js
async function commit(move, salt) {
  const s = `v1|${room}|${round}|${seat}|${move}|${salt}`;
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s));
  return [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, '0')).join('');
}
```

注意：**盐必须够随机**（16 字节），否则对手可以穷举三个动作反推出你出了什么。

### 场景二：需要向玩家证明服务器没作弊

承诺-揭示让"服务器事后改结果"变得可检测。但说实话，对朋友局小游戏这是过度设计 ——
玩家真正在意的是"好不好玩"，不是"能不能审计服务器"。

### 结论

| 你的情况 | 用什么 |
|---|---|
| 服务器存状态（本套件） | 收齐再广播 + 只认第一条，够了 |
| 服务器只转发（锁步） | 必须用承诺-揭示 |
| 想公开可验证的公平性 | 承诺-揭示 + 把 log 暴露给玩家 |

---

## 结算：先落盘，再广播

```js
async settle() {
  const st = this.state;
  const a = st.picks.A, b = st.picks.B;
  st.picks = { A: null, B: null };

  const r = resolve(a, b);
  if (r === 'A') st.score.A += 1;
  else if (r === 'B') st.score.B += 1;

  st.lastResult = { round: st.round, picks: { A: a, B: b }, winner: r };

  if (st.score.A >= WIN_SCORE || st.score.B >= WIN_SCORE) {
    st.phase = 'over';
    await this.ctx.storage.deleteAlarm();
  } else {
    st.round += 1;
    await this.armTimer();
  }
  await this.save();          // ★ 落盘在广播之前
}
```

顺序不能反。如果先广播再落盘，中间 DO 被重启/异常，玩家看到的是"我赢了"，
但服务端记的是旧分数 —— 两边永久不一致。

`lastResult` 是**已公开**的数据（双方都出了），所以可以放心放进视图。
它要保留到下一轮结算，否则前端看不到"上一回合发生了什么"。

---

## 超时：别用 setTimeout

```js
// ❌ 不要这样
setTimeout(() => this.timeout(), 30000);
```

Durable Object 会被休眠，进程内的定时器随之消失。30 秒后没人发消息，
DO 可能已经睡了，`setTimeout` 永远不会执行 —— 这局就卡死了。

正确做法是 DO 的 alarm：

```js
await this.ctx.storage.setAlarm(Date.now() + TURN_MS);   // 定闹钟
// ...
async alarm() {                                          // 到点自动唤醒并调用
  const st = await this.load();
  if (!st || st.phase !== 'playing') return;
  if (!st.picks.A) st.picks.A = randomMove();
  if (!st.picks.B) st.picks.B = randomMove();
  await this.settle();
  this.broadcast();
}
```

三个细节：

1. **闹钟只在回合开始时设一次**。不要每次 `pick` 都重设 —— 否则玩家一直出招就能无限拖延。
2. **结束时删掉闹钟**（`deleteAlarm`），否则整局结束后还会莫名其妙醒一次。
3. 超时补的动作**用真随机就行**。它的作用是"让对局继续"，不是公平性的一部分。

---

## DO 的并发模型：不用加锁

同一个 Durable Object 的请求是**串行**处理的。也就是说：

- 两个玩家的 `pick` 不会同时进入 `settle`
- `alarm` 不会和 `webSocketMessage` 同时跑
- 你不需要 mutex、不需要事务、不需要担心 "检查-写入" 之间的竞态

这是 DO 相比"自己写 Node + Redis"最省心的地方。前提是**所有状态都放在这个 DO 里**，
不要再去连一个共享数据库自己造竞态。

---

## 再来一局：两个人同意才重开

```js
if (msg.type === 'again') {
  if (st.phase !== 'over') return;
  st.again[seat] = true;
  if (st.again.A && st.again.B) await this.restart();
  else await this.save();
  this.broadcast();
}
```

一个人点就重开会让对手莫名其妙（"我还没看完比分呢"）。两人都点，
并且把"对方已同意" broadcast 回去，体验才对。

下一步：[04 · 换成你自己的游戏](04-swap-your-game.md)
