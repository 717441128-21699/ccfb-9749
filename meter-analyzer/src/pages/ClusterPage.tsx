// 页面三：负荷聚类（各簇典型曲线、户数、用户类型构成、成员明细）
import { useMemo, useState } from 'react';
import { useAppState } from '../state/store.ts';
import { Card, Empty, StatCard, Tag } from '../components/ui.tsx';
import { BarChart, LineChart } from '../components/Charts.tsx';
import { slotToTimeLabel, USER_TYPES } from '../lib/util.ts';
import type { UserType } from '../types.ts';

const CLUSTER_COLORS = ['#2563eb', '#059669', '#d97706', '#7c3aed', '#dc2626', '#0891b2', '#db2777', '#65a30d', '#475569'];

export function ClusterPage(): JSX.Element {
  const s = useAppState();
  const [active, setActive] = useState(0);

  const members = useMemo(
    () => s.analytics.filter((a) => a.clusterId === active),
    [s.analytics, active],
  );

  if (!s.meta || !s.clusters.length) return <Empty text="请先在「数据导入」页生成数据集并完成聚类" />;

  const xLabels = Array.from({ length: 96 }, (_, i) => (i % 8 === 0 ? slotToTimeLabel(i) : ''));
  const centroidSeries = s.clusters.map((c, i) => ({
    name: `簇${c.clusterId}（${c.userCount}户）`,
    points: Array.from(c.centroid),
    color: CLUSTER_COLORS[i % CLUSTER_COLORS.length],
    width: i === active ? 2.6 : 1.3,
  }));

  const activeCluster = s.clusters.find((c) => c.clusterId === active) ?? s.clusters[0];
  const compData = USER_TYPES.map((t: UserType) => ({
    label: t,
    value: activeCluster.typeComposition[t],
    color: t === '居民' ? '#2563eb' : t === '商业' ? '#059669' : '#d97706',
  }));

  // 簇内成员的归一化曲线抽样叠加
  const sampleMembers = members.slice(0, 60);
  const overlaySeries = [
    {
      name: `簇${active} 典型曲线`,
      points: Array.from(activeCluster.centroid),
      color: CLUSTER_COLORS[active % CLUSTER_COLORS.length],
      width: 3,
    },
    ...sampleMembers.map((m, i) => ({
      name: i === 0 ? '成员曲线（抽样60户）' : '',
      points: Array.from(m.curve),
      color: 'rgba(100,116,139,0.28)',
      width: 1,
    })),
  ];

  return (
    <div>
      <div className="grid grid-4" style={{ marginBottom: 16 }}>
        <StatCard label="聚类簇数 k" value={s.clusters.length} tone="blue" />
        <StatCard label="轮廓系数" value={s.silhouette?.toFixed(3) ?? '-'} sub="抽样 1200 户评估" tone="green" />
        <StatCard label="最大簇规模" value={Math.max(...s.clusters.map((c) => c.userCount))} />
        <StatCard label="最小簇规模" value={Math.min(...s.clusters.map((c) => c.userCount))} />
      </div>

      <Card title="全部簇的典型日负荷曲线（归一化，96 点）">
        <LineChart height={300} series={centroidSeries} xLabels={xLabels} xTickEvery={8} unit="" />
        <div className="pill-row" style={{ marginTop: 10 }}>
          {s.clusters.map((c) => (
            <button
              key={c.clusterId}
              className={`tag ${c.clusterId === active ? 'tag-blue' : 'tag-gray'}`}
              style={{ cursor: 'pointer', border: 'none' }}
              onClick={() => setActive(c.clusterId)}
            >
              簇{c.clusterId}：{c.userCount} 户
            </button>
          ))}
        </div>
      </Card>

      <div className="grid grid-2">
        <Card title={`簇 ${active} 成员曲线叠加（抽样 ${sampleMembers.length} 户）`}>
          <LineChart height={280} series={overlaySeries} xLabels={xLabels} xTickEvery={8} />
        </Card>
        <Card title={`簇 ${active} 用户类型构成`}>
          <BarChart data={compData} height={280} />
        </Card>
      </div>

      <Card title={`簇 ${active} 成员明细（共 ${members.length} 户，按日均电量排序）`}>
        <div className="table-wrap">
          <table className="data">
            <thead>
              <tr><th>用户编号</th><th>台区</th><th>类型</th><th>日均电量(kWh)</th><th>年电量(kWh)</th><th>嫌疑分</th></tr>
            </thead>
            <tbody>
              {[...members]
                .sort((a, b) => b.avgDailyKwh - a.avgDailyKwh)
                .slice(0, 300)
                .map((m) => (
                  <tr key={m.userId}>
                    <td>{m.userId}</td>
                    <td>{m.taId}</td>
                    <td>{m.userType}</td>
                    <td>{m.avgDailyKwh.toFixed(1)}</td>
                    <td>{m.totalEnergyKwh.toFixed(0)}</td>
                    <td>
                      <Tag tone={m.totalScore >= 70 ? 'red' : m.totalScore >= 50 ? 'amber' : 'gray'}>
                        {m.totalScore.toFixed(1)}
                      </Tag>
                    </td>
                  </tr>
                ))}
            </tbody>
          </table>
        </div>
        {members.length > 300 && <div className="small muted" style={{ marginTop: 8 }}>仅展示前 300 户，完整名单可在嫌疑排查页导出</div>}
      </Card>
    </div>
  );
}
