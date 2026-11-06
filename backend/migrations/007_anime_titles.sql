-- Anime titles use AniList ids ("anilist:140960") instead of IMDb ids. Let
-- My List and Continue watching hold both, so one list covers everything.
ALTER TABLE watchlist DROP CONSTRAINT IF EXISTS watchlist_imdb_id_check;
ALTER TABLE watchlist ADD CONSTRAINT watchlist_title_id_check CHECK (imdb_id ~ '^(tt[0-9]{5,12}|anilist:[0-9]{1,9})$');
ALTER TABLE progress DROP CONSTRAINT IF EXISTS progress_imdb_id_check;
ALTER TABLE progress ADD CONSTRAINT progress_title_id_check CHECK (imdb_id ~ '^(tt[0-9]{5,12}|anilist:[0-9]{1,9})$');
