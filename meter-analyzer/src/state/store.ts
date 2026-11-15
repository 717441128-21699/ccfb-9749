// 全局应用状态：数据集索引、流水线进度、稽查反馈，useSyncExternalStore 订阅
import { useSyncExternalStore } from 'react';
import type {
  ClusterInfo,
  InspectionRecord,
  PageKey,
  PipelineMeta,
  QualityIssue,
  TaRecord,
  TheftLabel,
  UserAnalytics,
  UserProfile,
  MeterEvent,
} from '../types.ts';
import { store } from '../lib/storage.ts';
import type { PipelineProgress, PipelineTiming } from '../lib/pipeline.ts';

export interface AppState {
  ready: boolean;
  page: PageKey;
  meta: PipelineMeta | null;
  profiles: UserProfile[];
  events: MeterEvent[];
  labels: TheftLabel[];
  analytics: UserAnalytics[];
  clusters: ClusterInfo[];
  issues: QualityIssue[];
  taRecords: TaRecord[];
  inspections: InspectionRecord[];
  progress: ProgressState;
  timing: PipelineTiming | null;
  silhouette: number | null;
  storageBytes: number;
  storageQuota: number;
  showTruthLabels: boolean; // 测试真值对照（仅演示数据可用）
}

export interface ProgressState {
  stage: string;
  percent: number;
  message: string;
  running: boolean;
}

const initial: AppState = {
  ready: false,
  page: 'import',
  meta: null,
  profiles: [],
  events: [],
  labels: [],
  analytics: [],
  clusters: [],
  issues: [],
  taRecords: [],
  inspections: [],
  progress: { stage: '', percent: 0, message: '', running: false },
  timing: null,
  silhouette: null,
  storageBytes: 0,
  storageQuota: 0,
  showTruthLabels: true,
};

let state: AppState = { ...initial };
const listeners = new Set<() => void>();

function emit(): void {
  for (const l of listeners) l();
}

function setState(patch: Partial<AppState>): void {
  state = { ...state, ...patch };
  emit();
}

export const appStore = {
  getState: (): AppState => state,
  subscribe(l: () => void): () => void {
    listeners.add(l);
    return () => listeners.delete(l);
  },

  async init(): Promise<void> {
    const est = await store.estimate();
    const index = await store.loadIndex();
    if (index) {
      setState({
        ready: true,
        meta: index.meta,
        profiles: index.profiles,
        events: index.events,
        labels: index.labels,
        analytics: index.analytics,
        clusters: index.clusters,
        issues: index.issues,
        taRecords: index.taRecords,
        inspections: index.inspections,
        storageBytes: est.usage,
        storageQuota: est.quota,
      });
    } else {
      setState({ ready: true, storageBytes: est.usage, storageQuota: est.quota });
    }
  },

  setPage(page: PageKey): void {
    setState({ page });
  },

  setProgress(p: Partial<ProgressState>): void {
    setState({ progress: { ...state.progress, ...p } });
  },

  applyDataset(
    index: {
      meta: PipelineMeta;
      profiles: UserProfile[];
      events: MeterEvent[];
      labels: TheftLabel[];
      analytics: UserAnalytics[];
      clusters: ClusterInfo[];
      issues: QualityIssue[];
      taRecords: TaRecord[];
      inspections: InspectionRecord[];
    },
    timing: PipelineTiming | null,
    silhouette: number | null,
  ): void {
    setState({
      meta: index.meta,
      profiles: index.profiles,
      events: index.events,
      labels: index.labels,
      analytics: index.analytics,
      clusters: index.clusters,
      issues: index.issues,
      taRecords: index.taRecords,
      inspections: index.inspections ?? [],
      timing,
      silhouette,
      page: 'clean',
    });
  },

  updateIndex(patch: Partial<AppState>): void {
    setState(patch);
  },

  async refreshStorage(): Promise<void> {
    const est = await store.estimate();
    setState({ storageBytes: est.usage, storageQuota: est.quota });
  },

  async clearAll(): Promise<void> {
    await store.clearAll();
    state = { ...initial, ready: true };
    emit();
  },

  toggleTruth(): void {
    setState({ showTruthLabels: !state.showTruthLabels });
  },

  async upsertInspection(rec: InspectionRecord): Promise<InspectionRecord[]> {
    const rest = state.inspections.filter((r) => r.userId !== rec.userId);
    const inspections = [...rest, rec].sort((a, b) => b.inspectedAt.localeCompare(a.inspectedAt));
    setState({ inspections });
    const index = await store.loadIndex();
    if (index) {
      index.inspections = inspections;
      await store.saveIndex(index);
    }
    return inspections;
  },

  async removeInspection(userId: string): Promise<void> {
    const inspections = state.inspections.filter((r) => r.userId !== userId);
    setState({ inspections });
    const index = await store.loadIndex();
    if (index) {
      index.inspections = inspections;
      await store.saveIndex(index);
    }
  },
};

export function useAppState(): AppState {
  return useSyncExternalStore(appStore.subscribe, appStore.getState);
}
