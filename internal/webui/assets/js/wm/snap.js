/**
 * wm/snap.js —— 窗口拖拽贴边交互
 * 要点：拖动窗口时探测边缘区域并显示预览，松手后回传区域，由窗口执行贴边或最大化。
 */
import { dom } from '../core/vdom.js';

const SNAP_PAD = 12;

/** 贴边控制器：负责拖拽中的区域探测、预览显示与吸附判定 */
export class Snap {
  constructor(manager) {
    this.manager = manager;
    this.previewEl = null;
    this.currentZone = null;
    this._vw = 0;
    this._vh = 0;
    this._left = 0;
    this._top = 0;
  }

  onDragStart(win) {
    this.currentZone = null;
    const vp = this.manager.viewport();
    this._vw = vp.width;
    this._vh = vp.height;
    this._left = vp.left;
    this._top = vp.top;
  }

  onDragMove(win, cx, cy) {
    const zone = this._detectZone(cx, cy);
    if (zone !== this.currentZone) {
      this.currentZone = zone;
      if (zone) this._showPreview(zone);
      else this._hidePreview();
    }
  }

  onDragEnd(win, cx, cy) {
    const zone = this._detectZone(cx, cy);
    this._hidePreview();
    this.currentZone = null;
    if (zone) win.snapTo(zone);
  }

  _detectZone(cx, cy) {
    const vw = this._vw || this.manager.viewport().width;
    const vh = this._vh || this.manager.viewport().height;
    const localX = cx - this._left;
    const localY = cy - this._top;
    if (vw < 768) return 'max';
    if (localY <= SNAP_PAD) return 'max';
    if (localX <= SNAP_PAD) return 'left';
    if (localX >= vw - SNAP_PAD) return 'right';
    return null;
  }

  _rectForZone(zone) {
    return this.manager.snapRect(zone);
  }

  _showPreview(zone) {
    if (!this.previewEl) {
      this.previewEl = dom('div', { class: 'qx-snap-preview' });
      document.body.append(this.previewEl);
    }
    const rect = this._rectForZone(zone);
    const vp = this.manager.viewport();
    this.previewEl.style.display = 'block';
    this.previewEl.style.left = `${rect.x + vp.left}px`;
    this.previewEl.style.top = `${rect.y + vp.top}px`;
    this.previewEl.style.width = `${rect.width}px`;
    this.previewEl.style.height = `${rect.height}px`;
  }

  _hidePreview() {
    if (this.previewEl) this.previewEl.style.display = 'none';
  }
}
