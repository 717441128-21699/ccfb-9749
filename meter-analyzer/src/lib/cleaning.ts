// 数据清洗：倍率校正 → 冻结识别 → 跳变识别 → 缺测补齐
// 全部为纯函数，输入 Float32Array，输出清洗结果与问题清单，可在 Worker / Node 中复用
import { SLOTS_PER_DAY } from './util.ts';
import type { QualityIssue } from '../types.ts';

export interface CleanConfig {
  freezeMinRun: number; // 连续恒定/近恒定多少个槽位判为冻结
  freezeEps: number; // 近恒定相对阈值
  jumpMadK: number; // 跳变判定的 MAD 倍数
  jumpRatio: number; // 跳变的绝对倍率阈值
  jumpWindow: number; // 单侧邻域窗口
  longGapSlots: number; // 超过该长度用典型曲线补齐
}

export const DEFAULT_CLEAN_CONFIG: CleanConfig = {
  freezeMinRun: 6,
  freezeEps: 0.01,
  jumpMadK: 6,
  jumpRatio: 3,
  jumpWindow: 4,
  longGapSlots: 24,
};

export interface CleanStats {
  gapSlots: number;
  gapRuns: number;
  freezeSlots: number;
  freezeRuns: number;
  jumpSlots: number;
  filledSlots: number;
  totalSlots: number;
  beforeEnergyKwh: number;
  afterEnergyKwh: number;
}

export interface CleanResult {
  cleaned: Float32Array; // 校正+清洗后的一次侧电量 Wh
  issues: QualityIssue[];
  stats: CleanStats;
}

/** 倍率校正：把表计二次侧登记值折算回一次侧（处理换表/倍率变化） */
export function correctRatio(reported: Float32Array, ratioByDay: Float32Array): Float32Array {
  const out = new Float32Array(reported.length);
  for (let d = 0; d < ratioByDay.length; d++) {
    const r = ratioByDay[d] || 1;
    const base = d * SLOTS_PER_DAY;
    for (let s = 0; s < SLOTS_PER_DAY; s++) {
      const v = reported[base + s];
      out[base + s] = isFinite(v) ? v * r : NaN;
    }
  }
  return out;
}

function markMissing(data: Float32Array, mask: Uint8Array, start: number, len: number): void {
  for (let i = start; i < start + len && i < data.length; i++) mask[i] = 1;
}

/** 计算每用户 96 点典型曲线（用于长缺测补齐），仅用有效点 */
function slotProfile(data: Float32Array, mask: Uint8Array, days: number): Float32Array {
  const prof = new Float32Array(SLOTS_PER_DAY);
  const cnt = new Float32Array(SLOTS_PER_DAY);
  for (let d = 0; d < days; d++) {
    for (let s = 0; s < SLOTS_PER_DAY; s++) {
      const i = d * SLOTS_PER_DAY + s;
      const v = data[i];
      if (isFinite(v) && !mask[i]) {
        prof[s] += v;
        cnt[s]++;
      }
    }
  }
  for (let s = 0; s < SLOTS_PER_DAY; s++) prof[s] = cnt[s] ? prof[s] / cnt[s] : 0;
  return prof;
}

/** 线性插值补齐一段缺失 */
function interpFill(data: Float32Array, start: number, len: number): void {
  const left = start - 1;
  const right = start + len;
  const lv = left >= 0 ? data[left] : NaN;
  const rv = right < data.length ? data[right] : NaN;
  if (isFinite(lv) && isFinite(rv)) {
    for (let k = 0; k < len; k++) data[start + k] = lv + ((rv - lv) * (k + 1)) / (len + 1);
  } else if (isFinite(lv)) {
    for (let k = 0; k < len; k++) data[start + k] = lv;
  } else if (isFinite(rv)) {
    for (let k = 0; k < len; k++) data[start + k] = rv;
  }
}

export function cleanSeries(
  userId: string,
  corrected: Float32Array,
  days: number,
  config: CleanConfig = DEFAULT_CLEAN_CONFIG,
): CleanResult {
  const n = corrected.length;
  const data = new Float32Array(corrected); // 工作副本
  const mask = new Uint8Array(n); // 1 = 判定为问题点，待补齐
  const issues: QualityIssue[] = [];

  let gapSlots = 0;
  let gapRuns = 0;
  let freezeSlots = 0;
  let freezeRuns = 0;
  let jumpSlots = 0;

  // 1) 既有缺测（NaN）统计
  for (let i = 0; i < n; ) {
    if (isNaN(data[i])) {
      let j = i;
      while (j < n && isNaN(data[j])) j++;
      const len = j - i;
      gapSlots += len;
      gapRuns++;
      markMissing(data, mask, i, len);
      issues.push({
        userId,
        kind: 'gap',
        startSlot: i,
        endSlot: j - 1,
        detail: `缺测 ${len} 个槽位（约 ${(len / 4).toFixed(1)} 小时）`,
      });
      i = j;
    } else i++;
  }

  // 2) 冻结识别：连续近恒定值（相邻差满足相对阈值）且长度达标，O(n) 游程扫描
  let runStart = 0;
  for (let i = 1; i <= n; i++) {
    const prev = data[i - 1];
    const cur = i < n ? data[i] : NaN;
    const sameRun =
      i < n &&
      isFinite(cur) &&
      isFinite(prev) &&
      !mask[i] &&
      !mask[i - 1] &&
      Math.abs(cur - prev) <= config.freezeEps * (1 + Math.abs(prev));
    if (!sameRun) {
      const len = i - runStart;
      if (len >= config.freezeMinRun && isFinite(data[runStart]) && !mask[runStart]) {
        freezeSlots += len;
        freezeRuns++;
        markMissing(data, mask, runStart, len);
        issues.push({
          userId,
          kind: 'freeze',
          startSlot: runStart,
          endSlot: i - 1,
          detail: `数值冻结 ${len} 个槽位，恒定为 ${data[runStart].toFixed(1)}Wh`,
        });
      }
      runStart = i;
    }
  }

  // 3) 跳变识别：流式邻域统计（无数组分配/排序），同时要求 MAD 倍数与绝对倍率
  const w = config.jumpWindow;
  for (let i = 0; i < n; i++) {
    const v = data[i];
    if (!isFinite(v) || mask[i]) continue;
    let sum = 0;
    let cnt = 0;
    const lo = Math.max(0, i - w);
    const hi = Math.min(n - 1, i + w);
    for (let k = lo; k <= hi; k++) {
      if (k === i) continue;
      const x = data[k];
      if (isFinite(x) && !mask[k]) {
        sum += x;
        cnt++;
      }
    }
    if (cnt < 4) continue;
    const mean = sum / cnt;
    let devSum = 0;
    for (let k = lo; k <= hi; k++) {
      if (k === i) continue;
      const x = data[k];
      if (isFinite(x) && !mask[k]) devSum += Math.abs(x - mean);
    }
    // 平均绝对偏差 ≈ 0.8 × MAD，作为稳健离散度
    const madLike = (devSum / cnt) / 0.8 || mean * 0.05 || 1;
    const ratio = mean > 0 ? v / mean : v > 0 ? Infinity : 1;
    if (
      Math.abs(v - mean) > config.jumpMadK * madLike &&
      (ratio >= config.jumpRatio || ratio <= 1 / config.jumpRatio)
    ) {
      mask[i] = 1;
      jumpSlots++;
      issues.push({
        userId,
        kind: 'jump',
        startSlot: i,
        endSlot: i,
        detail: `跳变点：${v.toFixed(1)}Wh，邻域均值 ${mean.toFixed(1)}Wh（${ratio >= 1 ? ratio.toFixed(1) + '倍尖峰' : '降至 ' + (ratio * 100).toFixed(0) + '%'}）`,
      });
    }
  }

  // 4) 补齐：先构造典型曲线，长缺测按同槽位典型值+邻近日缩放，短缺测线性插值
  const profile = slotProfile(data, mask, days);
  const profileDaySum = profile.reduce((a, b) => a + b, 0) || 1;
  let filledSlots = 0;
  for (let i = 0; i < n; ) {
    if (mask[i]) {
      let j = i;
      while (j < n && mask[j]) j++;
      const len = j - i;
      if (len <= config.longGapSlots) {
        interpFill(data, i, len);
      } else {
        // 邻近有效日的日均能量作为缩放
        let nearSum = 0;
        let nearCnt = 0;
        const dLo = Math.max(0, Math.floor(i / 96) - 7);
        const dHi = Math.min(days, Math.floor(i / 96) + 8);
        for (let d = dLo; d < dHi; d++) {
          let daySum = 0;
          let ok = true;
          const db = d * 96;
          for (let s = 0; s < 96; s++) {
            const x = data[db + s];
            if (!isFinite(x) || mask[db + s]) {
              ok = false;
              break;
            }
            daySum += x;
          }
          if (ok) {
            nearSum += daySum;
            nearCnt++;
          }
        }
        const scale = nearCnt ? nearSum / nearCnt / profileDaySum : 1;
        for (let k = 0; k < len; k++) {
          data[i + k] = profile[(i + k) % SLOTS_PER_DAY] * scale;
        }
      }
      filledSlots += len;
      i = j;
    } else i++;
  }

  // 兜底：任何残余 NaN 用典型曲线填
  for (let i = 0; i < n; i++) {
    if (isNaN(data[i])) {
      data[i] = profile[i % SLOTS_PER_DAY] || 0;
      filledSlots++;
    }
  }

  let beforeEnergy = 0;
  let afterEnergy = 0;
  for (let i = 0; i < n; i++) {
    if (isFinite(corrected[i])) beforeEnergy += corrected[i];
    afterEnergy += data[i];
  }

  return {
    cleaned: data,
    issues,
    stats: {
      gapSlots,
      gapRuns,
      freezeSlots,
      freezeRuns,
      jumpSlots,
      filledSlots,
      totalSlots: n,
      beforeEnergyKwh: beforeEnergy / 1000,
      afterEnergyKwh: afterEnergy / 1000,
    },
  };
}
