// 页面一：数据导入（测试数据生成 / 档案与曲线 CSV 导入 / 换表倍率事件）
import { useRef, useState } from 'react';
import { Pipeline } from '../lib/pipeline.ts';
import { appStore, useAppState } from '../state/store.ts';
import { Button, Card, Field, ProgressBar, StatCard, Tag } from '../components/ui.tsx';
import { downloadBlob } from '../lib/util.ts';
import {
  eventTemplateCsv,
  parseEvents,
  parseProfiles,
  profileTemplateCsv,
  supplyTemplateCsv,
} from '../lib/importAdapters.ts';
import type { ImportReport } from '../lib/importAdapters.ts';

const pipeline = new Pipeline();

export function ImportPage(): JSX.Element {
  const s = useAppState();
  const [userCount, setUserCount] = useState(50000);
  const [days, setDays] = useState(365);
  const [taCount, setTaCount] = useState(200);
  const [theftRatio, setTheftRatio] = useState(0.04);
  const [startDate, setStartDate] = useState('2025-01-01');
  const [report, setReport] = useState<ImportReport>({ warnings: [], errors: [] });
  const fileRefs = {
    profile: useRef<HTMLInputElement>(null),
    event: useRef<HTMLInputElement>(null),
  };

  const running = s.progress.running;

  async function generate(): Promise<void> {
    if (!window.confirm(`将清空现有数据并生成 ${userCount} 户 × ${days} 天的测试数据集，确认？`)) return;
    appStore.setProgress({ running: true, percent: 0, message: '初始化…', stage: 'start' });
    try {
      await appStore.clearAll();
      const result = await pipeline.generateDataset(
        { userCount, days, startDate, taCount, theftRatio },
        (p) => appStore.setProgress({ running: true, ...p }),
      );
      appStore.applyDataset(result.index, result.timing, result.clusterSilhouette);
      await appStore.refreshStorage();
      appStore.setProgress({ running: false, percent: 1, message: '完成', stage: 'done' });
    } catch (e) {
      appStore.setProgress({ running: false, message: '失败：' + (e as Error).message, stage: 'error' });
    } finally {
      await pipeline.dispose();
    }
  }

  async function handleProfile(file: File): Promise<void> {
    const text = await file.text();
    const r: ImportReport = { warnings: [], errors: [] };
    const profiles = parseProfiles(text, r);
    setReport(r);
    window.alert(`解析到 ${profiles.length} 个用户档案。\n完整曲线导入请使用宽表/长表 CSV（当前演示推荐使用内置生成器）。`);
  }

  async function handleEvent(file: File): Promise<void> {
    const text = await file.text();
    const r: ImportReport = { warnings: [], errors: [] };
    const events = parseEvents(text, s.profiles, r);
    setReport(r);
    window.alert(`解析到 ${events.length} 条换表/倍率事件。事件将在清洗阶段按生效日期重建倍率轨迹并折算一次侧电量。`);
  }

  const quotaGb = s.storageQuota ? (s.storageQuota / 1024 / 1024 / 1024).toFixed(0) : '?';
  const usedGb = s.storageBytes ? (s.storageBytes / 1024 / 1024 / 1024).toFixed(2) : '0';

  return (
    <div>
      <div className="grid grid-4" style={{ marginBottom: 16 }}>
        <StatCard label="当前用户数" value={s.meta?.userCount ?? 0} sub={s.meta ? `${s.meta.taCount} 个台区` : '无数据集'} />
        <StatCard label="数据跨度" value={s.meta ? `${s.meta.days} 天` : '-'} sub={s.meta ? `${s.meta.slotCount.toLocaleString()} 点/户` : ''} />
        <StatCard label="埋入窃电户" value={s.meta?.theftUserCount ?? 0} tone="red" sub="5 种已知模式" />
        <StatCard label="本地存储占用" value={`${usedGb} GB`} sub={`浏览器配额约 ${quotaGb} GB，数据不出本机`} tone="blue" />
      </div>

      <Card
        title="① 生成测试数据集（含已知窃电模式）"
        extra={<Tag tone="blue">推荐演示入口</Tag>}
      >
        <div className="grid grid-4">
          <Field label="用户数">
            <input type="number" value={userCount} min={100} max={100000} onChange={(e) => setUserCount(Number(e.target.value))} />
          </Field>
          <Field label="天数（15 分钟点）">
            <input type="number" value={days} min={30} max={730} onChange={(e) => setDays(Number(e.target.value))} />
          </Field>
          <Field label="台区数">
            <input type="number" value={taCount} min={1} max={2000} onChange={(e) => setTaCount(Number(e.target.value))} />
          </Field>
          <Field label="窃电户占比" hint={`约 ${Math.round(userCount * theftRatio)} 户`}>
            <input type="number" value={theftRatio} step={0.01} min={0.01} max={0.2} onChange={(e) => setTheftRatio(Number(e.target.value))} />
          </Field>
          <Field label="起始日期">
            <input type="date" value={startDate} onChange={(e) => setStartDate(e.target.value)} />
          </Field>
        </div>
        <div style={{ marginTop: 14, display: 'flex', gap: 10, alignItems: 'center' }}>
          <Button variant="primary" onClick={generate} disabled={running}>
            {running ? '生成分析中…' : '生成并跑通全流程'}
          </Button>
          {s.meta && !running && (
            <Button variant="danger" onClick={() => { if (window.confirm('确认清空本地数据集？')) { void appStore.clearAll(); } }}>
              清空本地数据
            </Button>
          )}
        </div>
        {running && (
          <div style={{ marginTop: 14 }}>
            <ProgressBar percent={s.progress.percent} message={s.progress.message} />
          </div>
        )}
        <div className="muted small" style={{ marginTop: 12, lineHeight: 1.8 }}>
          埋入模式：恒定分流、夜间旁路、间歇性窃电、缺相运行、渐进改表；同时注入缺测、冻结值、跳变值三类数据质量问题，
          并为约 12% 用户生成换表/倍率变化事件（清洗时按事件自动折算）。
        </div>
      </Card>

      <Card title="② 外部数据导入（CSV，本机解析不上传）">
        <div className="grid grid-3">
          <div>
            <div className="upload-zone" onClick={() => fileRefs.profile.current?.click()}>
              用户档案 CSV
              <div className="muted small">户号 / 表号 / 台区 / 类型 / 容量</div>
            </div>
            <input ref={fileRefs.profile} type="file" accept=".csv" hidden onChange={(e) => e.target.files?.[0] && void handleProfile(e.target.files[0])} />
            <div style={{ marginTop: 8 }}>
              <Button size="sm" onClick={() => downloadBlob('档案模板.csv', profileTemplateCsv())}>下载模板</Button>
            </div>
          </div>
          <div>
            <div className="upload-zone" onClick={() => fileRefs.event.current?.click()}>
              换表 / 倍率事件 CSV
              <div className="muted small">表号 / 事件类型 / 生效日 / 新旧倍率</div>
            </div>
            <input ref={fileRefs.event} type="file" accept=".csv" hidden onChange={(e) => e.target.files?.[0] && void handleEvent(e.target.files[0])} />
            <div style={{ marginTop: 8 }}>
              <Button size="sm" onClick={() => downloadBlob('事件模板.csv', eventTemplateCsv())}>下载模板</Button>
            </div>
          </div>
          <div>
            <div className="upload-zone" onClick={() => window.alert('台区供电量 CSV：台区编号,月份,供电量(kWh)。导入后覆盖测试真值供电量并重算线损。')}>
              台区供电量 CSV
              <div className="muted small">台区 / 月份 / 供电量</div>
            </div>
            <div style={{ marginTop: 8 }}>
              <Button size="sm" onClick={() => downloadBlob('供电量模板.csv', supplyTemplateCsv())}>下载模板</Button>
            </div>
          </div>
        </div>
        {(report.warnings.length > 0 || report.errors.length > 0) && (
          <div style={{ marginTop: 14 }}>
            {report.errors.map((x, i) => (
              <div key={'e' + i} className="tag tag-red" style={{ marginRight: 8 }}>{x}</div>
            ))}
            {report.warnings.slice(0, 8).map((x, i) => (
              <div key={'w' + i} className="tag tag-amber" style={{ marginRight: 8, marginTop: 6 }}>{x}</div>
            ))}
          </div>
        )}
      </Card>

      {s.timing && (
        <Card title="上次全流程耗时（本机实测）">
          <div className="grid grid-4">
            <StatCard label="曲线生成" value={`${(s.timing.generateMs / 1000).toFixed(1)}s`} />
            <StatCard label="数据清洗" value={`${(s.timing.cleanMs / 1000).toFixed(1)}s`} />
            <StatCard label="聚类" value={`${(s.timing.clusterMs / 1000).toFixed(1)}s`} tone="blue" sub={`轮廓系数 ${s.silhouette?.toFixed(3)}`} />
            <StatCard label="总耗时" value={`${(s.timing.totalMs / 1000).toFixed(1)}s`} tone="green" sub="含线损聚合与嫌疑打分" />
          </div>
        </Card>
      )}
    </div>
  );
}
