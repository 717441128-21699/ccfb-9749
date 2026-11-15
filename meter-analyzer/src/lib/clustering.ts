// 负荷曲线聚类：k-means（L1 距离）+ 轮廓系数选 k，支持增量分配新用户
import { SLOTS_PER_DAY } from './util.ts';
import { rngFor } from './rng.ts';
import type { ClusterInfo, UserType } from '../types.ts';

export interface ClusterResult {
  labels: Uint16Array; // 每用户簇号
  centroids: Float32Array[]; // k 条 96 点曲线
  silhouette: number;
  k: number;
}

export interface KMeansOptions {
  kMin?: number;
  kMax?: number;
  maxIter?: number;
  seed?: string;
  /** 候选 k 评估时的抽样步长（5 万户全量算轮廓太贵） */
  silhouetteSampleSize?: number;
  /** 大规模数据：仅抽样拟合中心，再全量分配，控制 k-means 耗时 */
  fitSampleSize?: number;
}

function kmeansOnce(curves: Float32Array[], k: number, rng: () => number, maxIter: number, initLabels?: Uint16Array) {
  const n = curves.length;
  const centroids: Float32Array[] = [];
  const labels = new Uint16Array(n);

  if (initLabels) {
    labels.set(initLabels);
  } else {
    // k-means++ 初始化
    const first = Math.floor(rng() * n);
    const chosen = [first];
    labels[first] = 0;
    const minDist = new Float32Array(n);
    for (let i = 0; i < n; i++) minDist[i] = l1(curves[i], curves[first]);
    while (chosen.length < k) {
      let sum = 0;
      for (let i = 0; i < n; i++) sum += minDist[i] * minDist[i];
      let target = rng() * sum;
      let pick = chosen[0];
      for (let i = 0; i < n; i++) {
        target -= minDist[i] * minDist[i];
        if (target <= 0) {
          pick = i;
          break;
        }
      }
      chosen.push(pick);
      labels[pick] = chosen.length - 1;
      for (let i = 0; i < n; i++) {
        const d = l1(curves[i], curves[pick]);
        if (d < minDist[i]) minDist[i] = d;
      }
    }
  }

  for (let iter = 0; iter < maxIter; iter++) {
    // 更新中心
    const sums = Array.from({ length: k }, () => new Float64Array(SLOTS_PER_DAY));
    const counts = new Uint32Array(k);
    for (let i = 0; i < n; i++) {
      const c = labels[i];
      counts[c]++;
      const cv = curves[i];
      const sm = sums[c];
      for (let s = 0; s < SLOTS_PER_DAY; s++) sm[s] += cv[s];
    }
    centroids.length = 0;
    for (let c = 0; c < k; c++) {
      const cen = new Float32Array(SLOTS_PER_DAY);
      if (counts[c]) for (let s = 0; s < SLOTS_PER_DAY; s++) cen[s] = sums[c][s] / counts[c];
      else cen.set(curves[Math.floor(rng() * n)]);
      centroids.push(cen);
    }
    // 重新分配
    let moved = 0;
    for (let i = 0; i < n; i++) {
      let best = 0;
      let bestD = Infinity;
      for (let c = 0; c < k; c++) {
        const d = l1(curves[i], centroids[c]);
        if (d < bestD) {
          bestD = d;
          best = c;
        }
      }
      if (labels[i] !== best) {
        labels[i] = best;
        moved++;
      }
    }
    if (moved === 0) break;
  }
  return { labels, centroids };
}

function l1(a: Float32Array, b: Float32Array): number {
  let d = 0;
  for (let i = 0; i < a.length; i++) d += Math.abs(a[i] - b[i]);
  return d;
}

/** 抽样轮廓系数 */
function silhouetteSample(curves: Float32Array[], labels: Uint16Array, k: number, rng: () => number, sampleSize: number): number {
  const n = curves.length;
  if (n <= k) return 0;
  const m = Math.min(sampleSize, n);
  const idxs = new Set<number>();
  while (idxs.size < m) idxs.add(Math.floor(rng() * n));
  const counts = new Uint32Array(k);
  for (let i = 0; i < n; i++) counts[labels[i]]++;

  let total = 0;
  let used = 0;
  for (const i of idxs) {
    const own = labels[i];
    if (counts[own] < 2) continue;
    let aSum = 0;
    const bSums = new Float64Array(k);
    for (let j = 0; j < n; j++) {
      const d = l1(curves[i], curves[j]);
      if (labels[j] === own) aSum += d;
      else bSums[labels[j]] += d;
    }
    const a = aSum / (counts[own] - 1);
    let b = Infinity;
    for (let c = 0; c < k; c++) {
      if (c !== own && counts[c] > 0) b = Math.min(b, bSums[c] / counts[c]);
    }
    if (!isFinite(b)) continue;
    total += (b - a) / Math.max(a, b);
    used++;
  }
  return used ? total / used : 0;
}

export function runClustering(curves: Float32Array[], opts: KMeansOptions = {}): ClusterResult {
  const {
    kMin = 4,
    kMax = 10,
    maxIter = 30,
    seed = 'cluster',
    silhouetteSampleSize = 1500,
    fitSampleSize = 6000,
  } = opts;
  const rng = rngFor(seed);
  const n = curves.length;

  // 大规模数据抽样拟合中心，再全量分配
  let fitCurves = curves;
  if (n > fitSampleSize) {
    const picked = new Set<number>();
    while (picked.size < fitSampleSize) picked.add(Math.floor(rng() * n));
    fitCurves = [...picked].map((i) => curves[i]);
  }

  let best: ClusterResult | null = null;

  for (let k = kMin; k <= kMax; k++) {
    // 每个 k 跑 2 次取优（k=4 起步，成本可控）
    let runBest: { labels: Uint16Array; centroids: Float32Array[] } | null = null;
    let runBestCost = Infinity;
    for (let rep = 0; rep < 2; rep++) {
      const r = kmeansOnce(fitCurves, k, rng, maxIter);
      let cost = 0;
      for (let i = 0; i < fitCurves.length; i++) cost += l1(fitCurves[i], r.centroids[r.labels[i]]);
      if (cost < runBestCost) {
        runBestCost = cost;
        runBest = r;
      }
    }
    const sil = silhouetteSample(fitCurves, runBest!.labels, k, rng, Math.min(silhouetteSampleSize, fitCurves.length));
    if (!best || sil > best.silhouette) {
      best = { labels: runBest!.labels, centroids: runBest!.centroids, silhouette: sil, k };
    }
  }
  // 全量分配到最优中心
  const labels = new Uint16Array(n);
  for (let i = 0; i < n; i++) labels[i] = assignToClusters(curves[i], best!.centroids);
  return { labels, centroids: best!.centroids, silhouette: best!.silhouette, k: best!.k };
}

/** 把新用户分配到已有簇（导入新数据时增量使用） */
export function assignToClusters(curve: Float32Array, centroids: Float32Array[]): number {
  let best = 0;
  let bestD = Infinity;
  for (let c = 0; c < centroids.length; c++) {
    const d = l1(curve, centroids[c]);
    if (d < bestD) {
      bestD = d;
      best = c;
    }
  }
  return best;
}

export function buildClusterInfo(
  labels: Uint16Array,
  centroids: Float32Array[],
  userTypes: UserType[],
): ClusterInfo[] {
  const k = centroids.length;
  const counts = new Uint32Array(k);
  const comp: Record<UserType, number>[] = Array.from({ length: k }, () => ({
    居民: 0,
    商业: 0,
    工业: 0,
  }));
  for (let i = 0; i < labels.length; i++) {
    const c = labels[i];
    counts[c]++;
    comp[c][userTypes[i]]++;
  }
  return centroids.map((centroid, c) => ({
    clusterId: c,
    centroid,
    userCount: counts[c],
    typeComposition: comp[c],
  }));
}
