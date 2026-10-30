#!/usr/bin/env python3
"""Run the TrendsUpLoader-derived public trend scanner in bounded free mode."""
import os
# Set before importing the module because provider switches are read at import time.
os.environ["DISCOVERY_PAID_SEARCH_ENABLED"] = "false"
os.environ["YOUTUBE_API_ENABLED"] = "true"
from social_discovery import main
# No Firecrawl spend. Public Telegram + rotating Bing + optional official YouTube
# Data API (only when its secret exists; internal ceiling is 30 searches/day).
raise SystemExit(main(force_fallback=True))
