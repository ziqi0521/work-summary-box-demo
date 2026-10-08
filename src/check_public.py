"""发布前闸门：确认公开产物里没有一处真实数据或内部地址。

**没跑绿就不许 push。**

做法是「拿真实数据反过来扫产物」：从项目的 work.db 里只读拉出真实姓名、群名、
项目名、open_id，在内存里当黑名单，再逐行扫仓库里每一个要公开的文本文件。
DB 里的东西**只进内存，不落盘、不打印原文**（命中只报前两个字 + 长度 + 行号，
够你定位就行）。

为什么必须这么做：这份产物是从线上页面改出来的，线上页面的占位文案、示例、
日志里本来就散着内部信息，改漏一处就发出去了。靠人眼看一遍不现实。

用法：python src/check_public.py
"""
from pathlib import Path
import re
import sqlite3
import sys

ROOT = Path(__file__).resolve().parent.parent
SRC = ROOT / "src"
PROJECT = Path(r"C:\Users\ziqi.ma\Desktop\工作汇总工具")
DB = PROJECT / "work.db"

# 本文件自己就装着下面这张黑名单，扫自己必然自伤 —— 跳过，且只跳它一个。
SELF = Path(__file__).resolve()

# 要公开的文件类型（按文本处理）；其余（png 等）跳过
TEXT_EXT = {".html", ".md", ".js", ".py", ".css", ".json", ".txt", ".yml", ".yaml"}
SKIP_DIRS = {".git", "node_modules", "__pycache__"}

# 公司/内网专有名词。这些在公开产物里一个都不该出现。
# 刻意**不含** `feishu`/`llm-gateway` 这类通用词：飞书是公开产品、llm-gateway 是
# 行业通用叫法，页面里出现它们是正常的（applink.feishu.cn 就是公开的深链域名）。
# 真正要拦的是「租户域名」（momenta.feishu.cn）—— 那被 `momenta` 这条兜住了。
HARDCODED = [
    "momenta",            # 公司名；同时兜住 momenta.feishu.cn / *.momenta.works
    "dpi-inner",          # 内网域名后缀
    "artifactory",        # 内网制品库
    "topbind",            # 内网服务名
    "10.21.15.20",        # 内网部署机
    "work.db",            # 生产库文件名
    "MY_OPEN_ID",
    "FEISHU_REDIRECT_URI",
]

# 形状类：不看具体值，只看像不像凭证
PATTERNS = [
    (r"ou_[0-9a-f]{16,}", "飞书 open_id"),
    (r"\bsk-[A-Za-z0-9_-]{16,}", "疑似 API Key"),
    (r"\b10\.\d{1,3}\.\d{1,3}\.\d{1,3}\b", "内网 IP"),
    (r"\b(?:u|t|r|s)-[A-Za-z0-9_-]{20,}\b", "疑似飞书 token"),
    (r"[\\/]\.feishu[\\/]", "飞书凭证目录路径"),
]


def mask(s):
    """命中只报前两个字 + 长度：够定位，又不至于把真实姓名抄进日志。"""
    s = s.strip()
    if len(s) <= 2:
        return s[0] + "·" * (len(s) - 1)
    return s[:2] + "…" + f"({len(s)}字)"


def denylist_from_db():
    """只读拉真实数据当黑名单。DB 不存在就跳过（比如换了台机器）。"""
    if not DB.exists():
        print(f"[gate] 找不到 {DB.name}，跳过真实数据比对（只跑硬编码词表）")
        return set()
    terms = set()
    q = [
        ("users.name", "SELECT name FROM users"),
        ("feedback.name", "SELECT name FROM feedback"),
        ("feedback_replies.name", "SELECT name FROM feedback_replies"),
        ("game_scores.name", "SELECT name FROM game_scores"),
        ("work_items.project", "SELECT project FROM work_items"),
        ("work_items.title", "SELECT title FROM work_items"),
        ("raw_messages.chat_name", "SELECT chat_name FROM raw_messages"),
        ("users.open_id", "SELECT open_id FROM users"),
        ("raw_messages.sender_id", "SELECT DISTINCT sender_id FROM raw_messages"),
    ]
    try:
        conn = sqlite3.connect(f"file:{DB.as_posix()}?mode=ro", uri=True)
        conn.row_factory = sqlite3.Row
        for label, sql in q:
            # 逐条报数：某张表读空了必须看得见，不然闸门会「全绿」但什么都没比
            try:
                rows = conn.execute(sql).fetchall()
            except sqlite3.Error as e:
                print(f"[gate] !! {label} 读失败：{e}")
                continue
            got = 0
            for r in rows:
                v = r[0]
                if isinstance(v, str) and len(v.strip()) >= 2:
                    terms.add(v.strip())
                    got += 1
            print(f"[gate]   {label:24} {len(rows):5} 行 → {got} 条可用")
        conn.close()
    except sqlite3.Error as e:
        print(f"[gate] 读生产库失败（{e.__class__.__name__}），只跑硬编码词表")
        return set()

    # 同事姓名其实**不在** users 表里（那张表只有登录过的本人），而是在消息正文里
    # 以 @提及 的形式出现。只捞 @ 后面那段（到标点/空白为止），噪声最小。
    try:
        conn = sqlite3.connect(f"file:{DB.as_posix()}?mode=ro", uri=True)
        n_rows = n_men = 0
        for (txt,) in conn.execute("SELECT text FROM raw_messages WHERE text LIKE '%@%'"):
            n_rows += 1
            for m in re.finditer(r"@([^\s@,，。；;:：、()（）\[\]【】<>《》]{1,12})", txt or ""):
                name = m.group(1).strip()
                if len(name) >= 2:
                    terms.add(name)
                    n_men += 1
        conn.close()
        print(f"[gate]   raw_messages.text @提及  {n_rows:5} 行 → 捞出 {n_men} 条")
    except sqlite3.Error as e:
        print(f"[gate] !! 捞 @提及 失败：{e}")

    print(f"[gate] 黑名单共 {len(terms)} 条去重词条（只在内存里，不落盘）")
    return terms


def targets():
    out = []
    for p in ROOT.rglob("*"):
        if not p.is_file():
            continue
        if any(part in SKIP_DIRS for part in p.parts):
            continue
        if p.resolve() == SELF:
            continue
        if p.suffix.lower() in TEXT_EXT:
            out.append(p)
    return sorted(out)


def scan_line(line, real_sorted):
    """一行文本的命中检查。抽出来是为了自检能复用同一条路径。"""
    hits = []
    low = line.lower()
    for term in HARDCODED:
        if term.lower() in low:
            hits.append((f"硬编码词表 {term!r}", line.strip()[:110]))
    for term in real_sorted:
        if term in line:
            hits.append((f"真实数据 {mask(term)}", line.strip()[:110]))
    for pat, label in PATTERNS:
        m = re.search(pat, line)
        if m:
            hits.append((f"{label} {mask(m.group(0))}", line.strip()[:110]))
    return hits


def self_test(real):
    """证明闸门不是空转的：拿一条真实词条当探针，走一遍真正的匹配路径。

    探针只在内存里拼一行字符串，**不落盘**。没有这一步的话，黑名单读空了、
    或者匹配写错了，闸门照样打印「全部通过」，比没有闸门更危险。
    """
    if not real:
        print("[gate] !! 自检失败：黑名单是空的，闸门现在等于空转")
        return False
    probe = max(real, key=len)
    got = scan_line(f"<p>这里塞一条 {probe} 试试</p>", sorted(real, key=len, reverse=True))
    if not any(h[0].startswith("真实数据") for h in got):
        print("[gate] !! 自检失败：真实词条没被匹配上，闸门的比对逻辑有问题")
        return False
    # 反向：造一个明显安全的串，不该误报
    clean = scan_line("这是一个完全干净的演示句子 demo", sorted(real, key=len, reverse=True))
    if clean:
        print(f"[gate] !! 自检失败：干净文本被误报 {len(clean)} 处")
        return False
    print(f"[gate] 自检通过：探针能命中、干净文本不误报")
    return True


def main():
    if not (ROOT / "index.html").exists():
        sys.exit("[gate] 没有 index.html —— 先跑 python src/build_site.py")

    real = denylist_from_db()
    # 长词优先，避免短词先命中把长词的上下文吃掉
    real_sorted = sorted(real, key=len, reverse=True)
    if not self_test(real):
        sys.exit(1)

    hits = []
    files = targets()
    for p in files:
        try:
            text = p.read_text(encoding="utf-8")
        except (UnicodeDecodeError, OSError):
            continue
        for lineno, line in enumerate(text.splitlines(), 1):
            for what, ctx in scan_line(line, real_sorted):
                hits.append((p, lineno, what, ctx))

    print(f"[gate] 扫了 {len(files)} 个文本文件")
    if hits:
        print(f"\n[gate] ✗ 命中 {len(hits)} 处，禁止发布：\n")
        for p, lineno, what, ctx in hits[:60]:
            print(f"  {p.relative_to(ROOT)}:{lineno}  {what}")
            print(f"      {ctx}")
        if len(hits) > 60:
            print(f"  … 还有 {len(hits) - 60} 处")
        sys.exit(1)

    print("[gate] ✓ 全部通过：没有真实数据、没有内部地址")


if __name__ == "__main__":
    main()
