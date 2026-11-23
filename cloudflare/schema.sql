CREATE TABLE IF NOT EXISTS objects (
  key TEXT PRIMARY KEY NOT NULL,
  body TEXT NOT NULL CHECK (json_valid(body)),
  etag TEXT NOT NULL
);
