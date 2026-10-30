#!/usr/bin/env python3
"""Run the TrendsUpLoader-derived public trend scanner in free fallback mode."""
import os
from social_discovery import main
os.environ["DISCOVERY_PAID_SEARCH_ENABLED"] = "false"
os.environ["YOUTUBE_API_ENABLED"] = "false"
raise SystemExit(main(force_fallback=True))
