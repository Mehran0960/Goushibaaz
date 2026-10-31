#!/usr/bin/env python3
"""Run the bounded Firecrawl-backed discovery pass; fall back safely when no repo key exists."""
import os

os.environ["YOUTUBE_API_ENABLED"] = "true"

if not os.environ.get("FIRECRAWL_API_KEY", "").strip():
    # ChatGPT's connected Firecrawl session is not inherited by GitHub runners.
    # Never make anonymous paid-search calls when the repository key is absent.
    os.environ["DISCOVERY_PAID_SEARCH_ENABLED"] = "false"
    from social_discovery import main
    print("FIRECRAWL_API_KEY_MISSING: using free Telegram/Bing/YouTube discovery only.")
    raise SystemExit(main(force_fallback=True))

os.environ["DISCOVERY_PAID_SEARCH_ENABLED"] = "true"
from social_discovery import main

# social_discovery.py enforces the persisted 800-credit monthly ceiling.
# Two searches per four-hour run use at most ~720 credits in a 30-day month.
raise SystemExit(main())
