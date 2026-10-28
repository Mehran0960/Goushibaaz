-- Persist the user's preferred content language/format signals for ranking and review.
ALTER TABLE video_candidates
  ADD COLUMN content_fit TEXT NOT NULL DEFAULT 'other_language_review';

ALTER TABLE video_candidates
  ADD COLUMN language_hint TEXT NOT NULL DEFAULT 'unknown';

ALTER TABLE video_candidates
  ADD COLUMN fit_reason TEXT;

CREATE INDEX IF NOT EXISTS idx_video_candidates_content_fit
  ON video_candidates(content_fit, growth_score DESC, last_seen_at DESC);
