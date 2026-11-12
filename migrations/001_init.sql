-- 001_init.sql — runs once at plugin load. Later schema changes go in NEW
-- numbered files (002_*.sql, ...); editing this file after it has run does
-- nothing. Timestamps are Unix-ms integers by convention.
CREATE TABLE visits (
  id         TEXT PRIMARY KEY,
  visitor_id TEXT NOT NULL,
  visited_at INTEGER NOT NULL
);

CREATE INDEX idx_visits_visited_at ON visits(visited_at);
