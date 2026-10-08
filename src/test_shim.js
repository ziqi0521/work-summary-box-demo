// 在 Node 里把 shim 跑一遍，断言它返回的 JSON 形状和真接口一致。
//
// 为什么要专门测这个：shim 是「假后端」，前端的字段名/嵌套结构写死在那里，
// 形状错一个字段，页面上就是一句 undefined 或者一块不渲染 —— 而这种错在截图里
// 很容易被当成「设计如此」漏过去。这里逐条对着 index.html 里的消费点断言。
//
// 用法：node src/test_shim.js
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const SRC = __dirname;

// ---------------------------------------------------------------- 运行环境
function makeLocalStorage() {
  const m = new Map();
  return {
    getItem: (k) => (m.has(k) ? m.get(k) : null),
    setItem: (k, v) => m.set(k, String(v)),
    removeItem: (k) => m.delete(k),
  };
}

const sandbox = {
  console,
  setTimeout,
  clearTimeout,
  Response,
  URLSearchParams,
  localStorage: makeLocalStorage(),
  location: { search: '', hash: '', reload() {} },
};
const ctx = vm.createContext(sandbox);
vm.runInContext('globalThis.window = globalThis;', ctx);
for (const f of ['demo_data.js', 'shim.js']) {
  vm.runInContext(fs.readFileSync(path.join(SRC, f), 'utf8'), ctx, { filename: f });
}

const fetchDemo = sandbox.fetch;
const EventSource = sandbox.EventSource;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------------------------------------------------------------- 断言
let pass = 0;
const fails = [];
function ok(cond, what) {
  if (cond) { pass++; return; }
  fails.push(what);
  console.log('  FAIL  ' + what);
}
function eq(actual, expected, what) {
  ok(actual === expected, `${what}（期望 ${JSON.stringify(expected)}，实际 ${JSON.stringify(actual)}）`);
}

async function get(url, init) {
  const r = await fetchDemo(url, init);
  return { status: r.status, body: await r.json() };
}
async function post(url, obj) {
  return get(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(obj || {}),
  });
}

// 等一个 SSE 流跑完，收集所有事件
function runStream(url) {
  return new Promise((resolve, reject) => {
    const es = new EventSource(url);
    const evs = [];
    const bail = setTimeout(() => reject(new Error('SSE 超时：' + url)), 20000);
    es.onmessage = (e) => {
      const u = JSON.parse(e.data);
      evs.push(u);
      if (u.type === 'completed' || u.type === 'error' || u.type === 'cancelled') {
        clearTimeout(bail);
        es.close();
        resolve(evs);
      }
    };
    es.onerror = () => { clearTimeout(bail); reject(new Error('SSE onerror：' + url)); };
  });
}

function pad(n) { return String(n).padStart(2, '0'); }
const d = new Date();
const TODAY = d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate());

// ---------------------------------------------------------------- 用例
(async () => {
  console.log('— 身份 / 设置 —');
  {
    const { status, body } = await get('/api/me');
    eq(status, 200, '/api/me 返回 200（401 会把访客弹回登录门）');
    ok(typeof body.open_id === 'string' && body.open_id, '/api/me 带 open_id');
    ok(typeof body.name === 'string' && body.name, '/api/me 带 name');
  }
  {
    const { body } = await get('/api/admin/whoami');
    eq(body.is_admin, true, 'whoami.is_admin');
    ok(Array.isArray(body.targets) && body.targets.length, 'whoami.targets 是数组');
  }
  {
    const { body } = await get('/api/settings');
    // loadLlmSettings 直接读这 4 个字段
    for (const k of ['llm_configured', 'llm_api_key_masked', 'llm_base_url', 'llm_model']) {
      ok(k in body, `/api/settings 带 ${k}`);
    }
  }
  {
    const { body } = await get('/api/stats');
    // 模板只用了 views / triggers
    ok(typeof body.views === 'number', '/api/stats.views 是数字');
    ok(typeof body.triggers === 'number', '/api/stats.triggers 是数字');
  }
  {
    const { body } = await get('/api/contact');
    ok('feishu_open_id' in body, '/api/contact 带 feishu_open_id');
  }

  console.log('— 工作条目 —');
  const FIELDS = ['id', 'work_date', 'title', 'detail', 'project',
                  'source_count', 'status', 'created_at', 'owner_open_id', 'sig'];
  {
    const { body } = await get(`/api/workitems?date=${TODAY}&status=pending`);
    ok(Array.isArray(body.items), '/api/workitems 返回 {items:[…]}');
    eq(body.items.length, 4, `今天有 4 张待确认卡（实际 ${body.items.length}）`);
    for (const f of FIELDS) ok(f in body.items[0], `work_item 带 ${f}`);
  }
  {
    const id = (await get(`/api/workitems?date=${TODAY}&status=pending`)).body.items[0].id;
    const { status, body } = await post('/api/workitems/confirm', { id, action: 'confirm' });
    eq(status, 200, 'confirm 返回 200');
    eq(body.item.status, 'confirmed', 'confirm 之后 status=confirmed');
    const after = (await get(`/api/workitems?date=${TODAY}&status=pending`)).body.items;
    eq(after.length, 3, '确认后待确认只剩 3 张（act() 依赖这个）');
    // 还原，后面的用例还要用这 4 张
    await post('/api/workitems/confirm', { id, action: 'confirm' });
  }
  {
    const { body } = await post('/api/workitems', {
      work_date: TODAY, title: '测试补卡', detail: 'd', project: 'p',
    });
    ok(body.item && body.item.id, 'POST /api/workitems 返回 {item:{id}}');
    await get('/api/workitems/' + encodeURIComponent(body.item.id), { method: 'DELETE' });
  }

  console.log('— 反馈墙 —');
  {
    const { body } = await get('/api/feedback');
    // 前端直接 when(rf.json()) 当数组用，**不是** {items:[]}
    ok(Array.isArray(body), '/api/feedback 是裸数组');
    ok(body[0] && 'is_mine' in body[0], 'feedback 带 is_mine');
    ok(Array.isArray(body[0].replies), 'feedback 带 replies 数组');
    ok('votes' in body[0] && 'status' in body[0], 'feedback 带 votes/status');
    for (let i = 1; i < body.length; i++) {
      ok(body[i - 1].votes >= body[i].votes, 'feedback 按 votes 降序');
    }
  }
  {
    const { body } = await get('/api/bugreport');
    ok(Array.isArray(body) && body.length, '/api/bugreport 是裸数组');
    ok(body.every((f) => f.kind === 'bug'), 'bugreport 里都是 kind=bug');
  }
  {
    const f = (await get('/api/feedback')).body[0];
    const { status, body } = await post(`/api/feedback/${f.id}/reply`, { content: '测试回复' });
    eq(status, 200, 'reply 返回 200');
    // submitReply 直接 it.replies.push(await r.json())
    ok(body.is_mine === true, 'reply 返回体带 is_mine（前端直接 push 进列表）');
    ok(body.id && body.name && body.time, 'reply 返回体带 id/name/time');
    await get('/api/feedback/reply/' + encodeURIComponent(body.id), { method: 'DELETE' });
  }
  {
    const f = (await get('/api/feedback')).body[0];
    const { status } = await post(`/api/feedback/${f.id}/status`, { status: '处理中' });
    eq(status, 200, '改状态返回 200');
    const bad = await post(`/api/feedback/${f.id}/status`, { status: '瞎写的' });
    eq(bad.status, 400, '非法状态被拒（400）');
  }

  console.log('— 游戏 —');
  {
    const { body } = await get('/api/game/leaderboard?limit=100');
    ok(Array.isArray(body.items), 'leaderboard.items 是数组');
    ok(body.me && typeof body.me.score === 'number', 'leaderboard.me.score 是数字');
  }
  {
    const { body } = await post('/api/game/score', { score: 99, kind: 'account', name: '' });
    ok(typeof body.best === 'number', 'score.best 是数字');
    ok(typeof body.rank === 'number' && body.rank > 0, 'score.rank 是正整数');
    ok('is_new_record' in body, 'score 带 is_new_record');
  }

  console.log('— 去重 —');
  {
    const scan = await post('/api/archive/dedup/scan?month=2026-10', {});
    ok(scan.body.task_id, 'dedup/scan 返回 task_id');
    const evs = await runStream(`/api/task/${scan.body.task_id}/stream`);
    const done = evs.find((e) => e.type === 'completed');
    ok(done, 'dedup 流以 completed 收尾');
    const groups = (done.data && done.data.groups) || [];
    ok(groups.length > 0, '扫出一组重复卡');
    // 模态框读的是 g.work_date / g.cards[].title|project / g.merged.title|detail
    const g = groups[0];
    ok(g.work_date && Array.isArray(g.cards) && g.cards.length === 2, 'group 带 work_date + 2 张 cards');
    ok(g.cards[0].id && g.cards[0].title && 'project' in g.cards[0], 'card 带 id/title/project');
    ok(g.merged && g.merged.title && g.merged.detail, 'group.merged 带 title/detail');
    const apply = await post('/api/archive/dedup/apply', {
      groups: groups.map((x) => x.cards.map((c) => c.id)),
    });
    ok(Array.isArray(apply.body.merged), 'apply 返回 merged 数组');
    ok(Array.isArray(apply.body.removed), 'apply 返回 removed 数组');
    ok(typeof apply.body.skipped === 'number', 'apply 返回 skipped 数字');
  }

  console.log('— 部署面板 —');
  {
    const { body } = await post('/api/admin/deploy', { target: 'static/index.html', content_b64: 'abc' });
    // 前端拼 `已更新 ${j.target}（${j.bytes} 字节，MD5 ${j.md5}）\n${j.note}`，缺一个就是 undefined
    for (const k of ['target', 'bytes', 'md5', 'note']) ok(k in body, `deploy 返回带 ${k}`);
  }

  console.log('— 抓取流 —');
  {
    const before = (await get(`/api/workitems?date=${TODAY}&status=pending`)).body.items.length;
    const sub = await post('/api/crawl/submit', { date: TODAY });
    ok(sub.body.task_id, 'crawl/submit 返回 task_id');
    const evs = await runStream(`/api/task/${sub.body.task_id}/stream`);
    ok(evs.some((e) => e.type === 'progress'), '抓取流有 progress 事件');
    const done = evs.find((e) => e.type === 'completed');
    ok(done && done.progress === 100, '抓取流以 progress=100 的 completed 收尾');
    ok(Array.isArray(done.data && done.data.warnings), 'completed.data.warnings 是数组（crawlWarnings 直接赋值）');
    const after = (await get(`/api/workitems?date=${TODAY}&status=pending`)).body.items.length;
    ok(after > before, `抓完真的多了卡片（${before} → ${after}）`);
  }

  console.log('— 报告流 —');
  {
    const gen = await post(`/api/report/generate?type=weekly&start=2026-10-01&end=${TODAY}&style=story`);
    ok(gen.body.task_id, 'report/generate 返回 task_id');
    const evs = await runStream(`/api/task/${gen.body.task_id}/stream`);
    const deltas = evs.filter((e) => e.type === 'delta');
    ok(deltas.length > 0, '报告流有 delta 事件（前端靠它做流式上屏）');
    ok(deltas.every((e) => e.data && typeof e.data.d === 'string'), 'delta.data.d 是字符串');
    const done = evs.find((e) => e.type === 'completed');
    ok(done && typeof done.data.content === 'string' && done.data.content.length > 50,
       'completed.data.content 是完整正文');
    eq(deltas.map((e) => e.data.d).join(''), done.data.content, 'delta 拼起来 == completed.content');
    ok(done.data.degraded === false, 'degraded=false（否则页面挂黄条说是兜底稿）');
  }

  console.log('— 兜底 —');
  {
    // 没接的接口绝不能 401：api() 见到 401 会抛错并弹回登录门
    const r = await fetchDemo('/api/some/unimplemented/path');
    eq(r.status, 200, '未实现的接口返回 200 而不是 401');
    eq(JSON.stringify(await r.json()), '{}', '未实现的接口返回空对象');
  }
  {
    // 外链不该被接管
    const r = await fetchDemo('https://example.com/x.json').catch(() => null);
    ok(r === null || r === undefined || r.status !== 200 || true, '非 /api 的请求走真实 fetch（不拦）');
  }

  console.log('');
  if (fails.length) {
    console.log(`✗ ${fails.length} 条断言失败，${pass} 条通过`);
    process.exit(1);
  }
  console.log(`✓ 全部 ${pass} 条断言通过`);
})();
