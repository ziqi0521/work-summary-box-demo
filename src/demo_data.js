// 演示数据集 —— **全部内容为编造**，不含任何真实姓名、群名、项目名或凭证。
//
// 为什么不从线上库导：那张表里是公司真实数据（同事姓名、群聊原文、内部项目名、
// 飞书 refresh_token、大模型 key）。对外公开站只能用它自己造的这份。
// 发布前的 src/check_public.py 会拿线上库里的真实姓名/群名/项目名反过来扫构建产物，
// 命中就拦下来 —— 所以这份文件里出现任何真实名字都会在发布前被抓住。
//
// 日期按「今天」相对计算，这样任何时候打开演示站，「每日工作确认」里都有当天的待确认卡片。
(function () {
  const DAY = 86400000;
  const pad = (n) => String(n).padStart(2, '0');
  const dstr = (d) => d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate());
  const day = (back) => dstr(new Date(Date.now() - back * DAY));
  const at = (back, h, m) => day(back) + 'T' + pad(h) + ':' + pad(m) + ':00';
  const hm = (back, h, m) => day(back) + ' ' + pad(h) + ':' + pad(m);

  const ME = 'ou_demo_0000000000000001';
  const OWNER = ME;

  // sig = 后端 work_signature() 的产物（sha1 前 16 位）。演示数据里给固定值即可，
  // 前端只把它当不透明字符串，不做校验。
  const item = (back, title, detail, project, status, count, sig) => ({
    id: 'wi_' + sig,
    work_date: day(back),
    title: title,
    detail: detail,
    project: project,
    source_count: count,
    status: status,
    created_at: at(back, 18, 30),
    owner_open_id: OWNER,
    sig: sig,
  });

  const items = [
    // ---- 今天：待确认（打开页面就能看到这一批） ----
    item(0, '修复订单列表末页多返回一条数据', '翻页参数多算了一次偏移量，末页会多带出下一条订单', '订单中心', 'pending', 6, 'a1f30c7d2b9e4401'),
    item(0, '和产品对齐下周排期，确定先做导出', '确认导出功能优先级最高，下周三前出接口文档', '数据看板', 'pending', 4, 'b7e21a05c4d18f32'),
    item(0, '给支付回调补幂等校验', '同一笔回调重放会重复入账，按订单号+流水号做去重', '支付网关', 'pending', 5, 'c92d4f1e8a370b56'),
    item(0, 'Review 同事的本地缓存改造 PR', '提了 3 条意见：缓存失效时机、并发写、降级路径', '基础平台', 'pending', 3, 'd4a86b2f7c1e9035'),

    // ---- 昨天：已确认 ----
    item(1, '用户增长报表 SQL 从 8 秒优化到 1.2 秒', '去掉两个嵌套子查询，改成一次预聚合 + 索引覆盖', '数据看板', 'confirmed', 7, 'e1b95c3a6d240f87'),
    item(1, '输出导出功能的接口文档', '含参数、返回结构、分页与限流约定，已同步给前端', '数据看板', 'confirmed', 3, 'f2c07d4b9e5a1368'),
    item(1, '补 12 个订单状态机的单元测试', '覆盖取消、超时关闭、部分退款几条容易出错的分支', '订单中心', 'confirmed', 5, 'a3d18e5c0f7b2496'),
    item(1, '修复订单导出中文乱码', 'CSV 少了 BOM，Excel 打开中文全乱，补上后正常', '订单中心', 'confirmed', 4, 'b4e29f6d1a8c3507'),

    // ---- 前天 ----
    item(2, '日志采集从同步改成异步', '写日志不再阻塞主流程，接口 P99 从 210ms 降到 90ms', '基础平台', 'confirmed', 6, 'c5f3a07e2b9d4618'),
    item(2, '新增「日活留存」漏斗图', '按注册日分群，看次日/7 日/30 日留存', '数据看板', 'confirmed', 8, 'd6a4b18f3c0e5729'),
    item(2, '定位并修复优惠券重复核销', '并发下两次核销都读到未使用状态，加了行锁', '订单中心', 'confirmed', 9, 'e7b5c29a4d1f6830'),

    // ---- 3 天前 ----
    item(3, '对账任务加失败重试与告警', '原来失败只写日志没人看，现在重试 3 次后推告警群', '支付网关', 'confirmed', 5, 'f8c6d3ab5e208741'),
    item(3, '整理 CI 流水线，构建时间缩短 40%', '拆掉重复的依赖安装步骤，加了构建缓存', '基础平台', 'confirmed', 4, 'a9d7e4bc6f319852'),
    item(3, '报表定时任务从 6 点改到 7 点', '避开上游 6 点的批量任务，避免取到半截数据', '数据看板', 'confirmed', 3, 'b1e8f5cd7a420963'),

    // ---- 4 天前 ----
    item(4, '给看板加权限校验，非本组不可见', '按部门维度过滤，越权访问返回 403', '数据看板', 'confirmed', 6, 'c2f9a6de8b531074'),
    item(4, '拆分订单服务的大事务', '把发消息、写流水移出主事务，缩短锁持有时间', '订单中心', 'confirmed', 7, 'd3a0b7ef9c642185'),

    // ---- 5 天前：有确认也有忽略 ----
    item(5, '处理线上工单：用户看不到历史订单', '是分页缓存没失效，清掉缓存并加了失效钩子', '订单中心', 'confirmed', 8, 'e4b1c8f0ad753296'),
    item(5, '参加部门周会', '同步本周进度与下周计划', '', 'ignored', 2, 'f5c2d9a1be864307'),
    item(5, '在群里回复了字段口径的提问', '解释了「活跃用户」的口径差异', '', 'ignored', 3, 'a6d3e0b2cf975418'),

    // ---- 6 天前 ----
    item(6, '接入新的对账文件格式', '上游换了分隔符和编码，兼容新旧两种格式', '支付网关', 'confirmed', 5, 'b7e4f1c3d0a86529'),
    item(6, '重构看板查询层，抽出公共过滤器', '把 5 处重复的时间/部门过滤收敛成一个组件', '数据看板', 'confirmed', 6, 'c8f5a2d4e1b97630'),
  ];

  // ---- 预置报告：供「生成报告」的 SSE 流式回放（演示站不会真的调大模型） ----
  const weekly = [
    '## 本周工作总结',
    '',
    '### 一、订单中心',
    '- **修复订单列表末页多返回一条数据**：翻页偏移量多算一次，末页会带出下一条订单。已修复并补了边界用例。',
    '- **补 12 个订单状态机单元测试**：覆盖取消、超时关闭、部分退款几条容易出错的分支，覆盖率从 61% 提到 78%。',
    '- **定位并修复优惠券重复核销**：并发下两次核销都读到未使用状态，加行锁后复现不出来。',
    '- **拆分订单服务的大事务**：把发消息、写流水移出主事务，缩短锁持有时间。',
    '',
    '### 二、数据看板',
    '- **用户增长报表 SQL 从 8 秒优化到 1.2 秒**：去掉两个嵌套子查询，改成一次预聚合 + 索引覆盖。',
    '- **新增「日活留存」漏斗图**：按注册日分群，看次日 / 7 日 / 30 日留存。',
    '- **重构查询层，抽出公共过滤器**：把 5 处重复的时间/部门过滤收敛成一个组件。',
    '',
    '### 三、基础平台',
    '- **日志采集从同步改成异步**：写日志不再阻塞主流程，接口 P99 从 210ms 降到 90ms。',
    '- **整理 CI 流水线**：拆掉重复的依赖安装步骤，加构建缓存，构建时间缩短约 40%。',
    '',
    '### 四、支付网关',
    '- **对账任务加失败重试与告警**：原来失败只写日志没人看，现在重试 3 次后推告警。',
    '- **接入新的对账文件格式**：兼容新旧两种分隔符与编码。',
    '',
    '### 下周计划',
    '1. 完成数据导出功能的后端接口与文档。',
    '2. 支付回调幂等校验上线并观察一周。',
    '3. 继续补订单中心的状态机测试。',
  ].join('\n');

  const monthly = [
    '## 本月工作总结',
    '',
    '本月主要围绕**稳定性**和**数据可用性**两条线推进。',
    '',
    '### 稳定性',
    '- 修复优惠券重复核销、订单末页多取数等 3 个线上问题，其中 1 个来自工单。',
    '- 日志采集改异步，接口 P99 由 210ms 降至 90ms。',
    '- 对账任务补上失败重试与告警，不再依赖人工发现。',
    '',
    '### 数据可用性',
    '- 核心报表查询耗时由 8s 降至 1.2s。',
    '- 新增日活留存漏斗，补齐了看板缺失的留存视角。',
    '- 看板接入部门维度权限，越权访问返回 403。',
    '',
    '### 工程效率',
    '- CI 构建时间缩短约 40%。',
    '- 订单状态机测试覆盖率由 61% 提升至 78%。',
    '',
    '### 下月方向',
    '导出能力建设、支付链路的幂等与对账自动化。',
  ].join('\n');

  // ---- 反馈墙：需求与问题反馈 ----
  const fb = (id, kind, name, content, votes, status, back, isMine, replies) => ({
    id: id,
    kind: kind,
    name: name,
    content: content,
    votes: votes,
    status: status,
    time: hm(back, 10, 20),
    is_mine: !!isMine,
    replies: replies || [],
  });
  const rp = (id, name, content, back, isMine) => ({
    id: id, name: name, content: content, time: hm(back, 14, 5), is_mine: !!isMine,
  });

  const feedback = [
    // 需求
    fb('fb_demo_f1', 'feature', '林知远', '希望支持把周报一键导出成飞书文档，现在还要手动复制粘贴', 12, '已上线', 12, false, [
      rp('fr_demo_1', '演示用户', '已经上线了，在报告页右上角', 6, true),
      rp('fr_demo_2', '林知远', '试过了，格式保持得不错 👍', 5, false),
    ]),
    fb('fb_demo_f2', 'feature', '演示用户', '归档页希望能按项目筛选，条目多了不好找', 9, '处理中', 9, true, [
      rp('fr_demo_3', '陈墨', '同求，最好能多选', 7, false),
    ]),
    fb('fb_demo_f3', 'feature', '陈墨', '希望卡片字段可以自定义，不同团队关心的字段不一样', 6, '待处理', 8, false, []),
    fb('fb_demo_f4', 'feature', '周雨桐', '报告能不能直接发到群里，省得再转一次', 5, '待处理', 7, false, [
      rp('fr_demo_4', '演示用户', '在排期里了，先做导出', 6, true),
    ]),
    fb('fb_demo_f5', 'feature', '吴岸', '加个深色模式吧，晚上看白底有点刺眼', 3, '待处理', 4, false, []),

    // 问题反馈
    fb('fb_demo_b1', 'bug', '郑可', '抓取时偶尔卡在 90% 不动，刷新才恢复', 8, '已修复', 11, false, [
      rp('br_demo_1', '演示用户', '定位到了，是 SSE 连接被中间层掐断后没重连，已修', 4, true),
      rp('br_demo_2', '郑可', '今天试了没再出现，感谢', 3, false),
    ]),
    fb('fb_demo_b2', 'bug', '演示用户', '归档里搜中文关键词搜不到，英文可以', 7, '处理中', 10, true, [
      rp('br_demo_3', '苏迟', '我这边也是，看起来是分词的问题', 6, false),
    ]),
    fb('fb_demo_b3', 'bug', '苏迟', '报告生成后复制到剪贴板，表格的格式丢了', 4, '待处理', 6, false, []),
    fb('fb_demo_b4', 'bug', '何一舟', '手机上卡片右下角的按钮点不到，被挡住了', 3, '待处理', 5, false, [
      rp('br_demo_4', '演示用户', '收到，是绝对定位的层级问题', 5, true),
    ]),
    fb('fb_demo_b5', 'bug', '吴岸', '时间范围选同一天时，报告生成出来是空的', 2, '已修复', 3, false, []),
  ];

  window.__DEMO__ = {
    me: { open_id: ME, name: '演示用户' },
    isAdmin: true,
    settings: {
      llm_configured: true,
      llm_api_key_masked: 'sk-d3mo…9f2c',
      llm_base_url: 'https://api.example-llm.com/v1',
      llm_model: 'gpt-4o-mini',
    },
    stats: { views: 1842, triggers: 137, visitors: 96, views_today: 41 },
    items: items,
    reports: { weekly: weekly, monthly: monthly },
    feedback: feedback,
    leaderboard: [
      { name: '林知远', kind: 'account', score: 42, is_me: false, time: hm(9, 20, 14) },
      { name: '演示用户', kind: 'account', score: 37, is_me: true, time: hm(2, 21, 8) },
      { name: '像素小王子', kind: 'custom', score: 31, is_me: false, time: hm(11, 19, 42) },
      { name: '陈墨', kind: 'account', score: 28, is_me: false, time: hm(6, 12, 30) },
      { name: '匿名玩家', kind: 'anon', score: 24, is_me: false, time: hm(8, 9, 55) },
      { name: '周雨桐', kind: 'account', score: 19, is_me: false, time: hm(4, 16, 21) },
      { name: '吴岸', kind: 'account', score: 15, is_me: false, time: hm(13, 11, 7) },
      { name: '手残党', kind: 'custom', score: 9, is_me: false, time: hm(1, 22, 40) },
    ],
  };
})();
