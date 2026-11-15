// 台区线损：按月聚合供电量/售电量，计算线损率
// 测试数据下供电量=真实用电量汇总；真实导入场景由台区供电量文件提供
import { SLOTS_PER_DAY } from './util.ts';
import type { TaRecord } from '../types.ts';

export interface TaLossTables {
  taIds: string[];
  monthCount: number;
  months: string[]; // YYYY-MM
  /** 展平数组 [taIndex * monthCount + month] */
  supply: Float64Array;
  sold: Float64Array;
  lossRate: Float64Array;
  truthTheftKwh: Float64Array;
}

export function monthKeys(startDate: string, days: number): string[] {
  const set: string[] = [];
  const d = new Date(startDate + 'T00:00:00Z');
  for (let i = 0; i < days; i++) {
    const key = d.toISOString().slice(0, 7);
    if (!set.includes(key)) set.push(key);
    d.setUTCDate(d.getUTCDate() + 1);
  }
  return set;
}

export interface TaAggInput {
  userId: string;
  taId: string;
  cleaned: Float32Array; // 一次侧 Wh（清洗后）
  truth?: Float32Array; // 测试真值
  monthOfSlot: Uint8Array; // 每槽位所属月份序号
}

export function aggregateTaLoss(
  inputs: TaAggInput[],
  taIds: string[],
  months: string[],
): TaLossTables {
  const m = months.length;
  const taIndex = new Map(taIds.map((id, i) => [id, i]));
  const supply = new Float64Array(taIds.length * m);
  const sold = new Float64Array(taIds.length * m);
  const theft = new Float64Array(taIds.length * m);

  for (const inp of inputs) {
    const ti = taIndex.get(inp.taId)!;
    const n = inp.cleaned.length;
    for (let i = 0; i < n; i++) {
      const mi = inp.monthOfSlot[i];
      const v = inp.cleaned[i];
      if (isFinite(v)) sold[ti * m + mi] += v / 1000;
      if (inp.truth) {
        const t = inp.truth[i];
        if (isFinite(t)) {
          supply[ti * m + mi] += t / 1000;
          if (isFinite(v)) theft[ti * m + mi] += Math.max(0, t - v) / 1000;
        }
      }
    }
  }

  const lossRate = new Float64Array(taIds.length * m);
  for (let i = 0; i < lossRate.length; i++) {
    lossRate[i] = supply[i] > 0 ? (supply[i] - sold[i]) / supply[i] : 0;
  }

  return { taIds, monthCount: m, months, supply, sold, lossRate, truthTheftKwh: theft };
}

/** 外部导入供电量时覆盖供电量并重算线损 */
export function applyExternalSupply(tables: TaLossTables, records: TaRecord[]): void {
  for (const r of records) {
    const ti = tables.taIds.indexOf(r.taId);
    const mi = tables.months.indexOf(r.month);
    if (ti < 0 || mi < 0) continue;
    tables.supply[ti * tables.monthCount + mi] = r.supplyKwh;
  }
  for (let i = 0; i < tables.lossRate.length; i++) {
    tables.lossRate[i] = tables.supply[i] > 0 ? (tables.supply[i] - tables.sold[i]) / tables.supply[i] : 0;
  }
}

export function slotMonthMap(startDate: string, days: number): { map: Uint8Array; months: string[] } {
  const months = monthKeys(startDate, days);
  const index = new Map(months.map((k, i) => [k, i]));
  const map = new Uint8Array(days * SLOTS_PER_DAY);
  const d = new Date(startDate + 'T00:00:00Z');
  for (let day = 0; day < days; day++) {
    const mi = index.get(d.toISOString().slice(0, 7))!;
    map.fill(mi, day * SLOTS_PER_DAY, (day + 1) * SLOTS_PER_DAY);
    d.setUTCDate(d.getUTCDate() + 1);
  }
  return { map, months };
}

export function flattenTaRecords(tables: TaLossTables): TaRecord[] {
  const out: TaRecord[] = [];
  for (let ti = 0; ti < tables.taIds.length; ti++) {
    for (let mi = 0; mi < tables.monthCount; mi++) {
      const idx = ti * tables.monthCount + mi;
      out.push({
        taId: tables.taIds[ti],
        month: tables.months[mi],
        supplyKwh: tables.supply[idx],
        soldKwh: tables.sold[idx],
        lossRate: tables.lossRate[idx],
        truthTheftKwh: tables.truthTheftKwh[idx],
      });
    }
  }
  return out;
}
