-- Goushibaaz / Cloudflare D1 schema
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS app_config (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS scan_runs (
  id TEXT PRIMARY KEY,
  source TEXT NOT NULL,
  started_at TEXT NOT NULL,
  finished_at TEXT,
  status TEXT NOT NULL,
  candidate_count INTEGER NOT NULL DEFAULT 0,
  emerging_count INTEGER NOT NULL DEFAULT 0,
  note TEXT
);

CREATE TABLE IF NOT EXISTS video_candidates (
  video_id TEXT PRIMARY KEY,
  source_platform TEXT NOT NULL DEFAULT 'youtube',
  source_url TEXT NOT NULL,
  title TEXT NOT NULL,
  channel_id TEXT,
  channel_title TEXT,
  published_at TEXT,
  first_seen_at TEXT NOT NULL,
  last_seen_at TEXT NOT NULL,
  view_count INTEGER NOT NULL DEFAULT 0,
  like_count INTEGER,
  comment_count INTEGER,
  duration TEXT,
  source_license TEXT,
  views_per_minute REAL NOT NULL DEFAULT 0,
  previous_views_per_minute REAL NOT NULL DEFAULT 0,
  growth_ratio REAL NOT NULL DEFAULT 0,
  growth_score REAL NOT NULL DEFAULT 0,
  snapshot_count INTEGER NOT NULL DEFAULT 0,
  trend_state TEXT NOT NULL DEFAULT 'insufficient_history',
  content_fit TEXT NOT NULL DEFAULT 'other_language_review',
  language_hint TEXT NOT NULL DEFAULT 'unknown',
  fit_reason TEXT,
  license_status TEXT NOT NULL DEFAULT 'unverified',
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS video_snapshots (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  video_id TEXT NOT NULL,
  observed_at TEXT NOT NULL,
  views INTEGER NOT NULL,
  likes INTEGER,
  comments INTEGER,
  UNIQUE(video_id, observed_at),
  FOREIGN KEY(video_id) REFERENCES video_candidates(video_id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_video_snapshots_video_time
  ON video_snapshots(video_id, observed_at DESC);
CREATE INDEX IF NOT EXISTS idx_video_snapshots_time
  ON video_snapshots(observed_at DESC);
CREATE INDEX IF NOT EXISTS idx_video_candidates_score
  ON video_candidates(growth_score DESC, last_seen_at DESC);
CREATE INDEX IF NOT EXISTS idx_video_candidates_content_fit
  ON video_candidates(content_fit, growth_score DESC, last_seen_at DESC);

CREATE TABLE IF NOT EXISTS publication_authorizations (
  video_id TEXT PRIMARY KEY,
  status TEXT NOT NULL CHECK(status IN ('approved', 'rejected', 'revoked')),
  license_type TEXT NOT NULL CHECK(license_type IN ('owner_permission', 'public_domain', 'cc_commercial', 'other_verified')),
  evidence_url TEXT NOT NULL,
  media_url TEXT,
  notes TEXT,
  approved_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY(video_id) REFERENCES video_candidates(video_id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS delivery_jobs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  video_id TEXT NOT NULL,
  destination TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  attempt_count INTEGER NOT NULL DEFAULT 0,
  next_attempt_at TEXT,
  destination_post_id TEXT,
  last_error TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(video_id, destination),
  FOREIGN KEY(video_id) REFERENCES video_candidates(video_id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_delivery_due
  ON delivery_jobs(status, next_attempt_at);
