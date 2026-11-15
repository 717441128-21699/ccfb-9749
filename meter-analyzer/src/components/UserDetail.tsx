// 用户详情抽屉：档案、嫌疑分贡献拆解、历史日电量/典型曲线/月度与线损对照、稽查回填入口
import { useEffect, useMemo, useRef, useState } from 'react';
import { useAppState, appStore } from '../state/store.ts';
import { Button, ScoreBar, Tag, scoreTone } from './ui.tsx';
import { BarChart, LineChart } from './Charts.tsx';
import { PREFIX_CLEAN, PREFIX_RAW, slotCountOf, store } from '../lib/storage.ts';
import { SLOTS_PER_DAY, THEFT_MODE_LABEL, pct, slotToTimeLabel } from '../lib/util.ts';
import type { UserAnalytics } from '../types.ts';
import { InspectionForm } from '../pages/InspectPage.tsx';

export function UserDetail({ userId, onClose }: { userId: string; onClose: () => void }): JSX.Element {
  const s = useAppState();
  const a = s.analytics.find((x) => x.userId === userId);
  const profile = s.profiles.find((p) => p.userId === userId);
  const label = s.labels.find((l) => l.userId === userId);
  const inspection = s.inspections.find((r) => r.userId === userId);
  const [tab, setTab] = useState<'overview' | 'daily' | 'quarter'>('overview');
  const [day, setDay] = useState(Math.floor((s.meta?.days ?? 365) / 2));
  const [series, setSeries] = useState<{ daily: number[]; dayRaw: number[]; dayClean: number[]; monthly: number[] } | null>(null);
  const blockCache = useRef<{ key: string; raw: Float32Array; clean: Float32Array } | null>(null);

  const entry = useMemo(() => {
    if (!s.meta) return undefined;
    const idx = s.analytics.findIndex((x) => x.userId === userId);
    if (idx < 0) return undefined;
    return { block: Math.floor(idx / s.meta.blockSize), offset: idx % s.meta.blockSize };
  }, [s.analytics, s.meta, userId]);

  // 整块只加载一次并缓存，日期切换在本地切片（避免拖动滑块反复读盘）
  useEffect(() => {
    let cancelled = false;
    async function loadBlock(): Promise<void> {
      if (!s.meta || !entry) return;
      const key = `${entry.block}`;
      if (!blockCache.current || blockCache.current.key !== key) {
        const slotCount = slotCountOf(s.meta);
        const [rawBuf, cleanBuf] = await Promise.all([
          store.readBlockBuffer(PREFIX_RAW, entry.block),
          store.readBlockBuffer(PREFIX_CLEAN, entry.block),
        ]);
        if (cancelled) return;
        const recordFloats = slotCount * 2;
        const rawStart = (2 + entry.offset * recordFloats) * 4;
        const cleanStart = (2 + entry.offset * recordFloats) * 4;
        blockCache.current = {
          key,
          raw: new Float32Array(rawBuf, rawStart, recordFloats),
          clean: new Float32Array(cleanBuf, cleanStart, recordFloats),
        };
      }
      const cached = blockCache.current;
      const slotCount = slotCountOf(s.meta);
      const raw = { reported: cached.raw.subarray(0, slotCount), truth: cached.raw.subarray(slotCount) };
      const clean = { reported: cached.clean.subarray(0, slotCount) };
      const daily: number[] = [];
      for (let d = 0; d < s.meta!.days; d++) {
        let sum = 0;
        for (let k = 0; k < SLOTS_PER_DAY; k++) {
          const v = clean.reported[d * SLOTS_PER_DAY + k];
          if (isFinite(v)) sum += v;
        }
        daily.push(sum / 1000);
      }
      const months = Array.from(new Set(s.taRecords.map((r) => r.month))).sort();
      const monthly = months.map((mk) => {
        let sum = 0;
        const d0 = new Date(s.meta!.startDate + 'T00:00:00Z');
        for (let d = 0; d < s.meta!.days; d++) {
          if (d0.toISOString().slice(0, 7) === mk) sum += daily[d];
          d0.setUTCDate(d0.getUTCDate() + 1);
        }
        return sum;
      });
      const base = day * SLOTS_PER_DAY;
      setSeries({
        daily,
        monthly,
        dayRaw: Array.from(raw.reported.subarray(base, base + SLOTS_PER_DAY)),
        dayClean: Array.from(clean.reported.subarray(base, base + SLOTS_PER_DAY)),
      });
    }
    void loadBlock();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [userId, entry, day]);

  if (!a || !profile || !s.meta) {
    return (
      <div className="dialog-mask" onClick={onClose}>
        <div className="dialog" onClick={(e) => e.stopPropagation()}>未找到用户 {userId}</div>
      </div>
    );
  }

  const taLoss = s.taRecords.filter((r) => r.taId === a.taId).sort((x, y) => x.month.localeCompare(y.month));
  const centroid = s.clusters.find((c) => c.clusterId === a.clusterId)?.centroid;
  const xLabels = Array.from({ length: 96 }, (_, i) => (i % 8 === 0 ? slotToTimeLabel(i) : ''));
  const events = s.events.filter((e) => e.meterId === profile.meterId);

  return (
    <div className="dialog-mask" onClick={onClose}>
      <div className="dialog dialog-wide" onClick={(e) => e.stopPropagation()}>
        <div className="dialog-head">
          <div>
            <span className="dialog-title">用户 {userId}</span>
            <span style={{ marginLeft: 12 }} className="muted small">
              {profile.userType} ｜ {a.taId} ｜ 表号 {profile.meterId} ｜ 容量 {profile.capacityKva}kVA
            </span>
            {label && s.showTruthLabels && (
              <Tag tone="red">真值：{THEFT_MODE_LABEL[label.mode]}（{label.startDate} 起，少计{pct(label.strength, 0)}）</Tag>
            )}
            {inspection && (
              <Tag tone={inspection.result === 'confirmed' ? 'red' : inspection.result === 'cleared' ? 'green' : 'amber'}>
                已稽查：{inspection.result === 'confirmed' ? '确认窃电' : inspection.result === 'cleared' ? '排除' : '待处理'}
              </Tag>
            )}
          </div>
          <Button size="sm" onClick={onClose}>关闭</Button>
        </div>

        <div className="tabs">
          <button className={`tab ${tab === 'overview' ? 'active' : ''}`} onClick={() => setTab('overview')}>嫌疑分拆解</button>
          <button className={`tab ${tab === 'daily' ? 'active' : ''}`} onClick={() => setTab('daily')}>历史曲线</button>
          <button className={`tab ${tab === 'quarter' ? 'active' : ''}`} onClick={() => setTab('quarter')}>稽查回填</button>
        </div>

        {tab === 'overview' && <OverviewTab a={a} centroid={centroid} xLabels={xLabels} />}

        {tab === 'daily' && (
          <div>
            <div className="grid grid-2">
              <div>
                <div className="card-title small" style={{ marginBottom: 8 }}>全年日电量（kWh/天）</div>
                {series && <LineChart height={240} series={[{ name: '日电量', points: series.daily, color: '#2563eb' }]} xLabels={dayLabels(s.meta.days)} xTickEvery={45} unit=" kWh" />}
              </div>
              <div>
                <div className="card-title small" style={{ marginBottom: 8 }}>月电量 vs 台区线损率</div>
                {series && (
                  <>
                    <BarChart height={150} data={taLoss.map((r, i) => ({ label: r.month.slice(5), value: series.monthly[i], color: '#93c5fd' }))} unit=" kWh" />
                    <LineChart
                      height={120}
                      series={[{ name: '台区线损率', points: taLoss.map((r) => r.lossRate * 100), color: '#dc2626' }]}
                      xLabels={taLoss.map((r) => r.month.slice(5))}
                      xTickEvery={1}
                      unit="%"
                    />
                  </>
                )}
              </div>
            </div>
            <div className="card-title small" style={{ margin: '14px 0 8px' }}>
              单日 15 分钟曲线（第 {day + 1} 天）
              <input type="range" min={0} max={s.meta.days - 1} value={day} onChange={(e) => setDay(Number(e.target.value))} style={{ width: 300, marginLeft: 16 }} />
            </div>
            {series && (
              <LineChart
                height={260}
                xLabels={xLabels}
                xTickEvery={8}
                unit=" Wh"
                series={[
                  { name: '原始上报', points: series.dayRaw, color: '#dc2626', dashed: true },
                  { name: '清洗后', points: series.dayClean, color: '#2563eb', width: 2 },
                ]}
              />
            )}
            {events.length > 0 && (
              <div className="small muted" style={{ marginTop: 10 }}>
                表计事件：{events.map((e) => `${e.effectiveDate} ${e.eventType}（${e.oldRatio}→${e.newRatio}）`).join('；')}
              </div>
            )}
          </div>
        )}

        {tab === 'quarter' && <InspectionForm userId={userId} currentScore={a.totalScore} onDone={onClose} />}
      </div>
    </div>
  );
}

function OverviewTab({ a, centroid, xLabels }: { a: UserAnalytics; centroid: Float32Array | undefined; xLabels: string[] }): JSX.Element {
  return (
    <div className="grid grid-2">
      <div>
        <div className="card-title small" style={{ marginBottom: 10 }}>
          总分 <Tag tone={scoreTone(a.totalScore)}>{a.totalScore.toFixed(1)}</Tag>
          <span className="muted small" style={{ marginLeft: 8 }}>满分 100，全样本相对位次合成</span>
        </div>
        <ScoreBar label="① 负荷突降" score={a.scoreDrop} weight={a.scoreDrop ? 0.4 : 0.4} raw={`相对同类走低 ${pct(a.peerShift)}，突变强度 ${a.peerChangeZ.toFixed(1)}σ，低尾占比 ${pct(a.lowTailRatio)}，持续偏低 ${pct(a.persistentWeak)}`} />
        <ScoreBar label="② 同类用户偏离" score={a.scorePeer} weight={0.28} raw={`曲线形状偏离 ${a.peerDeviation.toFixed(3)}，后期/前期波动比 ${a.cvRatio.toFixed(2)}`} />
        <ScoreBar label="③ 台区线损关联" score={a.scoreLoss} weight={0.22} raw={`电量-线损相关系数 ${a.taLossCorr.toFixed(2)}（负相关可疑），台区均线损 ${pct(a.taLossMean)}`} />
        <ScoreBar label="④ 数据质量" score={a.scoreQuality} weight={0.1} raw={`异常点占比 ${pct(a.qualityFlag, 2)}，缺测${a.gapCount}/冻结${a.freezeCount}/跳变${a.jumpCount}`} />
        <div className="small muted" style={{ marginTop: 6, lineHeight: 1.8 }}>
          每个子分均为该特征在全体用户中的百分位排名（0~100）；总分 = 子分 × 权重之和。
          权重可在嫌疑排查页调整后实时重算。
        </div>
      </div>
      <div>
        <div className="card-title small" style={{ marginBottom: 8 }}>典型曲线 vs 所属簇中心（归一化）</div>
        <LineChart
          height={260}
          xLabels={xLabels}
          xTickEvery={8}
          series={[
            { name: `本户（簇${a.clusterId}）`, points: Array.from(a.curve), color: '#2563eb', width: 2.4 },
            { name: '簇中心曲线', points: centroid ? Array.from(centroid) : [], color: '#dc2626', dashed: true },
          ]}
        />
        <div className="kv" style={{ marginTop: 14 }}>
          <div><div className="k">年累计电量</div><div className="v">{a.totalEnergyKwh.toFixed(0)} kWh</div></div>
          <div><div className="k">日均电量</div><div className="v">{a.avgDailyKwh.toFixed(1)} kWh</div></div>
          <div><div className="k">有效天数</div><div className="v">{a.validDayCount} 天</div></div>
          <div><div className="k">所属簇</div><div className="v">簇 {a.clusterId}</div></div>
        </div>
      </div>
    </div>
  );
}

function dayLabels(days: number): string[] {
  return Array.from({ length: days }, (_, d) => (d % 45 === 0 ? `D${d + 1}` : ''));
}

export { appStore };
