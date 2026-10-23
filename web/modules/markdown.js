// 轻量 Markdown 渲染：把 AI 回答渲染成结构化 HTML（标题/列表/代码块/加粗等），
// 参考 Gank 的回答卡片排版。仅支持模型实际会输出的语法子集，离线可用。
// 安全：所有文本先经 escapeHtml，再套标签，不会注入原始 HTML。
//
// 数学公式用 KaTeX（和 Gank 同一个方案），vendor 在 web/vendor/katex。

import { stripAnswerMetadata } from './answer-sections.js';

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

// 三种定界符都要认。提示词要求 $...$ / $$...$$，但模型经常改用 LaTeX 原生的
// \( ... \) 和 \[ ... \]（Gank 用的 remark-math 默认也支持这两套），
// 只认 $ 的话整篇公式会原样露出来。
const MATH_INLINE = /(?<!\\)\$(?!\s)([^$\n]{1,200}?)(?<![\\\s])\$(?!\d)/g;
const MATH_INLINE_PAREN = /\\\((.+?)\\\)/g;
const MATH_BLOCK = /^\s*\$\$\s*$/;
const MATH_BLOCK_BRACKET = /^\s*\\\[\s*$/;
const MATH_BLOCK_END = /^\s*\\\]\s*$/;

// KaTeX 由 index.html 提前加载（<script src="vendor/katex/katex.min.js">）。
// 加载失败时返回 null，公式退回纯文本显示——总比整段回答渲染不出来好。
function tex(expr, displayMode) {
  const katex = typeof window !== "undefined" ? window.katex : null;
  if (!katex || typeof katex.renderToString !== "function") {
    return `<span class="md-math-fallback">${escapeHtml(expr)}</span>`;
  }
  try {
    return katex.renderToString(expr, {
      displayMode,
      throwOnError: false,
      // 流式输出时公式常常只到一半（\frac{ 少了右括号），
      // 别把半截公式染成红色错误提示。
      strict: "ignore",
      trust: false,
      output: "html",
    });
  } catch {
    return `<span class="md-math-fallback">${escapeHtml(expr)}</span>`;
  }
}

function renderInline(text) {
  // 先在「未转义」的原文上把公式抠出来，再做 HTML 转义。
  // 反过来的话 `h > m` 会先变成 `h &gt; m`，KaTeX 收到 `&gt;` 直接报解析错误。
  const slots = [];
  const stash = (rendered) => {
    slots.push(rendered);
    return `\u0000${slots.length - 1}\u0000`;
  };

  let source = String(text);
  // 反引号里的内容不是公式，先保护起来（只存内部文本，还原时再补标签）。
  source = source.replace(/`([^`\n]+)`/g, (_match, inner) => stash(`\u0001${inner}\u0001`));
  source = source.replace(MATH_INLINE, (_match, expr) => {
    // $6$ / $0$ 也是合法数学表达式；金额通常只有左侧一个美元符号。
    if (!/[\\^_{}=<>+\-*/()A-Za-z0-9]/.test(expr)) return _match;
    return stash(tex(expr, false));
  });
  source = source.replace(MATH_INLINE_PAREN, (_match, expr) => stash(tex(expr.trim(), false)));

  let out = escapeHtml(source);
  out = out.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
  out = out.replace(/__([^_]+)__/g, "<strong>$1</strong>");
  out = out.replace(/(?<!\w)\*([^*\n]+)\*(?!\w)/g, "<em>$1</em>");
  out = out.replace(/(?<!\w)_([^_\n]+)_(?!\w)/g, "<em>$1</em>");
  out = out.replace(/~~([^~]+)~~/g, "<del>$1</del>");

  // 还原占位：公式原样放回，行内代码补上正常标签。
  return out.replace(/\u0000(\d+)\u0000/g, (_m, i) => {
    const value = slots[Number(i)];
    const code = value.match(/^\u0001(.*)\u0001$/s);
    return code ? `<code class="md-inline-code">${escapeHtml(code[1])}</code>` : value;
  });
}

// 块级渲染：按行扫描，识别代码块、标题、列表、表格、引用、分隔线、段落。
// 流式场景安全：未闭合的代码块按已到内容渲染（末尾假装闭合）。
export function renderMarkdown(source) {
  const lines = stripAnswerMetadata(source).text.split("\n");
  const html = [];
  let paragraph = [];
  let list = null; // { type: "ul"|"ol", items: [] }
  let codeFence = null; // { lang, lines: [] }
  let table = null; // { header: [], align: [], rows: [[]] }

  const flushParagraph = () => {
    if (!paragraph.length) return;
    html.push(`<p>${paragraph.map(renderInline).join("<br>")}</p>`);
    paragraph = [];
  };
  const flushList = () => {
    if (!list) return;
    const tag = list.type;
    // 保留作者写的起始编号：答案常写成 1./2./3./4. 且各题之间空行分隔，
    // 不传 start 的话每组都从 1 重新数，四道题全变成「1.」。
    const start = list.start && list.start !== 1 ? ` start="${list.start}"` : "";
    html.push(`<${tag}${start}>${list.items.map((item) => `<li>${renderInline(item)}</li>`).join("")}</${tag}>`);
    list = null;
  };
  // 代码块用 highlight.js 上色（Gank 用的也是它）。vendor 在 web/vendor/highlight，
  // 加载失败时退回纯文本，不能让整段回答渲染不出来。
  const highlightCode = (source, lang) => {
    const hljs = typeof window !== "undefined" ? window.hljs : null;
    if (!hljs || !lang || !hljs.getLanguage(lang)) return escapeHtml(source);
    try {
      return hljs.highlight(source, { language: lang, ignoreIllegals: true }).value;
    } catch {
      return escapeHtml(source);
    }
  };
  const flushCode = () => {
    if (!codeFence) return;
    const lang = codeFence.lang ? ` data-lang="${escapeHtml(codeFence.lang)}"` : "";
    const raw = codeFence.lines.join("\n");
    // 行号单独一列：不切分高亮后的 HTML，跨行注释/字符串的 span 不会被拆断。
    // 行号列在 pre 之外，复制按钮读 pre.textContent 就只拿到源码本身。
    const lines = Math.max(1, codeFence.lines.length);
    const gutter = Array.from({length: lines}, (_line, index) => index + 1).join("\n");
    html.push(
      `<div class="md-code-block"${lang}>` +
        `<div class="md-code-head">` +
          `<span class="md-code-lang">${escapeHtml(codeFence.lang || "text")}</span>` +
          `<button type="button" class="md-copy" aria-label="复制代码">复制</button>` +
        `</div>` +
        `<div class="md-code-body">` +
          `<span class="md-code-gutter" aria-hidden="true">${gutter}</span>` +
          `<pre class="md-code"${lang}><code class="hljs">${highlightCode(raw, codeFence.lang)}</code></pre>` +
        `</div>` +
      `</div>`,
    );
    codeFence = null;
  };
  const flushTable = () => {
    if (!table || !table.rows.length) { table = null; return; }
    const cells = (row, tag) =>
      row.map((cell) => `<${tag}>${renderInline(cell.trim())}</${tag}>`).join("");
    const head = table.header.length
      ? `<thead><tr>${cells(table.header, "th")}</tr></thead>`
      : "";
    const body = table.rows.map((row) => `<tr>${cells(row, "td")}</tr>`).join("");
    html.push(`<table class="md-table">${head}<tbody>${body}</tbody></table>`);
    table = null;
  };
  const splitTableRow = (line) => {
    // 去掉首尾竖线后按竖线切分
    const trimmed = line.trim().replace(/^\||\|$/g, "");
    return trimmed.split("|");
  };
  const isTableDivider = (line) =>
    /^\s*\|?[\s:|-]+\|?\s*$/.test(line) && line.includes("-");

  let mathBlock = null; // 块级公式 $$ ... $$，可能跨行

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];

    // 围栏里的公式定界符也是代码；必须先处理围栏，再识别数学块。
    const fence = line.match(/^```(\S*)\s*$/);
    if (!mathBlock && fence) {
      if (codeFence) {
        flushCode();
      } else {
        flushParagraph();
        flushList();
        flushTable();
        codeFence = { lang: fence[1] || "", lines: [] };
      }
      continue;
    }
    if (codeFence) {
      codeFence.lines.push(line);
      continue;
    }

    // 单行写完的块级公式：`$$ ... $$`（模型经常这么写，虽然提示词要求独占行）。
    const oneLine = line.trim().match(/^\$\$(.+)\$\$$/);
    if (oneLine && !mathBlock) {
      flushParagraph();
      flushList();
      flushTable();
      html.push(`<div class="md-math-block">${tex(oneLine[1].trim(), true)}</div>`);
      continue;
    }

    // 跨行的块级公式：开头 $$（或 \[）独占一行，结尾也独占一行。
    if (MATH_BLOCK.test(line) || MATH_BLOCK_BRACKET.test(line)) {
      if (mathBlock) {
        html.push(`<div class="md-math-block">${tex(mathBlock.lines.join("\n"), true)}</div>`);
        mathBlock = null;
      } else {
        flushParagraph();
        flushList();
        flushTable();
        mathBlock = { lines: [] };
      }
      continue;
    }
    // 块级公式的收尾：`\]` 独占一行，或者 `$$` / `\]` 和最后一行挤在一起。
    if (mathBlock && (MATH_BLOCK_END.test(line) || /\$\$\s*$/.test(line) || /\\\]\s*$/.test(line))) {
      const body = line.replace(MATH_BLOCK_END, "").replace(/\$\$\s*$/, "").replace(/\\\]\s*$/, "");
      if (body.trim()) mathBlock.lines.push(body);
      html.push(`<div class="md-math-block">${tex(mathBlock.lines.join("\n"), true)}</div>`);
      mathBlock = null;
      continue;
    }
    if (mathBlock) {
      mathBlock.lines.push(line);
      continue;
    }

    // 表格：连续以 | 开头/结尾的行。第一行是表头，第二行是分隔线，其余是数据。
    if (line.trim().startsWith("|") && line.trim().endsWith("|")) {
      flushParagraph();
      flushList();
      if (!table) {
        table = { header: [], align: [], rows: [] };
        table.header = splitTableRow(line);
        continue;
      }
      if (isTableDivider(line)) continue; // 分隔线跳过
      table.rows.push(splitTableRow(line));
      continue;
    }
    flushTable();

    // 标题
    const heading = line.match(/^(#{1,4})\s+(.+?)\s*$/);
    if (heading) {
      flushParagraph();
      flushList();
      const level = heading[1].length + 1; // h2-h5，h1 留给页面
      html.push(`<h${level} class="md-heading">${renderInline(heading[2])}</h${level}>`);
      continue;
    }

    // 分隔线
    if (/^\s*(-{3,}|\*{3,}|_{3,})\s*$/.test(line)) {
      flushParagraph();
      flushList();
      html.push("<hr>");
      continue;
    }

    // 引用
    const quote = line.match(/^>\s?(.*)$/);
    if (quote) {
      flushParagraph();
      flushList();
      html.push(`<blockquote>${renderInline(quote[1])}</blockquote>`);
      continue;
    }

    // 无序列表
    const ul = line.match(/^\s*[-*•]\s+(.+)$/);
    if (ul) {
      flushParagraph();
      if (!list || list.type !== "ul") { flushList(); list = { type: "ul", items: [] }; }
      list.items.push(ul[1]);
      continue;
    }

    // 有序列表
    const ol = line.match(/^\s*(\d+)[.、)]\s+(.+)$/);
    if (ol) {
      flushParagraph();
      if (!list || list.type !== "ol") {
        flushList();
        list = { type: "ol", items: [], start: Number(ol[1]) };
      }
      list.items.push(ol[2]);
      continue;
    }

    // 空行 → 段落分隔
    if (!line.trim()) {
      flushParagraph();
      flushList();
      continue;
    }

    // 普通文本行，进段落
    flushList();
    paragraph.push(line);
  }

  flushCode(); // 流式未闭合代码块也渲染
  if (mathBlock) {
    // 流式时右半边 $$ 还没到，先把已有内容渲染出来，不要吞掉。
    html.push(`<div class="md-math-block">${tex(mathBlock.lines.join("\n"), true)}</div>`);
  }
  flushParagraph();
  flushList();
  flushTable();
  return html.join("");
}
