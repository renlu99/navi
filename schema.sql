CREATE TABLE IF NOT EXISTS navi_meta (
    id BOOLEAN PRIMARY KEY DEFAULT TRUE CHECK (id = TRUE),
    revision BIGINT NOT NULL DEFAULT 0,
    updated_at TIMESTAMPTZ NULL
);

CREATE TABLE IF NOT EXISTS navi_shortcuts (
    id TEXT PRIMARY KEY,
    title TEXT NOT NULL,
    url TEXT NOT NULL,
    updated_at TIMESTAMPTZ NOT NULL,
    "position" INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS navi_icons (
    item_id TEXT PRIMARY KEY REFERENCES navi_shortcuts(id) ON DELETE CASCADE,
    content_type TEXT NOT NULL,
    body BYTEA NOT NULL,
    source_url TEXT NOT NULL,
    fetched_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

INSERT INTO navi_meta (id, revision)
VALUES (TRUE, 0)
ON CONFLICT (id) DO NOTHING;
