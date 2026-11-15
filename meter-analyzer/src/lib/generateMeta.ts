// 测试数据生成：用户档案、台区、换表/倍率事件、窃电标签（确定性可复现）
import type { MeterEvent, TheftLabel, TheftMode, UserProfile, UserType } from '../types.ts';
import { DEFAULT_DAYS } from './util.ts';
import { rngFor, weightedPick } from './rng.ts';

export interface GenerationSpec {
  userCount: number;
  days: number;
  startDate: string; // YYYY-MM-DD
  taCount: number;
  /** 窃电用户占比，默认 4% */
  theftRatio?: number;
  /** 注入数据质量问题的用户占比 */
  qualityIssueRatio?: number;
  /** 发生换表/倍率变化事件的用户占比 */
  meterEventRatio?: number;
  seed?: string;
}

export interface GeneratedMeta {
  profiles: UserProfile[];
  events: MeterEvent[];
  labels: TheftLabel[];
  /** 每用户的"真实"倍率轨迹（按天），用于曲线生成与换表处理验证 */
  ratioByDay: Map<string, Float32Array>;
  /** 每用户注入质量问题的配置（供 series 生成器使用） */
  qualityPlan: Map<string, QualityPlan>;
}

export interface QualityPlan {
  gaps: { day: number; startSlot: number; len: number }[];
  freezeDays: number[]; // 整天冻结
  jumps: { day: number; slot: number; factor: number }[];
}

const TYPE_WEIGHTS: { value: UserType; weight: number }[] = [
  { value: '居民', weight: 72 },
  { value: '商业', weight: 18 },
  { value: '工业', weight: 10 },
];

const THEFT_MODE_WEIGHTS: { value: TheftMode; weight: number }[] = [
  { value: 'constant_shunt', weight: 22 },
  { value: 'night_bypass', weight: 20 },
  { value: 'intermittent', weight: 20 },
  { value: 'phase_drop', weight: 18 },
  { value: 'tamper_evolve', weight: 20 },
];

function padId(prefix: string, n: number, width: number): string {
  return prefix + String(n).padStart(width, '0');
}

export function generateMeta(spec: GenerationSpec): GeneratedMeta {
  const {
    userCount,
    days = DEFAULT_DAYS,
    startDate,
    taCount,
    theftRatio = 0.04,
    qualityIssueRatio = 0.18,
    meterEventRatio = 0.12,
    seed = 'meter-2026',
  } = spec;

  const rng = rngFor(seed + ':meta');
  const profiles: UserProfile[] = [];
  const events: MeterEvent[] = [];
  const labels: TheftLabel[] = [];
  const ratioByDay = new Map<string, Float32Array>();
  const qualityPlan = new Map<string, QualityPlan>();

  // 每个台区的用户编号范围，保证台区规模不均（模拟真实）
  const taSizes = new Array(taCount).fill(0);
  for (let i = 0; i < userCount; i++) taSizes[Math.floor(rng() * taCount)]++;

  let uid = 0;
  for (let ta = 0; ta < taCount; ta++) {
    for (let k = 0; k < taSizes[ta]; k++) {
      uid++;
      const userType = weightedPick(rng, TYPE_WEIGHTS);
      const capacity =
        userType === '居民'
          ? 8 + Math.floor(rng() * 8)
          : userType === '商业'
            ? 50 + Math.floor(rng() * 200)
            : 160 + Math.floor(rng() * 840);
      const profile: UserProfile = {
        userId: padId('U', uid, 6),
        meterId: padId('M', uid, 6),
        taId: padId('TA', ta + 1, 3),
        userType,
        capacityKva: capacity,
        installDate: startDate,
      };
      profiles.push(profile);

      // 倍率轨迹：默认 1，部分用户带倍率（工商业），并在年中发生事件
      const baseRatio =
        userType === '工业'
          ? [30, 50, 80, 100, 150][Math.floor(rng() * 5)]
          : userType === '商业'
            ? [1, 5, 10, 15, 20][Math.floor(rng() * 5)]
            : 1;
      const ratios = new Float32Array(days).fill(baseRatio);
      ratioByDay.set(profile.userId, ratios);

      if (rng() < meterEventRatio) {
        const eventDay = 60 + Math.floor(rng() * (days - 120));
        const isReplace = rng() < 0.5;
        const newRatio = isReplace
          ? baseRatio // 换表倍率不变（同规格）
          : Math.max(1, Math.round(baseRatio * (rng() < 0.5 ? 2 : 0.5)));
        const evDate = dateAfter(startDate, eventDay);
        events.push({
          meterId: profile.meterId,
          eventType: isReplace ? '换表' : '倍率变化',
          effectiveDate: evDate,
          oldRatio: baseRatio,
          newRatio,
          note: isReplace ? '周期轮换/故障换表' : 'CT变比调整',
        });
        for (let d = eventDay; d < days; d++) ratios[d] = newRatio;
        // 换表当天留一小段缺测（换表停电）
        if (isReplace) {
          const plan = ensurePlan(qualityPlan, profile.userId);
          plan.gaps.push({ day: eventDay, startSlot: 40 + Math.floor(rng() * 8), len: 4 + Math.floor(rng() * 6) });
        }
      }
    }
  }

  // 窃电标签：在全部用户中随机抽取，但保证 5 种模式都有足够样本
  const theftCount = Math.max(THEFT_MODE_WEIGHTS.length * 4, Math.round(userCount * theftRatio));
  const chosen = new Set<number>();
  while (chosen.size < theftCount) chosen.add(1 + Math.floor(rng() * userCount));
  let modeIdx = 0;
  for (const u of chosen) {
    const profile = profiles[u - 1];
    // 前 5*N 个轮流指定模式保证覆盖，其余按权重随机
    const mode =
      modeIdx < THEFT_MODE_WEIGHTS.length * 4
        ? THEFT_MODE_WEIGHTS[modeIdx % THEFT_MODE_WEIGHTS.length].value
        : weightedPick(rng, THEFT_MODE_WEIGHTS);
    modeIdx++;
    const startDay = 30 + Math.floor(rng() * 150); // 第 30~180 天开始
    const strength = 0.25 + rng() * 0.45; // 少计 25%~70%
    labels.push({
      userId: profile.userId,
      mode,
      startDate: dateAfter(startDate, startDay),
      strength: Math.round(strength * 100) / 100,
    });
  }

  // 数据质量问题注入计划（与窃电标签独立，部分窃电户也可能有质量问题）
  const qCount = Math.round(userCount * qualityIssueRatio);
  for (let i = 0; i < qCount; i++) {
    const idx = Math.floor(rng() * userCount);
    const profile = profiles[idx];
    const plan = ensurePlan(qualityPlan, profile.userId);
    const issueKind = rng();
    if (issueKind < 0.4) {
      // 缺测：1~3 段，每段 2~24 个槽位
      const segs = 1 + Math.floor(rng() * 3);
      for (let s = 0; s < segs; s++) {
        plan.gaps.push({
          day: Math.floor(rng() * days),
          startSlot: Math.floor(rng() * 80),
          len: 2 + Math.floor(rng() * 22),
        });
      }
    } else if (issueKind < 0.75) {
      // 冻结：1~3 整天数值恒定
      const fd = 1 + Math.floor(rng() * 3);
      for (let f = 0; f < fd; f++) plan.freezeDays.push(Math.floor(rng() * days));
    } else {
      // 跳变：1~2 个异常尖峰/突降点
      const jn = 1 + Math.floor(rng() * 2);
      for (let j = 0; j < jn; j++) {
        plan.jumps.push({
          day: Math.floor(rng() * days),
          slot: Math.floor(rng() * 96),
          factor: rng() < 0.5 ? 4 + rng() * 6 : 0.05 + rng() * 0.15,
        });
      }
    }
  }

  return { profiles, events, labels, ratioByDay, qualityPlan };
}

function ensurePlan(map: Map<string, QualityPlan>, userId: string): QualityPlan {
  let p = map.get(userId);
  if (!p) {
    p = { gaps: [], freezeDays: [], jumps: [] };
    map.set(userId, p);
  }
  return p;
}

function dateAfter(startDate: string, days: number): string {
  const d = new Date(startDate + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}
