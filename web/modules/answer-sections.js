// 只按明确的 Markdown 小节拆分；代码围栏、公式和题号保留原文。
const TYPES = new Set(['choice', 'programming', 'reasoning', 'essay', 'calculation', 'general', 'mixed']);
const LABELS = {answer:'答案', thought:'思路', code:'代码', analysis:'解析', other:'补充', all:'全文'};

function sectionKind(title) {
  const value = title.replace(/[*`]/g, '').replace(/^\s*(?:\d+[.、)）]|[一二三四五六七八九十]+[、.])\s*/, '').trim();
  const names = {
    answer: /^(?:答案|最终答案|参考答案|参考作答|作答正文|参考范文|范文|结论|计算结果|Answer|Final Answer)(?:$|[\s:：（(])/i,
    thought: /^(?:解题思路|答题思路|写作思路|论证思路|证明思路|思路|思考过程|关键观察|分层提示|提示|Approach|Hints?)(?:$|[\s:：（(])/i,
    code: /^(?:代码|参考代码|完整代码|实现代码|代码实现|参考实现|完整实现|实现|Code|Implementation)(?:$|[\s:：（(])/i,
    analysis: /^(?:详细解析|答案解析|选项分析|材料分析|题目分析|复杂度分析|复杂度|推导过程|计算过程|证明过程|解析|分析|论证|验证|易错点|Analysis|Explanation|Complexity)(?:$|[\s:：（(])/i,
  };
  return Object.entries(names).find(([, pattern]) => pattern.test(value))?.[0] || null;
}

export function stripAnswerMetadata(markdown) {
  const source = String(markdown || '').replace(/^\uFEFF/, '').replaceAll('\r\n', '\n');
  const match = source.match(/^\s*<!--\s*liuwa:type=([a-z]+)\s*-->\s*/i);
  if (match && TYPES.has(match[1].toLowerCase())) return {type:match[1].toLowerCase(), text:source.slice(match[0].length)};
  // 分片中的元信息不应短暂泄露到正文。
  const start = source.trimStart();
  if (!source.includes('-->') && (start.startsWith('<!--') || '<!--'.startsWith(start))) return {type:null, text:''};
  return {type:null, text:source};
}

export function splitAnswer(markdown) {
  const {type:declaredType, text:full} = stripAnswerMetadata(markdown);
  const chunks = [];
  const parents = [];
  let current = {kind:'other', level:0, prefix:'', lines:[], body:[]};
  let fence = null;
  const push = () => { if(current.lines.join('\n').trim()) chunks.push(current); };
  for (const line of full.split('\n')) {
    const fenced = line.match(/^\s{0,3}(`{3,}|~{3,})(.*)$/);
    if (fenced) {
      if (!fence) fence = {char:fenced[1][0], length:fenced[1].length};
      else if (fenced[1][0] === fence.char && fenced[1].length >= fence.length && !fenced[2].trim()) fence = null;
      current.lines.push(line); current.body.push(line); continue;
    }
    const heading = !fence && line.match(/^(#{1,6})\s+(.+?)\s*#*\s*$/);
    if (heading) {
      const level = heading[1].length;
      const kind = sectionKind(heading[2]);
      while(parents.length && parents.at(-1).level >= level) parents.pop();
      if (current.kind === 'other' || level <= current.level) {
        push();
        const context = parents.filter(p => !p.kind).map(p => p.line).join('\n\n');
        current = {kind:kind || 'other', level, prefix:context, lines:[line], body:[]};
      } else { current.lines.push(line); current.body.push(line); }
      parents.push({level, kind, line});
    } else { current.lines.push(line); current.body.push(line); }
  }
  push();
  const groups = new Map();
  for (const chunk of chunks) {
    // 文档标题属于上下文；有实质内容的未知小节仍可在“补充”与全文中阅读。
    if (chunk.kind === 'other' && !chunk.body.join('\n').trim()) continue;
    if (!groups.has(chunk.kind)) groups.set(chunk.kind, []);
    groups.get(chunk.kind).push(chunk);
  }
  const recognized = [...groups.keys()].some(kind => kind !== 'other');
  let type = declaredType;
  if (!type) {
    if (groups.has('code')) type = 'programming';
    else if (/^#{1,3}\s+(?:参考作答|参考范文|范文|作答正文)/m.test(full)) type = 'essay';
    else if (groups.has('thought') && !groups.has('answer')) type = 'reasoning';
    else type = 'general';
  }
  if (type === 'general' && groups.has('code')) type = 'programming';
  const priority = type === 'mixed' ? ['answer','all','code','thought','analysis','other']
    : type === 'programming' ? ['answer','code','thought','analysis','other','all']
    : ['answer','thought','analysis','code','other','all'];
  const panels = recognized ? [...groups].map(([key, parts]) => ({
    key, label:type === 'essay' && key === 'answer' ? '参考作答' : LABELS[key],
    markdown:parts.map(p => [p.prefix,p.lines.join('\n')].filter(Boolean).join('\n\n')).join('\n\n'),
    hasContent:parts.some(p => p.body.join('\n').trim()),
  })) : [];
  panels.push({key:'all',label:LABELS.all,markdown:full,hasContent:chunks.some(p => p.body.join('\n').trim())});
  panels.sort((a,b)=>priority.indexOf(a.key)-priority.indexOf(b.key));
  const preferred = type === 'mixed' && !panels.some(p => p.key === 'answer' && p.hasContent)
    ? 'all'
    : panels.find(p => p.hasContent)?.key || panels[0]?.key || 'all';
  return {type,full,panels,preferred};
}
