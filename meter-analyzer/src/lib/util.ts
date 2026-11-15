// 全局常量与通用工具

export const SLOTS_PER_DAY = 96; // 15 分钟一个点
export const DEFAULT_DAYS = 365;
export const DEFAULT_BLOCK_SIZE = 1000;

export const USER_TYPES = ['居民', '商业', '工业'] as const;

export const THEFT_MODES = [
  { value: 'constant_shunt', label: '恒定分流' },
  { value: 'night_bypass', label: '夜间旁路' },
  { value: 'intermittent', label: '间歇性窃电' },
  { value: 'phase_drop', label: '缺相运行' },
  { value: 'tamper_evolve', label: '渐进改表' },
] as const;

export const THEFT_MODE_LABEL: Record<string, string> = Object.fromEntries(
  THEFT_MODES.map((m) => [m.value, m.label]),
);

export function slotToTimeLabel(slot: number): string {
  const s = ((slot % SLOTS_PER_DAY) + SLOTS_PER_DAY) % SLOTS_PER_DAY;
  const h = Math.floor(s / 4);
  const m = (s % 4) * 15;
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
}

export function addDays(dateStr: string, days: number): string {
  const d = new Date(dateStr + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

export function dayIndexOf(dateStr: string, startDate: string): number {
  const a = new Date(startDate + 'T00:00:00Z').getTime();
  const b = new Date(dateStr + 'T00:00:00Z').getTime();
  return Math.round((b - a) / 86400000);
}

export function formatKwh(v: number): string {
  if (!isFinite(v)) return '-';
  if (Math.abs(v) >= 10000) return (v / 1000).toFixed(1) + ' 万kWh';
  if (Math.abs(v) >= 100) return v.toFixed(0) + ' kWh';
  return v.toFixed(1) + ' kWh';
}

export function formatNum(v: number, digits = 2): string {
  if (v === undefined || v === null || !isFinite(v)) return '-';
  return v.toFixed(digits);
}

export function pct(v: number, digits = 1): string {
  if (!isFinite(v)) return '-';
  return (v * 100).toFixed(digits) + '%';
}

export function clamp(v: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, v));
}

export function mean(arr: ArrayLike<number>): number {
  let s = 0;
  let n = 0;
  for (let i = 0; i < arr.length; i++) {
    const v = arr[i];
    if (isFinite(v)) {
      s += v;
      n++;
    }
  }
  return n ? s / n : NaN;
}

export function median(sorted: number[]): number {
  if (!sorted.length) return NaN;
  const mid = sorted.length >> 1;
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

export function quantile(sortedAsc: number[], q: number): number {
  if (!sortedAsc.length) return NaN;
  const pos = (sortedAsc.length - 1) * q;
  const base = Math.floor(pos);
  const rest = pos - base;
  if (base + 1 < sortedAsc.length) {
    return sortedAsc[base] * (1 - rest) + sortedAsc[base + 1] * rest;
  }
  return sortedAsc[base];
}

/** 百分位排名映射：把原始值数组映射为 0~100 的相对位次分（越大越可疑） */
export function percentileRankScores(values: Float32Array | number[]): Float32Array {
  const n = values.length;
  const idx = Array.from({ length: n }, (_, i) => i).filter((i) => isFinite(values[i]));
  idx.sort((a, b) => values[a] - values[b]);
  const out = new Float32Array(n);
  // 同分取平均名次
  let i = 0;
  while (i < idx.length) {
    let j = i + 1;
    while (j < idx.length && values[idx[j]] === values[idx[i]]) j++;
    const avgRank = (i + j - 1) / 2;
    const score = n > 1 ? (avgRank / (idx.length - 1)) * 100 : 50;
    for (let k = i; k < j; k++) out[idx[k]] = score;
    i = j;
  }
  return out;
}

export function downloadBlob(filename: string, content: string | Blob, mime = 'text/csv;charset=utf-8'): void {
  const blob = typeof content === 'string' ? new Blob(['﻿' + content], { type: mime }) : content;
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 5000);
}
