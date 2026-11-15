// 单户 15 分钟曲线合成：真实用电 truth + 表计上报 reported（含倍率、窃电、质量问题）
import type { TheftLabel, UserProfile } from '../types.ts';
import { SLOTS_PER_DAY } from './util.ts';
import { gaussian, rngFor } from './rng.ts';
import type { QualityPlan } from './generateMeta.ts';

export interface UserShapeParams {
  shapeWeekday: Float32Array; // 96 点权重，和为 1
  shapeWeekend: Float32Array;
  baseDailyKwh: number; // 典型日用电量
  summerAmp: number; // 夏季降温负荷增幅
  winterAmp: number; // 冬季采暖负荷增幅
  weekendFactor: number;
  noiseSigma: number;
  shiftPattern: number;
}

function gaussianPeak(center: number, sigma: number): Float32Array {
  const w = new Float32Array(SLOTS_PER_DAY);
  for (let s = 0; s < SLOTS_PER_DAY; s++) {
    const d = Math.min(Math.abs(s - center), SLOTS_PER_DAY - Math.abs(s - center));
    w[s] = Math.exp(-(d * d) / (2 * sigma * sigma));
  }
  return w;
}

function normalize(weights: Float32Array): Float32Array {
  let sum = 0;
  for (let i = 0; i < weights.length; i++) sum += weights[i];
  for (let i = 0; i < weights.length; i++) weights[i] /= sum;
  return weights;
}

export function buildUserShape(profile: UserProfile): UserShapeParams {
  const rng = rngFor('shape:' + profile.userId);
  const wd = new Float32Array(SLOTS_PER_DAY);
  const we = new Float32Array(SLOTS_PER_DAY);
  let baseDailyKwh: number;
  let summerAmp: number;
  let winterAmp: number;
  let weekendFactor: number;
  const noiseSigma = 0.06 + rng() * 0.06;

  if (profile.userType === '居民') {
    baseDailyKwh = 8 + rng() * 17;
    summerAmp = 0.25 + rng() * 0.45;
    winterAmp = 0.1 + rng() * 0.3;
    weekendFactor = 1.1 + rng() * 0.25;
    const morning = gaussianPeak(28 + Math.floor(rng() * 6), 2.2);
    const evening = gaussianPeak(76 + Math.floor(rng() * 8), 3.0);
    const lunch = gaussianPeak(48, 2.5);
    for (let s = 0; s < 96; s++) {
      wd[s] = 0.42 + morning[s] * 0.7 + evening[s] * 1.3 + lunch[s] * 0.25;
      we[s] = 0.5 + morning[s] * 0.25 + evening[s] * 1.4 + lunch[s] * 0.35;
    }
  } else if (profile.userType === '商业') {
    baseDailyKwh = 40 + rng() * 260;
    summerAmp = 0.2 + rng() * 0.35;
    winterAmp = 0.05 + rng() * 0.15;
    weekendFactor = rng() < 0.5 ? 1.1 + rng() * 0.3 : 0.55 + rng() * 0.3;
    const openAt = 32 + Math.floor(rng() * 8); // 8-10 点
    const closeAt = 84 + Math.floor(rng() * 8); // 21-23 点
    const noon = gaussianPeak(48, 3);
    for (let s = 0; s < 96; s++) {
      const active = s >= openAt && s <= closeAt ? 1 : 0;
      wd[s] = 0.08 + active * (0.75 + noon[s] * 0.5);
      we[s] = 0.1 + active * (0.85 + noon[s] * 0.6);
    }
  } else {
    const pattern = Math.floor(rng() * 3);
    baseDailyKwh = 200 + rng() * 1800;
    summerAmp = 0.1 + rng() * 0.3;
    winterAmp = 0.05 + rng() * 0.2;
    weekendFactor = pattern === 0 ? 0.9 + rng() * 0.15 : 0.35 + rng() * 0.4;
    for (let s = 0; s < 96; s++) {
      if (pattern === 0) {
        wd[s] = 0.85 + 0.15 * Math.sin((s / 96) * Math.PI * 2); // 三班连续
      } else if (pattern === 1) {
        wd[s] = s >= 32 && s <= 72 ? 1 : 0.12; // 长白班
      } else {
        wd[s] = s >= 28 && s <= 88 ? 1 : 0.2; // 两班倒
      }
      we[s] = wd[s] * (pattern === 0 ? 0.95 : weekendFactor);
    }
    return {
      shapeWeekday: normalize(wd),
      shapeWeekend: normalize(we),
      baseDailyKwh,
      summerAmp,
      winterAmp,
      weekendFactor,
      noiseSigma,
      shiftPattern: pattern,
    };
  }

  return {
    shapeWeekday: normalize(wd),
    shapeWeekend: normalize(we),
    baseDailyKwh,
    summerAmp,
    winterAmp,
    weekendFactor,
    noiseSigma,
    shiftPattern: 0,
  };
}

/** 年度季节调制：夏季降温（年中）+ 冬季采暖（年初年末） */
function annualMod(day: number, days: number, summerAmp: number, winterAmp: number): number {
  const summerCenter = days * 0.57;
  const summer = summerAmp * Math.exp(-((day - summerCenter) ** 2) / (2 * 32 ** 2));
  const winterDist = Math.min(day, days - day);
  const winter = winterAmp * Math.exp(-(winterDist ** 2) / (2 * 22 ** 2));
  return 1 + summer + winter;
}

/** 计算某天某槽位的窃电少计比例 0~1 */
function theftFactorAt(
  label: TheftLabel | undefined,
  startDay: number,
  day: number,
  slot: number,
  rng: () => number,
): number {
  if (!label || day < startDay) return 0;
  const t = day - startDay;
  switch (label.mode) {
    case 'constant_shunt':
      return label.strength;
    case 'night_bypass':
      // 20:00 (slot 80) 到次日 07:00 (slot 28)
      return slot >= 80 || slot <= 28 ? label.strength : 0;
    case 'intermittent':
      return rng() < 0.35 ? label.strength : 0;
    case 'phase_drop': {
      // 每 10~14 天出现持续 3~7 天的缺相段
      const cycle = 12;
      const phase = t % cycle;
      return phase < 5 ? label.strength : 0;
    }
    case 'tamper_evolve': {
      const horizon = 120;
      const grow = Math.min(1, t / horizon);
      return Math.max(0.08, label.strength * grow);
    }
    default:
      return 0;
  }
}

export interface SeriesGenOptions {
  days: number;
  startDate: string;
  ratios: Float32Array; // 该用户按天倍率
  label?: TheftLabel;
  quality?: QualityPlan;
}

export function generateUserSeries(profile: UserProfile, opts: SeriesGenOptions): {
  reported: Float32Array;
  truth: Float32Array;
} {
  const { days, ratios, label, quality } = opts;
  const n = days * SLOTS_PER_DAY;
  const truth = new Float32Array(n);
  const reported = new Float32Array(n);
  const shape = buildUserShape(profile);
  const rng = rngFor('series:' + profile.userId);
  const startDay = label ? dayIndexFrom(label.startDate, opts.startDate) : -1;

  // 天气级 AR(1) 波动
  let weather = 0;
  const freezeSet = new Set(quality?.freezeDays ?? []);
  // 跳变因子展平为按槽位数组（热循环里避免 Map 查找）
  const jumpFactor = new Float32Array(n);
  for (const j of quality?.jumps ?? []) jumpFactor[j.day * 96 + j.slot] = j.factor;
  const hasLabel = !!label;
  const noiseSigma = shape.noiseSigma;

  for (let day = 0; day < days; day++) {
    weather = weather * 0.55 + gaussian(rng) * 0.45;
    const dow = dayOfWeek(opts.startDate, day);
    const isWeekend = dow === 0 || dow === 6;
    const dayShape = isWeekend ? shape.shapeWeekend : shape.shapeWeekday;
    const season = annualMod(day, days, shape.summerAmp, shape.winterAmp);
    const dailyWh =
      shape.baseDailyKwh *
      1000 *
      season *
      (isWeekend ? shape.weekendFactor : 1) *
      (1 + weather * 0.12) *
      (1 + gaussian(rng) * 0.05);
    const base = day * 96;
    const ratio = ratios[day];
    const invRatio = 1 / ratio;

    if (!hasLabel) {
      // 快路径：无窃电标签，省掉每槽位函数调用与分支
      for (let slot = 0; slot < 96; slot++) {
        const idx = base + slot;
        // 轻量对数正态近似：两次均匀分布之和（Irwin-Hall）替代 Box-Muller
        const z = rng() + rng() - 1;
        const actualWh = dailyWh * dayShape[slot] * Math.exp(z * noiseSigma * 1.73);
        truth[idx] = actualWh;
        const jf = jumpFactor[idx];
        reported[idx] = (jf ? actualWh * jf : actualWh) * invRatio;
      }
    } else {
      for (let slot = 0; slot < 96; slot++) {
        const idx = base + slot;
        const z = rng() + rng() - 1;
        const actualWh = dailyWh * dayShape[slot] * Math.exp(z * noiseSigma * 1.73);
        truth[idx] = actualWh;
        const tf = theftFactorAt(label, startDay, day, slot, rng);
        let reg = actualWh * (1 - tf) * invRatio;
        const jf = jumpFactor[idx];
        if (jf) reg *= jf;
        reported[idx] = reg;
      }
    }

    // 冻结：整天上报值恒定（取当天真实首点折算）
    if (freezeSet.has(day)) {
      const frozen = truth[base] * invRatio * 0.6;
      reported.fill(frozen, base, base + 96);
    }
  }

  // 缺测置 NaN（最后处理，覆盖冻结/跳变）
  for (const g of quality?.gaps ?? []) {
    const base = g.day * 96 + g.startSlot;
    for (let i = 0; i < g.len && base + i < n; i++) reported[base + i] = NaN;
  }

  return { reported, truth };
}

function dayIndexFrom(dateStr: string, startDate: string): number {
  const a = new Date(startDate + 'T00:00:00Z').getTime();
  const b = new Date(dateStr + 'T00:00:00Z').getTime();
  return Math.round((b - a) / 86400000);
}

function dayOfWeek(startDate: string, day: number): number {
  const d = new Date(startDate + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() + day);
  return d.getUTCDay();
}
