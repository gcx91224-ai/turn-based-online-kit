/* =============================================================================
 * 游戏规则 —— 整个套件里唯一需要你改的文件
 *
 * 默认实现是「石头剪刀布，先赢 3 局」。换成你自己的游戏时，保持这三个导出：
 *
 *   MOVES        可选动作列表（字符串 id）
 *   isValidMove  某个 id 是不是合法动作
 *   resolve      给定双方动作，返回 'A' | 'B' | 'draw'
 *
 * 服务器的房间流程（座位、回合、超时、重连）完全不需要动。
 * 如果你的游戏有更多状态（血量、手牌、能量），看 docs/03-swap-your-game.md。
 * ========================================================================== */

export const MOVES = ['rock', 'paper', 'scissors'];

export const MOVE_LABEL = {
  rock: '石头',
  paper: '布',
  scissors: '剪刀'
};

export const WIN_SCORE = 3;

export function isValidMove(move) {
  return MOVES.includes(move);
}

/* 返回 'A' 赢 / 'B' 赢 / 'draw' 平 */
export function resolve(a, b) {
  if (!isValidMove(a) || !isValidMove(b)) throw new Error('非法动作: ' + a + ' / ' + b);
  if (a === b) return 'draw';
  if (
    (a === 'rock' && b === 'scissors') ||
    (a === 'scissors' && b === 'paper') ||
    (a === 'paper' && b === 'rock')
  ) return 'A';
  return 'B';
}

/* 超时自动出拳用。服务器侧随机即可 —— 这是「补一个动作」，不是公平性的一部分。 */
export function randomMove() {
  return MOVES[Math.floor(Math.random() * MOVES.length)];
}
