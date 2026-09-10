/**
 * 极简 Markdown 渲染器（运维文档同源引用用）——只覆盖我们这四篇 docs/ops/*.md
 * 实际用到的语法：标题、列表、表格、引用、围栏代码块、行内 code、粗体、链接。
 *
 * 关键点：**代码块自带复制按钮**，md 里写的 PowerShell/git 命令直接可复制，
 * 不需要在 UI 里再抄一份。
 */
import { useState } from 'react';

/** 复制文本（与 tab.jsx 内同语义，独立实现避免跨文件耦合）。 */
function copyText(text, done) {
  const s = String(text ?? '');
  const fallback = () => {
    try {
      const ta = document.createElement('textarea');
      ta.value = s;
      ta.style.position = 'fixed';
      ta.style.opacity = '0';
      document.body.appendChild(ta);
      ta.select();
      document.execCommand('copy');
      ta.remove();
    } catch { /* 复制失败不阻塞 */ }
    done();
  };
  try {
    if (navigator.clipboard && navigator.clipboard.writeText) {
      void navigator.clipboard.writeText(s).then(done).catch(fallback);
      return;
    }
  } catch { /* 走回退 */ }
  fallback();
}

/** 行内语法：`code`、**bold**、[text](url)。 */
function inline(text, keyPrefix) {
  const out = [];
  const re = /(`[^`]+`)|(\*\*[^*]+\*\*)|(\[[^\]]+\]\([^)]+\))/g;
  let last = 0;
  let m;
  let i = 0;
  while ((m = re.exec(text)) !== null) {
    if (m.index > last) out.push(text.slice(last, m.index));
    const token = m[0];
    if (token.startsWith('`')) out.push(<code key={`${keyPrefix}-c${i}`} className="dsb-md-code">{token.slice(1, -1)}</code>);
    else if (token.startsWith('**')) out.push(<strong key={`${keyPrefix}-b${i}`}>{token.slice(2, -2)}</strong>);
    else {
      const mm = /\[([^\]]+)\]\(([^)]+)\)/.exec(token);
      out.push(<span key={`${keyPrefix}-l${i}`}>{mm[1]}<span className="dsb-md-url">（{mm[2]}）</span></span>);
    }
    last = m.index + token.length;
    i += 1;
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
}

/** 代码块：<pre> + 复制按钮（md 里的命令即 UI 里可复制的命令）。 */
function CodeBlock({ code, t }) {
  const [copied, setCopied] = useState(false);
  return (
    <div className="dsb-md-pre-wrap">
      <button
        type="button"
        className="dsb-btn-secondary dsb-copy dsb-md-copy"
        onClick={() => copyText(code, () => { setCopied(true); setTimeout(() => setCopied(false), 1600); })}
      >
        {copied ? t('cmdCopied') : t('cmdCopy')}
      </button>
      <pre className="dsb-md-pre"><code>{code}</code></pre>
    </div>
  );
}

/**
 * 渲染 Markdown 文本。
 * @param props.text 文档原文（构建时从 docs/ops/*.md 内联）；props.t 文案函数。
 */
export function Markdown({ text, t }) {
  const lines = String(text ?? '').split('\n');
  const blocks = [];
  let i = 0;
  let k = 0;

  while (i < lines.length) {
    const line = lines[i];

    // 围栏代码块
    if (line.trim().startsWith('```')) {
      const body = [];
      i += 1;
      while (i < lines.length && !lines[i].trim().startsWith('```')) { body.push(lines[i]); i += 1; }
      i += 1;
      blocks.push(<CodeBlock key={`code${k++}`} code={body.join('\n')} t={t} />);
      continue;
    }

    // 标题
    const h = /^(#{1,4})\s+(.*)$/.exec(line);
    if (h) {
      const level = h[1].length;
      const content = inline(h[2], `h${k}`);
      const Tag = level === 1 ? 'h3' : level === 2 ? 'h4' : 'h5';
      blocks.push(<Tag key={`h${k++}`} className={`dsb-md-h dsb-md-h${level}`}>{content}</Tag>);
      i += 1;
      continue;
    }

    // 表格（| a | b |  + 分隔行）
    if (/^\s*\|.*\|\s*$/.test(line) && i + 1 < lines.length && /^\s*\|[\s:|-]+\|\s*$/.test(lines[i + 1])) {
      const header = line.trim().replace(/^\||\|$/g, '').split('|').map((s) => s.trim());
      i += 2;
      const rows = [];
      while (i < lines.length && /^\s*\|.*\|\s*$/.test(lines[i])) {
        rows.push(lines[i].trim().replace(/^\||\|$/g, '').split('|').map((s) => s.trim()));
        i += 1;
      }
      blocks.push(
        <table key={`tbl${k++}`} className="dsb-md-table">
          <thead><tr>{header.map((cell, ci) => <th key={ci}>{inline(cell, `th${ci}`)}</th>)}</tr></thead>
          <tbody>
            {rows.map((row, ri) => (
              <tr key={ri}>{row.map((cell, ci) => <td key={ci}>{inline(cell, `td${ri}-${ci}`)}</td>)}</tr>
            ))}
          </tbody>
        </table>,
      );
      continue;
    }

    // 引用
    if (/^\s*>\s?/.test(line)) {
      const body = [];
      while (i < lines.length && /^\s*>\s?/.test(lines[i])) { body.push(lines[i].replace(/^\s*>\s?/, '')); i += 1; }
      blocks.push(<blockquote key={`q${k++}`} className="dsb-md-quote">{inline(body.join(' '), `q${k}`)}</blockquote>);
      continue;
    }

    // 无序列表
    if (/^\s*[-*]\s+/.test(line)) {
      const items = [];
      while (i < lines.length && /^\s*[-*]\s+/.test(lines[i])) { items.push(lines[i].replace(/^\s*[-*]\s+/, '')); i += 1; }
      blocks.push(<ul key={`ul${k++}`} className="dsb-md-list">{items.map((it, ii) => <li key={ii}>{inline(it, `li${ii}`)}</li>)}</ul>);
      continue;
    }

    // 有序列表
    if (/^\s*\d+\.\s+/.test(line)) {
      const items = [];
      while (i < lines.length && /^\s*\d+\.\s+/.test(lines[i])) { items.push(lines[i].replace(/^\s*\d+\.\s+/, '')); i += 1; }
      blocks.push(<ol key={`ol${k++}`} className="dsb-md-list">{items.map((it, ii) => <li key={ii}>{inline(it, `oli${ii}`)}</li>)}</ol>);
      continue;
    }

    // 空行
    if (!line.trim()) { i += 1; continue; }

    // 普通段落（连续行合并）
    const para = [];
    while (i < lines.length && lines[i].trim() && !/^(#{1,4}\s|\s*[-*]\s|\s*\d+\.\s|\s*>|\s*\||\s*```)/.test(lines[i])) {
      para.push(lines[i]);
      i += 1;
    }
    blocks.push(<p key={`p${k++}`} className="dsb-md-p">{inline(para.join(' '), `p${k}`)}</p>);
  }

  return <div className="dsb-md">{blocks}</div>;
}
