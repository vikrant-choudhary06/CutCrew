const mongoose = require('mongoose');

const episodeSchema = new mongoose.Schema({
  episode_number: Number,
  title: String,
  link: String, // The direct or intermediate link from the provider
  stream_data: { type: mongoose.Schema.Types.Mixed },
  stream_fetched_at: { type: Date },
});

const seasonSchema = new mongoose.Schema({
  season_number: Number,
  episodes: [episodeSchema],
});

const movieSchema = new mongoose.Schema({
  imdb_id: {
    type: String,
    required: true,
    unique: true,
    trim: true,
  },
  title: {
    type: String,
    required: true,
  },
  original_title: {
    type: String,
  },
  title_type: {
    type: String,
  },
  release_year: {
    type: Number,
  },
  release_date: {
    type: String,
  },
  runtime_minutes: {
    type: Number,
  },
  rating: {
    type: Number,
  },
  vote_count: {
    type: Number,
  },
  metascore: {
    type: Number,
  },
  genres: [{
    type: String,
  }],
  country: [{
    type: String,
  }],
  plot: {
    type: String,
  },
  poster_url: {
    type: String,
  },
  streaming_url: {
    type: String,
    default: "", // As requested, empty for now
  },
  defaultStreamLink: {
    type: String,
    default: "",
  },
  provider_name: {
    type: String,
    default: "",
  },
  stream_data: {
    type: mongoose.Schema.Types.Mixed,
  },
  stream_fetched_at: {
    type: Date,
  },
  local_poster_path: {
    type: String,
    default: "",
  },
  local_backdrop_path: {
    type: String,
    default: "",
  },
  seasons: [seasonSchema],
  cast: [{
    name: String,
    profile_image: String,
    character: String
  }]
}, {
  timestamps: true // Adds createdAt and updatedAt automatically
});

module.exports = mongoose.model('Movie', movieSchema);
