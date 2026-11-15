// OPFS 本地存储：曲线按用户分块存为二进制文件，元数据/档案/结果为 JSON
// 所有数据仅写入浏览器源私有文件系统，不上传任何远端
import type {
  ClusterInfo,
  InspectionRecord,
  MeterEvent,
  PipelineMeta,
  QualityIssue,
  TaRecord,
  TheftLabel,
  UserAnalytics,
  UserProfile,
} from '../types.ts';
import { DEFAULT_BLOCK_SIZE, SLOTS_PER_DAY } from './util.ts';

const ROOT = 'meter-analyzer';
const MAGIC = 0x4d4c4131; // 'MLA1'
export const PREFIX_RAW = 'block';
export const PREFIX_CLEAN = 'cleaned';

export interface BlockIndexEntry {
  userId: string;
  block: number;
  offset: number; // 块内记录偏移
}

export interface DatasetIndex {
  meta: PipelineMeta;
  profiles: UserProfile[];
  events: MeterEvent[];
  labels: TheftLabel[];
  blockIndex: BlockIndexEntry[];
  issues: QualityIssue[];
  analytics: UserAnalytics[];
  clusters: ClusterInfo[];
  taRecords: TaRecord[];
  inspections: InspectionRecord[];
}

async function getRoot(): Promise<FileSystemDirectoryHandle> {
  return await navigator.storage.getDirectory().then((d) => d.getDirectoryHandle(ROOT, { create: true }));
}

async function writeJson(dir: FileSystemDirectoryHandle, name: string, value: unknown): Promise<void> {
  const fh = await dir.getFileHandle(name, { create: true });
  const w = await (fh as any).createWritable();
  await w.write(JSON.stringify(value));
  await w.close();
}

async function readJson<T>(dir: FileSystemDirectoryHandle, name: string): Promise<T | null> {
  try {
    const fh = await dir.getFileHandle(name);
    const file = await (fh as any).getFile();
    return JSON.parse(await file.text());
  } catch {
    return null;
  }
}

function blockFileName(prefix: string, block: number): string {
  return `${prefix}-${String(block).padStart(4, '0')}.bin`;
}

export class OpfsStore {
  private dir: FileSystemDirectoryHandle | null = null;

  private async root(): Promise<FileSystemDirectoryHandle> {
    if (!this.dir) this.dir = await getRoot();
    return this.dir;
  }

  static isAvailable(): boolean {
    return typeof navigator !== 'undefined' && !!navigator.storage?.getDirectory;
  }

  async estimate(): Promise<{ quota: number; usage: number }> {
    if (!navigator.storage?.estimate) return { quota: 0, usage: 0 };
    const e = await navigator.storage.estimate();
    return { quota: e.quota ?? 0, usage: e.usage ?? 0 };
  }

  /** 写入一个用户块：reported + truth 各一条 Float32 记录，8 字节头，单 buffer 一次落盘 */
  async writeBlock(
    prefix: string,
    block: number,
    records: { userId: string; reported: Float32Array; truth: Float32Array }[],
    slotCount: number,
  ): Promise<void> {
    const buffer = buildBlockBuffer(records, slotCount);
    const dir = await this.root();
    const fh = await dir.getFileHandle(blockFileName(prefix, block), { create: true });
    const w = await (fh as any).createWritable();
    await w.write(buffer);
    await w.close();
  }

  /** Worker 专用：同步句柄写入（createSyncAccessHandle 仅 Worker 可用，吞吐显著更高） */
  async writeBlockSync(
    prefix: string,
    block: number,
    records: { userId: string; reported: Float32Array; truth: Float32Array }[],
    slotCount: number,
  ): Promise<void> {
    const buffer = buildBlockBuffer(records, slotCount);
    const dir = await this.root();
    const fh = await dir.getFileHandle(blockFileName(prefix, block), { create: true });
    const handle = await (fh as any).createSyncAccessHandle();
    try {
      handle.truncate(0);
      handle.write(buffer);
    } finally {
      handle.close();
    }
  }

  /** Worker 专用：同步句柄整块读取 */
  async readBlockBufferSync(prefix: string, block: number): Promise<ArrayBuffer> {
    const dir = await this.root();
    const fh = await dir.getFileHandle(blockFileName(prefix, block));
    const handle = await (fh as any).createSyncAccessHandle();
    try {
      const size = handle.getSize();
      const buffer = new ArrayBuffer(size);
      handle.read(buffer, { at: 0 });
      return buffer;
    } finally {
      handle.close();
    }
  }

  /** 读取单户两条曲线 */
  async readUser(prefix: string, entry: BlockIndexEntry, slotCount: number): Promise<{ reported: Float32Array; truth: Float32Array }> {
    const dir = await this.root();
    const fh = await dir.getFileHandle(blockFileName(prefix, entry.block));
    const file = await (fh as any).getFile();
    const recordBytes = slotCount * 4 * 2;
    const fileOffset = 8 + entry.offset * recordBytes;
    const buf = await file.slice(fileOffset, fileOffset + recordBytes).arrayBuffer();
    const reported = new Float32Array(buf, 0, slotCount);
    const truth = new Float32Array(buf, slotCount * 4, slotCount);
    return { reported: reported.slice(), truth: truth.slice() };
  }

  /** 流式读取整块（Worker 批处理用），返回可转移的 ArrayBuffer */
  async readBlockBuffer(prefix: string, block: number): Promise<ArrayBuffer> {
    const dir = await this.root();
    const fh = await dir.getFileHandle(blockFileName(prefix, block));
    const file = await (fh as any).getFile();
    return await file.arrayBuffer();
  }

  /** 解析块缓冲 */
  static parseBlock(buffer: ArrayBuffer, slotCount: number): { reported: Float32Array; truth: Float32Array }[] {
    const view = new DataView(buffer);
    if (view.getUint32(0, true) !== MAGIC) throw new Error('块文件魔数校验失败');
    const count = view.getUint32(4, true);
    const out: { reported: Float32Array; truth: Float32Array }[] = [];
    const recordFloats = slotCount * 2;
    for (let i = 0; i < count; i++) {
      const start = 8 / 4 + i * recordFloats;
      const all = new Float32Array(buffer, start * 4, recordFloats);
      out.push({ reported: all.slice(0, slotCount), truth: all.slice(slotCount) });
    }
    return out;
  }

  async saveIndex(index: DatasetIndex): Promise<void> {
    const dir = await this.root();
    await writeJson(dir, 'index.json', index);
  }

  async loadIndex(): Promise<DatasetIndex | null> {
    const dir = await this.root();
    return await readJson<DatasetIndex>(dir, 'index.json');
  }

  async hasDataset(): Promise<boolean> {
    return (await this.loadIndex()) !== null;
  }

  async clearAll(): Promise<void> {
    const root = await navigator.storage.getDirectory();
    try {
      await root.removeEntry(ROOT, { recursive: true });
    } catch {
      /* 忽略 */
    }
    this.dir = null;
  }

  async listBlockFiles(prefix: string): Promise<number[]> {
    const dir = await this.root();
    const blocks: number[] = [];
    const re = new RegExp(`^${prefix}-(\\d+)\\.bin$`);
    for await (const name of (dir as any).keys()) {
      const m = re.exec(name);
      if (m) blocks.push(Number(m[1]));
    }
    return blocks.sort((a, b) => a - b);
  }

  /** 保存一个块内用户的按天倍率轨迹（二进制，与块用户顺序一致），单 buffer 落盘 */
  async writeRatioBlock(block: number, ratiosPerUser: Float32Array[], days: number): Promise<void> {
    const buffer = buildRatioBuffer(ratiosPerUser, days);
    const dir = await this.root();
    const fh = await dir.getFileHandle(blockFileName('ratios', block), { create: true });
    const w = await (fh as any).createWritable();
    await w.write(buffer);
    await w.close();
  }

  async writeRatioBlockSync(block: number, ratiosPerUser: Float32Array[], days: number): Promise<void> {
    const buffer = buildRatioBuffer(ratiosPerUser, days);
    const dir = await this.root();
    const fh = await dir.getFileHandle(blockFileName('ratios', block), { create: true });
    const handle = await (fh as any).createSyncAccessHandle();
    try {
      handle.truncate(0);
      handle.write(buffer);
    } finally {
      handle.close();
    }
  }

  async readRatioBlockSync(block: number, days: number): Promise<Float32Array[]> {
    const dir = await this.root();
    const fh = await dir.getFileHandle(blockFileName('ratios', block));
    const handle = await (fh as any).createSyncAccessHandle();
    let buffer: ArrayBuffer;
    try {
      const size = handle.getSize();
      buffer = new ArrayBuffer(size);
      handle.read(buffer, { at: 0 });
    } finally {
      handle.close();
    }
    return parseRatioBuffer(buffer, days);
  }

  async readRatioBlock(block: number, days: number): Promise<Float32Array[]> {
    const dir = await this.root();
    const fh = await dir.getFileHandle(blockFileName('ratios', block));
    const file = await (fh as any).getFile();
    return parseRatioBuffer(await file.arrayBuffer(), days);
  }
}

/** 把一个块的全部用户曲线拼成单个连续 ArrayBuffer（8 字节头 + 每户 reported/truth） */
function buildBlockBuffer(
  records: { userId: string; reported: Float32Array; truth: Float32Array }[],
  slotCount: number,
): ArrayBuffer {
  const recordFloats = slotCount * 2;
  const buffer = new ArrayBuffer(8 + records.length * recordFloats * 4);
  new DataView(buffer).setUint32(0, MAGIC, true);
  new DataView(buffer).setUint32(4, records.length, true);
  const view = new Float32Array(buffer, 8);
  let cursor = 0;
  for (const r of records) {
    if (r.reported.length !== slotCount || r.truth.length !== slotCount) {
      throw new Error(`用户 ${r.userId} 曲线长度不符`);
    }
    view.set(r.reported, cursor);
    cursor += slotCount;
    view.set(r.truth, cursor);
    cursor += slotCount;
  }
  return buffer;
}

function buildRatioBuffer(ratiosPerUser: Float32Array[], days: number): ArrayBuffer {
  const buffer = new ArrayBuffer(8 + ratiosPerUser.length * days * 4);
  new DataView(buffer).setUint32(0, MAGIC, true);
  new DataView(buffer).setUint32(4, ratiosPerUser.length, true);
  const view = new Float32Array(buffer, 8);
  let cursor = 0;
  for (const r of ratiosPerUser) {
    if (r.length !== days) throw new Error('倍率轨迹天数不符');
    view.set(r, cursor);
    cursor += days;
  }
  return buffer;
}

function parseRatioBuffer(buffer: ArrayBuffer, days: number): Float32Array[] {
  const view = new DataView(buffer);
  if (view.getUint32(0, true) !== MAGIC) throw new Error('倍率块魔数错误');
  const count = view.getUint32(4, true);
  const out: Float32Array[] = [];
  for (let i = 0; i < count; i++) {
    const start = 8 / 4 + i * days;
    out.push(new Float32Array(buffer, start * 4, days).slice());
  }
  return out;
}

export function buildBlockIndex(userIds: string[], blockSize = DEFAULT_BLOCK_SIZE): BlockIndexEntry[] {
  return userIds.map((userId, i) => ({
    userId,
    block: Math.floor(i / blockSize),
    offset: i % blockSize,
  }));
}

export function expectedBlockCount(userCount: number, blockSize = DEFAULT_BLOCK_SIZE): number {
  return Math.ceil(userCount / blockSize);
}

export function slotCountOf(meta: PipelineMeta): number {
  return meta.days * SLOTS_PER_DAY;
}

export const store = new OpfsStore();
