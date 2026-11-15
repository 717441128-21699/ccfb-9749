// 页面二：数据清洗（质量总览、问题清单、清洗前后对比、单户曲线对照）
import { useEffect, useMemo, useState } from 'react';
import { appStore, useAppState } from '../state/store.ts';
import { Button, Card, Empty, ProgressBar, StatCard, Tag } from '../components/ui.tsx';
import { BarChart, LineChart } from '../components/Charts.tsx';
import { Pipeline } from '../lib/pipeline.ts';
import { PREFIX_CLEAN, PREFIX_RAW, slotCountOf, store, type BlockIndexEntry } from '../lib/storage.ts';
import { SLOTS_PER_DAY, slotToTimeLabel } from '../lib/util.ts';
import { correctRatio } from '../lib/cleaning.ts';

const pipeline = new Pipeline();

export function CleanPage(): JSX.Element {
  const s = useAppState();
  const [selected, setSelected] = useState<string | null>(null);
  const [rerunMsg, setRerunMsg] = useState('');

  const summary = useMemo(() => {
    const byKind = { gap: 0, freeze: 0, jump: 0 };
    const affected = new Set<string>();
    for (const iss of s.issues) {
      byKind[iss.kind]++;
      affected.add(iss.userId);
    }
    return { byKind, affectedCount: affected.size };
  }, [s.issues]);

  const issuesByUser = useMemo(() => {
    const m = new Map<string, { gap: number; freeze: number; jump: number; sample: string }>();
    for (const iss of s.issues) {
      const cur = m.get(iss.userId) ?? { gap: 0, freeze: 0, jump: 0, sample: iss.detail };
      cur[iss.kind]++;
      m.set(iss.userId, cur);
    }
    return [...m.entries()].sort((a, b) => b[1].gap + b[1].freeze + b[1].jump - (a[1].gap + a[1].freeze + a[1].jump));
  }, [s.issues]);

  const typeChart = useMemo(
    () => [
      { label: '缺测段', value: summary.byKind.gap, color: '#d97706' },
      { label: '冻结段', value: summary.byKind.freeze, color: '#7c3aed' },
      { label: '跳变点', value: summary.byKind.jump, color: '#dc2626' },
    ],
    [summary],
  );

  if (!s.meta) return <Empty text="请先在「数据导入」页生成或导入数据集" />;

  async function rerun(): Promise<void> {
    appStore.setProgress({ running: true, percent: 0, message: '重新清洗…', stage: 'clean' });
    try {
      const index = (await store.loadIndex())!;
      const { index: next, timing } = await pipeline.rerunClean(index, (p) =>
        appStore.setProgress({ running: true, ...p }),
      );
      appStore.applyDataset(next, null, null);
      setRerunMsg(`重洗完成，耗时 ${(timing.cleanMs / 1000).toFixed(1)}s`);
      appStore.setProgress({ running: false, percent: 1, message: '完成', stage: 'done' });
    } catch (e) {
      appStore.setProgress({ running: false, message: '失败：' + (e as Error).message, stage: 'error' });
    } finally {
      await pipeline.dispose();
    }
  }

  return (
    <div>
      <div className="grid grid-4" style={{ marginBottom: 16 }}>
        <StatCard label="问题用户数" value={summary.affectedCount} sub={`占 ${((summary.affectedCount / (s.meta?.userCount ?? 1)) * 100).toFixed(1)}%`} tone="amber" />
        <StatCard label="缺测段" value={summary.byKind.gap} tone="amber" />
        <StatCard label="冻结段" value={summary.byKind.freeze} tone="red" />
        <StatCard label="跳变点" value={summary.byKind.jump} tone="red" />
      </div>

      <Card title="清洗规则与执行" extra={<Button size="sm" variant="primary" onClick={rerun} disabled={s.progress.running}>重新执行清洗</Button>}>
        <div className="muted small" style={{ lineHeight: 1.9 }}>
          ① <b>倍率校正</b>：按换表/倍率事件的生效日期重建按天倍率轨迹，将表计二次侧登记值折算为一次侧电量；<br />
          ② <b>冻结识别</b>：连续 6 个槽位（1.5 小时）相邻值近恒定（相对差≤1%）判冻结；<br />
          ③ <b>跳变识别</b>：点值偏离 ±4 点邻域均值超过 6 倍稳健离散度且倍率≥3 或≤1/3；<br />
          ④ <b>缺测补齐</b>：≤24 点（6 小时）线性插值，更长缺测按该户 96 点典型曲线 × 邻近日能量缩放补齐。
        </div>
        {s.progress.running && (
          <div style={{ marginTop: 12 }}>
            <ProgressBar percent={s.progress.percent} message={s.progress.message} />
          </div>
        )}
        {rerunMsg && <div className="small" style={{ marginTop: 8, color: 'var(--green)' }}>{rerunMsg}</div>}
      </Card>

      <div className="grid grid-2">
        <Card title="问题类型分布"><BarChart data={typeChart} height={220} /></Card>
        <Card title="问题用户 Top 20（按问题段数）">
          <div className="table-wrap" style={{ maxHeight: 260 }}>
            <table className="data">
              <thead><tr><th>用户编号</th><th>台区</th><th>缺测</th><th>冻结</th><th>跳变</th><th></th></tr></thead>
              <tbody>
                {issuesByUser.slice(0, 20).map(([uid, c]) => {
                  const p = s.profiles.find((x) => x.userId === uid);
                  return (
                    <tr key={uid} className="clickable" onClick={() => setSelected(uid)}>
                      <td>{uid}</td><td>{p?.taId}</td>
                      <td>{c.gap || '-'}</td><td>{c.freeze || '-'}</td><td>{c.jump || '-'}</td>
                      <td><Tag tone="blue">查看曲线</Tag></td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </Card>
      </div>

      <Card title="单户清洗前后对比" extra={
        <select value={selected ?? ''} onChange={(e) => setSelected(e.target.value || null)}>
          <option value="">选择问题用户…</option>
          {issuesByUser.slice(0, 200).map(([uid]) => <option key={uid} value={uid}>{uid}</option>)}
        </select>
      }>
        {selected ? <UserCompare userId={selected} /> : <Empty text="选择一个用户查看原始上报曲线与清洗后曲线的逐点对照（含缺测/冻结/跳变标注）" />}
      </Card>
    </div>
  );
}

function UserCompare({ userId }: { userId: string }): JSX.Element {
  const s = useAppState();
  const [data, setData] = useState<{ raw: number[]; clean: number[]; day: number } | null>(null);
  const [day, setDay] = useState(0);
  const [loading, setLoading] = useState(false);

  const entry = s.meta && findEntry(userId, s);
  const profile = s.profiles.find((p) => p.userId === userId);
  const userIssues = s.issues.filter((i) => i.userId === userId);

  async function load(d: number): Promise<void> {
    if (!s.meta || !entry) return;
    setLoading(true);
    try {
      const slotCount = slotCountOf(s.meta);
      const [rawBlock, cleanBlock] = await Promise.all([
        store.readBlockBuffer(PREFIX_RAW, entry.block),
        store.readBlockBuffer(PREFIX_CLEAN, entry.block),
      ]);
      const rawRec = parseOne(rawBlock, entry.offset, slotCount);
      const cleanRec = parseOne(cleanBlock, entry.offset, slotCount);
      const ratios = await store.readRatioBlock(entry.block, s.meta.days);
      const corrected = correctRatio(rawRec.reported, ratios[entry.offset]);
      const base = d * SLOTS_PER_DAY;
      setData({
        raw: Array.from(corrected.subarray(base, base + SLOTS_PER_DAY)),
        clean: Array.from(cleanRec.reported.subarray(base, base + SLOTS_PER_DAY)),
        day: d,
      });
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    if (entry) void load(day);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [userId, day, entry]);

  const dayIssues = userIssues.filter((i) => i.startSlot >= day * 96 && i.startSlot < (day + 1) * 96);
  const xLabels = Array.from({ length: 96 }, (_, i) => (i % 8 === 0 ? slotToTimeLabel(i) : ''));

  return (
    <div>
      <div className="toolbar">
        <span className="small muted">{profile?.userId} ｜ {profile?.userType} ｜ {profile?.taId}</span>
        <input type="range" min={0} max={(s.meta?.days ?? 1) - 1} value={day} onChange={(e) => setDay(Number(e.target.value))} style={{ width: 320 }} />
        <span>第 {day + 1} 天</span>
        {loading && <span className="muted small">加载中…</span>}
      </div>
      {dayIssues.length > 0 && (
        <div className="pill-row" style={{ marginBottom: 10 }}>
          {dayIssues.map((i, k) => (
            <Tag key={k} tone={i.kind === 'gap' ? 'amber' : 'red'}>{i.kind === 'gap' ? '缺测' : i.kind === 'freeze' ? '冻结' : '跳变'}：{i.detail}</Tag>
          ))}
        </div>
      )}
      {data && (
        <LineChart
          height={280}
          unit=" Wh"
          xLabels={xLabels}
          xTickEvery={8}
          series={[
            { name: '原始（倍率校正后）', points: data.raw, color: '#dc2626', dashed: true },
            { name: '清洗后', points: data.clean, color: '#2563eb', width: 2 },
          ]}
        />
      )}
      <div className="small muted" style={{ marginTop: 8 }}>
        该户全年共 {userIssues.length} 个问题段：缺测 {userIssues.filter((i) => i.kind === 'gap').length}、
        冻结 {userIssues.filter((i) => i.kind === 'freeze').length}、
        跳变 {userIssues.filter((i) => i.kind === 'jump').length}
      </div>
    </div>
  );
}

function findEntry(userId: string, s: ReturnType<typeof useAppState>): BlockIndexEntry | undefined {
  // blockIndex 不放在 state，临时从 store 读；这里通过 analytics 顺序与 blockSize 推断
  const idx = s.analytics.findIndex((a) => a.userId === userId);
  if (idx < 0 || !s.meta) return undefined;
  return { userId, block: Math.floor(idx / s.meta.blockSize), offset: idx % s.meta.blockSize };
}

function parseOne(buffer: ArrayBuffer, offset: number, slotCount: number): { reported: Float32Array; truth: Float32Array } {
  const MAGIC = 0x4d4c4131;
  const view = new DataView(buffer);
  if (view.getUint32(0, true) !== MAGIC) throw new Error('块魔数错误');
  const recordFloats = slotCount * 2;
  const start = 2 + offset * recordFloats;
  const all = new Float32Array(buffer, start * 4, recordFloats);
  return { reported: all.slice(0, slotCount), truth: all.slice(slotCount) };
}
