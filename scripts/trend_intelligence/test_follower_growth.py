import sys
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "scripts" / "trend_intelligence"))

from follower_growth import annotate_candidate, retention_potential


class RetentionPotentialTests(unittest.TestCase):
    def test_open_loop_and_payoff_raise_metadata_proxy(self):
        strong = retention_potential({
            "duration_seconds": 16,
            "title": "Wait until the final reveal: impossible trick",
        })
        plain = retention_potential({
            "duration_seconds": 75,
            "title": "A general video",
        })
        self.assertGreater(strong, plain)

    def test_replay_cue_is_recognized(self):
        self.assertGreater(
            retention_potential({"duration_seconds": 20, "title": "Optical illusion puzzle"}),
            retention_potential({"duration_seconds": 20, "title": "Simple clip"}),
        )

    def test_cross_region_youtube_chart_signal_increases_priority(self):
        base = {
            "url": "https://www.youtube.com/watch?v=example",
            "title": "Amazing science demonstration",
            "description": "A short visual science experiment",
            "platform": "youtube",
            "source": "youtube_global_chart",
            "age_hours": 2,
            "views": 50000,
            "likes": 2000,
            "comments": 100,
            "views_velocity_per_hour": 5000,
            "views_velocity_kind": "observed",
            "duration_seconds": 20,
            "chart_rank": 2,
        }
        one_region = annotate_candidate({**base, "chart_region_count": 1})
        four_regions = annotate_candidate({**base, "chart_region_count": 4})
        self.assertGreater(four_regions["youtube_chart_signal_score"], one_region["youtube_chart_signal_score"])
        self.assertGreater(four_regions["follow_growth_score"], one_region["follow_growth_score"])

    def test_wooden_cabin_build_is_classified_as_diy(self):
        result = annotate_candidate({
            "url": "https://www.youtube.com/watch?v=example12345",
            "title": "Building Wooden Log Cabin in Forest | Survival House Step by Step",
            "description": "A single continuous woodworking and shelter construction project",
            "platform": "youtube",
            "source": "youtube_public_api",
            "age_hours": 2,
            "views": 14560765,
            "views_velocity_per_hour": 404746.08,
            "views_velocity_kind": "observed",
            "views_acceleration_per_hour2": 39587.09,
            "duration_seconds": 45,
        })
        self.assertEqual(result["content_lane"], "diy_and_creativity")
        self.assertEqual(result["views_velocity_kind"], "observed")
        self.assertEqual(result["views_acceleration_per_hour2"], 39587.09)
        self.assertFalse(result["news_risk_signal"])
        self.assertFalse(result["promotional_signal"])

    def test_persian_wooden_cabin_build_is_classified_as_diy(self):
        result = annotate_candidate({
            "url": "https://t.me/example/123",
            "title": "ساخت کلبه چوبی در جنگل با ابزار ساده",
            "description": "مراحل ساخت یک خانه چوبی کوچک",
            "platform": "telegram",
            "source": "telegram_native_video",
            "age_hours": 3,
            "views": 12000,
            "views_velocity_per_hour": 1200,
            "views_velocity_kind": "observed",
            "duration_seconds": 30,
        })
        self.assertEqual(result["content_lane"], "diy_and_creativity")

    def test_annotated_score_does_not_claim_measured_watch_time(self):
        result = annotate_candidate({
            "url": "https://t.me/example/123",
            "title": "قبل و بعد؛ نتیجه نهایی",
            "description": "یک تغییر غیرمنتظره",
            "platform": "telegram",
            "source": "telegram_native_video",
            "age_hours": 2,
            "views": 12000,
            "views_velocity_per_hour": 1500,
            "views_velocity_kind": "observed",
            "duration_seconds": 15,
        })
        self.assertIn("retention_potential_score", result)
        self.assertEqual(result["retention_evidence_basis"], "metadata_proxy_not_measured_watch_time")
        self.assertIs(result["watch_time_observed"], False)


if __name__ == "__main__":
    unittest.main()
