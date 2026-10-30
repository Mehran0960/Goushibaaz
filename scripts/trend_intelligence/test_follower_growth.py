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
