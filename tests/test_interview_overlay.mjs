import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import { selectInterviewQuestion, interviewTranscriptSnapshot, autoAnswerCandidate } from '../web/modules/interview-overlay.js';

const segment = (id, text, source = 'system') => ({ segment_id: `${source}:${id}`, text, source, speaker: source === 'mic' ? 'candidate' : 'interviewer', is_final: true, start_ms: id });

test('the next interview question uses only unconsumed final counterpart statements', () => {
  const snapshot = { run_id: 'run-a', role: 'candidate', transcripts: [segment(0,'已回答'),segment(1,'我的发言','mic'),segment(2,'请说明设计'),segment(3,'以及边界条件'),{...segment(4,'尚未完成'),is_final:false}] };
  const question = selectInterviewQuestion(snapshot,new Set(['system:0']));
  // 两条一起回答时不猜目标，交给后端按最新未答处理。
  assert.deepEqual(question,{text:'请说明设计\n以及边界条件',interview_role:'candidate',interview_transcript:snapshot.transcripts.slice(0,4).map(({source,speaker,text,segment_id})=>({source,speaker,text,segment_id})),segmentIds:['system:2','system:3'],interview_target:'',run_id:'run-a'});
  assert.equal(snapshot.transcripts.length,5);
});

test('no new counterpart statement reuses the stable previous question without using partial text', () => {
  const previous = {text:'固定问题',interview_role:'interviewer',run_id:'a',segmentIds:['system:0']};
  const snapshot = {run_id:'a',role:'interviewer',transcripts:[segment(0,'固定问题')],partials:{system:{text:'正在变化'}}};
  assert.equal(selectInterviewQuestion(snapshot,new Set(['system:0']),previous),previous);
  assert.equal(selectInterviewQuestion({...snapshot,transcripts:[]},new Set()),null);
});

test('interviewer identity is snapshotted instead of inferred from microphone source', () => {
  assert.equal(selectInterviewQuestion({run_id:'b',role:'interviewer',transcripts:[segment(1,'候选人的回答')]}).interview_role,'interviewer');
});

test('real final speech from both sources is snapshotted without interim or later changes',()=>{
  const snapshot={run_id:'run',role:'candidate',transcripts:[segment(100,'我们项目用了Go。','mic'),segment(200,'为什么选这门语言？'),{...segment(300,'尚未完成','mic'),is_final:false}]};
  const question=selectInterviewQuestion(snapshot);
  assert.deepEqual(question.interview_transcript,[{source:'mic',speaker:'candidate',text:'我们项目用了Go。',segment_id:'mic:100'},{source:'system',speaker:'interviewer',text:'为什么选这门语言？',segment_id:'system:200'}]);
  // 只有一条未消费的对方发言，直接标成目标。
  assert.equal(question.interview_target,'system:200');
  snapshot.transcripts[0].text='改写';snapshot.transcripts.push(segment(400,'未来的句子'));
  assert.equal(question.interview_transcript.length,2);
  assert.equal(question.interview_transcript[0].text,'我们项目用了Go。');
  assert.ok(Object.isFrozen(question.interview_transcript)&&Object.isFrozen(question.interview_transcript[0]));
});

test('speech context keeps recent chronological entries within all request limits',()=>{
  const transcripts=Array.from({length:30},(_,index)=>segment(index,`${index}:`+'字'.repeat(2500),index%2?'mic':'system')).reverse();
  const snapshot=interviewTranscriptSnapshot({transcripts});
  assert.ok(snapshot.length<=12);
  assert.ok(snapshot.every(item=>item.text.length<=2000));
  assert.ok(snapshot.reduce((total,item)=>total+item.text.length,0)<=8000);
  assert.ok(snapshot.at(-1).text.startsWith('29:'));
  assert.ok(snapshot.every(item=>item.text.endsWith('…')));
  assert.deepEqual(Object.keys(snapshot[0]),['source','speaker','text','segment_id']);
});

test('transcript context rejects invented sources and speakers',()=>{
  assert.equal(interviewTranscriptSnapshot({transcripts:[{...segment(1,'未标注'),speaker:'unknown'},{...segment(2,'模型草稿'),source:'assistant'}]}).length,0);
});

test('unused long-term-memory controls are absent without overwriting the stored backend preference', () => {
  const html=fs.readFileSync(new URL('../web/settings.html',import.meta.url),'utf8');
  const settings=fs.readFileSync(new URL('../web/modules/settings.js',import.meta.url),'utf8');
  assert.doesNotMatch(html,/longTermMemoryConsent/);
  assert.doesNotMatch(settings,/long_term_memory_consent/);
});

test('compact interview UI reuses one answer reader and keeps provider credentials out of the overlay', () => {
  const html=fs.readFileSync(new URL('../web/index.html',import.meta.url),'utf8');
  const ids=[...html.matchAll(/\bid="([^"]+)"/g)].map(match=>match[1]);
  assert.equal(new Set(ids).size,ids.length);
  for(const id of ['liuwaAnswerTabs','liuwaThread','liuwaCurrentQuestion','quickMode','liuwaInterviewRecord','liuwaTranscript'])assert.equal(ids.filter(value=>value===id).length,1);
  const source=fs.readFileSync(new URL('../web/modules/interview-overlay.js',import.meta.url),'utf8');
  assert.doesNotMatch(source,/new WebSocket|getUserMedia|getDisplayMedia|api_key|audioBuffer/);
  assert.match(source,/onInterviewState/);
  assert.match(source,/value\.revision <= snapshot\.revision/);
  assert.match(source,/snapshot\.run_id !== autoOpenedRun/);
});

test('auto answer only targets the counterpart and skips consumed speech', () => {
  const snapshot = {
    run_id: 'run-auto', role: 'candidate',
    transcripts: [
      segment(1, '我的自我介绍', 'mic'),
      segment(2, '请说明缓存穿透'),
      segment(3, '还有缓存雪崩'),
      segment(4, '嗯'),
      { ...segment(5, '识别中的问题'), is_final: false },
    ],
  };
  const picked = autoAnswerCandidate(snapshot);
  assert.equal(picked.text, '请说明缓存穿透\n还有缓存雪崩');
  assert.deepEqual(picked.segmentIds, ['system:2', 'system:3']);
  assert.equal(picked.latest.segment_id, 'system:3');
  assert.equal(autoAnswerCandidate(snapshot, new Set(['system:2', 'system:3'])), null);
  assert.equal(autoAnswerCandidate(snapshot, new Set(['system:2'])).text, '还有缓存雪崩');
});

test('auto answer ignores candidate speech and interim text entirely', () => {
  const snapshot = { run_id: 'r', role: 'candidate', transcripts: [segment(1, '我讲完了', 'mic'), { ...segment(2, '还没说完', 'system'), is_final: false }] };
  assert.equal(autoAnswerCandidate(snapshot), null);
  assert.equal(autoAnswerCandidate({ transcripts: [] }), null);
});


test('echoed microphone speech never becomes candidate context', () => {
  const snapshot = {
    run_id: 'run-echo', role: 'candidate',
    transcripts: [
      segment(1000, '请用两句话概括订单系统性能优化的排查思路。'),
      segment(1120, '请用两句话概括订单系统性能优化的排查思路', 'mic'),
      segment(2000, '我在订单系统做过索引优化。', 'mic'),
    ],
  };
  const snapshotAfterEcho = interviewTranscriptSnapshot(snapshot);
  assert.equal(snapshotAfterEcho.length, 2);
  assert.ok(snapshotAfterEcho.some(item => item.source === 'system'));
  assert.ok(snapshotAfterEcho.some(item => item.source === 'mic' && item.text === '我在订单系统做过索引优化。'));
  assert.ok(!snapshotAfterEcho.some(item => item.source === 'mic' && item.text.includes('概括')));
});

test('auto answer still keys off the counterpart when an echo is present', () => {
  const snapshot = {
    run_id: 'run-echo', role: 'candidate',
    transcripts: [
      segment(1000, '请用两句话概括订单系统性能优化的排查思路。'),
      segment(1120, '请用两句话概括订单系统性能优化的排查思路', 'mic'),
    ],
  };
  const picked = autoAnswerCandidate(snapshot);
  assert.equal(picked.text, '请用两句话概括订单系统性能优化的排查思路。');
  assert.equal(picked.latest.segment_id, 'system:1000');
});
