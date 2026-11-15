// 外部 CSV 导入：用户档案、换表/倍率事件、15 分钟负荷曲线、台区供电量
// 表头支持常见中文列名的模糊匹配；导入数据全程仅在本机解析
import { parseCsv } from './csv.ts';
import { addDays, dayIndexOf, SLOTS_PER_DAY } from './util.ts';
import type { MeterEvent, TaRecord, UserProfile, UserType } from '../types.ts';

export interface ImportReport {
  warnings: string[];
  errors: string[];
}

function pick(row: string[], headers: string[], aliases: string[]): string | undefined {
  for (const a of aliases) {
    const idx = headers.findIndex((h) => h.replace(/\s/g, '') === a || h.replace(/\s/g, '').includes(a));
    if (idx >= 0 && row[idx] !== undefined && row[idx] !== '') return row[idx].trim();
  }
  return undefined;
}

const USER_TYPE_MAP: Record<string, UserType> = {
  居民: '居民',
  居民用户: '居民',
  商业: '商业',
  商业用户: '商业',
  工业: '工业',
  工业用户: '工业',
};

export function parseProfiles(text: string, report: ImportReport): UserProfile[] {
  const { headers, rows } = parseCsv(text);
  const out: UserProfile[] = [];
  rows.forEach((row, i) => {
    const userId = pick(row, headers, ['用户编号', '户号', 'userId', '用户ID']);
    if (!userId) return;
    const meterId = pick(row, headers, ['电表编号', '表号', 'meterId', '电表ID']) ?? userId + '-M';
    const taId = pick(row, headers, ['台区编号', '台区', 'taId', '台区ID']) ?? 'TA001';
    const typeRaw = pick(row, headers, ['用户类型', '用电类别', 'userType']) ?? '居民';
    const userType = USER_TYPE_MAP[typeRaw] ?? '居民';
    const capacityKva = Number(pick(row, headers, ['合同容量', '容量', 'capacityKva']) ?? 0) || 0;
    const installDate = pick(row, headers, ['装表日期', '建档日期', 'installDate']) ?? '2025-01-01';
    if (!USER_TYPE_MAP[typeRaw] && typeRaw) {
      report.warnings.push(`第 ${i + 2} 行用户类型「${typeRaw}」未识别，按居民处理`);
    }
    out.push({ userId, meterId, taId, userType, capacityKva, installDate });
  });
  return out;
}

export function parseEvents(text: string, profiles: UserProfile[], report: ImportReport): MeterEvent[] {
  const { headers, rows } = parseCsv(text);
  const meterToUser = new Map(profiles.map((p) => [p.meterId, p.userId]));
  const out: MeterEvent[] = [];
  rows.forEach((row, i) => {
    const meterId = pick(row, headers, ['电表编号', '表号', 'meterId']);
    const typeRaw = pick(row, headers, ['事件类型', '类型', 'eventType']) ?? '';
    const date = pick(row, headers, ['生效日期', '日期', 'effectiveDate']);
    const newRatio = Number(pick(row, headers, ['新倍率', '倍率', 'newRatio']) ?? 1);
    const oldRatio = Number(pick(row, headers, ['旧倍率', 'oldRatio']) ?? newRatio);
    if (!meterId || !date) {
      report.warnings.push(`事件第 ${i + 2} 行缺表号或日期，已跳过`);
      return;
    }
    if (!meterToUser.has(meterId)) {
      report.warnings.push(`事件第 ${i + 2} 行表号 ${meterId} 在档案中不存在，已跳过`);
      return;
    }
    const eventType: MeterEvent['eventType'] = typeRaw.includes('换') ? '换表' : '倍率变化';
    out.push({
      meterId,
      eventType,
      effectiveDate: normalizeDate(date),
      newRatio: newRatio || 1,
      oldRatio: oldRatio || 1,
      note: pick(row, headers, ['备注', 'note']),
    });
  });
  return out;
}

/** 由事件表重建每用户按天倍率轨迹 */
export function buildRatioTrajectories(
  profiles: UserProfile[],
  events: MeterEvent[],
  days: number,
  startDate: string,
): Map<string, Float32Array> {
  const eventsByMeter = new Map<string, MeterEvent[]>();
  for (const e of events) {
    const list = eventsByMeter.get(e.meterId) ?? [];
    list.push(e);
    eventsByMeter.set(e.meterId, list);
  }
  const map = new Map<string, Float32Array>();
  for (const p of profiles) {
    const ratios = new Float32Array(days).fill(1);
    const list = eventsByMeter.get(p.meterId);
    if (list) {
      const sorted = [...list].sort((a, b) => a.effectiveDate.localeCompare(b.effectiveDate));
      let cur = sorted[0].oldRatio || 1;
      for (const e of sorted) {
        const day0 = Math.max(0, dayIndexOf(e.effectiveDate, startDate));
        for (let d = 0; d < Math.min(day0, days); d++) ratios[d] = cur;
        cur = e.newRatio || cur;
      }
      const lastDay = sorted.length ? Math.max(0, dayIndexOf(sorted[sorted.length - 1].effectiveDate, startDate)) : 0;
      for (let d = lastDay; d < days; d++) ratios[d] = cur;
    }
    map.set(p.userId, ratios);
  }
  return map;
}

/**
 * 负荷曲线 CSV：宽表（每行一户，列为各 15 分钟时间戳）或长表（户号,时间,电量）。
 * 时间戳支持 2025-01-01 00:00 / 2025-01-01T00:00:00。
 */
export function parseLoadCurves(
  text: string,
  profiles: UserProfile[],
  days: number,
  startDate: string,
  report: ImportReport,
): Map<string, Float32Array> {
  const { headers, rows } = parseCsv(text);
  const n = days * SLOTS_PER_DAY;
  const out = new Map<string, Float32Array>();
  const idCol = headers.findIndex((h) => /户号|用户编号|userId/.test(h));
  const timeCol = headers.findIndex((h) => /时间|时刻|timestamp/.test(h));
  const valCol = headers.findIndex((h) => /电量|kwh|wh|负荷|功率/i.test(h));

  if (timeCol >= 0 && valCol >= 0 && idCol >= 0) {
    // 长表
    const known = new Set(profiles.map((p) => p.userId));
    for (const row of rows) {
      const userId = row[idCol]?.trim();
      if (!userId || !known.has(userId)) continue;
      const slot = timestampToSlot(row[timeCol], startDate);
      if (slot < 0 || slot >= n) continue;
      let arr = out.get(userId);
      if (!arr) {
        arr = new Float32Array(n).fill(NaN);
        out.set(userId, arr);
      }
      arr[slot] = Number(row[valCol]);
    }
  } else if (idCol >= 0) {
    // 宽表：其余表头为时间戳
    const slotOfCol = headers.map((h) => timestampToSlot(h, startDate));
    for (const row of rows) {
      const userId = row[idCol]?.trim();
      if (!userId) continue;
      const arr = new Float32Array(n).fill(NaN);
      for (let c = 0; c < headers.length; c++) {
        if (c === idCol || slotOfCol[c] < 0) continue;
        const v = Number(row[c]);
        if (isFinite(v)) arr[slotOfCol[c]] = v;
      }
      out.set(userId, arr);
    }
  } else {
    report.errors.push('负荷曲线文件未识别到户号/时间列');
  }
  return out;
}

export function parseTaSupply(text: string, report: ImportReport): TaRecord[] {
  const { headers, rows } = parseCsv(text);
  const out: TaRecord[] = [];
  rows.forEach((row, i) => {
    const taId = pick(row, headers, ['台区编号', '台区', 'taId']);
    const month = pick(row, headers, ['月份', 'month']);
    const supplyKwh = Number(pick(row, headers, ['供电量', 'supplyKwh']) ?? NaN);
    if (!taId || !month || !isFinite(supplyKwh)) {
      report.warnings.push(`供电量第 ${i + 2} 行字段不全，已跳过`);
      return;
    }
    out.push({
      taId,
      month: month.slice(0, 7),
      supplyKwh,
      soldKwh: 0,
      lossRate: 0,
      truthTheftKwh: 0,
    });
  });
  return out;
}

function timestampToSlot(text: string, startDate: string): number {
  const t = text.trim().replace('T', ' ');
  const m = /^(\d{4}-\d{2}-\d{2})[ ]?(\d{2}):(\d{2})/.exec(t);
  if (!m) return -1;
  const day = dayIndexOf(m[1], startDate);
  if (day < 0) return -1;
  const slot = Number(m[2]) * 4 + Math.floor(Number(m[3]) / 15);
  return day * SLOTS_PER_DAY + Math.min(slot, SLOTS_PER_DAY - 1);
}

function normalizeDate(s: string): string {
  const m = /^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})/.exec(s.trim());
  if (!m) return s;
  return `${m[1]}-${m[2].padStart(2, '0')}-${m[3].padStart(2, '0')}`;
}

/** 导出档案模板内容 */
export function profileTemplateCsv(): string {
  return ['用户编号,电表编号,台区编号,用户类型,合同容量,装表日期', 'U000001,M000001,TA001,居民,10,2025-01-01'].join('\r\n');
}

export function eventTemplateCsv(): string {
  return ['电表编号,事件类型,生效日期,旧倍率,新倍率,备注', 'M000001,倍率变化,2025-06-01,10,20,CT变比调整'].join('\r\n');
}

export function supplyTemplateCsv(): string {
  return ['台区编号,月份,供电量', 'TA001,2025-06,125000'].join('\r\n');
}

export { addDays };
