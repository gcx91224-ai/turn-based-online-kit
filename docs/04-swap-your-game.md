# 04 · 换成你自己的游戏

默认 demo 是"石头剪刀布，先赢 3 局"。它存在的意义是**证明管道通了**，
不是让你改改文案就上线。

---

## 最小改动：只换判定

`worker/game.js` 只要保持三个导出，`room.js` 一行都不用动：

```js
export const MOVES = ['rock', 'paper', 'scissors'];
export const isValidMove = (m) => MOVES.includes(m);
export const resolve = (a, b) => 'A' | 'B' | 'draw';
```

比如换成"比大小"：

```js
export const MOVES = ['1', '2', '3', '4', '5'];
export const MOVE_LABEL = { 1: '一', 2: '二', 3: '三', 4: '四', 5: '五' };
export const isValidMove = (m) => MOVES.includes(m);
export const resolve = (a, b) => (a === b ? 'draw' : (Number(a) > Number(b) ? 'A' : 'B'));
```

前端会自己按 `MOVES` 渲染按钮（`public/app.js` 里读的是 `st.moves` —— 需要时把
`MOVES` 放进视图，见下面"让前端知道有哪些动作"）。

---

## 有额外状态：血量、手牌、能量

demo 的比分是 `score`。如果你的游戏有血量，改三处：

### ① 初始状态

```js
// room.js 的 blank()
game: {
  hp: { A: 10, B: 10 },
  hand: { A: [], B: [] }     // 有隐藏信息时特别小心，见 ③
}
```

### ② 结算逻辑搬进 game.js

不要让它散在 `settle()` 里：

```js
// game.js
export function applyRound(game, picks) {
  const r = resolve(picks.A, picks.B);
  if (r === 'A') game.hp.B -= 1;
  if (r === 'B') game.hp.A -= 1;
  return { winner: r, over: game.hp.A <= 0 || game.hp.B <= 0 };
}
```

```js
// room.js 的 settle()
const outcome = applyRound(st.game, st.picks);
...
if (outcome.over) { st.phase = 'over'; st.winner = st.game.hp.A <= 0 ? 'B' : 'A'; }
```

### ③ 视图裁剪要按"谁能看到什么"

有隐藏信息时，`viewFor(seat)` 必须真的按座位裁剪：

```js
viewFor(seat) {
  const opp = other(seat);
  return {
    ...
    myHand: st.game.hand[seat],          // 自己的手牌
    oppHandCount: st.game.hand[opp].length,  // 对方只有数量
    hp: { ...st.game.hp }                // 血量是公开的
  };
}
```

**这是最容易出事的地方。** 判断标准很简单：问自己"这个字段如果对手打开 DevTools 看到，
游戏还成立吗？" 不成立就不能放进广播。

---

## 多人（3-4 人）

改两个地方：

```js
// room.js
const SEATS = ['A', 'B', 'C', 'D'];
```

```js
// game.js —— resolve 要能处理"每个人打谁"
export function applyRound(game, picks, targets) { ... }
```

同时这些地方会跟着变：

- 满员判断（`freeSeat` 自然支持）
- 视图里 `players` 是 N 个而不是 2 个
- 前端布局（三个以上玩家，按钮和状态区要重排）
- 超时：所有人都要出，缺一个补一个
- 结算顺序：多人同时出招时，**先算伤害再统一应用**，否则先手会占便宜

> 多人局最容易忽略的是"目标"：A 打 B、C 打 A，同一轮里 B 的伤害要一起结算。
> 如果你只是按座位顺序 for 循环一边算一边扣血，结果会依赖循环顺序 —— 那就不是同时出招了。

---

## 让前端知道有哪些动作

demo 里动作写死在 `app.js` 的三个按钮上。要动态化，把动作表放进视图：

```js
// room.js viewFor()
moves: MOVES.map(id => ({ id, label: MOVE_LABEL[id] }))
```

```js
// app.js renderPlaying()
var moves = st.moves.map(function (m) {
  return '<button class="move" data-move="' + m.id + '">' + esc(m.label) + '</button>';
}).join('');
```

**动作的合法性只由服务器判断。** 前端禁用按钮只是体验，不是安全边界 ——
用户可以直接用 DevTools 发任意 `pick`。服务器那句 `isValidMove()` 才是真的。

---

## 别把这些逻辑放到前端

| 放在前端会怎样 | 正确位置 |
|---|---|
| 算胜负 | 服务器 `game.js` |
| 校验"这张牌现在能不能出" | 服务器 |
| 维护血量/手牌 | 服务器 |
| 判断"该谁了" | 服务器 |
| 生成随机数决定结果 | 服务器（或带种子的确定性随机） |

前端只做两件事：**渲染服务器给的状态**、**把点击变成消息**。

---

## 换成"交替回合"游戏（井字棋、象棋）

本套件是**同时出招**模型。交替回合的游戏不一样：

- 只有一个人能行动，另一个人只能等
- 需要"当前该谁"的严格校验（`if (seat !== st.turn) return;`）
- 超时是"这一个人超时"，不是"双方都超时"

改造点：

```js
// state 里加
turn: 'A'

// pick 处理里加
if (st.turn !== seat) return;      // 不是你的回合
...
st.turn = other(seat);             // 结算后换人
```

其余（房间、座位、重连、视图裁剪、超时闹钟）都能原样复用。

下一步：[05 · 连接、心跳与重连](05-transport.md)
