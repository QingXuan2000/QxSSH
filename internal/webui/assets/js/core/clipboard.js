/**
 * core/clipboard.js —— 剪贴板写入工具
 * 要点：优先走异步 Clipboard API，失败时回退到临时 textarea + execCommand；返回是否写入成功。
 */
/** 把文本写入系统剪贴板，返回是否成功 */
export async function writeClipboard(text) {
  const value = String(text ?? '');
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(value);
      return true;
    }
  } catch { }
  try {
    const ta = document.createElement('textarea');
    ta.setAttribute('style', 'position:fixed;top:-1000px;left:0;opacity:0');
    ta.value = value;
    document.body.append(ta);
    ta.select();
    const ok = document.execCommand('copy');
    ta.remove();
    return ok;
  } catch {
    return false;
  }
}