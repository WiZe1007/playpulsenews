CREATE TABLE IF NOT EXISTS objects (
  key TEXT PRIMARY KEY NOT NULL,
  body TEXT NOT NULL CHECK (json_valid(body)),
  etag TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS article_covers (
  article TEXT PRIMARY KEY NOT NULL,
  digest TEXT UNIQUE NOT NULL,
  format TEXT NOT NULL,
  credit TEXT NOT NULL,
  image BLOB NOT NULL
);
