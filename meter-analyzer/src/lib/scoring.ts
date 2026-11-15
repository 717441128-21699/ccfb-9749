// 窃电嫌疑打分：负荷突降 / 同类偏离 / 台区线损关联 / 数据质量 四个维度
// 子分使用全样本相对位次（0~100），保留全部原始特征值与贡献证据，UI 可逐项解释
import { percentileRankScores } from './util.ts';
import type { PeerFeatures, UserFeatures } from './features.ts';
import type { TaLossTables } from './taLoss.ts';

export interface ScoreWeights {
  drop: number;
  peer: number;
  loss: number;
  quality: number;
}

export const DEFAULT_WEIGHTS: ScoreWeights = { drop: 0.4, peer: 0.28, loss: 0.22, quality: 0.1 };

export interface ScoreInput {
  userId: string;
  taId: string;
  features: UserFeatures;
  peer: PeerFeatures;
  clusterId: number;
  qualityIssueRatio: number;
  gapCount: number;
  freezeCount: number;
  jumpCount: number;
}

export interface ScoreEvidence {
  userId: string;
  // 原始特征（页面展示用）
  dropRate: number;
  peerShift: number;
  changepointZ: number;
  peerChangeZ: number;
  changepointDay: number;
  peerChangeDay: number;
  cvRatio: number;
  lowTailRatio: number;
  persistentWeak: number;
  peerDeviation: number;
  taLossCorr: number; // 负值=电量走低时线损走高（可疑）
  taLossMean: number;
  qualityFlag: number;
  // 子分与总分
  scoreDrop: number;
  scorePeer: number;
  scoreLoss: number;
  scoreQuality: number;
  totalScore: number;
  weightPct: ScoreWeights;
}

/** 用户月度电量与所属台区月度线损率的相关性（窃电表现为显著负相关） */
function lossCorrelation(
  dailyKwh: Float32Array,
  daysPerMonth: number[],
  taLossSeries: Float64Array,
  monthCount: number,
): { corr: number; meanLoss: number } {
  const x: number[] = [];
  const y: number[] = [];
  let cursor = 0;
  for (let mi = 0; mi < monthCount; mi++) {
    const cnt = daysPerMonth[mi];
    let s = 0;
    let n = 0;
    for (let d = cursor; d < cursor + cnt && d < dailyKwh.length; d++) {
      if (isFinite(dailyKwh[d])) {
        s += dailyKwh[d];
        n++;
      }
    }
    cursor += cnt;
    if (n) {
      x.push(s / n);
      y.push(taLossSeries[mi]);
    }
  }
  const m = x.length;
  if (m < 3) return { corr: 0, meanLoss: avg(y) };
  const mx = avg(x);
  const my = avg(y);
  let cov = 0;
  let vx = 0;
  let vy = 0;
  for (let i = 0; i < m; i++) {
    const dx = x[i] - mx;
    const dy = y[i] - my;
    cov += dx * dy;
    vx += dx * dx;
    vy += dy * dy;
  }
  const corr = vx > 0 && vy > 0 ? cov / Math.sqrt(vx * vy) : 0;
  return { corr, meanLoss: my };
}

function avg(a: number[]): number {
  return a.length ? a.reduce((s, v) => s + v, 0) / a.length : 0;
}

export function scoreAll(
  inputs: ScoreInput[],
  centroids: Float32Array[],
  tables: TaLossTables,
  daysPerMonth: number[],
  weights: ScoreWeights = DEFAULT_WEIGHTS,
): ScoreEvidence[] {
  const n = inputs.length;

  // —— 负荷突降维度的原始量 ——
  const peerShiftRaw = new Float32Array(n); // 越负越可疑 → 取反
  const peerChangeRaw = new Float32Array(n); // 下行突变越大越可疑
  const rawDropRaw = new Float32Array(n);
  const rawChangeRaw = new Float32Array(n);
  const cvRaw = new Float32Array(n); // 间歇波动越大越可疑
  const tailRaw = new Float32Array(n); // 低尾天数占比越大越可疑
  const weakRaw = new Float32Array(n); // 持续偏低占比越大越可疑
  // —— 同类偏离 ——
  const shapeDevRaw = new Float32Array(n);
  // —— 线损 ——
  const corrRaw = new Float32Array(n); // 越负越可疑 → 取反
  const lossLevelRaw = new Float32Array(n);
  // —— 数据质量 ——
  const qualityRaw = new Float32Array(n);

  const pre: { peerDev: number; corr: number; meanLoss: number }[] = [];

  for (let i = 0; i < n; i++) {
    const inp = inputs[i];
    peerShiftRaw[i] = -inp.peer.peerShift;
    peerChangeRaw[i] = inp.peer.peerChangeZ;
    rawDropRaw[i] = -inp.features.dropRate;
    rawChangeRaw[i] = inp.features.changepointZ;
    cvRaw[i] = inp.peer.cvRatio;
    tailRaw[i] = inp.peer.lowTailRatio;
    weakRaw[i] = inp.peer.persistentWeak;

    let peerDev = 0;
    const cen = centroids[inp.clusterId];
    if (cen) {
      for (let s = 0; s < cen.length; s++) peerDev += Math.abs(inp.features.curve[s] - cen[s]);
    }
    shapeDevRaw[i] = peerDev;

    const ti = tables.taIds.indexOf(inp.taId);
    const series = tables.lossRate.subarray(ti * tables.monthCount, (ti + 1) * tables.monthCount);
    const { corr, meanLoss } = lossCorrelation(
      inp.features.dailyKwh,
      daysPerMonth,
      series as Float64Array,
      tables.monthCount,
    );
    corrRaw[i] = -corr; // 负相关 → 高分
    lossLevelRaw[i] = meanLoss;
    qualityRaw[i] = inp.qualityIssueRatio;
    pre.push({ peerDev, corr, meanLoss });
  }

  const rPeerShift = percentileRankScores(peerShiftRaw);
  const rPeerChange = percentileRankScores(peerChangeRaw);
  const rRawDrop = percentileRankScores(rawDropRaw);
  const rRawChange = percentileRankScores(rawChangeRaw);
  const rCv = percentileRankScores(cvRaw);
  const rTail = percentileRankScores(tailRaw);
  const rWeak = percentileRankScores(weakRaw);
  const rShape = percentileRankScores(shapeDevRaw);
  const rCorr = percentileRankScores(corrRaw);
  const rLoss = percentileRankScores(lossLevelRaw);
  const rQuality = percentileRankScores(qualityRaw);

  return inputs.map((inp, i) => {
    // 负荷突降：相对走低 30% + 下行突变 20% + 低尾 15% + 持续偏低 15% + 绝对信号 20%
    const scoreDrop =
      rPeerShift[i] * 0.3 +
      rPeerChange[i] * 0.2 +
      rTail[i] * 0.15 +
      rWeak[i] * 0.15 +
      rRawDrop[i] * 0.1 +
      rRawChange[i] * 0.1;
    // 同类偏离：曲线形状偏离 65% + 间歇波动 35%
    const scorePeer = rShape[i] * 0.65 + rCv[i] * 0.35;
    // 台区线损：电量-线损负相关 60% + 台区线损绝对水平 40%
    const scoreLoss = rCorr[i] * 0.6 + rLoss[i] * 0.4;
    const scoreQuality = rQuality[i];

    const totalScore =
      scoreDrop * weights.drop +
      scorePeer * weights.peer +
      scoreLoss * weights.loss +
      scoreQuality * weights.quality;

    return {
      userId: inp.userId,
      dropRate: inp.features.dropRate,
      peerShift: inp.peer.peerShift,
      changepointZ: inp.features.changepointZ,
      peerChangeZ: inp.peer.peerChangeZ,
      changepointDay: inp.features.changepointDay,
      peerChangeDay: inp.peer.peerChangeDay,
      cvRatio: inp.peer.cvRatio,
      lowTailRatio: inp.peer.lowTailRatio,
      persistentWeak: inp.peer.persistentWeak,
      peerDeviation: pre[i].peerDev,
      taLossCorr: pre[i].corr,
      taLossMean: pre[i].meanLoss,
      qualityFlag: inp.qualityIssueRatio,
      scoreDrop,
      scorePeer,
      scoreLoss,
      scoreQuality,
      totalScore,
      weightPct: weights,
    };
  });
}
