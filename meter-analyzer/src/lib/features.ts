// 特征工程：日电量聚合、归一化典型曲线、负荷突降/突变点特征
import { SLOTS_PER_DAY } from './util.ts';

export interface UserFeatures {
  userId: string;
  dailyKwh: Float32Array; // 每日电量（清洗后）
  curve: Float32Array; // 96 点归一化典型曲线（L1 归一）
  totalEnergyKwh: number;
  avgDailyKwh: number;
  validDayCount: number;
  dropRate: number; // 后半年日均/前半年日均 - 1
  changepointZ: number; // 年内最大突变强度（z 分数）
  changepointDay: number;
}

export function buildFeatures(userId: string, cleaned: Float32Array, days: number): UserFeatures {
  const dailyKwh = new Float32Array(days);
  const curveSum = new Float32Array(SLOTS_PER_DAY);
  const dayCount = new Float32Array(SLOTS_PER_DAY);
  let total = 0;
  let validDays = 0;

  for (let d = 0; d < days; d++) {
    let daySum = 0;
    let ok = true;
    for (let s = 0; s < SLOTS_PER_DAY; s++) {
      const v = cleaned[d * SLOTS_PER_DAY + s];
      if (!isFinite(v)) {
        ok = false;
        continue;
      }
      daySum += v;
      curveSum[s] += v;
      dayCount[s]++;
    }
    if (ok) {
      validDays++;
      const kwh = daySum / 1000;
      dailyKwh[d] = kwh;
      total += kwh;
    } else {
      dailyKwh[d] = NaN;
    }
  }

  const curve = new Float32Array(SLOTS_PER_DAY);
  let curveTotal = 0;
  for (let s = 0; s < SLOTS_PER_DAY; s++) {
    curve[s] = dayCount[s] ? curveSum[s] / dayCount[s] : 0;
    curveTotal += curve[s];
  }
  if (curveTotal > 0) {
    for (let s = 0; s < SLOTS_PER_DAY; s++) curve[s] /= curveTotal;
  }

  // 前后半年对比（消除季节性：分别取前 1/3 与后 1/3，避开夏季峰值居中影响较小）
  const third = Math.max(1, Math.floor(days / 3));
  const early = meanOf(dailyKwh, 0, third);
  const late = meanOf(dailyKwh, days - third, days);
  const dropRate = early > 0 ? late / early - 1 : 0;

  // 突变点：30 天滚动窗口两侧均值差，取最大 z 分数
  const win = 30;
  let bestZ = 0;
  let bestDay = -1;
  const values: number[] = [];
  for (let d = 0; d < days; d++) if (isFinite(dailyKwh[d])) values.push(dailyKwh[d]);
  const globalMean = values.reduce((a, b) => a + b, 0) / (values.length || 1);
  const globalStd =
    Math.sqrt(values.reduce((a, b) => a + (b - globalMean) ** 2, 0) / (values.length || 1)) || 1;

  for (let d = win; d < days - win; d++) {
    const a = meanOf(dailyKwh, d - win, d);
    const b = meanOf(dailyKwh, d, d + win);
    if (!isFinite(a) || !isFinite(b)) continue;
    const z = Math.abs(b - a) / globalStd;
    if (z > bestZ) {
      bestZ = z;
      bestDay = d;
    }
  }

  return {
    userId,
    dailyKwh,
    curve,
    totalEnergyKwh: total,
    avgDailyKwh: validDays ? total / validDays : 0,
    validDayCount: validDays,
    dropRate,
    changepointZ: bestZ,
    changepointDay: bestDay,
  };
}

function meanOf(arr: Float32Array, lo: number, hi: number): number {
  let s = 0;
  let n = 0;
  for (let i = lo; i < hi; i++) {
    if (isFinite(arr[i])) {
      s += arr[i];
      n++;
    }
  }
  return n ? s / n : NaN;
}

/** 两条归一化曲线的 L1 距离（0~2） */
export function curveDistance(a: Float32Array, b: Float32Array): number {
  let d = 0;
  for (let i = 0; i < a.length; i++) d += Math.abs(a[i] - b[i]);
  return d;
}

export interface PeerFeatures {
  /** 后 1/3 相对水平 / 前 1/3 相对水平 - 1（负值=相对同类持续走低，窃电核心信号） */
  peerShift: number;
  /** 相对轨迹上的最大突变 z 强度（稳健 MAD 归一） */
  peerChangeZ: number;
  /** 突变发生日 */
  peerChangeDay: number;
  /** 后期/前期相对水平波动比（间歇性窃电会显著升高） */
  cvRatio: number;
  /** 后期处于同簇最低 10% 分位以下的天数占比（正常用户≈10%，间歇/缺相窃电显著偏高） */
  lowTailRatio: number;
  /** 后 1/3 相对轨迹低于自身前期基线 15% 以上的天数占比（温和持续窃电信号） */
  persistentWeak: number;
}

/**
 * 构造每用户相对同簇 peers 的电量轨迹，消除季节/天气等共性扰动。
 * r[d] = 用户日电量 / 同簇当日中位电量，再做 7 天滚动平滑。
 */
export function buildPeerFeatures(
  features: UserFeatures[],
  clusterIds: Uint16Array | number[],
  days: number,
): PeerFeatures[] {
  const n = features.length;
  let k = 0;
  for (let i = 0; i < clusterIds.length; i++) k = Math.max(k, clusterIds[i] + 1);
  const members: number[][] = Array.from({ length: k }, () => []);
  for (let i = 0; i < n; i++) members[clusterIds[i]].push(i);

  // clusterMedian[c*days + d]
  const clusterMedian = new Float64Array(k * days);
  const scratch: number[] = [];
  for (let c = 0; c < k; c++) {
    const ids = members[c];
    if (!ids.length) continue;
    const buf = new Float64Array(ids.length);
    for (let d = 0; d < days; d++) {
      let len = 0;
      for (const i of ids) {
        const v = features[i].dailyKwh[d];
        if (isFinite(v) && v > 0) buf[len++] = v;
      }
      if (len === 0) {
        clusterMedian[c * days + d] = NaN;
        continue;
      }
      scratch.length = 0;
      for (let j = 0; j < len; j++) scratch.push(buf[j]);
      scratch.sort((a, b) => a - b);
      clusterMedian[c * days + d] = scratch[len >> 1];
    }
  }

  const out: PeerFeatures[] = new Array(n);
  const win = 30;
  const smooth = 7;
  const third = Math.max(1, Math.floor(days / 3));

  // 每个簇后期窗口的 10% 分位阈值（对成员抽样计算，控制 5 万户规模开销）
  const tailThreshold = new Float64Array(k);
  for (let c = 0; c < k; c++) {
    const ids = members[c];
    const sample = ids.length > 800 ? sampleIds(ids, 800, c) : ids;
    const pooled: number[] = [];
    for (const i of sample) {
      const daily = features[i].dailyKwh;
      for (let d = days - third; d < days; d++) {
        const med = clusterMedian[c * days + d];
        const v = daily[d];
        if (isFinite(v) && isFinite(med) && med > 0) pooled.push(v / med);
      }
    }
    pooled.sort((a, b) => a - b);
    tailThreshold[c] = pooled.length ? pooled[Math.floor(pooled.length * 0.1)] : 0;
  }

  for (let i = 0; i < n; i++) {
    const c = clusterIds[i];
    const daily = features[i].dailyKwh;
    const r = new Float64Array(days);
    for (let d = 0; d < days; d++) {
      const med = clusterMedian[c * days + d];
      const v = daily[d];
      r[d] = isFinite(v) && isFinite(med) && med > 0 ? v / med : NaN;
    }
    // 7 天滚动均值
    const rs = new Float64Array(days);
    let sum = 0;
    let cnt = 0;
    for (let d = 0; d < days; d++) {
      if (isFinite(r[d])) {
        sum += r[d];
        cnt++;
      }
      if (d >= smooth && isFinite(r[d - smooth])) {
        sum -= r[d - smooth];
        cnt--;
      }
      rs[d] = cnt ? sum / cnt : NaN;
    }

    const early = windowMean(rs, 0, third);
    const late = windowMean(rs, days - third, days);
    const peerShift = early > 0 ? late / early - 1 : 0;

    // 最大突变：前后 30 天窗口均值差，噪声尺度用一阶差分的 MAD
    const diffs: number[] = [];
    for (let d = 1; d < days; d++) {
      if (isFinite(rs[d]) && isFinite(rs[d - 1])) diffs.push(rs[d] - rs[d - 1]);
    }
    diffs.sort((a, b) => Math.abs(a) - Math.abs(b));
    const mad = diffs.length ? Math.abs(diffs[diffs.length >> 1]) * 1.4826 : 0;
    const scale = mad || 0.02;
    let bestZ = 0;
    let bestDay = -1;
    for (let d = win; d < days - win; d++) {
      const a = windowMean(rs, d - win, d);
      const b = windowMean(rs, d, d + win);
      if (!isFinite(a) || !isFinite(b)) continue;
      const z = (a - b) / scale; // 下行突变为正
      if (z > bestZ) {
        bestZ = z;
        bestDay = d;
      }
    }

    const cvEarly = cvOf(rs, 0, third);
    const cvLate = cvOf(rs, days - third, days);
    const cvRatio = cvEarly > 0 ? cvLate / cvEarly : 1;

    // 低尾占比：后期相对水平低于簇内 10% 分位阈值的天数比例
    let tailHits = 0;
    let tailTotal = 0;
    const thr = tailThreshold[c];
    for (let d = days - third; d < days; d++) {
      if (!isFinite(r[d])) continue;
      tailTotal++;
      if (thr > 0 && r[d] <= thr) tailHits++;
    }
    const lowTailRatio = tailTotal ? tailHits / tailTotal : 0;

    // 持续偏低：以自身前 1/3 的相对水平为基线，后期低于基线 15% 的天数占比
    const base = windowMean(rs, 0, third);
    let weakHits = 0;
    let weakTotal = 0;
    if (isFinite(base) && base > 0) {
      for (let d = days - third; d < days; d++) {
        if (!isFinite(rs[d])) continue;
        weakTotal++;
        if (rs[d] < base * 0.85) weakHits++;
      }
    }
    const persistentWeak = weakTotal ? weakHits / weakTotal : 0;

    out[i] = {
      peerShift,
      peerChangeZ: bestZ,
      peerChangeDay: bestDay,
      cvRatio,
      lowTailRatio,
      persistentWeak,
    };
  }
  return out;
}

function sampleIds(ids: number[], size: number, seedKey: number): number[] {
  // 确定性等距抽样（避免随机数依赖，保持结果可复现）
  const step = ids.length / size;
  const out: number[] = [];
  let acc = (seedKey * 7) % 1;
  for (let i = 0; i < ids.length && out.length < size; i++) {
    acc += step;
    if (acc >= 1) {
      acc -= 1;
      out.push(ids[i]);
    }
  }
  return out;
}

function windowMean(a: Float64Array, lo: number, hi: number): number {
  let s = 0;
  let n = 0;
  for (let i = lo; i < hi; i++) {
    if (isFinite(a[i])) {
      s += a[i];
      n++;
    }
  }
  return n ? s / n : NaN;
}

function cvOf(a: Float64Array, lo: number, hi: number): number {
  const vals: number[] = [];
  for (let i = lo; i < hi; i++) if (isFinite(a[i])) vals.push(a[i]);
  if (vals.length < 5) return 0;
  const m = vals.reduce((x, y) => x + y, 0) / vals.length;
  if (m <= 0) return 0;
  const v = vals.reduce((x, y) => x + (y - m) ** 2, 0) / vals.length;
  return Math.sqrt(v) / m;
}
