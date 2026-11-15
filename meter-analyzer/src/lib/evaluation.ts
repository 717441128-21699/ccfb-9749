// 模型评估：对照窃电真值标签与稽查反馈，计算 Top-N 命中率/召回率
import type { DatasetIndex } from './storage.ts';
import type { InspectionRecord, TheftLabel } from '../types.ts';

export interface EvalMetrics {
  totalUsers: number;
  labeledTheft: number;
  inspected: number;
  confirmed: number;
  cleared: number;
  pending: number;
  /** 仅基于稽查反馈的命中率（已结案） */
  inspectionPrecision: number | null;
  topN: { n: number; hits: number; precision: number; recall: number }[];
  byMode: { mode: string; total: number; top1000Hits: number; rate: number }[];
  /** 分数分桶的精确率（对照真值） */
  buckets: { range: string; users: number; theft: number; precision: number }[];
  /** 已稽查确认户的平均排名百分位（越小越靠前） */
  confirmedRankPctAvg: number | null;
}

const TOP_NS = [50, 100, 200, 500, 1000, 2000];

export function evaluate(index: DatasetIndex): EvalMetrics {
  const ranked = [...index.analytics].sort((a, b) => b.totalScore - a.totalScore);
  const labelMap = new Map<string, TheftLabel>(index.labels.map((l) => [l.userId, l]));
  const rankMap = new Map(ranked.map((a, i) => [a.userId, i]));
  const theftTotal = index.labels.length;

  const topN = TOP_NS.filter((n) => n <= ranked.length).map((n) => {
    const hits = ranked.slice(0, n).filter((a) => labelMap.has(a.userId)).length;
    return {
      n,
      hits,
      precision: n ? hits / n : 0,
      recall: theftTotal ? hits / theftTotal : 0,
    };
  });

  const modeStat = new Map<string, { total: number; top1000: number }>();
  const top1000 = new Set(ranked.slice(0, Math.min(1000, ranked.length)).map((a) => a.userId));
  for (const l of index.labels) {
    const s = modeStat.get(l.mode) ?? { total: 0, top1000: 0 };
    s.total++;
    if (top1000.has(l.userId)) s.top1000++;
    modeStat.set(l.mode, s);
  }
  const byMode = [...modeStat.entries()].map(([mode, v]) => ({
    mode,
    total: v.total,
    top1000Hits: v.top1000,
    rate: v.total ? v.top1000 / v.total : 0,
  }));

  // 分数分桶
  const bucketDefs = [
    { range: '80-100', lo: 80, hi: 101 },
    { range: '60-80', lo: 60, hi: 80 },
    { range: '40-60', lo: 40, hi: 60 },
    { range: '20-40', lo: 20, hi: 40 },
    { range: '0-20', lo: -1, hi: 20 },
  ];
  const buckets = bucketDefs.map((b) => {
    const inB = index.analytics.filter((a) => a.totalScore >= b.lo && a.totalScore < b.hi);
    const theft = inB.filter((a) => labelMap.has(a.userId)).length;
    return {
      range: b.range,
      users: inB.length,
      theft,
      precision: inB.length ? theft / inB.length : 0,
    };
  });

  // 稽查反馈
  const inspected = index.inspections.length;
  const confirmed = index.inspections.filter((r) => r.result === 'confirmed').length;
  const cleared = index.inspections.filter((r) => r.result === 'cleared').length;
  const pending = index.inspections.filter((r) => r.result === 'pending').length;
  const closed = confirmed + cleared;
  const inspectionPrecision = closed ? confirmed / closed : null;

  const confirmedRanks = index.inspections
    .filter((r) => r.result === 'confirmed')
    .map((r) => rankMap.get(r.userId))
    .filter((x): x is number => x !== undefined);
  const confirmedRankPctAvg = confirmedRanks.length
    ? confirmedRanks.reduce((s, r) => s + (r / (ranked.length - 1)) * 100, 0) / confirmedRanks.length
    : null;

  return {
    totalUsers: index.meta.userCount,
    labeledTheft: theftTotal,
    inspected,
    confirmed,
    cleared,
    pending,
    inspectionPrecision,
    topN,
    byMode,
    buckets,
    confirmedRankPctAvg,
  };
}

/** 基于稽查反馈的简易校准：被排除户视为负样本，确认户视为正样本，估计各分数段命中率 */
export function calibrationFromInspections(records: InspectionRecord[]): {
  scoreList: number;
  confirmedList: number;
}[] {
  const rows = records
    .filter((r) => r.result !== 'pending')
    .map((r) => ({ score: r.scoreAtInspection, ok: r.result === 'confirmed' ? 1 : 0 }));
  const edges = [0, 20, 40, 60, 80, 101];
  return edges.slice(0, -1).map((lo, i) => {
    const hi = edges[i + 1];
    const inB = rows.filter((r) => r.score >= lo && r.score < hi);
    return {
      scoreList: inB.length,
      confirmedList: inB.reduce((s, r) => s + r.ok, 0),
    };
  });
}
