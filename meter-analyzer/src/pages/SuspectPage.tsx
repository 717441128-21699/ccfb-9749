// 页面四：窃电嫌疑排查（筛选/排序/分页、权重调参、分数分布、台区排名、名单导出）
import { useMemo, useState } from 'react';
import { appStore, useAppState } from '../state/store.ts';
import { Button, Card, Empty, Field, StatCard, Tag, scoreTone } from '../components/ui.tsx';
import { BarChart } from '../components/Charts.tsx';
import { UserDetail } from '../components/UserDetail.tsx';
import { Pipeline } from '../lib/pipeline.ts';
import { store } from '../lib/storage.ts';
import { exportSuspectList } from '../lib/exporters.ts';
import { THEFT_MODE_LABEL, pct } from '../lib/util.ts';
import type { ScoreWeights } from '../lib/scoring.ts';

const PAGE_SIZE = 50;
type SortKey = 'totalScore' | 'scoreDrop' | 'scorePeer' | 'scoreLoss' | 'scoreQuality' | 'taId';

export function SuspectPage(): JSX.Element {
  const s = useAppState();
  const [taFilter, setTaFilter] = useState('');
  const [typeFilter, setTypeFilter] = useState('');
  const [clusterFilter, setClusterFilter] = useState('');
  const [minScore, setMinScore] = useState(0);
  const [keyword, setKeyword] = useState('');
  const [inspectFilter, setInspectFilter] = useState('');
  const [sortKey, setSortKey] = useState<SortKey>('totalScore');
  const [page, setPage] = useState(0);
  const [detailUser, setDetailUser] = useState<string | null>(null);
  const [weights, setWeights] = useState<ScoreWeights>({ drop: 0.4, peer: 0.28, loss: 0.22, quality: 0.1 });
  const [rescoring, setRescoring] = useState(false);

  const taOptions = useMemo(() => Array.from(new Set(s.analytics.map((a) => a.taId))).sort(), [s.analytics]);
  const inspectMap = useMemo(() => new Map(s.inspections.map((r) => [r.userId, r])), [s.inspections]);
  const labelMap = useMemo(() => new Map(s.labels.map((l) => [l.userId, l])), [s.labels]);

  const filtered = useMemo(() => {
    let rows = s.analytics;
    if (taFilter) rows = rows.filter((a) => a.taId === taFilter);
    if (typeFilter) rows = rows.filter((a) => a.userType === typeFilter);
    if (clusterFilter !== '') rows = rows.filter((a) => a.clusterId === Number(clusterFilter));
    if (minScore > 0) rows = rows.filter((a) => a.totalScore >= minScore);
    if (keyword) rows = rows.filter((a) => a.userId.includes(keyword.trim()));
    if (inspectFilter) {
      rows = rows.filter((a) => {
        const r = inspectMap.get(a.userId);
        if (inspectFilter === 'none') return !r;
        return r?.result === inspectFilter;
      });
    }
    const sorted = [...rows].sort((a, b) => {
      if (sortKey === 'taId') return a.taId.localeCompare(b.taId) || b.totalScore - a.totalScore;
      return (b[sortKey] as number) - (a[sortKey] as number);
    });
    return sorted;
  }, [s.analytics, taFilter, typeFilter, clusterFilter, minScore, keyword, inspectFilter, sortKey, inspectMap]);

  const pageRows = filtered.slice(page * PAGE_SIZE, (page + 1) * PAGE_SIZE);
  const pageCount = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE));

  const scoreDist = useMemo(() => {
    const edges = [0, 20, 40, 50, 60, 70, 80, 101];
    return edges.slice(0, -1).map((lo, i) => ({
      label: `${lo}-${edges[i + 1]}`,
      value: s.analytics.filter((a) => a.totalScore >= lo && a.totalScore < edges[i + 1]).length,
      color: lo >= 70 ? '#dc2626' : lo >= 50 ? '#d97706' : '#2563eb',
    }));
  }, [s.analytics]);

  const taBoard = useMemo(() => {
    const m = new Map<string, { count: number; high: number }>();
    for (const a of s.analytics) {
      const cur = m.get(a.taId) ?? { count: 0, high: 0 };
      cur.count++;
      if (a.totalScore >= 60) cur.high++;
      m.set(a.taId, cur);
    }
    return [...m.entries()].map(([taId, v]) => ({ taId, ...v, rate: v.count ? v.high / v.count : 0 })).sort((a, b) => b.high - a.high).slice(0, 15);
  }, [s.analytics]);

  if (!s.meta || !s.analytics.length) return <Empty text="请先在「数据导入」页生成数据集" />;

  async function rescore(): Promise<void> {
    setRescoring(true);
    try {
      const index = (await store.loadIndex())!;
      const p = new Pipeline();
      const next = await p.rerunScore(index, weights);
      await p.dispose();
      appStore.updateIndex({
        analytics: next.analytics,
        issues: next.issues,
        clusters: next.clusters,
        taRecords: next.taRecords,
      });
    } finally {
      setRescoring(false);
    }
  }

  async function exportCurrent(): Promise<void> {
    const index = await store.loadIndex();
    if (index) exportSuspectList(index, filtered);
  }

  function setWeight(key: keyof ScoreWeights, val: number): void {
    const next = { ...weights, [key]: val };
    const sum = Object.values(next).reduce((a, b) => a + b, 0);
    if (sum > 0) setWeights(next);
  }

  return (
    <div>
      <div className="grid grid-4" style={{ marginBottom: 16 }}>
        <StatCard label="高风险户（≥70 分）" value={s.analytics.filter((a) => a.totalScore >= 70).length} tone="red" sub="建议优先稽查" />
        <StatCard label="中风险户（50-70）" value={s.analytics.filter((a) => a.totalScore >= 50 && a.totalScore < 70).length} tone="amber" />
        <StatCard label="筛选结果" value={filtered.length} tone="blue" sub={`占全部 ${pct(filtered.length / s.analytics.length)}`} />
        <StatCard label="已稽查确认" value={s.inspections.filter((r) => r.result === 'confirmed').length} tone="green" />
      </div>

      <Card title="筛选与排序">
        <div className="grid grid-4">
          <Field label="台区">
            <select value={taFilter} onChange={(e) => { setTaFilter(e.target.value); setPage(0); }}>
              <option value="">全部台区（{taOptions.length}）</option>
              {taOptions.map((t) => <option key={t} value={t}>{t}</option>)}
            </select>
          </Field>
          <Field label="用户类型">
            <select value={typeFilter} onChange={(e) => { setTypeFilter(e.target.value); setPage(0); }}>
              <option value="">全部</option><option>居民</option><option>商业</option><option>工业</option>
            </select>
          </Field>
          <Field label="所属簇">
            <select value={clusterFilter} onChange={(e) => { setClusterFilter(e.target.value); setPage(0); }}>
              <option value="">全部</option>
              {s.clusters.map((c) => <option key={c.clusterId} value={c.clusterId}>簇{c.clusterId}（{c.userCount}户）</option>)}
            </select>
          </Field>
          <Field label="最低分数">
            <input type="number" min={0} max={100} value={minScore} onChange={(e) => { setMinScore(Number(e.target.value)); setPage(0); }} />
          </Field>
          <Field label="户号搜索">
            <input value={keyword} placeholder="如 U001234" onChange={(e) => { setKeyword(e.target.value); setPage(0); }} />
          </Field>
          <Field label="稽查状态">
            <select value={inspectFilter} onChange={(e) => { setInspectFilter(e.target.value); setPage(0); }}>
              <option value="">全部</option>
              <option value="none">未稽查</option>
              <option value="confirmed">已确认</option>
              <option value="cleared">已排除</option>
              <option value="pending">待处理</option>
            </select>
          </Field>
          <Field label="排序依据">
            <select value={sortKey} onChange={(e) => setSortKey(e.target.value as SortKey)}>
              <option value="totalScore">总分</option>
              <option value="scoreDrop">负荷突降分</option>
              <option value="scorePeer">同类偏离分</option>
              <option value="scoreLoss">线损关联分</option>
              <option value="scoreQuality">数据质量分</option>
              <option value="taId">台区+总分</option>
            </select>
          </Field>
          <Field label="操作">
            <div style={{ display: 'flex', gap: 8 }}>
              <Button size="sm" variant="primary" onClick={exportCurrent}>导出当前名单</Button>
            </div>
          </Field>
        </div>
      </Card>

      <div className="grid grid-2">
        <Card title="全量嫌疑分分布">
          <BarChart data={scoreDist} height={220} />
        </Card>
        <Card title="高风险户数最多的台区 Top 15">
          <BarChart horizontal height={220} data={taBoard.map((t) => ({ label: t.taId, value: t.high, color: '#dc2626', sub: pct(t.rate) }))} />
        </Card>
      </div>

      <Card title="打分权重调参（修改后实时重算，子分定义与证据见用户详情）" extra={
        <Button size="sm" variant="primary" onClick={rescore} disabled={rescoring}>
          {rescoring ? '重算中…' : '按权重重新打分'}
        </Button>
      }>
        <div className="grid grid-4">
          {([
            ['drop', '负荷突降'],
            ['peer', '同类偏离'],
            ['loss', '线损关联'],
            ['quality', '数据质量'],
          ] as [keyof ScoreWeights, string][]).map(([key, label]) => (
            <Field key={key} label={`${label}权重（当前 ${(weights[key] * 100).toFixed(0)}%）`}>
              <input type="range" min={0} max={0.8} step={0.02} value={weights[key]} onChange={(e) => setWeight(key, Number(e.target.value))} />
            </Field>
          ))}
        </div>
        <div className="small muted" style={{ marginTop: 6 }}>
          权重无需归一，系统按相对比例合成总分；默认 40/28/22/10。
        </div>
      </Card>

      <Card title={`嫌疑名单（${filtered.length} 户，第 ${page + 1}/${pageCount} 页，点击行查看证据与历史曲线）`}>
        <div className="table-wrap" style={{ maxHeight: 520 }}>
          <table className="data">
            <thead>
              <tr>
                <th>排名</th><th>户号</th><th>台区</th><th>类型</th><th>总分</th>
                <th>突降</th><th>偏离</th><th>线损</th><th>质量</th>
                <th>相对走低</th><th>线损相关</th><th>稽查</th>{s.showTruthLabels && <th>真值(演示)</th>}
              </tr>
            </thead>
            <tbody>
              {pageRows.map((a, i) => {
                const rec = inspectMap.get(a.userId);
                const label = labelMap.get(a.userId);
                return (
                  <tr key={a.userId} className="clickable" onClick={() => setDetailUser(a.userId)}>
                    <td>{page * PAGE_SIZE + i + 1}</td>
                    <td>{a.userId}</td>
                    <td>{a.taId}</td>
                    <td>{a.userType}</td>
                    <td><Tag tone={scoreTone(a.totalScore)}>{a.totalScore.toFixed(1)}</Tag></td>
                    <td>{a.scoreDrop.toFixed(0)}</td>
                    <td>{a.scorePeer.toFixed(0)}</td>
                    <td>{a.scoreLoss.toFixed(0)}</td>
                    <td>{a.scoreQuality.toFixed(0)}</td>
                    <td>{pct(a.peerShift)}</td>
                    <td>{a.taLossCorr.toFixed(2)}</td>
                    <td>
                      {rec ? <Tag tone={rec.result === 'confirmed' ? 'red' : rec.result === 'cleared' ? 'green' : 'amber'}>
                        {rec.result === 'confirmed' ? '确认' : rec.result === 'cleared' ? '排除' : '待处理'}
                      </Tag> : <span className="muted">—</span>}
                    </td>
                    {s.showTruthLabels && <td>{label ? <Tag tone="red">{THEFT_MODE_LABEL[label.mode]}</Tag> : <span className="muted">正常</span>}</td>}
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
        <div style={{ marginTop: 12, display: 'flex', gap: 10, alignItems: 'center' }}>
          <Button size="sm" disabled={page === 0} onClick={() => setPage(page - 1)}>上一页</Button>
          <span className="small muted">{page + 1} / {pageCount}</span>
          <Button size="sm" disabled={page >= pageCount - 1} onClick={() => setPage(page + 1)}>下一页</Button>
        </div>
      </Card>

      {detailUser && <UserDetail userId={detailUser} onClose={() => setDetailUser(null)} />}
    </div>
  );
}
