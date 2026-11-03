import assert from 'node:assert/strict';
import test from 'node:test';
import { echoSimilarity, findEchoSegments, isLikelyEcho, normalizeEchoText } from '../web/modules/echo-suppression.js';

const seg = (id, text, source, start) => ({ segment_id: `${source}:${id}`, source, text, start_ms: start, is_final: true });

test('similarity tolerates recognition noise but not different sentences', () => {
  assert.equal(echoSimilarity('请用两句话概括性能优化', '请用两句话概括性能优化'), 1);
  assert.ok(echoSimilarity('请用两句话概括订单系统性能优化的排查思路', '请用两句话概括订单系统性能优化的排查思') > 0.72);
  assert.ok(echoSimilarity('请用两句话概括性能优化', '我主要负责订单系统开发') < 0.3);
  assert.equal(normalizeEchoText(' 请用，两句话。概括 ！'), '请用两句话概括');
});

test('a microphone echo of the counterpart is suppressed', () => {
  const segments = [
    seg(0, '请用两句话概括订单系统性能优化的排查思路。', 'system', 1000),
    seg(1, '请用两句话概括订单系统性能优化的排查思路', 'mic', 1120),
  ];
  assert.deepEqual([...findEchoSegments(segments)], ['mic:1']);
});

test('the user repeating a question later is kept as real speech', () => {
  const segments = [
    seg(0, '请用两句话概括订单系统性能优化的排查思路。', 'system', 1000),
    seg(1, '请用两句话概括订单系统性能优化的排查思路', 'mic', 9000),
  ];
  assert.equal(findEchoSegments(segments).size, 0);
});

test('candidate speech that only shares wording is not treated as echo', () => {
  const segments = [
    seg(0, '你在订单系统做过哪些性能优化？', 'system', 1000),
    seg(1, '我在订单系统做过缓存和索引优化。', 'mic', 1100),
  ];
  assert.equal(findEchoSegments(segments).size, 0);
});

test('short fillers, partial segments and one-sided audio never trigger suppression', () => {
  assert.equal(isLikelyEcho(seg(1, '嗯嗯', 'mic', 100), seg(0, '嗯嗯', 'system', 100)), false);
  assert.equal(isLikelyEcho({ ...seg(1, '请用两句话概括性能优化', 'mic', 100), is_final: false }, seg(0, '请用两句话概括性能优化', 'system', 100)), false);
  assert.equal(isLikelyEcho(seg(1, '请用两句话概括性能优化', 'mic', 100), seg(0, '请用两句话概括性能优化', 'mic', 100)), false);
  assert.equal(findEchoSegments([seg(1, '只有麦克风', 'mic', 100)]).size, 0);
  assert.equal(findEchoSegments([]).size, 0);
  assert.equal(findEchoSegments(null).size, 0);
});
