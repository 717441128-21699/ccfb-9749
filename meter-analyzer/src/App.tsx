import { useEffect } from 'react';
import { appStore, useAppState } from './state/store.ts';
import { ImportPage } from './pages/ImportPage.tsx';
import { CleanPage } from './pages/CleanPage.tsx';
import { ClusterPage } from './pages/ClusterPage.tsx';
import { SuspectPage } from './pages/SuspectPage.tsx';
import { InspectPage } from './pages/InspectPage.tsx';
import type { PageKey } from './types.ts';
import './styles.css';

const NAV: { key: PageKey; label: string }[] = [
  { key: 'import', label: '数据导入' },
  { key: 'clean', label: '数据清洗' },
  { key: 'cluster', label: '负荷聚类' },
  { key: 'suspect', label: '嫌疑排查' },
  { key: 'inspect', label: '稽查反馈' },
];

export default function App(): JSX.Element {
  const s = useAppState();

  useEffect(() => {
    void appStore.init();
  }, []);

  const gb = (n: number) => (n ? (n / 1024 / 1024 / 1024).toFixed(2) + 'GB' : '0GB');

  return (
    <div className="app">
      <header className="app-header">
        <h1>智能电表负荷分析平台</h1>
        <span className="sub">15 分钟级负荷 · 本地运行 · 数据不出本机</span>
        <div className="header-right">
          {s.meta && (
            <>
              <span>{s.meta.userCount.toLocaleString()} 户 / {s.meta.days} 天 / {s.meta.taCount} 台区</span>
              <label style={{ display: 'flex', alignItems: 'center', gap: 6, cursor: 'pointer' }}>
                <input type="checkbox" checked={s.showTruthLabels} onChange={() => appStore.toggleTruth()} style={{ width: 15, height: 15 }} />
                显示演示真值
              </label>
            </>
          )}
          <span title="OPFS 本地存储占用">本地 {gb(s.storageBytes)}</span>
        </div>
      </header>
      <div className="layout">
        <nav className="sidebar">
          {NAV.map((n, i) => (
            <button
              key={n.key}
              className={`nav-item ${s.page === n.key ? 'active' : ''}`}
              onClick={() => appStore.setPage(n.key)}
            >
              <span className="idx">{i + 1}</span>
              {n.label}
            </button>
          ))}
          <div className="muted small" style={{ marginTop: 'auto', padding: '10px 12px', lineHeight: 1.7 }}>
            全部计算在浏览器 Worker 内完成，
            曲线数据存于 OPFS 本地磁盘，
            无任何网络上报。
          </div>
        </nav>
        <main className="main">
          {!s.ready ? (
            <div className="empty">正在加载本地数据集…</div>
          ) : (
            <>
              {s.page === 'import' && <ImportPage />}
              {s.page === 'clean' && <CleanPage />}
              {s.page === 'cluster' && <ClusterPage />}
              {s.page === 'suspect' && <SuspectPage />}
              {s.page === 'inspect' && <InspectPage />}
            </>
          )}
        </main>
      </div>
    </div>
  );
}
