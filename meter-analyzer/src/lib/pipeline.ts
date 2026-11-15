// 分析流水线：生成/导入 → 清洗 → 聚类 → 台区线损 → 嫌疑打分，全程本地执行
import { generateMeta, type GeneratedMeta } from './generateMeta.ts';
import { buildClusterInfo, runClustering } from './clustering.ts';
import { buildPeerFeatures, type UserFeatures } from './features.ts';
import { aggregateTaLoss, slotMonthMap } from './taLoss.ts';
import { scoreAll, DEFAULT_WEIGHTS, type ScoreWeights } from './scoring.ts';
import {
  buildBlockIndex,
  expectedBlockCount,
  store,
  type DatasetIndex,
} from './storage.ts';
import { WorkerPool, recommendedWorkerCount } from './workerPool.ts';
import { DEFAULT_BLOCK_SIZE, DEFAULT_DAYS } from './util.ts';
import type {
  ClusterInfo,
  InspectionRecord,
  PipelineMeta,
  QualityIssue,
  TaRecord,
  UserAnalytics,
  UserProfile,
} from '../types.ts';
import type { PerUserCleanStat, WorkerResponse } from './worker.ts';

export interface PipelineProgress {
  stage: string;
  percent: number;
  message: string;
}

export interface PipelineTiming {
  generateMs: number;
  cleanMs: number;
  clusterMs: number;
  taMs: number;
  scoreMs: number;
  totalMs: number;
}

export interface PipelineResult {
  index: DatasetIndex;
  timing: PipelineTiming;
  clusterSilhouette: number;
}

export interface GenOptions {
  userCount: number;
  days?: number;
  startDate: string;
  taCount: number;
  theftRatio?: number;
  blockSize?: number;
}

export class Pipeline {
  private pool: WorkerPool | null = null;
  private aborted = false;

  abort(): void {
    this.aborted = true;
  }

  private ensurePool(): WorkerPool {
    if (!this.pool) this.pool = new WorkerPool(recommendedWorkerCount());
    return this.pool;
  }

  async dispose(): Promise<void> {
    if (this.pool) {
      await this.pool.dispose();
      this.pool = null;
    }
  }

  async generateDataset(opts: GenOptions, onProgress: (p: PipelineProgress) => void): Promise<PipelineResult> {
    this.aborted = false;
    const t0 = performance.now();
    const days = opts.days ?? DEFAULT_DAYS;
    const blockSize = opts.blockSize ?? DEFAULT_BLOCK_SIZE;
    const pool = this.ensurePool();

    onProgress({ stage: 'meta', percent: 0.02, message: '生成用户档案、事件与窃电标签…' });
    const genMeta: GeneratedMeta = generateMeta({
      userCount: opts.userCount,
      days,
      startDate: opts.startDate,
      taCount: opts.taCount,
      theftRatio: opts.theftRatio,
    });

    const blockCount = expectedBlockCount(opts.userCount, blockSize);
    const meta: PipelineMeta = {
      generatedAt: new Date().toISOString(),
      days,
      slotCount: days * 96,
      userCount: opts.userCount,
      taCount: opts.taCount,
      startDate: opts.startDate,
      blockSize,
      blockCount,
      theftUserCount: genMeta.labels.length,
      labelVersion: 1,
    };

    onProgress({ stage: 'generate', percent: 0.05, message: `并行生成 ${opts.userCount} 户 × ${days} 天 15 分钟曲线…` });
    const tGen = performance.now();
    const blockIndex = buildBlockIndex(genMeta.profiles.map((p) => p.userId), blockSize);
    for (let b = 0; b < blockCount; b++) {
      if (this.aborted) throw new Error('已取消');
      const entries = blockIndex.filter((e) => e.block === b);
      const userIds = entries.map((e) => e.userId);
      await pool.submit({ kind: 'generate', block: b, userIds, meta, genMeta });
      onProgress({
        stage: 'generate',
        percent: 0.05 + 0.25 * ((b + 1) / blockCount),
        message: `曲线生成 ${b + 1}/${blockCount} 块`,
      });
    }
    const generateMs = performance.now() - tGen;

    // 清洗
    const tClean = performance.now();
    const { issues, cleanStats } = await this.runClean(meta, blockIndex, onProgress, 0.3);
    const cleanMs = performance.now() - tClean;

    // 特征（首轮不带中心）
    onProgress({ stage: 'features', percent: 0.66, message: '提取用户负荷特征…' });
    const features = await this.runFeatures(meta, blockIndex);

    // 聚类（主线程）
    const tCluster = performance.now();
    onProgress({ stage: 'cluster', percent: 0.72, message: '负荷曲线聚类（k-means + 轮廓系数选 k）…' });
    const curves = features.map((f) => f.curve);
    const cluster = runClustering(curves, { kMin: 4, kMax: 9, silhouetteSampleSize: 1200 });
    for (let i = 0; i < features.length; i++) features[i].clusterId = cluster.labels[i];
    const clusters: ClusterInfo[] = buildClusterInfo(
      cluster.labels,
      cluster.centroids,
      genMeta.profiles.map((p) => p.userType),
    );
    const clusterMs = performance.now() - tCluster;

    // 台区线损
    const tTa = performance.now();
    onProgress({ stage: 'taloss', percent: 0.85, message: '聚合台区线损…' });
    const taRecords = await this.buildTaRecords(meta, blockIndex, genMeta.profiles);
    const taMs = performance.now() - tTa;

    // 打分
    const tScore = performance.now();
    onProgress({ stage: 'score', percent: 0.93, message: '计算窃电嫌疑分…' });
    const analytics = this.buildAnalytics(meta, blockIndex, genMeta.profiles, features, clusters, taRecords, issues, cleanStats);
    const scoreMs = performance.now() - tScore;

    const index: DatasetIndex = {
      meta,
      profiles: genMeta.profiles,
      events: genMeta.events,
      labels: genMeta.labels,
      blockIndex,
      issues,
      analytics,
      clusters,
      taRecords,
      inspections: [],
    };
    await store.saveIndex(index);

    const timing: PipelineTiming = {
      generateMs,
      cleanMs,
      clusterMs,
      taMs,
      scoreMs,
      totalMs: performance.now() - t0,
    };
    onProgress({ stage: 'done', percent: 1, message: '分析完成' });
    return { index, timing, clusterSilhouette: cluster.silhouette };
  }

  async rerunClean(
    index: DatasetIndex,
    onProgress: (p: PipelineProgress) => void,
  ): Promise<{ index: DatasetIndex; timing: { cleanMs: number } }> {
    const t = performance.now();
    const { issues, cleanStats } = await this.runClean(index.meta, index.blockIndex, onProgress, 0);
    const features = await this.runFeatures(index.meta, index.blockIndex, index.clusters.map((c) => c.centroid));
    const taRecords = await this.buildTaRecords(index.meta, index.blockIndex, index.profiles);
    const analytics = this.buildAnalytics(
      index.meta,
      index.blockIndex,
      index.profiles,
      features,
      index.clusters,
      taRecords,
      issues,
      cleanStats,
    );
    const next: DatasetIndex = { ...index, issues, analytics, taRecords };
    await store.saveIndex(next);
    return { index: next, timing: { cleanMs: performance.now() - t } };
  }

  async rerunScore(index: DatasetIndex, weights: ScoreWeights): Promise<DatasetIndex> {
    const features = await this.runFeatures(index.meta, index.blockIndex, index.clusters.map((c) => c.centroid));
    const analytics = this.buildAnalytics(
      index.meta,
      index.blockIndex,
      index.profiles,
      features,
      index.clusters,
      index.taRecords,
      index.issues,
      null,
      weights,
      index.analytics,
    );
    const next = { ...index, analytics };
    await store.saveIndex(next);
    return next;
  }

  private async runClean(
    meta: PipelineMeta,
    blockIndex: DatasetIndex['blockIndex'],
    onProgress: (p: PipelineProgress) => void,
    basePercent: number,
  ): Promise<{ issues: QualityIssue[]; cleanStats: PerUserCleanStat[] }> {
    const pool = this.ensurePool();
    const issues: QualityIssue[] = [];
    const cleanStats: PerUserCleanStat[] = [];
    for (let b = 0; b < meta.blockCount; b++) {
      if (this.aborted) throw new Error('已取消');
      const entries = blockIndex.filter((e) => e.block === b);
      const res: WorkerResponse = await pool.submit({
        kind: 'clean',
        block: b,
        userIds: entries.map((e) => e.userId),
        meta,
        config: {
          freezeMinRun: 6,
          freezeEps: 0.01,
          jumpMadK: 6,
          jumpRatio: 3,
          jumpWindow: 4,
          longGapSlots: 24,
        },
      });
      if (res.issues) issues.push(...res.issues);
      if (res.cleanStats) cleanStats.push(...res.cleanStats);
      const inner = (b + 1) / meta.blockCount;
      onProgress({
        stage: 'clean',
        percent: basePercent + (basePercent === 0 ? 0.9 : 0.3) * inner,
        message: `数据清洗 ${b + 1}/${meta.blockCount} 块`,
      });
    }
    return { issues, cleanStats };
  }

  private async runFeatures(
    meta: PipelineMeta,
    blockIndex: DatasetIndex['blockIndex'],
    centroids?: Float32Array[],
  ): Promise<(UserFeatures & { clusterId: number })[]> {
    const pool = this.ensurePool();
    const all: (UserFeatures & { clusterId: number })[] = [];
    for (let b = 0; b < meta.blockCount; b++) {
      const entries = blockIndex.filter((e) => e.block === b);
      const res = await pool.submit({
        kind: 'features',
        block: b,
        userIds: entries.map((e) => e.userId),
        meta,
        centroids,
      });
      if (res.features) all.push(...res.features);
    }
    return all;
  }

  /** 台区线损：Worker 分块聚合后归并（避免主线程逐户扫描 17 亿点） */
  private async buildTaRecords(
    meta: PipelineMeta,
    blockIndex: DatasetIndex['blockIndex'],
    profiles: UserProfile[],
  ): Promise<TaRecord[]> {
    const { map: monthOfSlot, months } = slotMonthMap(meta.startDate, meta.days);
    const taIdList: string[] = [];
    const taSet = new Set<string>();
    const profileTa = new Map<string, string>();
    for (const p of profiles) {
      profileTa.set(p.userId, p.taId);
      if (!taSet.has(p.taId)) {
        taSet.add(p.taId);
        taIdList.push(p.taId);
      }
    }
    taIdList.sort();

    const m = months.length;
    const supply = new Float64Array(taIdList.length * m);
    const sold = new Float64Array(supply.length);
    const theft = new Float64Array(supply.length);
    const pool = this.ensurePool();

    for (let b = 0; b < meta.blockCount; b++) {
      const entries = blockIndex.filter((e) => e.block === b);
      const userIds = entries.map((e) => e.userId);
      const res = await pool.submit({
        kind: 'taloss',
        block: b,
        userIds,
        userTaIds: userIds.map((u) => profileTa.get(u)!),
        taIds: taIdList,
        meta,
        monthOfSlot,
        monthCount: m,
      });
      if (res.supply) {
        for (let i = 0; i < supply.length; i++) {
          supply[i] += res.supply[i];
          sold[i] += res.sold![i];
          theft[i] += res.theft![i];
        }
      }
    }

    const records: TaRecord[] = [];
    for (let ti = 0; ti < taIdList.length; ti++) {
      for (let mi = 0; mi < m; mi++) {
        const k = ti * m + mi;
        records.push({
          taId: taIdList[ti],
          month: months[mi],
          supplyKwh: supply[k],
          soldKwh: sold[k],
          lossRate: supply[k] > 0 ? (supply[k] - sold[k]) / supply[k] : 0,
          truthTheftKwh: theft[k],
        });
      }
    }
    return records;
  }

  private buildAnalytics(
    meta: PipelineMeta,
    blockIndex: DatasetIndex['blockIndex'],
    profiles: UserProfile[],
    features: (UserFeatures & { clusterId: number })[],
    clusters: ClusterInfo[],
    taRecords: TaRecord[],
    issues: QualityIssue[],
    cleanStats: PerUserCleanStat[] | null,
    weights: ScoreWeights = DEFAULT_WEIGHTS,
    previous?: UserAnalytics[],
  ): UserAnalytics[] {
    const profileMap = new Map(profiles.map((p) => [p.userId, p]));
    const featureMap = new Map(features.map((f) => [f.userId, f]));

    // 问题计数（按用户）
    const gapCount = new Map<string, number>();
    const freezeCount = new Map<string, number>();
    const jumpCount = new Map<string, number>();
    const issueSlots = new Map<string, number>();
    for (const iss of issues) {
      const len = iss.endSlot - iss.startSlot + 1;
      issueSlots.set(iss.userId, (issueSlots.get(iss.userId) ?? 0) + len);
      if (iss.kind === 'gap') gapCount.set(iss.userId, (gapCount.get(iss.userId) ?? 0) + 1);
      if (iss.kind === 'freeze') freezeCount.set(iss.userId, (freezeCount.get(iss.userId) ?? 0) + 1);
      if (iss.kind === 'jump') jumpCount.set(iss.userId, (jumpCount.get(iss.userId) ?? 0) + 1);
    }

    // 重建台区线损表结构供打分使用
    const months = Array.from(new Set(taRecords.map((r) => r.month))).sort();
    const taIds = Array.from(new Set(taRecords.map((r) => r.taId))).sort();
    const lossRate = new Float64Array(taIds.length * months.length);
    for (const r of taRecords) {
      const ti = taIds.indexOf(r.taId);
      const mi = months.indexOf(r.month);
      lossRate[ti * months.length + mi] = r.lossRate;
    }
    const daysPerMonth: number[] = months.map((mk) => countDaysInMonth(mk, meta.startDate, meta.days));
    const tables = {
      taIds,
      monthCount: months.length,
      months,
      supply: new Float64Array(0),
      sold: new Float64Array(0),
      lossRate,
      truthTheftKwh: new Float64Array(0),
    };

    // 同类相对轨迹特征（去季节性/天气共性）
    const clusterIds = Uint16Array.from(features.map((f) => f.clusterId));
    const peerFeatures = buildPeerFeatures(features, clusterIds, meta.days);
    const peerMap = new Map(features.map((f, i) => [f.userId, peerFeatures[i]]));

    const scoreInputs = blockIndex.map((e) => {
      const f = featureMap.get(e.userId)!;
      return {
        userId: e.userId,
        taId: profileMap.get(e.userId)!.taId,
        features: f,
        peer: peerMap.get(e.userId)!,
        clusterId: f.clusterId,
        qualityIssueRatio: (issueSlots.get(e.userId) ?? 0) / meta.slotCount,
        gapCount: gapCount.get(e.userId) ?? 0,
        freezeCount: freezeCount.get(e.userId) ?? 0,
        jumpCount: jumpCount.get(e.userId) ?? 0,
      };
    });

    const evidences = scoreAll(scoreInputs, clusters.map((c) => c.centroid), tables as any, daysPerMonth, weights);
    const evMap = new Map(evidences.map((e) => [e.userId, e]));
    const prevMap = new Map((previous ?? []).map((a) => [a.userId, a]));

    return blockIndex.map((e) => {
      const p = profileMap.get(e.userId)!;
      const f = featureMap.get(e.userId)!;
      const ev = evMap.get(e.userId)!;
      const prev = prevMap.get(e.userId);
      return {
        userId: e.userId,
        taId: p.taId,
        userType: p.userType,
        clusterId: f.clusterId,
        totalEnergyKwh: f.totalEnergyKwh,
        avgDailyKwh: f.avgDailyKwh,
        validDayCount: f.validDayCount,
        gapCount: gapCount.get(e.userId) ?? prev?.gapCount ?? 0,
        freezeCount: freezeCount.get(e.userId) ?? prev?.freezeCount ?? 0,
        jumpCount: jumpCount.get(e.userId) ?? prev?.jumpCount ?? 0,
        dropRate: ev.dropRate,
        peerShift: ev.peerShift,
        changepointZ: ev.changepointZ,
        peerChangeZ: ev.peerChangeZ,
        cvRatio: ev.cvRatio,
        lowTailRatio: ev.lowTailRatio,
        persistentWeak: ev.persistentWeak,
        peerDeviation: ev.peerDeviation,
        taLossCorr: ev.taLossCorr,
        taLossMean: ev.taLossMean,
        qualityFlag: ev.qualityFlag,
        scoreDrop: ev.scoreDrop,
        scorePeer: ev.scorePeer,
        scoreLoss: ev.scoreLoss,
        scoreQuality: ev.scoreQuality,
        totalScore: ev.totalScore,
        curve: f.curve,
      } as UserAnalytics;
    });
  }
}

function countDaysInMonth(monthKey: string, startDate: string, totalDays: number): number {
  const d = new Date(startDate + 'T00:00:00Z');
  let n = 0;
  for (let i = 0; i < totalDays; i++) {
    if (d.toISOString().slice(0, 7) === monthKey) n++;
    d.setUTCDate(d.getUTCDate() + 1);
  }
  return n;
}

export type { InspectionRecord };
