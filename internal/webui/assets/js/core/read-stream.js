/**
 * core/read-stream.js —— 响应流文本读取
 * 要点：把 fetch 响应体分块解码后交给回调，末尾补发残留字符；供各流式接口复用。
 */
/** 逐块读取响应体文本并回调，末尾补发残留内容 */
export async function drainText(res, onChunk) {
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (value && value.length) onChunk(dec.decode(value, { stream: true }));
  }
  const tail = dec.decode();
  if (tail) onChunk(tail);
}