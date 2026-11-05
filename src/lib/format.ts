// 展示格式化工具

/** 距离:米 -> “850 米” / “12.4 公里” */
export function formatDistance(m: number): string {
  if (!Number.isFinite(m)) return '--';
  if (Math.abs(m) < 1000) return `${Math.round(m)} 米`;
  return `${(m / 1000).toFixed(m < 10_000 ? 2 : 1)} 公里`;
}

/** 时长:秒 -> “1:23:45” / “12:34” */
export function formatDuration(s: number): string {
  if (!Number.isFinite(s) || s < 0) return '--';
  const total = Math.round(s);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const sec = total % 60;
  const mm = String(m).padStart(2, '0');
  const ss = String(sec).padStart(2, '0');
  return h > 0 ? `${h}:${mm}:${ss}` : `${m}:${ss}`;
}

/** 坐标格式化 */
export function formatCoord(v: number): string {
  return Number.isFinite(v) ? v.toFixed(6) : '--';
}

export function formatSpeed(kmh: number): string {
  if (!Number.isFinite(kmh)) return '--';
  return kmh >= 100 ? kmh.toFixed(0) : kmh.toFixed(1);
}

/** UDID 缩写显示 */
export function shortUdid(udid: string): string {
  if (udid.length <= 16) return udid;
  return `${udid.slice(0, 8)}…${udid.slice(-6)}`;
}
