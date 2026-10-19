/**
 * core/stream.js —— 流式文本传输与日志缓冲
 * 要点：streamText 边接收边回调分块；createLineBuffer 把分块内容切成行并限制最大行数；renderLog 负责把行渲染进 pre 元素。
 */
import { errorFromResponse } from './sys.js';
import { drainText } from './read-stream.js';

/** 以流式方式请求接口，逐块把文本交给 onChunk */
export async function streamText(url, { method = 'GET', body, signal, onChunk } = {}) {
  const opts = { method, signal };
  if (body !== undefined) {
    opts.headers = { 'Content-Type': 'application/json' };
    opts.body = JSON.stringify(body);
  }
  const res = await fetch(url, opts);
  if (!res.ok) throw await errorFromResponse(res);
  await drainText(res, onChunk);
}

/** 创建按行累积的缓冲器，供终端/日志增量刷新使用 */
export function createLineBuffer(maxLines = 5000) {
  let lines = [];
  let partial = '';
  return {
    push(chunk) {
      partial += chunk;
      let idx;
      while ((idx = partial.indexOf('\n')) >= 0) {
        lines.push(partial.slice(0, idx).replace(/\r$/, ''));
        partial = partial.slice(idx + 1);
      }
      if (lines.length > maxLines) lines = lines.slice(lines.length - maxLines);
    },
    clear() { lines = []; partial = ''; },
    get(partialLine = true) {
      return partialLine && partial ? [...lines, partial] : lines;
    },
    count() { return lines.length + (partial ? 1 : 0); },
  };
}

/** 把日志行渲染到 pre 元素，支持关键字过滤并保持贴底滚动 */
export function renderLog(pre, lines, filter = '') {
  const q = filter.trim().toLowerCase();
  const shown = q ? lines.filter((l) => l.toLowerCase().includes(q)) : lines;
  const nearBottom = pre.scrollHeight - pre.scrollTop - pre.clientHeight < 48;
  pre.textContent = shown.join('\n');
  if (nearBottom) pre.scrollTop = pre.scrollHeight;
  return shown.length;
}
