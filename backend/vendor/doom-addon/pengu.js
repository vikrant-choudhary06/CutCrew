"use strict";

const PROVIDER_NAME = "Pengu";
// CutCrew: no default link. Set your own in .env, otherwise this provider is off.
const DEFAULT_MANIFEST_URL = "";
const PENGU_ADDON_BASE = "https://pengu.uk";

function normalizeBaseUrl(raw) {
  return String(raw || "")
    .replace(/\/manifest\.json$/i, "")
    .replace(/\/+$/, "");
}

function configuredBaseUrl() {
  const configuredUrl = process.env.PENGU_MANIFEST_URL || process.env.PENGU_BASE_URL;
  if (configuredUrl) {
    return normalizeBaseUrl(configuredUrl);
  }

  const authToken = String(process.env.PENGU_AUTH_TOKEN || "").trim();
  if (authToken) {
    return `${PENGU_ADDON_BASE}/${encodeURIComponent(JSON.stringify({ auth_token: authToken }))}`;
  }

  return normalizeBaseUrl(DEFAULT_MANIFEST_URL);
}

function streamId(imdbId, tmdbId, mediaType, season, episode) {
  const baseId = imdbId || (tmdbId ? `tmdb:${tmdbId}` : "");
  if ((mediaType === "series" || mediaType === "tv") && season != null && episode != null) {
    return `${baseId}:${season}:${episode}`;
  }
  return baseId;
}

async function fetchPenguStreams(imdbId, tmdbId, mediaType, season, episode) {
  const baseUrl = configuredBaseUrl();
  const stremioType = mediaType === "tv" ? "series" : mediaType;
  const id = streamId(imdbId, tmdbId, stremioType, season, episode);
  if (!baseUrl || !id) {
    return [];
  }

  const response = await fetch(
    `${baseUrl}/stream/${encodeURIComponent(stremioType)}/${encodeURIComponent(id)}.json`,
    {
      headers: {
        Accept: "application/json",
        "User-Agent": "Doom-addon/3.0"
      },
      redirect: "follow"
    }
  );

  if (!response.ok) {
    throw new Error(`${PROVIDER_NAME} returned HTTP ${response.status}`);
  }

  const payload = await response.json();
  return Array.isArray(payload.streams) ? payload.streams : [];
}

async function getStreams(tmdbId, mediaType = "movie", season = null, episode = null, imdbId = "") {
  try {
    return (await fetchPenguStreams(imdbId, tmdbId, mediaType, season, episode))
      .filter((stream) => stream && typeof stream.url === "string" && stream.url);
  } catch (error) {
    console.error(`[${PROVIDER_NAME}] ${error.message || error}`);
    return [];
  }
}

module.exports = { getStreams };
