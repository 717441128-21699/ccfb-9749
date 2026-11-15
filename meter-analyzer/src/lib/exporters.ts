// 分析结果导出：嫌疑名单、聚类名册、台区线损、稽查记录、评估报告（CSV，本机生成）
import { toCsv } from './csv.ts';
import { THEFT_MODE_LABEL, pct } from './util.ts';
import { evaluate } from './evaluation.ts';
import type { DatasetIndex } from './storage.ts';
import type { UserAnalytics } from '../types.ts';

function stamp(): string {
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}_${p(d.getHours())}${p(d.getMinutes())}`;
}

export function exportSuspectList(index: DatasetIndex, rows?: UserAnalytics[]): void {
  const labelMap = new Map(index.labels.map((l) => [l.userId, l]));
  const inspectMap = new Map(index.inspections.map((r) => [r.userId, r]));
  const data = [...(rows ?? index.analytics)].sort((a, b) => b.totalScore - a.totalScore);
  const headers = [
    '排名', '用户编号', '台区', '用户类型', '所属簇', '总分',
    '负荷突降分', '同类偏离分', '线损关联分', '数据质量分',
    '相对同类走低', '突变强度σ', '低尾占比', '持续偏低占比', '曲线偏离',
    '电量线损相关系数', '台区均线损率', '异常点占比',
    '日均电量kWh', '年电量kWh', '稽查状态', '真值模式(演示)',
  ];
  const body = data.map((a, i) => {
    const label = labelMap.get(a.userId);
    const rec = inspectMap.get(a.userId);
    return [
      i + 1, a.userId, a.taId, a.userType, a.clusterId, a.totalScore.toFixed(2),
      a.scoreDrop.toFixed(2), a.scorePeer.toFixed(2), a.scoreLoss.toFixed(2), a.scoreQuality.toFixed(2),
      (a.peerShift * 100).toFixed(2) + '%', a.peerChangeZ.toFixed(2),
      (a.lowTailRatio * 100).toFixed(2) + '%', (a.persistentWeak * 100).toFixed(2) + '%',
      a.peerDeviation.toFixed(4), a.taLossCorr.toFixed(3),
      (a.taLossMean * 100).toFixed(2) + '%', (a.qualityFlag * 100).toFixed(3) + '%',
      a.avgDailyKwh.toFixed(2), a.totalEnergyKwh.toFixed(1),
      rec ? (rec.result === 'confirmed' ? '确认窃电' : rec.result === 'cleared' ? '排除' : '待处理') : '未稽查',
      label ? THEFT_MODE_LABEL[label.mode] ?? label.mode : '',
    ];
  });
  download('窃电嫌疑名单', toCsv(headers, body));
}

export function exportClusterRoster(index: DatasetIndex): void {
  const headers = ['簇号', '簇内户数', '用户编号', '台区', '用户类型', '日均电量kWh', '总分'];
  const body = [...index.analytics]
    .sort((a, b) => a.clusterId - b.clusterId || b.avgDailyKwh - a.avgDailyKwh)
    .map((a) => [a.clusterId, '', a.userId, a.taId, a.userType, a.avgDailyKwh.toFixed(2), a.totalScore.toFixed(2)]);
  // 户数列只在每簇首行写
  const seen = new Set<number>();
  for (const r of body) {
    if (!seen.has(Number(r[0]))) {
      r[1] = String(index.clusters.find((c) => c.clusterId === Number(r[0]))?.userCount ?? '');
      seen.add(Number(r[0]));
    }
  }
  download('聚类名册', toCsv(headers, body));
}

export function exportTaLoss(index: DatasetIndex): void {
  const headers = ['台区编号', '月份', '供电量kWh', '售电量kWh', '线损率', '真实窃电量kWh(演示)'];
  const body = index.taRecords.map((r) => [
    r.taId, r.month, r.supplyKwh.toFixed(1), r.soldKwh.toFixed(1),
    (r.lossRate * 100).toFixed(2) + '%', r.truthTheftKwh.toFixed(1),
  ]);
  download('台区线损台账', toCsv(headers, body));
}

export function exportInspections(index: DatasetIndex): void {
  const profileMap = new Map(index.profiles.map((p) => [p.userId, p]));
  const headers = ['用户编号', '台区', '稽查日期', '稽查结果', '稽查时嫌疑分', '稽查人', '窃电模式', '备注'];
  const body = index.inspections.map((r) => [
    r.userId, profileMap.get(r.userId)?.taId ?? '', r.inspectedAt,
    r.result === 'confirmed' ? '确认窃电' : r.result === 'cleared' ? '排除' : '待处理',
    r.scoreAtInspection.toFixed(2), r.inspector,
    r.theftMode ? THEFT_MODE_LABEL[r.theftMode] ?? r.theftMode : '', r.note,
  ]);
  download('稽查反馈记录', toCsv(headers, body));
}

export function exportEvaluation(index: DatasetIndex): void {
  const m = evaluate(index);
  const lines: string[] = [];
  lines.push(`模型评估报告（生成时间 ${new Date().toLocaleString()}）`);
  lines.push(`总用户数,${m.totalUsers}`);
  lines.push(`埋入窃电户数,${m.labeledTheft}`);
  lines.push('');
  lines.push('Top-N,命中数,精确率,召回率');
  for (const t of m.topN) lines.push(`${t.n},${t.hits},${pct(t.precision)},${pct(t.recall)}`);
  lines.push('');
  lines.push('分数段,用户数,窃电户数,段内精确率');
  for (const b of m.buckets) lines.push(`${b.range},${b.users},${b.theft},${pct(b.precision)}`);
  lines.push('');
  lines.push('窃电模式,该模式户数,Top1000命中,命中率');
  for (const x of m.byMode) lines.push(`${THEFT_MODE_LABEL[x.mode] ?? x.mode},${x.total},${x.top1000Hits},${pct(x.rate)}`);
  lines.push('');
  lines.push(`已稽查,${m.inspected},确认,${m.confirmed},排除,${m.cleared},待处理,${m.pending}`);
  lines.push(`稽查反馈命中率,${m.inspectionPrecision === null ? '暂无结案记录' : pct(m.inspectionPrecision)}`);
  download('模型评估报告', lines.join('\r\n'), 'text/csv;charset=utf-8', '.csv');
}

function download(name: string, content: string, mime = 'text/csv;charset=utf-8', ext = '.csv'): void {
  const blob = new Blob(['﻿' + content], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `${name}_${stamp()}${ext}`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 5000);
}

// 保持 pct 引用（tree-shaking 友好）
void pct;
