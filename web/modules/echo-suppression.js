// 对方声音从扬声器出来会被麦克风再收一遍：系统声里是正确的一条，
// 麦克风里是同一句话却会被标成「候选人说的」。这里只按文本与时间做保守判定，
// 宁可漏判也不误删用户真正说的话。
const ECHO_WINDOW_MS = 1500;
const ECHO_MIN_SIMILARITY = 0.72;
const ECHO_MIN_CHARS = 6;

export function normalizeEchoText(text) {
  return String(text || '')
    .toLowerCase()
    .replace(/[\s，。、；：？！,.;:?!"'“”‘’（）()【】[\]—…~·]/g, '');
}

function bigrams(value) {
  const set = new Set();
  for (let index = 0; index < value.length - 1; index += 1) set.add(value.slice(index, index + 2));
  return set;
}

// 字符二元组 Jaccard：对识别误差有一定容忍，又不会把不同的话判成同一句。
export function echoSimilarity(left, right) {
  const a = normalizeEchoText(left), b = normalizeEchoText(right);
  if (!a || !b) return 0;
  if (a === b) return 1;
  if (a.length < 2 || b.length < 2) return 0;
  const setA = bigrams(a), setB = bigrams(b);
  let shared = 0;
  for (const gram of setA) if (setB.has(gram)) shared += 1;
  return shared / (setA.size + setB.size - shared);
}

// 回声几乎与对方发言同时进入两路采集；人复述会有明显延迟，因此只看很近的时间窗。
// 注意：两路 ASR 的时间戳各自从本会话开始计时。两路同时启动时可以比较；
// 若某一路中途重连，时间会错位，此时只会漏判（放行），不会误删用户真正说过的话。
export function isLikelyEcho(mic, counterpart, windowMs = ECHO_WINDOW_MS) {
  if (!mic || !counterpart) return false;
  if (mic.source !== 'mic' || counterpart.source !== 'system') return false;
  if (!mic.is_final || !counterpart.is_final) return false;
  if (normalizeEchoText(mic.text).length < ECHO_MIN_CHARS) return false;
  const drift = Math.abs((mic.start_ms || 0) - (counterpart.start_ms || 0));
  if (drift > windowMs) return false;
  return echoSimilarity(mic.text, counterpart.text) >= ECHO_MIN_SIMILARITY;
}

// 返回被判定为回声的麦克风片段 id。
export function findEchoSegments(segments, windowMs = ECHO_WINDOW_MS) {
  const systems = (segments || []).filter(item => item && item.source === 'system' && item.is_final);
  const echo = new Set();
  for (const item of segments || []) {
    if (!item || item.source !== 'mic' || !item.is_final) continue;
    if (systems.some(other => other !== item && isLikelyEcho(item, other, windowMs))) echo.add(String(item.segment_id || ''));
  }
  echo.delete('');
  return echo;
}
