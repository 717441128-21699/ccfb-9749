// 页面五：稽查反馈与模型评估（回填、记录管理、Top-N 命中率、分模式/分桶评估、导出）
import { useMemo, useState } from 'react';
import { appStore, useAppState } from '../state/store.ts';
import { Button, Card, Empty, Field, StatCard, Tag, scoreTone } from '../components/ui.tsx';
import { BarChart } from '../components/Charts.tsx';
import { UserDetail } from '../components/UserDetail.tsx';
import { evaluate } from '../lib/evaluation.ts';
import { exportEvaluation, exportInspections, exportTaLoss } from '../lib/exporters.ts';
import { THEFT_MODES, THEFT_MODE_LABEL } from '../lib/util.ts';
import type { InspectionRecord, TheftMode } from '../types.ts';

export function InspectPage(): JSX.Element {
  const s = useAppState();
  const [detailUser, setDetailUser] = useState<string | null>(null);
  const metrics = useMemo(() => (s.meta ? evaluate(shim(s)) : null), [s]);

  if (!s.meta || !metrics) return <Empty text="请先在「数据导入」页生成数据集" />;

  return (
    <div>
      <div className="grid grid-4" style={{ marginBottom: 16 }}>
        <StatCard label="已稽查户数" value={metrics.inspected} tone="blue" sub={`待处理 ${metrics.pending} 户`} />
        <StatCard label="确认窃电" value={metrics.confirmed} tone="red" />
        <StatCard label="反馈命中率" value={metrics.inspectionPrecision === null ? '—' : (metrics.inspectionPrecision * 100).toFixed(1) + '%'} tone="green" sub="确认/已结案" />
        <StatCard label="确认户平均排名位置" value={metrics.confirmedRankPctAvg === null ? '—' : metrics.confirmedRankPctAvg.toFixed(1) + '%'} sub="越低代表模型排序越准" tone="amber" />
      </div>

      <Card title="模型命中率（对照埋入的已知窃电标签，随稽查反馈持续校准）" extra={
        <div style={{ display: 'flex', gap: 8 }}>
          <Button size="sm" onClick={() => exportEvaluation(shim(s))}>导出评估报告</Button>
          <Button size="sm" onClick={() => exportInspections(shim(s))}>导出稽查记录</Button>
          <Button size="sm" onClick={() => exportTaLoss(shim(s))}>导出线损台账</Button>
        </div>
      }>
        <div className="table-wrap" style={{ maxHeight: 240 }}>
          <table className="data">
            <thead><tr><th>名单范围</th><th>命中窃电户</th><th>精确率（命中率）</th><th>召回率（覆盖全部窃电户）</th><th>可视化</th></tr></thead>
            <tbody>
              {metrics.topN.map((t) => (
                <tr key={t.n}>
                  <td>Top {t.n}</td>
                  <td>{t.hits}</td>
                  <td><Tag tone={t.precision >= 0.6 ? 'red' : t.precision >= 0.3 ? 'amber' : 'gray'}>{(t.precision * 100).toFixed(1)}%</Tag></td>
                  <td>{(t.recall * 100).toFixed(1)}%</td>
                  <td style={{ width: 260 }}>
                    <div className="progress-track small"><div className="progress-fill" style={{ width: `${t.precision * 100}%` }} /></div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Card>

      <div className="grid grid-2">
        <Card title="分数段精确率（高分区应显著富集窃电户）">
          <BarChart height={240} data={metrics.buckets.map((b) => ({
            label: b.range,
            value: b.precision * 100,
            color: Number(b.range.split('-')[0]) >= 70 ? '#dc2626' : '#2563eb',
            sub: `${b.theft}/${b.users}`,
          }))} unit="%" />
        </Card>
        <Card title="分窃电模式召回（Top1000 名单）">
          <BarChart height={240} data={metrics.byMode.map((m) => ({
            label: THEFT_MODE_LABEL[m.mode] ?? m.mode,
            value: m.rate * 100,
            color: '#d97706',
            sub: `${m.top1000Hits}/${m.total}`,
          }))} unit="%" />
        </Card>
      </div>

      <Card title="稽查反馈记录（点击行打开用户详情）" extra={<span className="muted small">回填后上方命中率自动按最新反馈重算</span>}>
        {s.inspections.length === 0 ? (
          <Empty text="暂无稽查记录。到「嫌疑排查」页点开嫌疑户，在「稽查回填」标签页录入结果" />
        ) : (
          <div className="table-wrap" style={{ maxHeight: 380 }}>
            <table className="data">
              <thead><tr><th>户号</th><th>台区</th><th>稽查日期</th><th>结果</th><th>当时分数</th><th>稽查人</th><th>模式</th><th>备注</th><th></th></tr></thead>
              <tbody>
                {s.inspections.map((r) => {
                  const a = s.analytics.find((x) => x.userId === r.userId);
                  return (
                    <tr key={r.userId} className="clickable" onClick={() => setDetailUser(r.userId)}>
                      <td>{r.userId}</td>
                      <td>{a?.taId ?? '-'}</td>
                      <td>{r.inspectedAt}</td>
                      <td><Tag tone={r.result === 'confirmed' ? 'red' : r.result === 'cleared' ? 'green' : 'amber'}>
                        {r.result === 'confirmed' ? '确认窃电' : r.result === 'cleared' ? '排除' : '待处理'}
                      </Tag></td>
                      <td>{r.scoreAtInspection.toFixed(1)}</td>
                      <td>{r.inspector}</td>
                      <td>{r.theftMode ? THEFT_MODE_LABEL[r.theftMode] : '—'}</td>
                      <td style={{ whiteSpace: 'normal', maxWidth: 260 }}>{r.note}</td>
                      <td onClick={(e) => e.stopPropagation()}>
                        <Button size="sm" variant="danger" onClick={() => {
                          if (window.confirm(`删除 ${r.userId} 的稽查记录？`)) void appStore.removeInspection(r.userId);
                        }}>删除</Button>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      {detailUser && <UserDetail userId={detailUser} onClose={() => setDetailUser(null)} />}
    </div>
  );
}

/** 稽查回填表单（也用于用户详情抽屉内） */
export function InspectionForm({ userId, currentScore, onDone }: { userId: string; currentScore: number; onDone?: () => void }): JSX.Element {
  const s = useAppState();
  const existing = s.inspections.find((r) => r.userId === userId);
  const [result, setResult] = useState<InspectionRecord['result']>(existing?.result ?? 'confirmed');
  const [inspector, setInspector] = useState(existing?.inspector ?? '');
  const [note, setNote] = useState(existing?.note ?? '');
  const [mode, setMode] = useState<TheftMode | ''>(existing?.theftMode ?? '');
  const [saved, setSaved] = useState(false);

  async function submit(): Promise<void> {
    const rec: InspectionRecord = {
      userId,
      inspectedAt: new Date().toISOString().slice(0, 10),
      result,
      scoreAtInspection: currentScore,
      inspector: inspector || '稽查员',
      note,
      theftMode: result === 'confirmed' && mode ? (mode as TheftMode) : undefined,
    };
    await appStore.upsertInspection(rec);
    setSaved(true);
    setTimeout(() => onDone?.(), 700);
  }

  return (
    <div>
      <div className="grid grid-3" style={{ marginBottom: 14 }}>
        <Field label="稽查结果">
          <select value={result} onChange={(e) => setResult(e.target.value as InspectionRecord['result'])}>
            <option value="confirmed">确认窃电</option>
            <option value="cleared">排除（正常用户）</option>
            <option value="pending">待处理（已现场核查待结论）</option>
          </select>
        </Field>
        <Field label="确认的窃电手法（确认时填写）">
          <select value={mode} disabled={result !== 'confirmed'} onChange={(e) => setMode(e.target.value as TheftMode)}>
            <option value="">未指明</option>
            {THEFT_MODES.map((m) => <option key={m.value} value={m.value}>{m.label}</option>)}
          </select>
        </Field>
        <Field label="稽查人">
          <input value={inspector} placeholder="姓名/工号" onChange={(e) => setInspector(e.target.value)} />
        </Field>
      </div>
      <Field label="现场备注">
        <textarea rows={4} value={note} placeholder="现场情况、取证方式、计量装置异常描述…" onChange={(e) => setNote(e.target.value)} />
      </Field>
      <div style={{ marginTop: 14, display: 'flex', gap: 10, alignItems: 'center' }}>
        <Button variant="primary" onClick={submit}>保存回填</Button>
        {saved && <Tag tone="green">已保存，模型评估已更新</Tag>}
        <span className="muted small">回填时的嫌疑分 {currentScore.toFixed(1)} 将随记录保存，用于后续分析分数漂移</span>
      </div>
    </div>
  );
}

function shim(s: ReturnType<typeof useAppState>) {
  return {
    meta: s.meta!,
    profiles: s.profiles,
    events: s.events,
    labels: s.labels,
    analytics: s.analytics,
    clusters: s.clusters,
    issues: s.issues,
    taRecords: s.taRecords,
    inspections: s.inspections,
    blockIndex: [],
  };
}

void scoreTone;
