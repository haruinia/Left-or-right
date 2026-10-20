// 轻量 Markdown 渲染：把 AI 回答渲染成结构化 HTML（标题/列表/代码块/加粗等），
// 参考 Gank 的回答卡片排版。仅支持模型实际会输出的语法子集，离线可用，无外部依赖。
// 安全：所有文本先经 escapeHtml，再套标签，不会注入原始 HTML。

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

// 行内语法：代码、加粗、斜体、删除线
function renderInline(text) {
  let out = escapeHtml(text);
  out = out.replace(/`([^`\n]+)`/g, '<code class="md-inline-code">$1</code>');
  out = out.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
  out = out.replace(/__([^_]+)__/g, "<strong>$1</strong>");
  out = out.replace(/(?<!\w)\*([^*\n]+)\*(?!\w)/g, "<em>$1</em>");
  out = out.replace(/(?<!\w)_([^_\n]+)_(?!\w)/g, "<em>$1</em>");
  out = out.replace(/~~([^~]+)~~/g, "<del>$1</del>");
  return out;
}

// 块级渲染：按行扫描，识别代码块、标题、列表、表格、引用、分隔线、段落。
// 流式场景安全：未闭合的代码块按已到内容渲染（末尾假装闭合）。
export function renderMarkdown(source) {
  const lines = String(source || "").replaceAll("\r\n", "\n").split("\n");
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
    html.push(`<${tag}>${list.items.map((item) => `<li>${renderInline(item)}</li>`).join("")}</${tag}>`);
    list = null;
  };
  const flushCode = () => {
    if (!codeFence) return;
    const lang = codeFence.lang ? ` data-lang="${escapeHtml(codeFence.lang)}"` : "";
    html.push(`<pre class="md-code"${lang}><code>${escapeHtml(codeFence.lines.join("\n"))}</code></pre>`);
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

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    // 代码围栏
    const fence = line.match(/^```(\S*)\s*$/);
    if (fence) {
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
      if (!list || list.type !== "ol") { flushList(); list = { type: "ol", items: [] }; }
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
  flushParagraph();
  flushList();
  flushTable();
  return html.join("");
}
