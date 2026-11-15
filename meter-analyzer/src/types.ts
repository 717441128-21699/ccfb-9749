// 全局类型定义

export type UserType = '居民' | '商业' | '工业';

export type TheftMode =
  | 'none'
  | 'constant_shunt' // 恒定分流（长期少计固定比例）
  | 'night_bypass' // 夜间旁路（特定时段旁路）
  | 'intermittent' // 间歇性窃电（随机日期少计）
  | 'phase_drop' // 缺相运行（周期性整段低计）
  | 'tamper_evolve'; // 渐进式改表（少计比例逐步增大）

export interface UserProfile {
  userId: string;
  meterId: string;
  taId: string; // 台区编号
  userType: UserType;
  capacityKva: number; // 合同容量
  installDate: string; // YYYY-MM-DD
}

export interface MeterEvent {
  meterId: string;
  eventType: '换表' | '倍率变化';
  effectiveDate: string; // YYYY-MM-DD
  /** 换表：新表倍率；倍率变化：新倍率 */
  newRatio: number;
  /** 倍率变化时的旧倍率；换表事件也记录旧表倍率 */
  oldRatio: number;
  note?: string;
}

export interface TheftLabel {
  userId: string;
  mode: TheftMode;
  startDate: string; // 窃电起始日（含）
  /** 少计比例 0~1（恒定/渐进模式的起始比例等，具体语义按模式） */
  strength: number;
}

export interface QualityIssue {
  userId: string;
  kind: 'gap' | 'freeze' | 'jump';
  startSlot: number; // 全局槽位序号
  endSlot: number; // 含
  detail: string;
}

export interface UserSeries {
  userId: string;
  /** 上报电量（Wh/15min），长度 = days*96，含 NaN 缺测 */
  reported: Float32Array;
  /** 真实用电量（Wh/15min），用于线损计算与（内部）模型验证 */
  truth: Float32Array;
}

/** 每个用户的聚合分析结果（常驻内存，紧凑结构） */
export interface UserAnalytics {
  userId: string;
  taId: string;
  userType: UserType;
  clusterId: number;
  totalEnergyKwh: number; // 清洗后年累计电量
  avgDailyKwh: number;
  validDayCount: number;
  // 数据质量
  gapCount: number;
  freezeCount: number;
  jumpCount: number;
  // 嫌疑特征证据（原始量）
  dropRate: number; // 后段日均 / 前段日均 - 1（绝对）
  peerShift: number; // 相对同簇 peers 的后段/前段水平 - 1（去季节性）
  changepointZ: number; // 绝对负荷突变点的 z 强度
  peerChangeZ: number; // 相对轨迹下行突变强度
  cvRatio: number; // 后期/前期相对波动比（间歇性特征）
  lowTailRatio: number; // 后期处于同簇最低 10% 分位以下的天数占比
  persistentWeak: number; // 后期相对轨迹低于自身前期基线 15% 的天数占比
  peerDeviation: number; // 与同簇中位曲线的平均偏离（归一化空间）
  taLossCorr: number; // 用户电量与台区线损的相关系数（负相关可疑）
  taLossMean: number; // 所属台区平均月线损率
  qualityFlag: number; // 异常数据点占比
  // 子分与总分（0~100）
  scoreDrop: number;
  scorePeer: number;
  scoreLoss: number;
  scoreQuality: number;
  totalScore: number;
  /** 96 点归一化典型曲线（该用户日均） */
  curve: Float32Array;
}

export interface TaRecord {
  taId: string;
  month: string; // YYYY-MM
  supplyKwh: number; // 供电量
  soldKwh: number; // 售电量（清洗后汇总）
  lossRate: number; // 线损率
  truthTheftKwh: number; // 真实窃电量（测试数据真值，仅用于验证）
}

export interface InspectionRecord {
  userId: string;
  inspectedAt: string; // ISO 日期
  result: 'confirmed' | 'cleared' | 'pending';
  scoreAtInspection: number;
  inspector: string;
  note: string;
  theftMode?: TheftMode;
}

export interface ClusterInfo {
  clusterId: number;
  centroid: Float32Array; // 96 点归一化曲线
  userCount: number;
  typeComposition: Record<UserType, number>;
}

export interface PipelineMeta {
  generatedAt: string;
  days: number;
  slotCount: number;
  userCount: number;
  taCount: number;
  startDate: string; // YYYY-MM-DD
  blockSize: number;
  blockCount: number;
  theftUserCount: number;
  labelVersion: number;
}

export type PageKey = 'import' | 'clean' | 'cluster' | 'suspect' | 'inspect';

export interface ProgressState {
  stage: string;
  percent: number; // 0~1
  message: string;
  running: boolean;
}
