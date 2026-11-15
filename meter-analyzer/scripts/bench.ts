// Node 基准测试：不依赖浏览器/OPFS，直接验证全流程算法耗时
// 运行：node --experimental-strip-types scripts/bench.ts [用户数] [天数]
import { generateMeta } from '../src/lib/generateMeta.ts';
import { generateUserSeries } from '../src/lib/generateSeries.ts';
import { cleanSeries, correctRatio } from '../src/lib/cleaning.ts';
import { buildFeatures, buildPeerFeatures, type UserFeatures } from '../src/lib/features.ts';
import { runClustering, buildClusterInfo } from '../src/lib/clustering.ts';
import { slotMonthMap, aggregateTaLoss } from '../src/lib/taLoss.ts';
import { scoreAll, DEFAULT_WEIGHTS } from '../src/lib/scoring.ts';
import { THEFT_MODE_LABEL } from '../src/lib/util.ts';
import type { QualityIssue } from '../src/types.ts';

const userCount = Number(process.argv[2] ?? 50000);
const days = Number(process.argv[3] ?? 365);
const startDate = '2025-01-01';
const taCount = Math.max(20, Math.round(userCount / 250));

function fmt(ms: number): string {
  return ms < 1000 ? `${ms.toFixed(0)}ms` : `${(ms / 1000).toFixed(2)}s`;
}

async function main(): Promise<void> {
  const t0 = performance.now();
  console.log(`=== 基准测试：${userCount} 户 × ${days} 天（${days * 96} 点/户），${taCount} 个台区 ===`);

  const tMeta = performance.now();
  const genMeta = generateMeta({ userCount, days, startDate, taCount, theftRatio: 0.04 });
  console.log(`[1/6] 档案/事件/标签生成      ${fmt(performance.now() - tMeta)}  窃电户 ${genMeta.labels.length}`);

  // 曲线生成（同步模拟，浏览器端由 Worker 并行）
  const tGen = performance.now();
  let tGenOnly = 0;
  let tCleanOnly = 0;
  const allCleaned: Float32Array[] = new Array(userCount);
  const allTruth: Float32Array[] = new Array(userCount);
  const issues: QualityIssue[] = [];
  for (let i = 0; i < userCount; i++) {
    const p = genMeta.profiles[i];
    const ratios = genMeta.ratioByDay.get(p.userId)!;
    const label = genMeta.labels.find((l) => l.userId === p.userId);
    const quality = genMeta.qualityPlan.get(p.userId);
    const a1 = performance.now();
    const { reported, truth } = generateUserSeries(p, { days, startDate, ratios, label, quality });
    tGenOnly += performance.now() - a1;
    const corrected = correctRatio(reported, ratios);
    const a2 = performance.now();
    const res = cleanSeries(p.userId, corrected, days);
    tCleanOnly += performance.now() - a2;
    allCleaned[i] = res.cleaned;
    allTruth[i] = truth;
    if (i < 500) issues.push(...res.issues); // 仅抽样保留问题清单，控制内存
    if ((i + 1) % 10000 === 0) console.log(`      生成+清洗进度 ${i + 1}/${userCount}  ${fmt(performance.now() - tGen)}`);
  }
  const genMs = performance.now() - tGen;
  console.log(`[2/6] 曲线生成+清洗（单线程）  ${fmt(genMs)}（生成 ${fmt(tGenOnly)} / 清洗 ${fmt(tCleanOnly)}）`);

  const tFeat = performance.now();
  const features: UserFeatures[] = new Array(userCount);
  for (let i = 0; i < userCount; i++) {
    features[i] = buildFeatures(genMeta.profiles[i].userId, allCleaned[i], days);
  }
  console.log(`[3/6] 特征提取                ${fmt(performance.now() - tFeat)}`);

  const tCluster = performance.now();
  const cluster = runClustering(features.map((f) => f.curve), { kMin: 4, kMax: 9, silhouetteSampleSize: 1200 });
  const clusters = buildClusterInfo(cluster.labels, cluster.centroids, genMeta.profiles.map((p) => p.userType));
  console.log(
    `[4/6] 聚类 k=${cluster.k} 轮廓=${cluster.silhouette.toFixed(3)}  ${fmt(performance.now() - tCluster)}`,
  );
  for (const c of clusters) {
    console.log(
      `      簇${c.clusterId}: ${c.userCount} 户 (居民${c.typeComposition.居民}/商业${c.typeComposition.商业}/工业${c.typeComposition.工业})`,
    );
  }

  const tTa = performance.now();
  const { map: monthOfSlot, months } = slotMonthMap(startDate, days);
  const taInputs = genMeta.profiles.map((p, i) => ({
    userId: p.userId,
    taId: p.taId,
    cleaned: allCleaned[i],
    truth: allTruth[i],
    monthOfSlot,
  }));
  const taIds = Array.from(new Set(genMeta.profiles.map((p) => p.taId))).sort();
  const tables = aggregateTaLoss(taInputs, taIds, months);
  console.log(`[5/6] 台区线损聚合            ${fmt(performance.now() - tTa)}`);

  const tScore = performance.now();
  const issueSlots = new Map<string, number>();
  for (const iss of issues) issueSlots.set(iss.userId, (issueSlots.get(iss.userId) ?? 0) + (iss.endSlot - iss.startSlot + 1));

  // 同类相对轨迹特征
  const tPeer = performance.now();
  const peerFeatures = buildPeerFeatures(features, cluster.labels, days);
  console.log(`      同类相对轨迹特征        ${fmt(performance.now() - tPeer)}`);

  const scoreInputs = genMeta.profiles.map((p, i) => ({
    userId: p.userId,
    taId: p.taId,
    features: features[i],
    peer: peerFeatures[i],
    clusterId: cluster.labels[i],
    qualityIssueRatio: (issueSlots.get(p.userId) ?? 0) / (days * 96),
    gapCount: 0,
    freezeCount: 0,
    jumpCount: 0,
  }));
  const daysPerMonth = months.map((mk) => {
    const d = new Date(startDate + 'T00:00:00Z');
    let n = 0;
    for (let i = 0; i < days; i++) {
      if (d.toISOString().slice(0, 7) === mk) n++;
      d.setUTCDate(d.getUTCDate() + 1);
    }
    return n;
  });
  const evidences = scoreAll(scoreInputs, cluster.centroids, tables, daysPerMonth, DEFAULT_WEIGHTS);
  console.log(`[6/6] 嫌疑打分                ${fmt(performance.now() - tScore)}`);

  // 模型有效性验证：Top-N 命中率（对照埋入的窃电标签）
  const labelMap = new Map(genMeta.labels.map((l) => [l.userId, l]));
  const ranked = [...evidences].sort((a, b) => b.totalScore - a.totalScore);
  const theftTotal = genMeta.labels.length;
  const topN = [50, 100, 200, 500, 1000, 2000];
  console.log('\n=== 模型命中率（对照已知窃电标签）===');
  for (const n of topN) {
    if (n > ranked.length) continue;
    const hit = ranked.slice(0, n).filter((e) => labelMap.has(e.userId)).length;
    console.log(`Top${String(n).padStart(5)}: 命中 ${hit}  命中率 ${((hit / n) * 100).toFixed(1)}%  覆盖全部窃电户 ${((hit / theftTotal) * 100).toFixed(1)}%`);
  }

  // 分模式命中率（Top1000）
  const modeHit = new Map<string, { hit: number; total: number }>();
  for (const l of genMeta.labels) {
    const e = modeHit.get(l.mode) ?? { hit: 0, total: 0 };
    e.total++;
    modeHit.set(l.mode, e);
  }
  const top1000 = new Set(ranked.slice(0, 1000).map((e) => e.userId));
  for (const l of genMeta.labels) {
    if (top1000.has(l.userId)) modeHit.get(l.mode)!.hit++;
  }
  console.log('\n分模式 Top1000 命中：');
  for (const [mode, v] of modeHit) {
    console.log(`  ${THEFT_MODE_LABEL[mode] ?? mode}: ${v.hit}/${v.total} (${((v.hit / v.total) * 100).toFixed(0)}%)`);
  }

  // 内存占用
  const mb = (x: number) => (x / 1024 / 1024).toFixed(0) + 'MB';
  const curveBytes = userCount * days * 96 * 4 * 2;
  const featureBytes = userCount * (days * 4 + 96 * 4 + 128);
  console.log(`\n曲线内存估算: ${mb(curveBytes)}（单套），特征+日电量: ${mb(featureBytes)}`);
  console.log(`=== 总耗时 ${fmt(performance.now() - t0)}（单线程；浏览器 14 Worker 并行预期生成/清洗阶段加速 6~10 倍）===`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
