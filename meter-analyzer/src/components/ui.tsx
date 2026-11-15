// 通用 UI 组件
import type { ReactNode } from 'react';

export function Card({ title, extra, children, style }: { title?: ReactNode; extra?: ReactNode; children: ReactNode; style?: React.CSSProperties }): JSX.Element {
  return (
    <div className="card" style={style}>
      {(title || extra) && (
        <div className="card-head">
          <div className="card-title">{title}</div>
          <div>{extra}</div>
        </div>
      )}
      <div className="card-body">{children}</div>
    </div>
  );
}

export function StatCard({ label, value, sub, tone }: { label: string; value: ReactNode; sub?: ReactNode; tone?: 'blue' | 'red' | 'green' | 'amber' }): JSX.Element {
  const cls = tone ? `stat stat-${tone}` : 'stat';
  return (
    <div className={cls}>
      <div className="stat-label">{label}</div>
      <div className="stat-value">{value}</div>
      {sub && <div className="stat-sub">{sub}</div>}
    </div>
  );
}

export function ProgressBar({ percent, message }: { percent: number; message?: string }): JSX.Element {
  return (
    <div>
      <div className="progress-track">
        <div className="progress-fill" style={{ width: `${Math.round(percent * 100)}%` }} />
      </div>
      {message && <div className="progress-msg">{message}（{Math.round(percent * 100)}%）</div>}
    </div>
  );
}

export function Tag({ children, tone }: { children: ReactNode; tone?: 'red' | 'green' | 'amber' | 'blue' | 'gray' }): JSX.Element {
  return <span className={`tag tag-${tone ?? 'gray'}`}>{children}</span>;
}

export function scoreTone(score: number): 'red' | 'amber' | 'blue' | 'gray' {
  if (score >= 70) return 'red';
  if (score >= 50) return 'amber';
  if (score >= 30) return 'blue';
  return 'gray';
}

export function Button({
  children,
  onClick,
  disabled,
  variant,
  size,
  title,
}: {
  children: ReactNode;
  onClick?: () => void;
  disabled?: boolean;
  variant?: 'primary' | 'ghost' | 'danger';
  size?: 'sm';
  title?: string;
}): JSX.Element {
  const cls = ['btn', variant ? `btn-${variant}` : '', size === 'sm' ? 'btn-sm' : ''].filter(Boolean).join(' ');
  return (
    <button className={cls} onClick={onClick} disabled={disabled} title={title}>
      {children}
    </button>
  );
}

export function Field({ label, children, hint }: { label: string; children: ReactNode; hint?: string }): JSX.Element {
  return (
    <label className="field">
      <span className="field-label">{label}</span>
      {children}
      {hint && <span className="field-hint">{hint}</span>}
    </label>
  );
}

export function Empty({ text }: { text: string }): JSX.Element {
  return <div className="empty">{text}</div>;
}

/** 分数贡献条：显示一个子分及其在总分中的加权贡献 */
export function ScoreBar({ label, score, weight, raw }: { label: string; score: number; weight: number; raw?: string }): JSX.Element {
  return (
    <div className="scorebar">
      <div className="scorebar-head">
        <span>{label}</span>
        <span className="muted">
          子分 <b>{score.toFixed(1)}</b> × 权重 {(weight * 100).toFixed(0)}%
          {raw ? ` ｜ ${raw}` : ''}
        </span>
      </div>
      <div className="progress-track small">
        <div className={`progress-fill fill-${scoreTone(score)}`} style={{ width: `${score}%` }} />
      </div>
    </div>
  );
}
