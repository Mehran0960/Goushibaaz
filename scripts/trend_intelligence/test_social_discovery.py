import sys
import unittest
from datetime import datetime, timedelta, timezone
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from social_discovery import attach_view_trajectory


class ViewTrajectoryPersistenceTests(unittest.TestCase):
    def test_compact_platform_history_produces_observed_velocity(self):
        now = datetime(2026, 10, 30, 12, 0, tzinfo=timezone.utc)
        previous = [{
            "id": "stable-video-id",
            "url": "https://t.me/example/123",
            "last_views": 1000,
            "last_seen_at": (now - timedelta(hours=1)).isoformat(),
            "history": [{
                "at": (now - timedelta(hours=1)).isoformat(),
                "views": 1000,
            }],
        }]
        current = [{
            "id": "stable-video-id",
            "url": "https://t.me/example/123",
            "views": 1600,
            "age_hours": 2,
        }]
        result = attach_view_trajectory(current, previous, now)[0]
        self.assertEqual(result["views_velocity_kind"], "observed")
        self.assertEqual(result["views_delta_last_interval"], 600)
        self.assertAlmostEqual(result["views_velocity_per_hour"], 600.0)

    def test_non_increasing_views_are_not_misreported_as_growth(self):
        now = datetime(2026, 10, 30, 12, 0, tzinfo=timezone.utc)
        previous = [{
            "id": "stable-video-id",
            "last_views": 1000,
            "last_seen_at": (now - timedelta(hours=1)).isoformat(),
            "history": [{
                "at": (now - timedelta(hours=1)).isoformat(),
                "views": 1000,
            }],
        }]
        current = [{"id": "stable-video-id", "views": 900, "age_hours": 2}]
        result = attach_view_trajectory(current, previous, now)[0]
        self.assertEqual(result["views_velocity_kind"], "observed")
        self.assertEqual(result["views_delta_last_interval"], -100)
        self.assertLess(result["views_velocity_per_hour"], 0)


if __name__ == "__main__":
    unittest.main()
