import { terminalWSUrl } from '/assets/js/core/qxssh-api.js';
import { t, tf } from '/assets/js/core/i18n.js';
import { FALLBACK_COLS, FALLBACK_ROWS } from './config.js';

const MAX_RETRIES = 5;
const BASE_DELAY_MS = 800;
const MAX_DELAY_MS = 15000;

export function createSession(opts) {
  const {
    hostId, cwd = '', size,
    onData, onNotice, onState, onExit, shouldReconnect,
  } = opts;

  const state = {
    connecting: false,
    connected: false,
    exitCode: null,
    retries: 0,
  };

  let ws = null;
  let disposed = false;
  let retryTimer = null;
  let cwdHint = '';

  const notify = (text) => { try { onNotice && onNotice(text); } catch (e) { console.error(e); } };
  const touch = () => { try { onState && onState(); } catch (e) { console.error(e); } };

  function currentSize() {
    const s = (size && size()) || {};
    return {
      cols: Math.max(20, Number(s.cols) || 0) || FALLBACK_COLS,
      rows: Math.max(5, Number(s.rows) || 0) || FALLBACK_ROWS,
    };
  }

  function connect() {
    if (disposed) return;
    if (ws) { try { ws.close(); } catch { } }
    clearTimeout(retryTimer);
    retryTimer = null;

    state.connecting = true;
    state.connected = false;
    touch();

    const { cols, rows } = currentSize();
    const startCwd = cwdHint || cwd || '';
    cwdHint = '';

    let sock;
    try {
      sock = new WebSocket(terminalWSUrl(hostId, cols, rows, startCwd));
    } catch (err) {
      state.connecting = false;
      touch();
      notify(`\r\n\x1b[31m[${tf('app.terminal.notify-connect-failed', { v1: err.message })}]\x1b[0m\r\n`);
      return;
    }
    sock.binaryType = 'arraybuffer';
    ws = sock;

    sock.onopen = () => {
      if (disposed) { try { sock.close(); } catch { } return; }
      state.connecting = false;
      state.connected = true;
      state.exitCode = null;
      state.retries = 0;
      const now = currentSize();
      sock.send(JSON.stringify({ t: 'resize', c: now.cols, r: now.rows }));
      touch();
    };

    sock.onmessage = (ev) => {
      if (typeof ev.data === 'string') {
        let msg;
        try { msg = JSON.parse(ev.data); } catch { return; }
        if (msg && msg.t === 'exit') {
          state.connected = false;
          state.exitCode = msg.code ?? 0;
          notify(`\r\n\x1b[90m[${tf('app.terminal.notify-exited', { v1: msg.code })}]\x1b[0m\r\n`);
          touch();
          try { onExit && onExit(msg.code); } catch (e) { console.error(e); }
          return;
        }
        if (msg && msg.t === 'err') {
          state.connected = false;
          notify(`\r\n\x1b[31m[${msg.m || t('app.terminal.notify-session-failed')}]\x1b[0m\r\n`);
          touch();
        }
        return;
      }
      try { onData && onData(new Uint8Array(ev.data)); } catch (e) { console.error(e); }
    };

    sock.onerror = () => { };

    sock.onclose = () => {
      if (disposed) return;
      const wasConnected = state.connected;
      state.connected = false;
      state.connecting = false;
      touch();
      if (state.exitCode == null) {
        if (wasConnected) notify(`\r\n\x1b[31m[${t('app.terminal.notify-disconnected')}]\x1b[0m\r\n`);
        scheduleRetry();
      }
    };
  }

  function scheduleRetry() {
    if (shouldReconnect && !shouldReconnect()) return;
    if (state.retries >= MAX_RETRIES) {
      notify(`\r\n\x1b[31m[${t('app.terminal.notify-too-many-retries')}]\x1b[0m\r\n`);
      touch();
      return;
    }
    state.retries += 1;
    const delay = Math.min(MAX_DELAY_MS, BASE_DELAY_MS * 2 ** (state.retries - 1));
    notify(`\r\n\x1b[33m[${tf('app.terminal.notify-retrying', { v1: (delay / 1000).toFixed(1), v2: state.retries, v3: MAX_RETRIES })}]\x1b[0m\r\n`);
    cwdHint = state.cwd || cwd || '';
    retryTimer = setTimeout(connect, delay);
  }

  return {
    state,
    connect,
    reconnect() {
      state.retries = 0;
      connect();
    },
    send(text) {
      if (!ws || ws.readyState !== WebSocket.OPEN) return false;
      ws.send(JSON.stringify({ t: 'in', d: text }));
      return true;
    },
    resize(cols, rows) {
      if (!ws || ws.readyState !== WebSocket.OPEN) return;
      ws.send(JSON.stringify({ t: 'resize', c: cols, r: rows }));
    },
    setCwdHint(v) { cwdHint = v || ''; },
    dispose() {
      disposed = true;
      clearTimeout(retryTimer);
      retryTimer = null;
      if (ws) {
        try { ws.close(); } catch { }
        ws = null;
      }
    },
  };
}
