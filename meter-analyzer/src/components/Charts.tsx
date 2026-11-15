// Canvas 自绘图表：多序列折线、柱状、热力，支持高 DPI 与 tooltip
import { useEffect, useRef, useState } from 'react';

export interface LineSeries {
  name: string;
  color: string;
  points: number[];
  dashed?: boolean;
  width?: number;
}

interface LineChartProps {
  series: LineSeries[];
  height?: number;
  yLabel?: string;
  xLabels?: string[]; // 稀疏 x 轴标签
  xTickEvery?: number;
  fillAreaIndex?: number;
  unit?: string;
  markers?: { x: number; color: string; label?: string }[];
}

const PALETTE = ['#2563eb', '#dc2626', '#059669', '#d97706', '#7c3aed', '#0891b2', '#db2777', '#65a30d'];

export function LineChart(props: LineChartProps): JSX.Element {
  const ref = useRef<HTMLCanvasElement>(null);
  const wrapRef = useRef<HTMLDivElement>(null);
  const [tip, setTip] = useState<{ x: number; y: number; text: string } | null>(null);
  const [width, setWidth] = useState(800);
  const { height = 260 } = props;

  useEffect(() => {
    const el = wrapRef.current;
    if (!el) return;
    const ro = new ResizeObserver((entries) => setWidth(Math.max(320, entries[0].contentRect.width)));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  useEffect(() => {
    const canvas = ref.current;
    if (!canvas) return;
    const dpr = window.devicePixelRatio || 1;
    canvas.width = width * dpr;
    canvas.height = height * dpr;
    canvas.style.width = width + 'px';
    canvas.style.height = height + 'px';
    const ctx = canvas.getContext('2d')!;
    ctx.scale(dpr, dpr);
    drawLine(ctx, width, height, props);
  }, [width, height, props]);

  const onMove = (e: React.MouseEvent<HTMLCanvasElement>): void => {
    const canvas = ref.current;
    if (!canvas || !props.series.length) return;
    const rect = canvas.getBoundingClientRect();
    const padL = 56;
    const padR = 12;
    const padT = 14;
    const padB = 28;
    const n = props.series[0].points.length;
    const x = e.clientX - rect.left;
    const idx = Math.round(((x - padL) / (width - padL - padR)) * (n - 1));
    if (idx < 0 || idx >= n) {
      setTip(null);
      return;
    }
    const lines = props.series
      .map((s) => `${s.name}: ${formatTick(s.points[idx])}${props.unit ?? ''}`)
      .join('\n');
    const xLabel = props.xLabels?.[idx] ?? `#${idx}`;
    setTip({ x: e.clientX - rect.left, y: e.clientY - rect.top, text: `${xLabel}\n${lines}` });
  };

  return (
    <div ref={wrapRef} style={{ position: 'relative', width: '100%' }}>
      <canvas ref={ref} onMouseMove={onMove} onMouseLeave={() => setTip(null)} style={{ display: 'block' }} />
      {tip && (
        <div
          style={{
            position: 'absolute',
            left: Math.min(tip.x + 12, width - 180),
            top: Math.max(4, tip.y - 50),
            background: 'rgba(17,24,39,0.92)',
            color: '#fff',
            padding: '6px 9px',
            borderRadius: 6,
            fontSize: 12,
            whiteSpace: 'pre',
            pointerEvents: 'none',
            lineHeight: 1.5,
          }}
        >
          {tip.text}
        </div>
      )}
    </div>
  );
}

function drawLine(ctx: CanvasRenderingContext2D, w: number, h: number, props: LineChartProps): void {
  const padL = 56;
  const padR = 12;
  const padT = 14;
  const padB = 28;
  ctx.clearRect(0, 0, w, h);
  const n = props.series[0]?.points.length ?? 0;
  if (!n) return;
  let yMin = Infinity;
  let yMax = -Infinity;
  for (const s of props.series)
    for (const v of s.points) {
      if (isFinite(v)) {
        if (v < yMin) yMin = v;
        if (v > yMax) yMax = v;
      }
    }
  if (!isFinite(yMin)) {
    yMin = 0;
    yMax = 1;
  }
  if (yMin === yMax) yMax = yMin + 1;
  const pad = (yMax - yMin) * 0.06;
  yMin = Math.max(0, yMin - pad);
  yMax += pad;

  const xAt = (i: number) => padL + (i / (n - 1)) * (w - padL - padR);
  const yAt = (v: number) => padT + (1 - (v - yMin) / (yMax - yMin)) * (h - padT - padB);

  // 网格 + y 轴
  ctx.strokeStyle = '#e5e7eb';
  ctx.fillStyle = '#6b7280';
  ctx.font = '11px system-ui';
  ctx.lineWidth = 1;
  for (let g = 0; g <= 4; g++) {
    const y = padT + (g / 4) * (h - padT - padB);
    ctx.beginPath();
    ctx.moveTo(padL, y);
    ctx.lineTo(w - padR, y);
    ctx.stroke();
    const val = yMax - (g / 4) * (yMax - yMin);
    ctx.fillText(formatTick(val), 6, y + 4);
  }
  // x 轴刻度
  const tickEvery = props.xTickEvery ?? Math.ceil(n / 8);
  ctx.textAlign = 'center';
  for (let i = 0; i < n; i += tickEvery) {
    ctx.fillText(props.xLabels?.[i] ?? String(i), xAt(i), h - 8);
  }
  ctx.textAlign = 'left';

  // 标记线
  for (const m of props.markers ?? []) {
    ctx.strokeStyle = m.color;
    ctx.setLineDash([4, 4]);
    ctx.beginPath();
    ctx.moveTo(xAt(m.x), padT);
    ctx.lineTo(xAt(m.x), h - padB);
    ctx.stroke();
    ctx.setLineDash([]);
    if (m.label) {
      ctx.fillStyle = m.color;
      ctx.fillText(m.label, xAt(m.x) + 4, padT + 10);
    }
  }

  props.series.forEach((s, si) => {
    ctx.strokeStyle = s.color || PALETTE[si % PALETTE.length];
    ctx.lineWidth = s.width ?? 1.6;
    if (s.dashed) ctx.setLineDash([5, 4]);
    ctx.beginPath();
    let started = false;
    for (let i = 0; i < n; i++) {
      const v = s.points[i];
      if (!isFinite(v)) {
        started = false;
        continue;
      }
      const x = xAt(i);
      const y = yAt(v);
      if (!started) {
        ctx.moveTo(x, y);
        started = true;
      } else ctx.lineTo(x, y);
    }
    ctx.stroke();
    ctx.setLineDash([]);
  });

  // 图例
  let lx = padL;
  props.series.forEach((s, si) => {
    const c = s.color || PALETTE[si % PALETTE.length];
    ctx.fillStyle = c;
    ctx.fillRect(lx, 2, 10, 3);
    ctx.fillStyle = '#374151';
    ctx.fillText(s.name, lx + 14, 7);
    lx += ctx.measureText(s.name).width + 34;
  });
}

export function formatTick(v: number): string {
  if (!isFinite(v)) return '-';
  const a = Math.abs(v);
  if (a >= 10000) return (v / 10000).toFixed(1) + 'w';
  if (a >= 100) return v.toFixed(0);
  if (a >= 1) return v.toFixed(2);
  return v.toFixed(3);
}

interface BarChartProps {
  data: { label: string; value: number; color?: string; sub?: string }[];
  height?: number;
  unit?: string;
  horizontal?: boolean;
}

export function BarChart({ data, height = 240, unit = '', horizontal }: BarChartProps): JSX.Element {
  const ref = useRef<HTMLCanvasElement>(null);
  const wrapRef = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(800);
  useEffect(() => {
    const el = wrapRef.current;
    if (!el) return;
    const ro = new ResizeObserver((entries) => setWidth(Math.max(320, entries[0].contentRect.width)));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  useEffect(() => {
    const canvas = ref.current;
    if (!canvas) return;
    const dpr = window.devicePixelRatio || 1;
    canvas.width = width * dpr;
    canvas.height = height * dpr;
    canvas.style.width = width + 'px';
    canvas.style.height = height + 'px';
    const ctx = canvas.getContext('2d')!;
    ctx.scale(dpr, dpr);
    ctx.clearRect(0, 0, width, height);
    if (!data.length) return;
    const max = Math.max(...data.map((d) => d.value), 0.0001);
    ctx.font = '11px system-ui';
    ctx.fillStyle = '#6b7280';
    ctx.strokeStyle = '#e5e7eb';

    if (horizontal) {
      const rowH = Math.min(34, (height - 20) / data.length);
      const labelW = 90;
      data.forEach((d, i) => {
        const y = 10 + i * rowH;
        const bw = ((width - labelW - 70) * d.value) / max;
        ctx.fillStyle = d.color ?? '#2563eb';
        ctx.fillRect(labelW, y + 4, Math.max(2, bw), rowH - 10);
        ctx.fillStyle = '#374151';
        ctx.fillText(d.label, 6, y + rowH / 2 + 1);
        ctx.fillStyle = '#6b7280';
        ctx.fillText(formatTick(d.value) + unit, labelW + bw + 6, y + rowH / 2 + 1);
      });
    } else {
      const padB = 46;
      const bw = (width - 40) / data.length;
      for (let g = 0; g <= 4; g++) {
        const y = 10 + (g / 4) * (height - padB - 10);
        ctx.beginPath();
        ctx.moveTo(36, y);
        ctx.lineTo(width - 10, y);
        ctx.stroke();
        ctx.fillText(formatTick(max - (g / 4) * max), 4, y + 4);
      }
      data.forEach((d, i) => {
        const bh = ((height - padB - 10) * d.value) / max;
        const x = 36 + i * bw + bw * 0.15;
        ctx.fillStyle = d.color ?? '#2563eb';
        ctx.fillRect(x, height - padB - bh, bw * 0.7, bh);
        ctx.save();
        ctx.fillStyle = '#374151';
        ctx.translate(x + bw * 0.35, height - padB + 8);
        ctx.rotate(-Math.PI / 9);
        ctx.fillText(d.label, 0, 0);
        if (d.sub) ctx.fillText(d.sub, 0, 13);
        ctx.restore();
      });
    }
  }, [width, height, data, horizontal, unit]);

  return (
    <div ref={wrapRef} style={{ width: '100%' }}>
      <canvas ref={ref} />
    </div>
  );
}

/** 热力图：行=序列，列=时间槽，用于多用户/多日负荷模式总览 */
interface HeatmapProps {
  matrix: number[][]; // rows × cols
  rowLabels?: string[];
  colLabels?: string[];
  height?: number;
  colorScale?: (v: number, vmin: number, vmax: number) => string;
}

export function Heatmap({ matrix, rowLabels, colLabels, height = 220 }: HeatmapProps): JSX.Element {
  const ref = useRef<HTMLCanvasElement>(null);
  const wrapRef = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(800);
  useEffect(() => {
    const el = wrapRef.current;
    if (!el) return;
    const ro = new ResizeObserver((entries) => setWidth(Math.max(320, entries[0].contentRect.width)));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  useEffect(() => {
    const canvas = ref.current;
    if (!canvas || !matrix.length) return;
    const dpr = window.devicePixelRatio || 1;
    canvas.width = width * dpr;
    canvas.height = height * dpr;
    canvas.style.width = width + 'px';
    canvas.style.height = height + 'px';
    const ctx = canvas.getContext('2d')!;
    ctx.scale(dpr, dpr);
    ctx.clearRect(0, 0, width, height);
    const rows = matrix.length;
    const cols = matrix[0].length;
    let vmin = Infinity;
    let vmax = -Infinity;
    for (const r of matrix)
      for (const v of r) {
        if (v < vmin) vmin = v;
        if (v > vmax) vmax = v;
      }
    const labelW = rowLabels ? 70 : 0;
    const cw = (width - labelW - 10) / cols;
    const ch = (height - 24) / rows;
    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < cols; c++) {
        ctx.fillStyle = heatColor(matrix[r][c], vmin, vmax);
        ctx.fillRect(labelW + c * cw, r * ch, Math.ceil(cw), Math.ceil(ch));
      }
    }
    ctx.fillStyle = '#374151';
    ctx.font = '11px system-ui';
    if (rowLabels) {
      rowLabels.forEach((l, i) => ctx.fillText(l, 4, i * ch + ch / 2 + 4));
    }
    if (colLabels) {
      colLabels.forEach((l, i) => {
        const x = labelW + (i + 0.5) * ((width - labelW - 10) / colLabels.length);
        ctx.fillText(l, x - 10, height - 8);
      });
    }
  }, [width, height, matrix, rowLabels, colLabels]);

  return (
    <div ref={wrapRef} style={{ width: '100%' }}>
      <canvas ref={ref} />
    </div>
  );
}

function heatColor(v: number, min: number, max: number): string {
  const t = max > min ? (v - min) / (max - min) : 0;
  // 浅蓝 → 蓝 → 橙红
  const r = Math.round(239 + t * (220 - 239) + t * t * (185 - 220));
  const g = Math.round(243 - t * 130 - t * t * 40);
  const b = Math.round(255 - t * 200);
  return `rgb(${Math.max(0, r)},${Math.max(0, g)},${Math.max(0, b)})`;
}

export { PALETTE };
