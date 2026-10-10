// 假后端：把 window.fetch 和 window.EventSource 接管掉，让这份静态页表现得像连着真服务。
//
// 为什么这样做而不是改前端：原前端 40 多个请求全部汇集到 api() 里那一个 fetch(url, opts)，
// 所以在 window.fetch 上装一层路由表就能全覆盖，**前端源码一行都不用改** ——
// 演示站和线上跑的是同一份 index.html，只有这一层 shim 不同。
//
// 几个必须守住的点：
//   - **绝不能返回 401**：前端的 api() 见到 401 会抛错并弹回登录页（index.html:2685）。
//     演示站永远是「已登录」状态。
//   - **响应体形状要和真接口一模一样**：feedback 是裸数组不是 {items:[]}；work_items 带
//     owner_open_id/sig；投票状态后端不管（只存 localStorage 的 ws_voted_fb），所以别造 voted 字段。
//   - **EventSource 不走 fetch**，必须单独接管。抓取/报告/改稿/去重四条流都在这里回放。
(function () {
  'use strict';

  var DATA = window.__DEMO__;
  var KEY = 'ws_demo_state_v1';
  var TASKS = {};          // task_id -> [{ms, ev, effect}]
  var RealResponse = window.Response;

  // ---------------------------------------------------------------- 状态
  function fresh() {
    return JSON.parse(JSON.stringify({
      dataVersion: DATA.dataVersion,
      items: DATA.items,
      feedback: DATA.feedback,
      leaderboard: DATA.leaderboard,
      stats: DATA.stats,
    }));
  }
  function load() {
    try {
      var raw = localStorage.getItem(KEY);
      if (raw) {
        var p = JSON.parse(raw);
        // 版本对不上就丢掉旧存档：换了演示数据集之后，老访客不该继续看着上一次的
        // 卡片和统计数字（他们不会自己去点「重置」）。
        if (p && p.items && p.feedback && p.dataVersion === DATA.dataVersion) return p;
      }
    } catch (e) { /* 坏数据当作没有 */ }
    return fresh();
  }
  var S = load();
  function save() { try { localStorage.setItem(KEY, JSON.stringify(S)); } catch (e) {} }

  // 演示横幅上的「重置」按钮调它
  window.__DEMO_RESET__ = function () {
    try { localStorage.removeItem(KEY); } catch (e) {}
    location.reload();
  };

  // 截图脚本用：?demo_seen=<版本号> 时先把「最近上新」标成已读。
  // 否则每次开新 profile 截图，弹窗都会盖在首页上。版本号由 shoot.py 从构建产物里读出来传进来。
  var shotSeen = /[?&]demo_seen=([^&#]+)/.exec(location.search);
  if (shotSeen) {
    try { localStorage.setItem('ws_changelog_seen', decodeURIComponent(shotSeen[1])); } catch (e) {}
  }

  // ---------------------------------------------------------------- 小工具
  function pad(n) { return String(n).padStart(2, '0'); }
  function today() {
    var d = new Date();
    return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate());
  }
  function nowHM() {
    var d = new Date();
    return today() + ' ' + pad(d.getHours()) + ':' + pad(d.getMinutes());
  }
  function uid(prefix) {
    return prefix + '_' + Math.random().toString(36).slice(2, 11);
  }
  function json(obj, status) {
    return new RealResponse(JSON.stringify(obj), {
      status: status || 200,
      headers: { 'Content-Type': 'application/json; charset=utf-8' },
    });
  }
  function body(init) {
    try { return JSON.parse((init && init.body) || '{}'); } catch (e) { return {}; }
  }

  // feedback 的排序和真接口一致：votes 降序，再看时间
  function feedbackOf(kind) {
    return S.feedback
      .filter(function (f) { return f.kind === kind; })
      .sort(function (a, b) {
        if (b.votes !== a.votes) return b.votes - a.votes;
        return a.time < b.time ? 1 : -1;
      });
  }
  function findFb(id) {
    for (var i = 0; i < S.feedback.length; i++) if (S.feedback[i].id === id) return S.feedback[i];
    return null;
  }

  // ---------------------------------------------------------------- 任务（SSE 回放）
  function chunk(text, size) {
    var out = [];
    for (var i = 0; i < text.length; i += size) out.push(text.slice(i, i + size));
    return out;
  }

  function planCrawl(date) {
    var steps = [
      { ms: 350, ev: { type: 'progress', progress: 6, message: '正在连接飞书…', data: null } },
      { ms: 650, ev: { type: 'progress', progress: 21, message: '扫描会话 12/64…', data: null } },
      { ms: 850, ev: { type: 'progress', progress: 47, message: '扫描会话 41/64…', data: null } },
      { ms: 850, ev: { type: 'progress', progress: 71, message: '正在凝练工作卡片…', data: null } },
      { ms: 750, ev: { type: 'progress', progress: 90, message: '正在与已有卡片去重…', data: null } },
      {
        ms: 550,
        ev: { type: 'completed', progress: 100, message: '抓取完成', data: { count: 3, warnings: [] } },
        effect: function () { addCrawledItems(date); },
      },
    ];
    return steps;
  }

  // 抓完之后真的往列表里塞几张新的待确认卡片，否则「抓取」看起来没反应
  var CRAWL_POOL = [
    ['整理本周的线上问题清单', '把工单和告警按影响面排了序，挑出 3 个要跟进的', '基础平台'],
    ['和上游确认对账文件的字段变更', '对方下版本会加两个字段，提前对齐兼容方案', '支付网关'],
    ['补订单中心的埋点', '给下单、支付、取消三个关键路径加上埋点', '订单中心'],
    ['优化看板首屏加载', '把串行的三个查询改成并发，首屏快了 600ms', '数据看板'],
    ['梳理缓存使用规范', '整理出哪些场景该用本地缓存、哪些该用 Redis', '基础平台'],
    ['给导出任务加限流', '防止一次导太多把库拖垮，按用户维度限流', '数据看板'],
  ];
  var crawlPoolIdx = 0;
  function addCrawledItems(date) {
    var d = date || today();
    var n = 0;
    for (var i = 0; i < 3 && crawlPoolIdx < CRAWL_POOL.length; i++, crawlPoolIdx++) {
      var row = CRAWL_POOL[crawlPoolIdx];
      S.items.push({
        id: uid('wi'),
        work_date: d,
        title: row[0],
        detail: row[1],
        project: row[2],
        source_count: 3 + i,
        status: 'pending',
        created_at: new Date().toISOString().slice(0, 19),
        owner_open_id: DATA.me.open_id,
        sig: Math.random().toString(16).slice(2, 18),
      });
      n++;
    }
    save();
    return n;
  }

  function planReport(type, start, end) {
    var text = DATA.reports[type] || DATA.reports.weekly;
    var steps = [
      { ms: 300, ev: { type: 'progress', progress: 10, message: '正在拉取归档条目…', data: null } },
      { ms: 400, ev: { type: 'progress', progress: 28, message: '正在调用大模型…', data: null } },
    ];
    chunk(text, 22).forEach(function (d) {
      steps.push({ ms: 45, ev: { type: 'delta', progress: 28, message: '', data: { d: d } } });
    });
    steps.push({
      ms: 250,
      ev: {
        type: 'completed', progress: 100, message: '生成完成',
        data: { content: text, count: countConfirmed(start, end), degraded: false, reason: '' },
      },
    });
    return steps;
  }
  function countConfirmed(start, end) {
    return S.items.filter(function (i) {
      return i.status === 'confirmed' && (!start || i.work_date >= start) && (!end || i.work_date <= end);
    }).length;
  }

  function planRevise(instruction, current) {
    var text = '> （演示模式：已按「' + instruction + '」调整，此处不调用真大模型）\n\n' + current;
    var steps = [{ ms: 300, ev: { type: 'progress', progress: 30, message: '正在改稿…', data: null } }];
    chunk(text, 26).forEach(function (d) {
      steps.push({ ms: 30, ev: { type: 'delta', progress: 30, message: '', data: { d: d } } });
    });
    steps.push({
      ms: 200,
      ev: { type: 'completed', progress: 100, message: '改稿完成', data: { content: text, count: 0, degraded: false, reason: '' } },
    });
    return steps;
  }

  // 去重：从已确认的条目里挑一对同一天、同项目的，造一组「看着像重复」的
  function planDedup() {
    var groups = [];
    var byKey = {};
    S.items.forEach(function (i) {
      if (i.status !== 'confirmed') return;
      var k = i.work_date + '|' + i.project;
      (byKey[k] = byKey[k] || []).push(i);
    });
    Object.keys(byKey).forEach(function (k) {
      var arr = byKey[k];
      if (groups.length || arr.length < 2) return;
      var a = arr[0], b = arr[1];
      groups.push({
        work_date: a.work_date,
        cards: [
          { id: a.id, title: a.title, project: a.project },
          { id: b.id, title: b.title, project: b.project },
        ],
        merged: { title: a.title, detail: a.detail + '；' + b.detail },
      });
    });
    var steps = [
      { ms: 300, ev: { type: 'progress', progress: 25, message: '正在比对卡片…', data: null } },
      { ms: 500, ev: { type: 'progress', progress: 70, message: '正在用大模型复核…', data: null } },
      {
        ms: 400,
        ev: {
          type: 'completed', progress: 100, message: '扫描完成',
          data: { groups: groups, total: groups.length, used_llm: true, llm_failed: 0 },
        },
      },
    ];
    return steps;
  }

  function makeTask(steps) {
    var id = uid('task');
    TASKS[id] = steps;
    return id;
  }

  // ---------------------------------------------------------------- 路由
  function route(path, q, method, init) {
    var b = body(init);

    // ---- 身份 / 设置 ----
    if (path === '/api/me') return json({ open_id: DATA.me.open_id, name: DATA.me.name });
    if (path === '/api/admin/whoami') {
      return json({ is_admin: !!DATA.isAdmin, targets: ['static/index.html', 'main.py', 'db.py'] });
    }
    if (path === '/api/settings') return json(DATA.settings);
    if (path === '/api/contact') return json({ feishu_open_id: '' });
    if (path === '/api/health') return json({ status: 'ok', init_db_error: null, time: new Date().toISOString() });
    if (path === '/api/auth/logout') {
      // 演示站没有「退出」这回事：退了就再也登不回来（没有真的飞书 OAuth）。
      // 直接刷新回演示初始状态，别把访客扔在一个走不出去的登录门上。
      setTimeout(function () { location.reload(); }, 0);
      return json({ ok: true });
    }
    if (path === '/api/auth/feishu/start') return json({ authorize_url: '#' });

    // ---- 统计 ----
    if (path === '/api/stats') return json(S.stats);
    if (path === '/api/stats/view') {
      S.stats.views += 1;
      S.stats.views_today += 1;
      save();
      return json(S.stats);
    }

    // ---- 工作条目 ----
    if (path === '/api/workitems' && method === 'GET') {
      var date = q.get('date'), status = q.get('status');
      var items = S.items.filter(function (i) {
        if (date && i.work_date !== date) return false;
        if (status && i.status !== status) return false;
        return true;
      }).sort(function (a, c) {
        if (a.work_date !== c.work_date) return a.work_date < c.work_date ? -1 : 1;
        return a.title < c.title ? -1 : 1;
      });
      return json({ items: items });
    }
    if (path === '/api/workitems/confirm') {
      var it = null;
      for (var i = 0; i < S.items.length; i++) if (S.items[i].id === b.id) it = S.items[i];
      if (!it) return json({ error: 'not found' }, 404);
      if (b.action === 'confirm') it.status = 'confirmed';
      else if (b.action === 'ignore') it.status = 'ignored';
      else if (b.action === 'edit') {
        if (b.title !== undefined) it.title = b.title;
        if (b.detail !== undefined) it.detail = b.detail;
        if (b.project !== undefined) it.project = b.project;
      }
      save();
      return json({ item: it });
    }
    if (path === '/api/workitems' && method === 'POST') {
      var ni = {
        id: uid('wi'),
        work_date: b.work_date,
        title: b.title,
        detail: b.detail || '',
        project: b.project || '',
        source_count: 0,
        status: 'confirmed',
      };
      S.items.push(Object.assign({
        created_at: new Date().toISOString().slice(0, 19),
        owner_open_id: DATA.me.open_id,
        sig: Math.random().toString(16).slice(2, 18),
      }, ni));
      save();
      return json({ item: ni });
    }
    var mDel = /^\/api\/workitems\/(.+)$/.exec(path);
    if (mDel && method === 'DELETE') {
      var did = decodeURIComponent(mDel[1]);
      var before = S.items.length;
      S.items = S.items.filter(function (x) { return x.id !== did; });
      save();
      if (S.items.length === before) return json({ error: '卡片不存在或无权删除' }, 404);
      return json({ ok: true, id: did });
    }

    // ---- 反馈墙 ----
    if (path === '/api/feedback' && method === 'GET') return json(feedbackOf('feature'));
    if (path === '/api/bugreport' && method === 'GET') return json(feedbackOf('bug'));
    if (path === '/api/feedback' && method === 'POST') return addFb('feature', b);
    if (path === '/api/bugreport' && method === 'POST') return addFb('bug', b);

    var mVote = /^\/api\/(feedback|bugreport)\/([^/]+)\/vote$/.exec(path);
    if (mVote && method === 'POST') {
      var fv = findFb(decodeURIComponent(mVote[2]));
      if (!fv) return json({ error: 'not found' }, 404);
      fv.votes += 1; save();
      return json({ votes: fv.votes });
    }
    var mFbDel = /^\/api\/(feedback|bugreport)\/([^/]+)$/.exec(path);
    if (mFbDel && method === 'DELETE') {
      var fd = decodeURIComponent(mFbDel[2]);
      var n0 = S.feedback.length;
      S.feedback = S.feedback.filter(function (x) { return x.id !== fd; });
      save();
      return json({ ok: S.feedback.length < n0 });
    }
    var mReply = /^\/api\/feedback\/([^/]+)\/reply$/.exec(path);
    if (mReply && method === 'POST') {
      var fr = findFb(decodeURIComponent(mReply[1]));
      if (!fr) return json({ error: 'not found' }, 404);
      if (!b.content || !b.content.trim()) return json({ error: '内容不能为空' }, 400);
      if (b.content.length > 500) return json({ error: '回复最多 500 字' }, 400);
      var nr = { id: uid('rp'), name: DATA.me.name, content: b.content, time: nowHM(), is_mine: true };
      fr.replies = fr.replies || [];
      fr.replies.push(nr);
      save();
      return json({ id: nr.id, feedback_id: fr.id, name: nr.name, content: nr.content, time: nr.time, is_mine: true });
    }
    var mReplies = /^\/api\/feedback\/([^/]+)\/replies$/.exec(path);
    if (mReplies && method === 'GET') {
      var frl = findFb(decodeURIComponent(mReplies[1]));
      return json(frl ? (frl.replies || []) : []);
    }
    var mRDel = /^\/api\/feedback\/reply\/(.+)$/.exec(path);
    if (mRDel && method === 'DELETE') {
      var rid = decodeURIComponent(mRDel[1]), hit = false;
      S.feedback.forEach(function (f) {
        var n = (f.replies || []).length;
        f.replies = (f.replies || []).filter(function (r) { return r.id !== rid; });
        if (f.replies.length < n) hit = true;
      });
      save();
      return hit ? json({ ok: true }) : json({ error: 'not found' }, 404);
    }
    var mStatus = /^\/api\/feedback\/([^/]+)\/status$/.exec(path);
    if (mStatus && method === 'POST') {
      var fs = findFb(decodeURIComponent(mStatus[1]));
      if (!fs) return json({ error: 'not found' }, 404);
      var ok = { feature: ['待处理', '处理中', '已上线'], bug: ['待处理', '处理中', '已修复'] };
      if (ok[fs.kind].indexOf(b.status) < 0) return json({ error: '状态值不合法' }, 400);
      fs.status = b.status; save();
      return json({ ok: true, status: b.status });
    }

    // ---- 游戏 ----
    if (path === '/api/game/leaderboard') {
      var lim = Math.max(1, Math.min(parseInt(q.get('limit') || '20', 10) || 20, 100));
      var sorted = S.leaderboard.slice().sort(function (a, c) { return c.score - a.score; });
      var mine = null;
      sorted.forEach(function (r) { if (r.is_me && !mine) mine = { name: r.name, score: r.score }; });
      return json({ items: sorted.slice(0, lim), me: mine });
    }
    if (path === '/api/game/score' && method === 'POST') {
      var sc = parseInt(b.score, 10) || 0;
      var nm = b.name || (b.kind === 'account' ? DATA.me.name : '匿名');
      var prev = null;
      S.leaderboard.forEach(function (r) { if (r.name === nm) prev = r; });
      var best = prev ? Math.max(prev.score, sc) : sc;
      if (prev) { prev.score = best; prev.time = nowHM(); }
      else S.leaderboard.push({ name: nm, kind: b.kind || 'anon', score: sc, is_me: b.kind === 'account', time: nowHM() });
      save();
      var rank = S.leaderboard.slice().sort(function (a, c) { return c.score - a.score; })
        .findIndex(function (r) { return r.name === nm; }) + 1;
      return json({ best: best, is_new_record: !prev || sc > prev.score, rank: rank });
    }

    // ---- 设置 / 管理 ----
    if (path === '/api/settings/llm' && method === 'POST') return json({ ok: true });
    if (path === '/api/admin/deploy' && method === 'POST') {
      // 前端要拼 `已更新 ${j.target}（${j.bytes} 字节，MD5 ${j.md5}）\n${j.note}`，
      // 缺字段会显示成 undefined —— 照真接口给全
      return json({
        ok: true,
        target: b.target || '',
        bytes: ((b.content_b64 || '').length * 3 / 4) | 0,
        md5: 'demo0000000000000000000000000000',
        note: '演示模式：未真正写入服务器，也不会重启服务。',
      });
    }

    // ---- 任务型接口：只发任务号，结果走 SSE ----
    if (path === '/api/crawl/submit' && method === 'POST') {
      var dts = [b.date || today()];
      return json({ task_id: makeTask(planCrawl(dts[0])), dates: dts, count: dts.length });
    }
    var mCancel = /^\/api\/crawl\/([^/]+)\/cancel$/.exec(path);
    if (mCancel && method === 'POST') {
      var ct = decodeURIComponent(mCancel[1]);
      if (TASKS[ct]) {
        TASKS[ct] = [{ ms: 120, ev: { type: 'cancelled', progress: 0, message: '已取消抓取', data: { count: 0 } } }];
      }
      return json({ ok: true });
    }
    if (path === '/api/archive/dedup/scan' && method === 'POST') {
      return json({ task_id: makeTask(planDedup()) });
    }
    if (path === '/api/archive/dedup/apply' && method === 'POST') {
      var merged = [], removed = [], skipped = 0;
      (b.groups || []).forEach(function (ids) {
        var keep = null, drop = [];
        ids.forEach(function (id) {
          var x = null;
          S.items.forEach(function (i) { if (i.id === id) x = i; });
          if (!x) { skipped++; return; }
          if (!keep) keep = x; else drop.push(x);
        });
        if (!keep || !drop.length) return;
        keep.detail = drop.map(function (d) { return d.detail; })
          .filter(Boolean).join('；') || keep.detail;
        removed = removed.concat(drop.map(function (d) { return d.id; }));
        merged.push(keep);
      });
      var dropSet = {};
      removed.forEach(function (id) { dropSet[id] = 1; });
      S.items = S.items.filter(function (i) { return !dropSet[i.id]; });
      save();
      return json({ merged: merged, removed: removed, skipped: skipped });
    }
    if (path === '/api/report/generate' && method === 'POST') {
      return json({ task_id: makeTask(planReport(q.get('type') || 'weekly', q.get('start'), q.get('end'))) });
    }
    if (path === '/api/report/revise' && method === 'POST') {
      return json({ task_id: makeTask(planRevise(b.instruction || '', b.current || '')) });
    }

    // 没接的接口：返回 200 + 空对象，绝不 401（401 会把用户弹回登录页）
    return json({});
  }

  function addFb(kind, b) {
    if (!b.content || !b.content.trim()) return json({ error: '内容不能为空' }, 400);
    var f = {
      id: uid('fb'),
      kind: kind,
      name: b.name || DATA.me.name,
      content: b.content,
      votes: 0,
      status: '待处理',
      time: nowHM(),
      is_mine: true,
      replies: [],
    };
    S.feedback.push(f);
    save();
    return json({
      id: f.id, kind: f.kind, name: f.name, content: f.content,
      votes: 0, status: f.status, time: f.time,
    });
  }

  // ---------------------------------------------------------------- 接管 fetch
  var realFetch = window.fetch ? window.fetch.bind(window) : null;
  window.fetch = function (input, init) {
    var url = (typeof input === 'string') ? input : (input && input.url) || '';
    // 只接管同源的 /api/*，其余（外链、资源）原样放行
    var m = /^(?:https?:\/\/[^/]+)?(\/api\/[^?#]*)(\?[^#]*)?$/.exec(url);
    if (!m) return realFetch ? realFetch(input, init) : Promise.reject(new Error('no fetch'));
    var path = m[1];
    var q = new URLSearchParams(m[2] || '');
    var method = ((init && init.method) || 'GET').toUpperCase();
    try {
      return Promise.resolve(route(path, q, method, init));
    } catch (e) {
      return Promise.resolve(json({ error: String(e) }, 500));
    }
  };

  // ---------------------------------------------------------------- 接管 EventSource
  window.EventSource = function (url) {
    var self = this;
    this.readyState = 0;
    this.onmessage = null;
    this.onerror = null;
    this.onopen = null;
    this.__timers = [];
    this.close = function () {
      self.readyState = 2;
      self.__timers.forEach(clearTimeout);
      self.__timers = [];
    };
    var m = /\/api\/task\/([^/]+)\/stream/.exec(String(url));
    var steps = m && TASKS[decodeURIComponent(m[1])];
    if (!steps) {
      // 真 EventSource 找不到流时也是走 onerror，前端据此复位
      setTimeout(function () { if (self.readyState !== 2 && self.onerror) self.onerror({}); }, 40);
      return;
    }
    self.readyState = 1;
    if (self.onopen) setTimeout(function () { self.onopen({}); }, 0);
    var t = 0;
    steps.forEach(function (step) {
      t += step.ms;
      self.__timers.push(setTimeout(function () {
        if (self.readyState === 2) return;
        if (step.effect) { try { step.effect(); } catch (e) {} }
        if (self.onmessage) self.onmessage({ data: JSON.stringify(step.ev) });
      }, t));
    });
    self.__timers.push(setTimeout(function () {
      if (self.readyState !== 2) self.close();
    }, t + 60));
  };
})();
