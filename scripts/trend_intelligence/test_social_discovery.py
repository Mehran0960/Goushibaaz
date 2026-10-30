import sys
import unittest
from datetime import datetime, timedelta, timezone
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from social_discovery import attach_view_trajectory, rotating_batch, rotating_query_index, youtube_search_due


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

    def test_rapid_latest_snapshot_does_not_discard_older_usable_history(self):
        now = datetime(2026, 10, 30, 12, 0, tzinfo=timezone.utc)
        previous = [{
            "id": "stable-video-id",
            "views": 1500,
            "metrics_observed_at": (now - timedelta(seconds=30)).isoformat(),
            "views_history": [
                {
                    "observed_at": (now - timedelta(hours=1)).isoformat(),
                    "views": 1000,
                },
                {
                    "observed_at": (now - timedelta(seconds=30)).isoformat(),
                    "views": 1500,
                },
            ],
        }]
        current = [{"id": "stable-video-id", "views": 1600, "age_hours": 2}]
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


class RotatingDiscoveryBatchTests(unittest.TestCase):
    def test_two_telegram_batches_cover_all_channels_without_overlap(self):
        now = datetime(2026, 10, 30, 12, 0, tzinfo=timezone.utc)
        channels = [f"channel-{i}" for i in range(48)]
        first = rotating_batch(channels, now, batch_size=24, window_seconds=15 * 60)
        second = rotating_batch(channels, now + timedelta(minutes=15), batch_size=24, window_seconds=15 * 60)
        self.assertEqual(len(first), 24)
        self.assertEqual(len(second), 24)
        self.assertFalse(set(first) & set(second))
        self.assertEqual(set(first) | set(second), set(channels))
        self.assertEqual(
            first,
            rotating_batch(channels, now + timedelta(minutes=30), batch_size=24, window_seconds=15 * 60)
        )

    def test_two_chart_batches_cover_all_region_category_pairs(self):
        now = datetime(2026, 10, 30, 12, 0, tzinfo=timezone.utc)
        buckets = [(region, category) for region in ["US", "GB", "CA", "IN", "BR", "DE", "TR", "AU"]
                   for category in ["15", "17", "23", "24", "26", "28"]]
        first = rotating_batch(buckets, now, batch_size=24, window_seconds=15 * 60)
        second = rotating_batch(buckets, now + timedelta(minutes=15), batch_size=24, window_seconds=15 * 60)
        self.assertFalse(set(first) & set(second))
        self.assertEqual(set(first) | set(second), set(buckets))

    def test_youtube_search_budget_is_spread_across_the_day(self):
        now = datetime(2026, 10, 30, 12, 0, tzinfo=timezone.utc)
        ledger = {"youtube_search_last_at": (now - timedelta(minutes=40)).isoformat()}
        self.assertFalse(youtube_search_due(ledger, now))
        self.assertTrue(youtube_search_due(ledger, now + timedelta(minutes=8)))

    def test_full_web_query_pool_rotates_without_skipping_entries(self):
        now = datetime(2026, 10, 30, 12, 0, tzinfo=timezone.utc)
        indexes = {
            rotating_query_index(now + timedelta(minutes=15 * slot), query_count=22)
            for slot in range(22)
        }
        self.assertEqual(indexes, set(range(22)))


if __name__ == "__main__":
    unittest.main()
