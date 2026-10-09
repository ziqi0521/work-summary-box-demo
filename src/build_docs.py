# -*- coding: utf-8 -*-
"""把两篇线上 wiki 文档读出来 → 脱敏 → 渲染成对外可读的 tutorial.html / design.html。

用法：
    python src/build_docs.py                # 读线上 wiki（默认，需要飞书 token 有效）
    python src/build_docs.py --from-local   # 用 scripts/ 下的本地快照，只用于调试流水线

为什么默认必须读线上：本地快照是 2026-09-22 的 v0.5，线上已经到 v0.11+。
拿快照去生成公开文档 = 发一份落后六个版本的说明出去。所以读不到线上就退出，
不静默降级（要降级必须显式加 --from-local）。

脱敏是「尽力替换 + 硬校验」两层：先按 RULES 做替换，再把结果逐条扫 LEFTOVER，
命中就退出。不靠「我列全了替换规则」这种自信 —— 靠最后那道扫描兜底。
"""
import argparse
import re
import sys
from pathlib import Path

import markdown

ROOT = Path(__file__).resolve().parent.parent
PROJECT = Path(r"C:\Users\ziqi.ma\Desktop\工作汇总工具")
OUT_DOCS = ROOT / "src" / "docs"

# 演示站地址。换仓库名的话改这里一处。
SITE_URL = "https://ziqi0521.github.io/work-summary-box-demo/"
README_URL = "https://github.com/ziqi0521/work-summary-box-demo#readme"

# ---------------------------------------------------------------- 脱敏

RULES = [
    # 内网访问地址 → 演示站
    (r"http://10\.21\.15\.20:8002", SITE_URL),
    # 教程开头那条「公开演示站」自己带着演示站地址，而上一行规则已经把文首的
    # 内网地址也换成了同一个地址 —— 公网上会连着两条一模一样的链接。这里把那条
    # 说明里的地址去掉，改指向上一条。（内部版两条地址不同，这个替换不会命中。）
    (r"还有一个\*\*公开的演示站\*\*：" + re.escape(SITE_URL) + r"\s*——",
     "还有一个**公开的演示站**（就是上面那条「访问地址」）——"),
    # 飞书知识库链接（内网租户，外网打不开）
    (r"https?://[\w.-]*feishu\.cn/wiki/\S+", "（内部文档链接已移除）"),
    # 大模型网关 / 内部平台
    (r"https://llm-gateway\.momenta\.works", "https://api.example-llm.com/v1"),
    (r"\[abp\.momenta\.works\]\(https://abp\.momenta\.works[^)]*\)", "大模型服务商控制台"),
    (r"abp\.momenta\.works", "大模型服务商控制台"),
    # 线上库文件名（先吃掉「SQLite work.db」这种连写，否则会变成「SQLite 本地 SQLite 库」）
    (r"SQLite\s+`?work\.db`?", "SQLite 库"),
    (r"`?work\.db`?", "本地库"),
    # 凭证目录
    (r"`?\.feishu`?\s*与\s*本地库", "凭证目录与本地库"),
    (r"`?\.feishu`?", "凭证目录"),
    # 飞书图片 token —— 内网图床，外网取不到，且原图是真实数据截图
    (r"!\[\]\(image_token=[^)]*\)", ""),
    # 内部称谓中性化
    (r"公司内网电脑", "一台电脑"),
    (r"公司内网", "本地部署"),
    (r"同事", "用户"),
    # 与演示站口径保持一致（演示站里这张卡叫「绩效自评」）
    (r"飞书绩效", "绩效自评"),
    # 文档里拿真实 Key 的打码形式举例（首尾各露几位），公开版一律抹平。
    # 省略号是单个 U+2026「…」，不是三个英文句点 —— 第一版按 ... 写，没命中。
    (r"sk-[A-Za-z0-9_-]{1,12}(?:\.\.\.|…)[A-Za-z0-9_-]{1,12}", "sk-****…****"),
]

# 生成后逐条扫，命中即失败。这才是真正的闸门。
LEFTOVER = [
    (r"momenta", "公司域名"),
    (r"10\.21\.15\.20", "内网 IP"),
    (r"image_token=", "飞书图片 token"),
    (r"[\w.-]*feishu\.cn/wiki/", "飞书知识库链接"),
    (r"work\.db", "线上库文件名"),
    (r"\bou_[0-9a-f]{16,}", "飞书 open_id"),
    (r"同事", "内部称谓"),
    (r"公司内网", "内部网络描述"),
    (r"sk-[A-Za-z0-9_-]{1,12}(?:\.\.\.|…)[A-Za-z0-9_-]{1,12}", "打码形式未抹平的 API Key"),
]

# 演示站与线上版的差异 —— 插在对应小节标题后面。
# 不做整节改写：文档本身描述的是线上版的真实设计（这对作品集有价值），
# 差异用一段说明标出来，比把原文改得面目全非更诚实也更好维护。
SECTION_NOTES = {
    "tutorial": [
        (
            "第一步：登录",
            "演示站**恒为已登录状态**，没有真实的飞书 OAuth。下面这段描述的是线上版的登录方式。",
        ),
        (
            "第二步：绑定你自己的大模型 Key",
            "演示站**不接真的大模型** —— 卡片、报告、实习总结都是预设内容的回放，"
            "所以这一步在演示站里不需要做，但下面解释了线上版为什么它是必做项。",
        ),
        (
            "第三步：抓取某天的工作",
            "演示站里「开始抓取」跑的是**模拟进度**，不会真的去读任何聊天记录。",
        ),
    ],
    "design": [],
}


LIST_RE = re.compile(r"^\s*(?:[-*+]|\d+[.)])\s+")
FENCE_RE = re.compile(r"^\s*(?:```|~~~)")
BREAK_RE = re.compile(r"^\s*(?:-{3,}|\*{3,}|_{3,})\s*$")
# 普通段落行：顶格，且不是列表 / 标题 / 引用 / 围栏
PLAIN_RE = re.compile(r"^(?![ \t#>`])(?![-*+]\s)(?!\d+[.)]\s)\S")


def normalize_md(md):
    """飞书导出的 markdown 经常缺空行，两头都要防：

    - 列表 / `---` 直接跟在段落后面 → 被吞进上一段；`段落\\n---` 还会被当成
      setext 二级标题。所以在它们前面补空行。
    - 反过来，普通段落直接跟在**列表项**后面 → markdown 把它当成上一项的「懒惰续行」
      并进去。设计方案里「**演进**：v0.1 …」那一整句、以及「v0.6 / v0.7 新增端点」
      那几段就这么被吞进了上面的列表项，公网上看着像列表的一部分。

    但如果这条裸行的**下一行又是列表项**（设计方案里「**v0.6 / v0.7 新增端点**」那句），
    补空行会把列表劈成两半、还丢掉它自己的项目符号 —— 这种补回同款符号即可。

    **只对列表项补**，引用块不补：read_live 渲染引用块时只给第一行加 `>`，第二行起
    是裸的 —— 那是同一个引用块里的换行，补空行会把后半句甩出引用框（试过，回退了）。

    代码围栏内不动；缩进的续行 / 嵌套列表不动（飞书的列表续行都是缩进的）。"""
    lines = md.splitlines()
    out = []
    in_fence = False
    prev = ""
    for i, line in enumerate(lines):
        nxt = lines[i + 1] if i + 1 < len(lines) else ""
        if FENCE_RE.match(line):
            in_fence = not in_fence
        if not in_fence and prev.strip():
            if (PLAIN_RE.match(line) and LIST_RE.match(prev) and LIST_RE.match(nxt)
                    and not prev.startswith((" ", "\t"))):
                # 夹在两条列表项之间的裸行：原样留着会把列表劈成两半，补回同款项目符号
                line = LIST_RE.match(prev).group(0) + line
                out.append(line)
                prev = line             # 让下一项仍被当成列表项，否则列表会被判成「松散」、各项套上 <p>
                continue
            if BREAK_RE.match(line):
                out.append("")          # 段落/列表 后面直接跟 --- → 补空行
            elif (LIST_RE.match(line)
                  and not LIST_RE.match(prev)
                  and not prev.startswith((" ", "\t"))):
                out.append("")          # 段落后面直接跟列表 → 补空行
            elif (PLAIN_RE.match(line) and LIST_RE.match(prev)
                  and not prev.startswith((" ", "\t"))):
                out.append("")          # 顶层列表项后面直接跟段落 → 补空行（否则被当成懒惰续行吞进去）
                                        # 缩进的嵌套项后面不补：那是飞书的列表续行，本来就是同一项
        out.append(line)
        prev = line
    return "\n".join(out)


def apply_rules(md_text, report):
    for pat, repl in RULES:
        md_text, n = re.subn(pat, repl, md_text)
        if n:
            report.append(f"  替换 {n:>3} 处  {pat[:56]}")
    return md_text


def scan_leftover(html, where):
    hits = []
    for pat, label in LEFTOVER:
        for m in re.finditer(pat, html):
            line = html.count("\n", 0, m.start()) + 1
            hits.append(f"  {where}:{line}  {label} —— 命中 {pat}")
    return hits


def add_section_notes(md_text, report, doc_name, kind):
    """在每个目标小节标题后插一段「演示模式差异」说明。标题找不到就记一笔，不静默跳过。"""
    notes = SECTION_NOTES.get(kind, [])
    out = []
    used = set()
    for line in md_text.splitlines(keepends=True):
        out.append(line)
        if not line.startswith("#"):
            continue
        for anchor, note in notes:
            if anchor in line and anchor not in used:
                used.add(anchor)
                out.append(f"\n> [!demo]\n> **演示模式下：**{note}\n\n")
    for anchor, _ in notes:
        if anchor not in used:
            report.append(f"  [警告] {doc_name}：没找到小节「{anchor}」，差异说明未插入")
    return "".join(out)


# ---------------------------------------------------------------- 渲染

DOC_CSS = """
:root { color-scheme: light; --ink:#1e293b; --muted:#64748b; --line:#e2e8f0;
        --bg:#f6f7fb; --card:#fff; --accent:#2563eb; }
* { box-sizing: border-box; }
body { margin:0; background:var(--bg); color:var(--ink);
       font:15px/1.8 -apple-system,"Segoe UI","Microsoft YaHei",system-ui,sans-serif; }
a { color:var(--accent); text-decoration:none; }
a:hover { text-decoration:underline; }
code { background:#f1f5f9; border:1px solid var(--line); border-radius:5px;
       padding:1px 5px; font-size:.88em;
       font-family:"Cascadia Mono",Consolas,"SF Mono",Menlo,monospace; }
pre { background:#0f172a; color:#e2e8f0; border-radius:12px; padding:16px 18px;
      overflow:auto; font-size:13px; line-height:1.65; }
pre code { background:none; border:none; color:inherit; padding:0; font-size:inherit; }
hr { border:none; border-top:1px solid var(--line); margin:28px 0; }
h1,h2,h3,h4 { color:#0f172a; line-height:1.4; }
h2 { font-size:20px; margin:36px 0 12px; padding-bottom:8px;
     border-bottom:1px solid var(--line); }
h3 { font-size:17px; margin:26px 0 8px; }
h4 { font-size:15px; margin:20px 0 6px; color:var(--muted); }
blockquote { margin:16px 0; padding:10px 16px; border-left:3px solid var(--line);
             background:#f8fafc; color:#475569; border-radius:0 8px 8px 0; }
blockquote p { margin:6px 0; }
blockquote.callout { border-left:3px solid #f59e0b; background:#fffbeb; color:#78350f; }
blockquote.callout-demo { border-left:3px solid #3b82f6; background:#eff6ff; color:#1e40af; }
blockquote.callout-eyes { border-left:3px solid #ef4444; background:#fef2f2; color:#7f1d1d; }
table { border-collapse:collapse; width:100%; margin:16px 0; font-size:14px;
        background:var(--card); border-radius:10px; overflow:hidden; }
th,td { border:1px solid var(--line); padding:9px 12px; text-align:left;
        vertical-align:top; }
th { background:#f1f5f9; font-weight:600; color:#0f172a; }
ul,ol { padding-left:24px; }
li { margin:5px 0; }
img { max-width:100%; border-radius:10px; border:1px solid var(--line); }

.topbar { position:sticky; top:0; z-index:9; background:rgba(255,255,255,.9);
          backdrop-filter:blur(8px); border-bottom:1px solid var(--line); }
.topbar .inner { max-width:1100px; margin:0 auto; padding:12px 24px;
                 display:flex; align-items:center; gap:18px; font-size:14px; }
.topbar .brand { font-weight:600; color:#0f172a; }
.topbar .sp { flex:1; }
.topbar nav a { margin-left:16px; color:var(--muted); }
.topbar nav a.on { color:var(--accent); font-weight:600; }

.layout { max-width:1100px; margin:0 auto; padding:32px 24px 80px;
          display:grid; grid-template-columns:230px minmax(0,1fr); gap:32px;
          align-items:start; }
.toc { position:sticky; top:76px; font-size:13px; max-height:calc(100vh - 100px);
       overflow:auto; }
.toc ul { list-style:none; padding-left:0; margin:0; }
.toc ul ul { padding-left:14px; }
.toc li { margin:3px 0; }
.toc a { color:var(--muted); display:block; padding:3px 8px; border-radius:6px;
         border-left:2px solid transparent; }
.toc a:hover { background:#eef2f7; color:var(--accent); text-decoration:none; }
.doc { background:var(--card); border-radius:16px; padding:36px 44px;
       box-shadow:0 4px 24px rgba(15,23,42,.06); min-width:0; }
.doc > h1 { margin:0 0 6px; font-size:24px; }
.sub { color:var(--muted); font-size:13px; margin:0 0 24px; }
.gallery { display:grid; grid-template-columns:repeat(2,minmax(0,1fr));
           gap:14px; margin:20px 0 28px; }
.gallery figure { margin:0; }
/* 截图是整页长图，直接塞进网格会糊成一团。固定高度 + 从顶部裁切，
   露出页头那一段（最好认的部分）。 */
.gallery img { width:100%; height:210px; object-fit:cover; object-position:top; }
.gallery figcaption { font-size:12px; color:var(--muted); margin-top:6px; text-align:center; }
footer { max-width:1100px; margin:0 auto; padding:0 24px 48px;
         color:var(--muted); font-size:13px; }
@media (max-width:860px) {
  .layout { grid-template-columns:1fr; }
  .toc { position:static; max-height:none; }
  .doc { padding:24px 20px; }
}
"""

DOC_HEAD = """<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>{title} · 个人工作汇总BOX</title>
<style>{css}</style>
</head>
<body>
<div class="topbar"><div class="inner">
  <a class="brand" href="./">个人工作汇总 BOX</a>
  <span class="sp"></span>
  <nav>
    <a href="./">在线演示</a>
    <a href="tutorial.html"{tut_on}>使用教程</a>
    <a href="design.html"{des_on}>设计方案</a>
    <a href="{readme}">README</a>
  </nav>
</div></div>
<main class="layout">
  <aside class="toc">{toc}</aside>
  <article class="doc">
"""

DOC_FOOT = """  </article>
</main>
<footer>
  演示站数据全部为虚构，不含任何真实姓名、群名、项目名或凭证 ·
  <a href="./">回到演示站</a>
</footer>
</body>
</html>
"""

GALLERY = """
<div class="gallery">
  <figure><img src="assets/confirm.png" alt="每日工作确认"><figcaption>每日工作确认</figcaption></figure>
  <figure><img src="assets/archive.png" alt="历史归档"><figcaption>历史归档</figcaption></figure>
  <figure><img src="assets/report.png" alt="报告生成"><figcaption>报告生成</figcaption></figure>
  <figure><img src="assets/profile.png" alt="我的工作画像"><figcaption>我的工作画像</figcaption></figure>
</div>
"""


def promote_table_headers(html):
    """Feishu 导出的表格没有 thead，首行其实表头。把每个表的首行提成 th。"""
    def fix(m):
        table = m.group(0)
        first = re.search(r"<tr>(.*?)</tr>", table, re.S)
        if not first or "<th" in first.group(1):
            return table
        head = first.group(1).replace("<td>", "<th>").replace("</td>", "</th>")
        return table.replace(first.group(0), f"<thead><tr>{head}</tr></thead>", 1)
    return re.sub(r"<table[^>]*>.*?</table>", fix, html, flags=re.S)


def postprocess(html):
    # 原始 HTML 块（Feishu 表格）里的 markdown 语法不会被解析，手工补上。
    # <pre> 里的内容要原样保留，所以按 pre 切成段，只处理段外部分。
    parts = re.split(r"(<pre>.*?</pre>)", html, flags=re.S)
    for i, part in enumerate(parts):
        if part.startswith("<pre>"):
            continue
        part = re.sub(r"\*\*(.+?)\*\*", r"<strong>\1</strong>", part, flags=re.S)
        part = re.sub(r"(?<![\w>])`([^`\n]+)`", r"<code>\1</code>", part)
        parts[i] = part
    html = "".join(parts)
    # border="1" 会压过样式表
    html = re.sub(r"<table[^>]*>", "<table>", html)
    html = promote_table_headers(html)
    # 飞书高亮块 / 我们的演示模式提示 → 带样式的 callout。
    # 标记和正文在同一段里（`> [!eyes]` 后面没空行），所以只摘掉标记本身。
    html = re.sub(
        r"<blockquote>\s*<p>\[!(\w+)\]\s*",
        lambda m: f'<blockquote class="callout callout-{m.group(1).lower()}">\n<p>',
        html,
    )
    return html


def build_doc(md_text, title, kind, report):
    md_text = normalize_md(md_text)
    md_text = add_section_notes(md_text, report, title, kind)

    md = markdown.Markdown(
        extensions=["extra", "sane_lists", "toc"],
        extension_configs={"toc": {"toc_depth": "2-3"}},
    )
    body = postprocess(md.convert(md_text))
    toc = md.toc or ""

    # 文档自带的那个 h1 由页面模板单独渲染（带 id 属性，所以不能只匹配 <h1>）
    body = re.sub(r"<h1[^>]*>.*?</h1>", "", body, count=1, flags=re.S)

    gallery = GALLERY if kind == "tutorial" else ""
    return (
        DOC_HEAD.format(
            title=title,
            css=DOC_CSS,
            toc=toc,
            readme=README_URL,
            tut_on=' class="on"' if kind == "tutorial" else "",
            des_on=' class="on"' if kind == "design" else "",
        )
        + f'<h1>{title}</h1>\n<p class="sub">个人工作汇总 BOX · 演示站</p>\n'
        + gallery
        + body
        + DOC_FOOT
    )


# ---------------------------------------------------------------- 取源


def read_live():
    sys.path.insert(0, str(PROJECT))
    from scripts._wiki_lib import read_live as _read, TUTORIAL, DESIGN  # noqa: PLC0415

    out = {}
    for key, url in (("tutorial", TUTORIAL), ("design", DESIGN)):
        ctx = _read(url)
        md = ctx.get("md") or ""
        if not md.strip():
            sys.exit(f"[docs] 线上读到的 {key} 是空的，先查 read_live 的返回结构")
        out[key] = md
        print(f"  线上 {key}: {len(md):,} 字符")
    return out


LOCAL_SNAPSHOT = {
    "tutorial": PROJECT / "scripts" / "_tutorial_current.md",
    "design": PROJECT / "scripts" / "_wiki_current.md",
}


def read_local():
    out = {}
    for key, path in LOCAL_SNAPSHOT.items():
        out[key] = path.read_text(encoding="utf-8")
        print(f"  本地 {key}: {len(out[key]):,} 字符  ({path.name})")
    return out


# ---------------------------------------------------------------- main


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--from-local", action="store_true",
                    help="用 scripts/ 下的本地快照（仅调试流水线，产出的文档会落后线上）")
    args = ap.parse_args()

    print("[docs] 取源")
    src = read_local() if args.from_local else read_live()
    if args.from_local:
        print("  ⚠️  用的是本地快照，不是线上内容 —— 只可用于调试流水线")

    report = []
    pages = {}
    snapshots = {}

    for key, title in (("tutorial", "使用教程"), ("design", "设计方案")):
        md_text = apply_rules(src[key], report)
        snapshots[key] = md_text
        pages[key] = build_doc(md_text, title, key, report)

    print("[docs] 脱敏")
    print("\n".join(report) if report else "  （没有命中任何替换规则 —— 可疑，检查取源）")

    hits = []
    for key, html in pages.items():
        hits += scan_leftover(html, f"{key}.html")
    if hits:
        print("[docs] 脱敏扫描未通过：")
        print("\n".join(hits))
        sys.exit(1)
    print("[docs] 脱敏扫描通过：无内网域名 / IP / 图片 token / 内部称谓")

    # --from-local 的产物写进 _preview/，绝不覆盖仓库根目录的正式页面 ——
    # 否则一次调试就可能把落后六个版本的文档当成正式产物提交出去。
    out_dir = (ROOT / "src" / "docs" / "_preview") if args.from_local else ROOT
    out_dir.mkdir(parents=True, exist_ok=True)
    snap_dir = (out_dir / "docs") if args.from_local else OUT_DOCS
    snap_dir.mkdir(parents=True, exist_ok=True)
    for key, html in pages.items():
        (out_dir / f"{key}.html").write_text(html, encoding="utf-8")
        # 脱敏后的 markdown 快照留档，让仓库能独立重建（原文不落盘）
        (snap_dir / f"{key}.md").write_text(snapshots[key], encoding="utf-8")
        print(f"[docs] 写出 {out_dir / (key + '.html')}  ({len(html):,} 字节)")
    if args.from_local:
        print("[docs] ⚠️  这是调试产物，未写入仓库根目录；正式生成请去掉 --from-local")


if __name__ == "__main__":
    main()
