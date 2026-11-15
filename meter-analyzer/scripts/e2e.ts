// 零依赖 CDP 端到端测试：驱动无头 Chrome 跑通 生成→清洗→聚类→嫌疑→稽查 全流程
const BASE = 'http://localhost:9222';

async function getPageTarget(): Promise<string> {
  const list = await (await fetch(BASE + '/json/list')).json();
  const page = list.find((t: any) => t.type === 'page' && t.url.includes('localhost:5173'));
  if (!page) throw new Error('未找到页面 target');
  return page.webSocketDebuggerUrl;
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

class CDP {
  private ws: WebSocket;
  private id = 0;
  private pending = new Map<number, { resolve: (v: any) => void; reject: (e: any) => void }>();
  logs: { type: string; text: string }[] = [];
  errors: string[] = [];

  private constructor(ws: WebSocket) {
    this.ws = ws;
    ws.onmessage = (ev: MessageEvent) => {
      const msg = JSON.parse(ev.data as string);
      if (msg.id && this.pending.has(msg.id)) {
        const p = this.pending.get(msg.id)!;
        this.pending.delete(msg.id);
        if (msg.error) p.reject(new Error(JSON.stringify(msg.error)));
        else p.resolve(msg.result);
      } else if (msg.method === 'Runtime.consoleAPICalled') {
        const text = msg.params.args.map((a: any) => a.value ?? a.description ?? '').join(' ');
        this.logs.push({ type: msg.params.type, text });
      } else if (msg.method === 'Runtime.exceptionThrown') {
        this.errors.push(msg.params.exceptionDetails.exception?.description ?? msg.params.exceptionDetails.text);
      } else if (msg.method === 'Log.entryAdded' && msg.params.entry.level === 'error') {
        this.errors.push(msg.params.entry.text);
      }
    };
  }

  static async connect(url: string): Promise<CDP> {
    const ws = new WebSocket(url);
    await new Promise((r, rj) => {
      ws.onopen = r;
      ws.onerror = () => rj(new Error('ws 连接失败'));
    });
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

  close(): void {
    this.ws.close();
  }
}

async function main(): Promise<void> {
  const target = await getPageTarget();
  const cdp = await CDP.connect(target);
  await cdp.send('Runtime.enable');
  await cdp.send('Log.enable');
  await cdp.send('Page.enable');

  const step = (n: string): void => console.log(`\n=== ${n} ===`);
  const ok = (cond: boolean, msg: string): void => {
    console.log(`${cond ? 'PASS' : 'FAIL'}  ${msg}`);
    if (!cond) process.exitCode = 1;
  };

  step('1. 页面加载');
  await sleep(2000);
  const title = await cdp.eval('document.querySelector("h1")?.textContent');
  ok(title === '智能电表负荷分析平台', `标题渲染：${title}`);
  const navCount = await cdp.eval('document.querySelectorAll(".nav-item").length');
  ok(navCount === 5, `5 个导航页：${navCount}`);

  step('2. 设置小数据集参数（500 户 × 120 天，保证快速跑完）');
  await cdp.eval(`(() => {
    const set = (el, v) => { const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype,'value').set; setter.call(el, String(v)); el.dispatchEvent(new Event('input',{bubbles:true})); };
    const inputs = document.querySelectorAll('input[type=number]');
    set(inputs[0], 500); set(inputs[1], 120); set(inputs[2], 20); set(inputs[3], 0.06);
    return Array.from(inputs).map(i=>i.value).join(',');
  })()`);
  const params = await cdp.eval('Array.from(document.querySelectorAll("input[type=number]")).map(i=>i.value).join(",")');
  ok(params === '500,120,20,0.06', `参数已设置：${params}`);

  step('3. 点击生成（confirm 已被桩函数自动确认）');
  await cdp.eval('window.confirm = () => true');
  await cdp.eval('document.querySelector(".btn-primary").click()');

  // 轮询直到完成（最多 5 分钟）：完成后应用自动跳到清洗页，以导航激活态为判据
  let done = false;
  const t0 = Date.now();
  let lastMsg = '';
  while (Date.now() - t0 < 300000) {
    await sleep(1500);
    const msg = await cdp.eval('document.querySelector(".progress-msg")?.textContent ?? ""');
    if (msg && msg !== lastMsg) {
      lastMsg = msg;
      console.log('   进度:', msg);
    }
    const onCleanPage = await cdp.eval(`!!Array.from(document.querySelectorAll(".nav-item")).find(b=>b.classList.contains("active"))?.textContent.includes("数据清洗")`);
    if (onCleanPage && Date.now() - t0 > 4000) {
      done = true;
      break;
    }
  }
  ok(done, '全流程在 5 分钟内跑完（完成后自动进入清洗页）');

  step('4. 验证导入页统计与耗时（完成后先回到导入页）');
  await cdp.eval('Array.from(document.querySelectorAll(".nav-item")).find(b=>b.textContent.includes("数据导入")).click()');
  await sleep(1000);
  const stats = await cdp.eval('Array.from(document.querySelectorAll(".stat-value")).map(e=>e.textContent).slice(0,4).join(" | ")');
  console.log('   统计卡：', stats);
  const userStat = await cdp.eval('document.querySelectorAll(".stat-value")[0].textContent');
  ok(userStat === '500', `用户数 500：${userStat}`);
  const timingCards = await cdp.eval('Array.from(document.querySelectorAll(".stat-value")).map(e=>e.textContent).slice(-4).join(" | ")');
  console.log('   耗时卡：', timingCards);

  step('5. 数据清洗页');
  await cdp.eval('Array.from(document.querySelectorAll(".nav-item")).find(b=>b.textContent.includes("数据清洗")).click()');
  await sleep(1500);
  const cleanStats = await cdp.eval('Array.from(document.querySelectorAll(".stat-value")).map(e=>e.textContent).slice(0,4).join(" | ")');
  console.log('   清洗统计：', cleanStats);
  const issueUsers = Number((await cdp.eval('document.querySelectorAll(".stat-value")[0].textContent')).replace(/[^0-9]/g, ''));
  ok(issueUsers > 0, `识别出问题用户 ${issueUsers} 户`);
  // 选一个问题用户看对比曲线
  await cdp.eval('const sel=document.querySelector("select"); if(sel&&sel.options.length>1){sel.selectedIndex=1;sel.dispatchEvent(new Event("change",{bubbles:true}));}');
  await sleep(1500);
  const canvasCount = await cdp.eval('document.querySelectorAll("canvas").length');
  ok(canvasCount >= 1, `清洗前后曲线 canvas 渲染：${canvasCount} 个`);

  step('6. 负荷聚类页');
  await cdp.eval('Array.from(document.querySelectorAll(".nav-item")).find(b=>b.textContent.includes("负荷聚类")).click()');
  await sleep(1500);
  const k = await cdp.eval('document.querySelectorAll(".stat-value")[0].textContent');
  const sil = await cdp.eval('document.querySelectorAll(".stat-value")[1].textContent');
  console.log('   聚类：k =', k, '，轮廓 =', sil);
  ok(Number(k) >= 4, `聚类簇数 ${k}`);
  const clusterTags = await cdp.eval('document.querySelectorAll(".pill-row .tag").length');
  ok(clusterTags >= 4, `簇切换标签 ${clusterTags} 个`);

  step('7. 嫌疑排查页');
  await cdp.eval('Array.from(document.querySelectorAll(".nav-item")).find(b=>b.textContent.includes("嫌疑排查")).click()');
  await sleep(1500);
  const highRisk = await cdp.eval('document.querySelectorAll(".stat-value")[0].textContent');
  const rows = await cdp.eval('document.querySelectorAll("tbody tr").length');
  console.log('   高风险户：', highRisk, '，本页名单行数：', rows);
  ok(rows > 0, `嫌疑名单有数据（${rows} 行）`);
  // 打开第一户详情
  await cdp.eval('document.querySelector("tbody tr.clickable").click()');
  await sleep(1500);
  const dialog = await cdp.eval('document.querySelector(".dialog-title")?.textContent');
  ok(!!dialog, `详情抽屉打开：${dialog}`);
  const scoreBars = await cdp.eval('document.querySelectorAll(".scorebar").length');
  ok(scoreBars === 4, `4 个分数贡献条：${scoreBars}`);
  // 历史曲线 tab
  await cdp.eval('Array.from(document.querySelectorAll(".tab")).find(t=>t.textContent.includes("历史曲线")).click()');
  await sleep(1200);
  const detailCanvas = await cdp.eval('document.querySelectorAll(".dialog canvas").length');
  ok(detailCanvas >= 3, `详情内图表 ${detailCanvas} 个（日电量/月柱/线损/单日曲线）`);

  step('8. 稽查回填');
  await cdp.eval('Array.from(document.querySelectorAll(".tab")).find(t=>t.textContent.includes("稽查回填")).click()');
  await sleep(800);
  await cdp.eval(`(() => {
    const ta = document.querySelector(".dialog textarea");
    const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype,'value').set;
    setter.call(ta, 'E2E 测试：现场发现计量装置旁路');
    ta.dispatchEvent(new Event('input',{bubbles:true}));
    Array.from(document.querySelectorAll(".dialog .btn-primary")).find(b=>b.textContent.includes("保存回填")).click();
  })()`);
  await sleep(2000);
  // 抽屉可能自动关闭，去稽查反馈页验证
  await cdp.eval('Array.from(document.querySelectorAll(".nav-item")).find(b=>b.textContent.includes("稽查反馈")).click()');
  await sleep(1500);
  const inspected = await cdp.eval('document.querySelectorAll(".stat-value")[0].textContent');
  const confirmed = await cdp.eval('document.querySelectorAll(".stat-value")[1].textContent');
  console.log('   已稽查：', inspected, '，确认：', confirmed);
  ok(inspected === '1' && confirmed === '1', `回填落库：已稽查 ${inspected} / 确认 ${confirmed}`);
  const topnRows = await cdp.eval('document.querySelectorAll("tbody tr").length');
  ok(topnRows >= 1, `评估表 Top-N 行数 ${topnRows}`);

  step('9. 导出功能（拦截下载，验证 Blob 生成不报错）');
  const blobOk = await cdp.eval(`(async () => {
    let created = false;
    const orig = HTMLAnchorElement.prototype.click;
    HTMLAnchorElement.prototype.click = function(){ created = true; };
    const btns = Array.from(document.querySelectorAll("button")).filter(b=>b.textContent.includes("导出"));
    btns[0]?.click();
    await new Promise(r=>setTimeout(r,500));
    HTMLAnchorElement.prototype.click = orig;
    return created;
  })()`);
  ok(blobOk === true, '导出按钮生成下载 Blob');

  step('10. 控制台错误检查');
  const realErrors = cdp.errors.filter(
    (e) => !e.includes('favicon') && !e.includes('Download interrupted') && !e.includes('404'),
  );
  ok(realErrors.length === 0, `未捕获错误 ${realErrors.length} 条` + (realErrors.length ? '：' + realErrors.slice(0, 3).join(' | ') : ''));

  step('11. OPFS 持久化验证（刷新后数据仍在）');
  await cdp.send('Page.reload');
  await sleep(2500);
  const afterReload = await cdp.eval('document.querySelectorAll(".stat-value")[0]?.textContent ?? ""');
  ok(afterReload === '500', `刷新后仍读到 500 户数据集：${afterReload}`);

  console.log('\n========== E2E 完成 ==========');
  cdp.close();
}

main().catch((e) => {
  console.error('E2E 异常：', e);
  process.exit(1);
});

export {};
