// 并行计算 Worker：数据生成、清洗、特征提取（无 DOM 依赖，可在 Node 中复用同构逻辑）
import { generateMeta, type GeneratedMeta, type QualityPlan } from './generateMeta.ts';
import { generateUserSeries } from './generateSeries.ts';
import { cleanSeries, correctRatio, type CleanConfig } from './cleaning.ts';
import { buildFeatures, type UserFeatures } from './features.ts';
import { assignToClusters } from './clustering.ts';
import { PREFIX_CLEAN, PREFIX_RAW, slotCountOf, store } from './storage.ts';
import type { PipelineMeta, QualityIssue, TheftLabel, UserProfile } from '../types.ts';

interface GenTask {
  kind: 'generate';
  block: number;
  userIds: string[];
  meta: PipelineMeta;
  genMeta: GeneratedMeta;
}

interface CleanTask {
  kind: 'clean';
  block: number;
  userIds: string[];
  meta: PipelineMeta;
  config: CleanConfig;
}

interface FeatureTask {
  kind: 'features';
  block: number;
  userIds: string[];
  meta: PipelineMeta;
  centroids?: Float32Array[];
}

interface TaTask {
  kind: 'taloss';
  block: number;
  userIds: string[];
  /** 与 userIds 同序的台区编号 */
  userTaIds: string[];
  /** 本批涉及的台区编号（全局有序） */
  taIds: string[];
  meta: PipelineMeta;
  monthOfSlot: Uint8Array;
  monthCount: number;
}

export type WorkerRequest = GenTask | CleanTask | FeatureTask | TaTask;

export type { QualityIssue };

export interface PerUserCleanStat {
  userId: string;
  gapSlots: number;
  gapRuns: number;
  freezeSlots: number;
  freezeRuns: number;
  jumpSlots: number;
  filledSlots: number;
  beforeEnergyKwh: number;
  afterEnergyKwh: number;
}

export interface WorkerResponse {
  kind: 'generate' | 'clean' | 'features' | 'taloss' | 'error';
  block: number;
  issues?: QualityIssue[];
  cleanStats?: PerUserCleanStat[];
  features?: (UserFeatures & { clusterId: number })[];
  supply?: Float64Array;
  sold?: Float64Array;
  theft?: Float64Array;
  error?: string;
}

self.onmessage = async (e: MessageEvent<WorkerRequest>) => {
  const task = e.data;
  try {
    if (task.kind === 'generate') {
      self.postMessage(await runGenerate(task));
    } else if (task.kind === 'clean') {
      self.postMessage(await runClean(task));
    } else if (task.kind === 'features') {
      self.postMessage(await runFeatures(task));
    } else {
      self.postMessage(await runTaLoss(task));
    }
  } catch (err) {
    const res: WorkerResponse = {
      kind: 'error',
      block: (task as { block?: number }).block ?? -1,
      error: (err as Error).message,
    };
    self.postMessage(res);
  }
};

async function runGenerate(task: GenTask): Promise<WorkerResponse> {
  const { meta, genMeta, block, userIds } = task;
  const slotCount = slotCountOf(meta);
  const profileMap = new Map<string, UserProfile>(genMeta.profiles.map((p) => [p.userId, p]));
  const labelMap = new Map<string, TheftLabel>(genMeta.labels.map((l) => [l.userId, l]));
  const records: { userId: string; reported: Float32Array; truth: Float32Array }[] = [];
  const ratioRows: Float32Array[] = [];

  for (const userId of userIds) {
    const profile = profileMap.get(userId)!;
    const ratios = genMeta.ratioByDay.get(userId)!.slice();
    const label = labelMap.get(userId);
    const quality: QualityPlan | undefined = genMeta.qualityPlan.get(userId);
    const { reported, truth } = generateUserSeries(profile, {
      days: meta.days,
      startDate: meta.startDate,
      ratios,
      label,
      quality,
    });
    records.push({ userId, reported, truth });
    ratioRows.push(ratios);
  }
  await store.writeBlockSync(PREFIX_RAW, block, records, slotCount);
  await store.writeRatioBlockSync(block, ratioRows, meta.days);
  return { kind: 'generate', block };
}

async function runClean(task: CleanTask): Promise<WorkerResponse> {
  const { meta, block, userIds, config } = task;
  const slotCount = slotCountOf(meta);
  const [buffer, ratioRows] = await Promise.all([
    store.readBlockBufferSync(PREFIX_RAW, block),
    store.readRatioBlockSync(block, meta.days),
  ]);
  const parsed = OpfsStoreParse(buffer, slotCount);
  const issues: QualityIssue[] = [];
  const cleanStats: PerUserCleanStat[] = [];
  const out: { userId: string; reported: Float32Array; truth: Float32Array }[] = [];

  for (let i = 0; i < userIds.length; i++) {
    const userId = userIds[i];
    const { reported, truth } = parsed[i];
    const corrected = correctRatio(reported, ratioRows[i]);
    const res = cleanSeries(userId, corrected, meta.days, config);
    issues.push(...res.issues);
    cleanStats.push({ userId, ...res.stats });
    out.push({ userId, reported: res.cleaned, truth });
  }
  await store.writeBlockSync(PREFIX_CLEAN, block, out, slotCount);
  return { kind: 'clean', block, issues, cleanStats };
}

async function runFeatures(task: FeatureTask): Promise<WorkerResponse> {
  const { meta, block, userIds, centroids } = task;
  const slotCount = slotCountOf(meta);
  const buffer = await store.readBlockBufferSync(PREFIX_CLEAN, block);
  const parsed = OpfsStoreParse(buffer, slotCount);
  const features: (UserFeatures & { clusterId: number })[] = [];

  for (let i = 0; i < userIds.length; i++) {
    const f = buildFeatures(userIds[i], parsed[i].reported, meta.days);
    const clusterId = centroids ? assignToClusters(f.curve, centroids) : -1;
    features.push({ ...f, clusterId });
  }
  return { kind: 'features', block, features };
}

async function runTaLoss(task: TaTask): Promise<WorkerResponse> {
  const { meta, block, userIds, taIds, monthOfSlot, monthCount } = task;
  const slotCount = slotCountOf(meta);
  const buffer = await store.readBlockBufferSync(PREFIX_CLEAN, block);
  const parsed = OpfsStoreParse(buffer, slotCount);
  const taIndex = new Map(taIds.map((id, i) => [id, i]));
  const supply = new Float64Array(taIds.length * monthCount);
  const sold = new Float64Array(supply.length);
  const theft = new Float64Array(supply.length);

  for (let i = 0; i < userIds.length; i++) {
    const ti = taIndex.get(task.userTaIds[i])!;
    const cleaned = parsed[i].reported;
    const truth = parsed[i].truth;
    const base = ti * monthCount;
    for (let s = 0; s < slotCount; s++) {
      const mi = monthOfSlot[s];
      const v = cleaned[s];
      if (isFinite(v)) sold[base + mi] += v / 1000;
      const t = truth[s];
      if (isFinite(t)) {
        supply[base + mi] += t / 1000;
        if (isFinite(v)) theft[base + mi] += (t - v > 0 ? t - v : 0) / 1000;
      }
    }
  }
  return { kind: 'taloss', block, supply, sold, theft };
}

function OpfsStoreParse(buffer: ArrayBuffer, slotCount: number): { reported: Float32Array; truth: Float32Array }[] {
  const view = new DataView(buffer);
  const MAGIC = 0x4d4c4131;
  if (view.getUint32(0, true) !== MAGIC) throw new Error('块文件魔数校验失败');
  const count = view.getUint32(4, true);
  const out: { reported: Float32Array; truth: Float32Array }[] = [];
  const recordFloats = slotCount * 2;
  for (let i = 0; i < count; i++) {
    const start = 2 + i * recordFloats;
    // 直接建视图，避免逐户 slice 复制整块数据（清洗会写自己的输出副本）
    const all = new Float32Array(buffer, start * 4, recordFloats);
    out.push({ reported: all.subarray(0, slotCount), truth: all.subarray(slotCount) });
  }
  return out;
}
