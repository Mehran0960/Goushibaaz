#!/usr/bin/env python3
"""Build a safe, human-readable shortlist from the latest trend-intelligence snapshot.

Discovery intelligence only: this script never downloads, edits, or publishes media.
"""
import json
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
STATE = ROOT / "state" / "trend-intelligence.json"
OUTPUT = ROOT / "reports" / "latest-trend-preview.md"


def number(value, digits=0):
    try:
        return f"{float(value):,.{digits}f}"
    except (TypeError, ValueError):
        return "—"


def compact_title(value, limit=125):
    text = " ".join(str(value or "").split())
    return text if len(text) <= limit else text[: limit - 1] + "…"


def choose_diverse(rows, limit=10, per_lane=2):
    chosen = []
    lane_counts = {}
    seen = set()
    for row in rows:
        url = str(row.get("url") or "")
        lane = str(row.get("content_lane") or "unclassified")
        if not url or url in seen or lane_counts.get(lane, 0) >= per_lane:
            continue
        seen.add(url)
        lane_counts[lane] = lane_counts.get(lane, 0) + 1
        chosen.append(row)
        if len(chosen) >= limit:
            break
    return chosen


def main():
    if not STATE.exists():
        raise SystemExit("trend-intelligence.json not found")
    data = json.loads(STATE.read_text(encoding="utf-8"))
    items = data.get("items") if isinstance(data.get("items"), list) else []

    observed = [
        x for x in items
        if x.get("platform") == "telegram"
        and x.get("views_velocity_kind") == "observed"
        and x.get("candidate_action") in {
            "prioritize_for_visual_and_rights_review", "manual_review"
        }
    ]
    observed.sort(
        key=lambda x: (
            float(x.get("momentum_priority_score") or 0),
            float(x.get("views_velocity_per_hour") or 0),
            float(x.get("follow_growth_score") or 0),
        ),
        reverse=True,
    )
    telegram_shortlist = choose_diverse(observed)

    chart_rows = [
        x for x in items
        if x.get("platform") == "youtube"
        and x.get("source") == "youtube_global_chart"
        and float(x.get("age_hours") or 999999) <= 72
    ]
    chart_rows.sort(
        key=lambda x: (
            int(x.get("chart_region_count") or 0),
            -float(x.get("chart_average_rank") or 99),
            -float(x.get("age_hours") or 999999),
            int(x.get("views") or 0),
        ),
        reverse=True,
    )
    chart_shortlist = choose_diverse(chart_rows, limit=8, per_lane=2)

    observed_count = sum(1 for x in items if x.get("views_velocity_kind") == "observed")
    estimated_count = sum(
        1 for x in items if x.get("views_velocity_kind") == "estimated_from_lifetime_views"
    )
    youtube_count = sum(1 for x in items if x.get("source") == "youtube_global_chart")
    OUTPUT.parent.mkdir(parents=True, exist_ok=True)

    lines = [
        "# پیش‌نمایش رادار ترند گوشی‌باز",
        "",
        f"- آخرین به‌روزرسانی داده: {data.get('updated_at', 'نامشخص')}",
        f"- نامزدهای تحلیل‌شده: **{len(items)}**",
        f"- نرخ رشد مشاهده‌شده از چند snapshot: **{observed_count}**",
        f"- نرخ تخمینی بر اساس بازدید کل: **{estimated_count}**",
        f"- نامزدهای نمودار جهانی یوتیوب: **{youtube_count}**",
        "",
        "> این گزارش فقط سیگنال تقاضا و فهرست بررسی است؛ هیچ موردی با این گزارش مجوز دانلود یا بازنشر نمی‌گیرد.",
        "",
        "## نامزدهای دارای رشد مشاهده‌شده (تلگرام)",
        "",
        "| موضوع/عنوان | منبع | بازدید فعلی | رشد مشاهده‌شده در ساعت | امتیاز اولویت | وضعیت |",
        "|---|---|---:|---:|---:|---|",
    ]
    if telegram_shortlist:
        for x in telegram_shortlist:
            title = compact_title(x.get("title")).replace("|", "\\|")
            channel = str(x.get("telegram_channel") or "—")
            velocity = number(x.get("views_velocity_per_hour"))
            score = number(x.get("momentum_priority_score"), 1)
            action = str(x.get("candidate_action") or "manual_review")
            link = str(x.get("url") or "")
            lines.append(
                f"| [{title}]({link}) | {channel} | {number(x.get('views'))} | "
                f"{velocity} | {score} | {action} |"
            )
    else:
        lines.append("| هنوز مورد واجد شرایطی ثبت نشده | — | — | — | — | — |")

    lines += [
        "",
        "## سیگنال‌های نمودار جهانی یوتیوب (فقط کشف ترند)",
        "",
        "| عنوان | بازدید | عمر ویدئو (ساعت) | مناطق حضور در نمودار |",
        "|---|---:|---:|---:|",
    ]
    if chart_shortlist:
        for x in chart_shortlist:
            title = compact_title(x.get("title")).replace("|", "\\|")
            link = str(x.get("url") or "")
            lines.append(
                f"| [{title}]({link}) | {number(x.get('views'))} | "
                f"{number(x.get('age_hours'), 1)} | {number(x.get('chart_region_count'))} |"
            )
    else:
        lines.append("| هنوز نامزد تازه‌ای از نمودار جهانی موجود نیست | — | — | — |")

    lines += [
        "",
        "## محدودیت‌ها و حقوق انتشار",
        "",
        "- views_velocity_per_hour فقط در مواردی که نوع آن observed است از دو یا چند snapshot به‌دست آمده؛ مقدارهای تخمینی، رشد واقعی نیستند.",
        "- زمان تماشا و retention واقعی کانال‌های دیگر در دسترس نیست؛ امتیاز retention فقط یک proxy مبتنی بر metadata است.",
        "- وضعیت حقوقی موارد این فهرست بررسی نشده است؛ لینک عمومی یا ویدئوی ترند، اجازه بازنشر محسوب نمی‌شود.",
        "- انتشار عمومی خاموش می‌ماند تا مجوز و تأیید جداگانه دریافت شود.",
        "",
    ]
    OUTPUT.write_text("\n".join(lines), encoding="utf-8")


if __name__ == "__main__":
    main()
