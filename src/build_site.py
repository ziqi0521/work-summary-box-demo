"""把线上那份 index.html 转成对外演示站。

演示站和线上跑的是**同一份前端源码**，差别只有三处：Alpine 从 CDN 改成本地内联、
公司内网链接被换掉、以及末尾注入的演示数据 + shim。前端业务代码一行都不改 ——
所以线上改了什么，重新跑一次这个脚本就能同步过来。

每一条改写都要求**恰好命中一次**，命中数不对就直接退出。上游 index.html 一改，
这里会立刻炸掉而不是悄悄产出一个半坏的页面。

用法：python src/build_site.py
"""
from pathlib import Path
import re
import sys

ROOT = Path(__file__).resolve().parent.parent
SRC = ROOT / "src"
PROJECT = Path(r"C:\Users\ziqi.ma\Desktop\工作汇总工具")
SOURCE_HTML = PROJECT / "backend" / "static" / "index.html"
OUT_HTML = ROOT / "index.html"

DEMO_TITLE = "个人工作汇总BOX · 在线演示"


def sub_once(text, pattern, repl, what):
    """替换且必须恰好命中一次。命中 0 次或多次都说明上游变了，直接停手。"""
    new, n = re.subn(pattern, repl, text, flags=re.S)
    if n != 1:
        sys.exit(f"[build] {what}：期望命中 1 次，实际 {n} 次 —— 上游 index.html 变了，先改 build_site.py")
    return new


def main():
    if not SOURCE_HTML.exists():
        sys.exit(f"[build] 找不到源文件：{SOURCE_HTML}")
    html = SOURCE_HTML.read_text(encoding="utf-8")

    # ---- 1. 摘掉 Alpine 的 CDN <script> ------------------------------------
    # 只摘不换：Alpine 的 CDN 构建末尾是 `queueMicrotask(() => Alpine.start())`，
    # 而 start() 在 document.body 还不存在时会直接放弃初始化。原来靠 defer 撑到
    # DOM 解析完；**内联脚本不吃 defer**，留在 <head> 里就必然初始化失败（整页白屏，
    # 登录门常驻）。所以这里删掉，改到 </body> 前、shim 之后注入。
    html = sub_once(
        html,
        r'[ \t]*<script defer src="https://cdn\.jsdelivr\.net/npm/alpinejs@[^"]*"></script>\n',
        lambda m: "",
        "摘掉 Alpine CDN 标签",
    )

    # ---- 2. 标题标明是演示站 ----------------------------------------------
    html = sub_once(html, r"<title>[^<]*</title>",
                    lambda m: f"<title>{DEMO_TITLE}</title>", "改标题")

    # ---- 3. 内网链接 ------------------------------------------------------
    # 这里刻意用 `[\w.-]*feishu\.cn` 而不是把公司租户域名写死：写死的话
    # src/build_site.py 自己就会被 check_public.py 拦下来，而它是要公开的。
    # 使用教程指向站内那份公开版，而不是公司 wiki（外网打不开，也不该指向内部系统）
    html = sub_once(
        html,
        r"'https://[\w.-]*feishu\.cn/wiki/[^']*'",
        lambda m: "'tutorial.html'",
        "教程链接改指站内",
    )
    # 「飞书绩效」这张卡是「直达公司内部系统」的，连同报告页那个「复制并去绩效」按钮
    # 都写着公司系统名。但这条链路本身（同步复制 + 兜底异步复制 + 新开标签页）是
    # 实打实的功能，删卡会让按钮 `if (url) window.open()` 拿到 undefined、也会让
    # selectTool 跳到一个不存在的 section —— 所以只中性化措辞、把链接换成占位地址。
    html, n = re.subn("飞书绩效", "绩效自评", html)
    if n < 3:
        sys.exit(f"[build] 「飞书绩效」只命中 {n} 次（卡片/按钮/日志至少 3 处）—— 上游变了")
    html = sub_once(
        html,
        r"url: 'https://[\w.-]*feishu\.cn/perf/[^']*'",
        lambda m: "url: 'https://example.com/perf-review'",
        "绩效卡链接换占位地址",
    )
    # 网关地址占位符：把公司域名换成通用示例
    html, n = re.subn(r"https://llm-gateway\.[\w.-]+", "https://api.example-llm.com/v1", html)
    if n < 1:
        sys.exit("[build] 网关占位符一处都没命中 —— 上游变了")
    # 注释里点了内网服务的名（讲 OAuth 回调页长什么样），对外站没必要留
    html = sub_once(
        html,
        r"// ① 整段 JSON（如 \S+ 回调页返回的",
        lambda m: "// ① 整段 JSON（如回调页返回的",
        "去掉内网服务名注释",
    )

    # ---- 4. 上新日志加一条 v0.12 ------------------------------------------
    html = sub_once(
        html,
        r"(CHANGELOG: \[\n)",
        lambda m: m.group(1)
        + "      { v: 'v0.12', date: '2026-10-08', items: [\n"
        + "        '新增对外演示站：脱敏数据的静态版，公开可访问',\n"
        + "      ] },\n",
        "CHANGELOG 加 v0.12",
    )

    # ---- 5. 末尾注入演示数据 + shim + Alpine ------------------------------
    # 顺序不能动：横幅 → 数据 → shim → Alpine。
    # Alpine 放最后是因为它 start() 时要 document.body 已经存在（见上面第 1 条）；
    # shim 放 Alpine 前面是因为 Alpine 一 start 就会跑 x-init 里的 init()，
    # 那一刻 fetch('/api/me') 必须已经被接管。
    data_js = (SRC / "demo_data.js").read_text(encoding="utf-8")
    shim_js = (SRC / "shim.js").read_text(encoding="utf-8")
    alpine = (SRC / "alpine.min.js").read_text(encoding="utf-8")
    banner = (SRC / "banner.html").read_text(encoding="utf-8")

    inject = (
        "\n<!-- ===== 演示站附加内容（由 src/build_site.py 注入，勿手改） ===== -->\n"
        + banner
        + "\n<script>\n" + data_js + "\n</script>\n"
        + "<script>\n" + shim_js + "\n</script>\n"
        + "<script>\n" + alpine + "\n</script>\n"
    )
    html = sub_once(html, r"</body>", lambda m: inject + "</body>", "注入演示内容")

    OUT_HTML.write_text(html, encoding="utf-8")
    size = OUT_HTML.stat().st_size
    print(f"[build] 写出 {OUT_HTML}（{size:,} 字节）")
    # 只做「改写规则有没有生效」的自查；真实数据/内网地址的兜底在 src/check_public.py
    for token in ("cdn.jsdelivr.net", "飞书绩效"):
        if token in html:
            print(f"[build] !! 产物里仍有 {token!r}，检查改写规则")


if __name__ == "__main__":
    main()
