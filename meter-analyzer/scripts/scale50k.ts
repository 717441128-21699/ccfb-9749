// 真实 5 万户规模端到端计时（10 分钟目标验收）

const BASE = 'http://localhost:9222';
function sleep(ms: number): Promise<void> { return new Promise((r) => setTimeout(r, ms)); }

class CDP {
  private ws: WebSocket;
  private id = 0;
  private pending = new Map<number, { resolve: (v: any) => void; reject: (e: any) => void }>();
  errors: string[] = [];
  private constructor(ws: WebSocket) {
    this.ws = ws;
    ws.onmessage = (ev: MessageEvent) => {
      const msg = JSON.parse(ev.data as string);
      if (msg.id && this.pending.has(msg.id)) {
        const p = this.pending.get(msg.id)!;
        this.pending.delete(msg.id);
        msg.error ? p.reject(new Error(JSON.stringify(msg.error))) : p.resolve(msg.result);
      } else if (msg.method === 'Runtime.exceptionThrown') {
        this.errors.push(msg.params.exceptionDetails.exception?.description ?? msg.params.exceptionDetails.text);
      }
    };
  }
  static async connect(url: string): Promise<CDP> {
    const ws = new WebSocket(url);
    await new Promise((r, rj) => { ws.onopen = r; ws.onerror = () => rj(new Error('ws fail')); });
    return new CDP(ws);
  }
  send(method: string, params: any = {}): Promise<any> {
    const id = ++this.id;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }
  async eval(expression: string): Promise<any> {
    const r = await this.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? r.exceptionDetails.text);
    return r.result.value;
  }
  close(): void { this.ws.close(); }
}

async function main(): Promise<void> {
  const list = await (await fetch(BASE + '/json/list')).json();
  const page = list.find((t: any) => t.type === 'page' && t.url.includes('localhost:5173'));
  const cdp = await CDP.connect(page.webSocketDebuggerUrl);
  await cdp.send('Runtime.enable');

  for (let i = 0; i < 30; i++) {
    if (await cdp.eval('document.querySelectorAll("input[type=number]").length >= 4')) break;
    await sleep(500);
  }
  console.log('设置 50000 户 × 365 天 × 200 台区（真实规模验收）…');
  await cdp.eval('window.confirm = () => true');
  await cdp.eval(`(() => {
    const set = (el, v) => { const s = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype,'value').set; s.call(el, String(v)); el.dispatchEvent(new Event('input',{bubbles:true})); };
    const inputs = document.querySelectorAll('input[type=number]');
    set(inputs[0], 50000); set(inputs[1], 365); set(inputs[2], 200); set(inputs[3], 0.04);
  })()`);

  const t0 = Date.now();
  await cdp.eval('document.querySelector(".btn-primary").click()');
  let last = '';
  while (true) {
    await sleep(5000);
    const onClean = await cdp.eval(`!!Array.from(document.querySelectorAll(".nav-item")).find(b=>b.classList.contains("active"))?.textContent.includes("数据清洗")`);
    const msg = await cdp.eval('document.querySelector(".progress-msg")?.textContent ?? ""');
    if (msg !== last) {
      console.log(`  [${((Date.now() - t0) / 1000).toFixed(0)}s] ${msg}`);
      last = msg;
    }
    if (onClean && Date.now() - t0 > 10000) break;
    if (Date.now() - t0 > 900000) throw new Error('超时 15 分钟');
  }
  const elapsed = (Date.now() - t0) / 1000;

  await cdp.eval('Array.from(document.querySelectorAll(".nav-item")).find(b=>b.textContent.includes("数据导入")).click()');
  await sleep(1500);
  const head = await cdp.eval('Array.from(document.querySelectorAll(".stat-value")).map(e=>e.textContent).slice(0,4).join(" | ")');
  const timing = await cdp.eval('Array.from(document.querySelectorAll(".stat-value")).map(e=>e.textContent).slice(-4).join(" | ")');
  console.log('\n========== 5 万户真实规模验收 ==========');
  console.log('统计卡：', head);
  console.log('各阶段耗时（生成 | 清洗 | 聚类 | 总耗时）：', timing);
  console.log('端到端墙钟：', elapsed.toFixed(1), 's =', (elapsed / 60).toFixed(2), '分钟');
  console.log('10 分钟目标：', elapsed <= 600 ? '达标 ✓' : '未达标 ✗');
  console.log('JS 错误：', cdp.errors.length, cdp.errors.slice(0, 3).join(' | '));
  cdp.close();
}

main().catch((e) => { console.error(e); process.exit(1); });
export {};
