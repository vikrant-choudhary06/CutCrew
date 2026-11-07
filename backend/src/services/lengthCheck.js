// Is a video about as long as the title it is filed under? A provider that
// searches by name alone can return something else with the same name (a song,
// a trailer, another film); its length gives it away.
//   seconds        length of the video (unknown: cannot tell, so it passes)
//   runtimeMinutes the title's listed length (movie, or episode for series/anime)
//   episode        true for an episode, where lengths vary more
const MOVIE_FLOOR = 40 * 60;
const EPISODE_FLOOR = 60;

function lengthFits(seconds, { runtimeMinutes, episode = false } = {}) {
  if (!(Number(seconds) > 0)) return true;
  const expected = Number(runtimeMinutes) > 0 ? Number(runtimeMinutes) * 60 : 0;
  if (!expected) return seconds >= (episode ? EPISODE_FLOOR : MOVIE_FLOOR);
  // Episodes: double episodes and recaps; movies: extended cuts.
  const [low, high, extra] = episode ? [0.5, 2.5, 600] : [0.6, 1.6, 900];
  return seconds >= expected * low && seconds <= expected * high + extra;
}

// The listed length for a movie, or for one episode of a series or anime.
function runtimeOf(movie, episodeInfo) {
  const own = Number(episodeInfo?.runtime_minutes || episodeInfo?.runtime);
  if (own > 0) return own;
  const listed = Number(movie?.runtime_minutes);
  return listed > 0 ? listed : null;
}

module.exports = { lengthFits, runtimeOf };
