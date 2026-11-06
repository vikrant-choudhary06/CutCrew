"use strict";
var __create = Object.create;
var __defProp = Object.defineProperty;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __getProtoOf = Object.getPrototypeOf;
var __hasOwnProp = Object.prototype.hasOwnProperty;
var __export = (target, all) => {
  for (var name in all)
    __defProp(target, name, { get: all[name], enumerable: true });
};
var __copyProps = (to, from, except, desc) => {
  if (from && typeof from === "object" || typeof from === "function") {
    for (let key of __getOwnPropNames(from))
      if (!__hasOwnProp.call(to, key) && key !== except)
        __defProp(to, key, { get: () => from[key], enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable });
  }
  return to;
};
var __toESM = (mod, isNodeMode, target) => (target = mod != null ? __create(__getProtoOf(mod)) : {}, __copyProps(
  // If the importer is in node compatibility mode or this is not an ESM
  // file that has been converted to a CommonJS file using a Babel-
  // compatible transform (i.e. "__esModule" has not been set), then set
  // "default" to the CommonJS "module.exports" for node compatibility.
  isNodeMode || !mod || !mod.__esModule ? __defProp(target, "default", { value: mod, enumerable: true }) : target,
  mod
));
var __toCommonJS = (mod) => __copyProps(__defProp({}, "__esModule", { value: true }), mod);

// ../provider_anime/src/cutcrew.ts
var cutcrew_exports = {};
__export(cutcrew_exports, {
  AnimeParadiseProvider: () => AnimeParadiseProvider,
  FetchTransport: () => FetchTransport,
  HttpClient: () => HttpClient,
  PROVIDERS: () => PROVIDERS,
  createProvider: () => createProvider
});
module.exports = __toCommonJS(cutcrew_exports);

// ../provider_anime/src/transport/rateLimiter.ts
var RateLimiter = class {
  buckets = /* @__PURE__ */ new Map();
  defaultConfig;
  perHost;
  constructor(perHost = {}, defaultConfig) {
    this.perHost = perHost;
    this.defaultConfig = defaultConfig;
  }
  /**
   * Wait until a token is available for `hostname`. Resolves immediately if
   * no policy applies (no per-host entry and no default).
   *
   * Honors `signal`: when aborted, the wait rejects with the signal's reason
   * (or an AbortError) and the slot in the queue is released without
   * granting a token.
   */
  async acquire(hostname, signal) {
    const cfg = this.perHost[hostname] ?? this.defaultConfig;
    if (!cfg) return;
    if (signal?.aborted) throw abortError(signal);
    const bucket = this.getOrCreate(hostname, cfg);
    this.refill(bucket);
    if (this.tryConsume(bucket)) return;
    return new Promise((resolve, reject) => {
      const entry = { resolve, reject, signal };
      bucket.queue.push(entry);
      if (signal) {
        const onAbort = () => {
          const idx = bucket.queue.indexOf(entry);
          if (idx >= 0) bucket.queue.splice(idx, 1);
          reject(abortError(signal));
        };
        if (signal.aborted) return onAbort();
        signal.addEventListener("abort", onAbort, { once: true });
      }
      this.schedulePump(bucket);
    });
  }
  /**
   * Snapshot of the live state, useful for tests and observability.
   */
  snapshot(hostname) {
    const bucket = this.buckets.get(hostname);
    if (!bucket) return null;
    this.refill(bucket);
    return { tokens: bucket.tokens, queued: bucket.queue.length };
  }
  // ── internals ─────────────────────────────────────────────────────────────
  getOrCreate(hostname, config) {
    let bucket = this.buckets.get(hostname);
    if (!bucket) {
      bucket = {
        tokens: config.capacity,
        windowStart: Date.now(),
        config,
        burstTokens: config.burst?.capacity,
        burstWindowStart: config.burst ? Date.now() : void 0,
        queue: [],
        scheduled: false
      };
      this.buckets.set(hostname, bucket);
    }
    return bucket;
  }
  /** Top up tokens whose window has elapsed. */
  refill(b) {
    const now = Date.now();
    if (now - b.windowStart >= b.config.intervalMs) {
      b.tokens = b.config.capacity;
      b.windowStart = now;
    }
    if (b.config.burst && b.burstWindowStart != null) {
      if (now - b.burstWindowStart >= b.config.burst.intervalMs) {
        b.burstTokens = b.config.burst.capacity;
        b.burstWindowStart = now;
      }
    }
  }
  tryConsume(b) {
    if (b.tokens <= 0) return false;
    if (b.config.burst && (b.burstTokens ?? 0) <= 0) return false;
    b.tokens -= 1;
    if (b.config.burst) b.burstTokens = (b.burstTokens ?? 0) - 1;
    return true;
  }
  /** Schedule a wake-up at the next time we'd hand out at least one token. */
  schedulePump(b) {
    if (b.scheduled) return;
    b.scheduled = true;
    const now = Date.now();
    const waitMain = Math.max(0, b.config.intervalMs - (now - b.windowStart));
    const waitBurst = b.config.burst && b.burstWindowStart != null ? Math.max(0, b.config.burst.intervalMs - (now - b.burstWindowStart)) : 0;
    const wait = Math.max(1, Math.min(waitMain || 1, waitBurst || waitMain || 1));
    setTimeout(() => this.pump(b), wait).unref?.();
  }
  /** Drain as many waiters as the refilled bucket can satisfy. */
  pump(b) {
    b.scheduled = false;
    this.refill(b);
    while (b.queue.length > 0 && this.tryConsume(b)) {
      const entry = b.queue.shift();
      entry.resolve();
    }
    if (b.queue.length > 0) this.schedulePump(b);
  }
};
function abortError(signal) {
  if (signal.reason instanceof Error) return signal.reason;
  const e = new Error("Aborted");
  e.name = "AbortError";
  return e;
}
var DEFAULT_RATE_LIMITS = {
  "graphql.anilist.co": { capacity: 85, intervalMs: 6e4 },
  "api.jikan.moe": {
    capacity: 55,
    intervalMs: 6e4,
    burst: { capacity: 3, intervalMs: 1e3 }
  },
  "kitsu.io": { capacity: 100, intervalMs: 6e4 },
  "api.malsync.moe": { capacity: 30, intervalMs: 6e4 },
  "api.anify.tv": { capacity: 30, intervalMs: 6e4 },
  "arm.haglund.dev": { capacity: 60, intervalMs: 6e4 }
};

// ../provider_anime/src/transport/retry.ts
var DEFAULT_RETRY_STATUSES = [408, 425, 429, 500, 502, 503, 504];
var HttpRetryableError = class extends Error {
  status;
  retryAfterMs;
  constructor(status, retryAfterMs) {
    super(`HTTP ${status}`);
    this.status = status;
    this.retryAfterMs = retryAfterMs;
    this.name = "HttpRetryableError";
  }
};
async function withRetry(fn, config = {}, signal) {
  const maxAttempts = config.maxAttempts ?? 3;
  const initial = config.initialDelayMs ?? 250;
  const max = config.maxDelayMs ?? 8e3;
  const factor = config.factor ?? 2;
  const jitter = clamp01(config.jitter ?? 0.25);
  let attempt = 0;
  let lastErr;
  while (attempt < maxAttempts) {
    if (signal?.aborted) throw abortError2(signal);
    attempt += 1;
    try {
      return await fn(attempt);
    } catch (err) {
      lastErr = err;
      if (signal?.aborted) throw abortError2(signal);
      if (!isRetryable(err, config)) throw err;
      if (attempt >= maxAttempts) throw err;
      const hinted = err instanceof HttpRetryableError ? err.retryAfterMs : void 0;
      const expBackoff = Math.min(max, initial * factor ** (attempt - 1));
      const noise = jitter > 0 ? expBackoff * jitter * Math.random() : 0;
      const delayMs = Math.max(0, hinted ?? expBackoff + noise);
      config.onRetry?.({
        attempt,
        reason: err instanceof Error ? err.message : String(err),
        delayMs
      });
      await sleep(delayMs, signal);
    }
  }
  throw lastErr;
}
function isRetryable(err, config) {
  if (config.isRetryableError?.(err)) return true;
  if (err instanceof HttpRetryableError) {
    return (config.retryStatuses ?? DEFAULT_RETRY_STATUSES).includes(err.status);
  }
  if (err instanceof Error) {
    const name = err.name;
    if (name === "AbortError") return false;
    if (name === "TypeError" && /fetch failed|network/i.test(err.message)) return true;
    if ("code" in err && typeof err.code === "string" && [
      "ECONNRESET",
      "ECONNREFUSED",
      "ETIMEDOUT",
      "EAI_AGAIN",
      "EPIPE",
      "EHOSTUNREACH",
      "ENETUNREACH",
      "UND_ERR_SOCKET"
    ].includes(err.code)) {
      return true;
    }
  }
  return false;
}
function parseRetryAfter(value) {
  if (!value) return void 0;
  const seconds = Number(value);
  if (!Number.isNaN(seconds)) return seconds * 1e3;
  const date = Date.parse(value);
  if (!Number.isNaN(date)) {
    const ms = date - Date.now();
    return ms > 0 ? ms : 0;
  }
  return void 0;
}
function sleep(ms, signal) {
  if (ms <= 0) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      cleanup();
      resolve();
    }, ms);
    timer.unref?.();
    const onAbort = () => {
      cleanup();
      reject(abortError2(signal));
    };
    const cleanup = () => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
    };
    if (signal) {
      if (signal.aborted) return onAbort();
      signal.addEventListener("abort", onAbort, { once: true });
    }
  });
}
function clamp01(n) {
  return Math.max(0, Math.min(1, n));
}
function abortError2(signal) {
  if (signal.reason instanceof Error) return signal.reason;
  const e = new Error("Aborted");
  e.name = "AbortError";
  return e;
}

// ../provider_anime/src/transport/transport.ts
var FetchTransport = class {
  fetch(url, init) {
    return fetch(url, init);
  }
};
var CurlFallbackTransport = class {
  cookieFile;
  timeoutMs;
  constructor(options = {}) {
    this.timeoutMs = options.timeoutMs ?? 1e4;
  }
  async fetch(url, init) {
    try {
      return await fetch(url, init);
    } catch (err) {
      if (init.signal?.aborted || err?.name === "AbortError" && init.signal) {
        throw err;
      }
      if (typeof process === "undefined" || !process.versions?.node) {
        throw err;
      }
      try {
        return await this.curlFetch(url, init);
      } catch {
        throw err;
      }
    }
  }
  async curlFetch(targetUrl, options) {
    const cp = await import("child_process");
    const execSync = cp.execSync;
    if (!this.cookieFile) {
      try {
        const os = await import("os");
        const path = await import("path");
        this.cookieFile = path.join(
          os.tmpdir(),
          `ani-sdk-cookie-${Math.random().toString(36).substring(2)}.txt`
        );
      } catch {
        this.cookieFile = `/tmp/ani-sdk-cookie-${Math.random().toString(36).substring(2)}.txt`;
      }
    }
    const method = options.method || "GET";
    const headers = {};
    if (options.headers instanceof Headers) {
      options.headers.forEach((v, k) => {
        headers[k] = v;
      });
    } else if (Array.isArray(options.headers)) {
      for (const [k, v] of options.headers) headers[k] = v;
    } else if (options.headers) {
      Object.assign(headers, options.headers);
    }
    if (options.body instanceof URLSearchParams && !headers["Content-Type"]) {
      headers["Content-Type"] = "application/x-www-form-urlencoded;charset=UTF-8";
    }
    let headerArgs = "";
    for (const [key, val] of Object.entries(headers)) {
      headerArgs += ` -H ${JSON.stringify(`${key}: ${val}`)}`;
    }
    let bodyArg = "";
    if (options.body) {
      let bodyStr = "";
      if (typeof options.body === "string") {
        bodyStr = options.body;
      } else if (options.body instanceof URLSearchParams) {
        bodyStr = options.body.toString();
      } else {
        bodyStr = JSON.stringify(options.body);
      }
      bodyArg = ` -d ${JSON.stringify(bodyStr)}`;
    }
    const methodArg = method !== "GET" && method !== "POST" ? ` -X ${method}` : "";
    const cookieArg = ` -c ${JSON.stringify(this.cookieFile)} -b ${JSON.stringify(this.cookieFile)}`;
    const cmd = `curl -sL --max-time ${Math.ceil(this.timeoutMs / 1e3)}${methodArg}${headerArgs}${bodyArg}${cookieArg} -i ${JSON.stringify(targetUrl)}`;
    const output = execSync(cmd, { maxBuffer: 10 * 1024 * 1024 });
    return parseCurlResponse(output.toString("binary"), targetUrl);
  }
};
function parseCurlResponse(raw, targetUrl) {
  const parts = raw.split("\r\n\r\n");
  let headerSection = "";
  let body = "";
  for (let i = 0; i < parts.length; i++) {
    if (parts[i].startsWith("HTTP/")) {
      headerSection = parts[i];
      body = parts.slice(i + 1).join("\r\n\r\n");
    }
  }
  const headerLines = headerSection.split("\r\n");
  const statusLine = headerLines[0];
  const m = statusLine.match(/HTTP\/\d+(\.\d+)?\s+(\d+)/);
  const status = m ? parseInt(m[2], 10) : 200;
  const responseHeaders = new Headers();
  for (let i = 1; i < headerLines.length; i++) {
    const line = headerLines[i];
    const idx = line.indexOf(":");
    if (idx !== -1) {
      responseHeaders.append(line.substring(0, idx).trim(), line.substring(idx + 1).trim());
    }
  }
  let finalUrl = targetUrl;
  for (const part of parts) {
    const lines = part.split("\r\n");
    if (lines[0].startsWith("HTTP/")) {
      for (const line of lines) {
        const idx = line.indexOf(":");
        if (idx === -1) continue;
        const key = line.substring(0, idx).trim().toLowerCase();
        if (key !== "location") continue;
        const val = line.substring(idx + 1).trim();
        try {
          finalUrl = val.startsWith("http") ? val : new URL(val, finalUrl).toString();
        } catch {
        }
      }
    }
  }
  return {
    status,
    statusText: "OK",
    ok: status >= 200 && status < 300,
    headers: responseHeaders,
    url: finalUrl,
    text: async () => body,
    json: async () => JSON.parse(body),
    arrayBuffer: async () => {
      const buf = Buffer.from(body, "binary");
      return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
    }
  };
}

// ../provider_anime/src/transport/http.ts
var HttpClient = class {
  proxyUrl;
  proxyType;
  proxyQueryParam;
  defaultHeaders;
  timeoutMs;
  rateLimiter;
  retryConfig;
  transport;
  constructor(config = {}) {
    this.proxyUrl = config.proxyUrl;
    this.proxyType = config.proxyType || "prepend";
    this.proxyQueryParam = config.proxyQueryParam || "url";
    this.defaultHeaders = config.defaultHeaders || {};
    this.timeoutMs = config.timeoutMs || 1e4;
    if (!config.disableRateLimit) {
      this.rateLimiter = new RateLimiter(
        { ...DEFAULT_RATE_LIMITS, ...config.rateLimits ?? {} },
        config.defaultRateLimit
      );
    }
    this.retryConfig = config.retry === false ? false : config.retry ?? {};
    this.transport = config.transport ?? new CurlFallbackTransport({ timeoutMs: this.timeoutMs });
  }
  /** Live rate-limiter; useful for tests and observability. May be undefined when disabled. */
  getRateLimiter() {
    return this.rateLimiter;
  }
  getTransport() {
    return this.transport;
  }
  getProxyUrl() {
    return this.proxyUrl;
  }
  getProxyType() {
    return this.proxyType;
  }
  getProxyQueryParam() {
    return this.proxyQueryParam;
  }
  getDefaultHeaders() {
    return this.defaultHeaders;
  }
  requestUrl(url) {
    if (!this.proxyUrl) return url;
    if (this.proxyType === "prepend") {
      const base = this.proxyUrl.endsWith("/") ? this.proxyUrl : `${this.proxyUrl}/`;
      const target = url.replace(/^(https?:\/\/)/, "");
      return `${base}${target}`;
    } else {
      const separator = this.proxyUrl.includes("?") ? "&" : "?";
      return `${this.proxyUrl}${separator}${this.proxyQueryParam}=${encodeURIComponent(url)}`;
    }
  }
  async request(url, options = {}) {
    const signal = options.signal;
    const host = safeHostname(this.requestUrl(url));
    if (this.retryConfig === false) {
      if (this.rateLimiter && host) await this.rateLimiter.acquire(host, signal ?? void 0);
      return this.requestOnce(url, options);
    }
    return withRetry(
      async () => {
        if (this.rateLimiter && host) await this.rateLimiter.acquire(host, signal ?? void 0);
        const res = await this.requestOnce(url, options);
        const retryStatuses = this.retryConfig === false ? DEFAULT_RETRY_STATUSES : this.retryConfig.retryStatuses ?? DEFAULT_RETRY_STATUSES;
        if (retryStatuses.includes(res.status)) {
          const ra = parseRetryAfter(res.headers.get("retry-after"));
          throw new HttpRetryableError(res.status, ra);
        }
        return res;
      },
      this.retryConfig,
      signal ?? void 0
    );
  }
  async requestOnce(url, options = {}) {
    const targetUrl = this.requestUrl(url);
    const headers = { ...this.defaultHeaders };
    if (options.headers) {
      if (options.headers instanceof Headers) {
        options.headers.forEach((value, key) => {
          headers[key] = value;
        });
      } else if (Array.isArray(options.headers)) {
        for (const [key, value] of options.headers) {
          headers[key] = value;
        }
      } else {
        Object.assign(headers, options.headers);
      }
    }
    const callerSignal = options.signal;
    const controller = new AbortController();
    const id = setTimeout(() => controller.abort(new Error("Request timed out")), this.timeoutMs);
    let onCallerAbort;
    if (callerSignal) {
      if (callerSignal.aborted) {
        clearTimeout(id);
        throw abortReason(callerSignal);
      }
      onCallerAbort = () => controller.abort(callerSignal.reason);
      callerSignal.addEventListener("abort", onCallerAbort, { once: true });
    }
    const cleanup = () => {
      clearTimeout(id);
      if (onCallerAbort) callerSignal.removeEventListener("abort", onCallerAbort);
    };
    try {
      const res = await this.transport.fetch(targetUrl, {
        ...options,
        headers,
        signal: controller.signal
      });
      cleanup();
      return res;
    } catch (err) {
      cleanup();
      throw err;
    }
  }
  async get(url, options = {}) {
    return this.request(url, { ...options, method: "GET" });
  }
  async post(url, body, options = {}) {
    const headers = {};
    if (options.headers) {
      if (options.headers instanceof Headers) {
        options.headers.forEach((value, key) => {
          headers[key] = value;
        });
      } else if (Array.isArray(options.headers)) {
        for (const [key, value] of options.headers) {
          headers[key] = value;
        }
      } else {
        Object.assign(headers, options.headers);
      }
    }
    let finalBody = body;
    if (body && typeof body === "object" && !(body instanceof FormData) && !(body instanceof URLSearchParams)) {
      if (!headers["Content-Type"]) {
        headers["Content-Type"] = "application/json";
      }
      finalBody = JSON.stringify(body);
    }
    return this.request(url, { ...options, method: "POST", headers, body: finalBody });
  }
  setCookie(name, value) {
    const existingCookie = this.defaultHeaders["Cookie"] || "";
    const cookies = existingCookie ? existingCookie.split(";").map((c) => c.trim()) : [];
    const newCookies = cookies.filter((c) => !c.startsWith(`${name}=`));
    newCookies.push(`${name}=${value}`);
    this.defaultHeaders["Cookie"] = newCookies.join("; ");
  }
  setUserAgent(userAgent) {
    this.defaultHeaders["User-Agent"] = userAgent;
  }
};
function safeHostname(url) {
  try {
    return new URL(url).hostname;
  } catch {
    return void 0;
  }
}
function abortReason(signal) {
  if (signal.reason instanceof Error) return signal.reason;
  const e = new Error(typeof signal.reason === "string" ? signal.reason : "Aborted");
  e.name = "AbortError";
  return e;
}

// ../provider_anime/src/utils/urn.ts
function buildUrn(providerId, rawId) {
  if (!providerId) throw new Error("buildUrn: providerId is required");
  if (rawId == null) throw new Error("buildUrn: rawId is required");
  return `${providerId}:${rawId}`;
}
function unwrapUrn(providerId, urn) {
  const sep = urn.indexOf(":");
  if (sep < 0) return urn;
  const prefix = urn.slice(0, sep);
  if (prefix !== providerId) return urn;
  return urn.slice(sep + 1);
}

// ../provider_anime/src/providers/BaseProvider.ts
var BaseProvider = class {
  constructor(http) {
    this.http = http;
  }
  /**
   * Simple FIFO semaphore. Constructed lazily so subclasses that don't
   * cap concurrency pay nothing for it.
   */
  __semaphore;
  withConcurrency(fn) {
    if (!this.maxConcurrency || this.maxConcurrency <= 0) return fn();
    if (!this.__semaphore) this.__semaphore = new Semaphore(this.maxConcurrency);
    return this.__semaphore.run(fn);
  }
  // ── Public API ────────────────────────────────────────────────────────────
  // These wrap the `Raw` methods below with URN encoding/decoding so callers
  // (and the meta layer) only ever see URN-formatted IDs. Every method also
  // accepts an optional `signal` for cancellation; subclasses are expected
  // to forward it on every outbound `http` call.
  search(query, options = {}) {
    return this.withConcurrency(async () => {
      const results = await this.searchRaw(query, options);
      return results.map((r) => ({
        ...r,
        id: buildUrn(this.id, r.id),
        providerId: this.id
      }));
    });
  }
  fetchContentUnits(mediaUrn, options = {}) {
    return this.withConcurrency(async () => {
      const raw = unwrapUrn(this.id, mediaUrn);
      const units = await this.fetchContentUnitsRaw(raw, options);
      return units.map((u) => ({ ...u, id: buildUrn(this.id, u.id) }));
    });
  }
  resolveStream(unitUrn, language, options = {}) {
    return this.withConcurrency(async () => {
      const raw = unwrapUrn(this.id, unitUrn);
      return this.resolveStreamRaw(raw, language, options);
    });
  }
  /** True iff the provider implements `fetchUnitTracksRaw`. */
  get supportsUnitTracks() {
    return typeof this.fetchUnitTracksRaw === "function";
  }
  fetchUnitTracks(unitUrn, language, options = {}) {
    if (!this.fetchUnitTracksRaw) {
      throw new Error(`${this.id}: fetchUnitTracks is not supported by this provider`);
    }
    return this.withConcurrency(async () => {
      const raw = unwrapUrn(this.id, unitUrn);
      return this.fetchUnitTracksRaw(raw, language, options);
    });
  }
  /**
   * Optional: comma-keyed array of MALSync `Sites` names this provider
   * corresponds to. When set, `MappingClient` will translate MALSync's
   * crowdsourced aliases into this provider's namespace automatically — so
   * new providers wire themselves in without touching the mapping client.
   */
  static malsyncSites = [];
  /**
   * Optional: maximum number of in-flight calls allowed on this provider.
   * Useful for strict sites where parallel fuzzy searches risk a ban.
   * `0` / `undefined` means unbounded.
   */
  maxConcurrency = 0;
};
var Semaphore = class {
  permits;
  waiters = [];
  constructor(max) {
    this.permits = max;
  }
  async run(fn) {
    await this.acquire();
    try {
      return await fn();
    } finally {
      this.release();
    }
  }
  acquire() {
    if (this.permits > 0) {
      this.permits -= 1;
      return Promise.resolve();
    }
    return new Promise((resolve) => this.waiters.push(resolve));
  }
  release() {
    const next = this.waiters.shift();
    if (next) next();
    else this.permits += 1;
  }
};

// ../provider_anime/src/utils/subtitles.ts
var LABEL_TO_BCP47 = {
  english: "en",
  portuguese: "pt",
  "portuguese-brazil": "pt-BR",
  spanish: "es",
  italian: "it",
  french: "fr",
  german: "de",
  japanese: "ja",
  arabic: "ar",
  russian: "ru",
  chinese: "zh",
  korean: "ko",
  dutch: "nl",
  polish: "pl",
  turkish: "tr",
  indonesian: "id",
  thai: "th",
  vietnamese: "vi"
};
function labelToBcp47(label) {
  return LABEL_TO_BCP47[label.toLowerCase()] ?? label.slice(0, 2).toLowerCase();
}
function normalizeSubtitleEntries(entries) {
  if (!Array.isArray(entries)) return [];
  const out = [];
  for (const item of entries) {
    if (!item || typeof item !== "object") continue;
    const rec = item;
    const rawUrl = rec.url ?? rec.src ?? rec.file;
    if (typeof rawUrl !== "string" || !/^https?:\/\//i.test(rawUrl)) continue;
    const rawLabel = rec.label ?? rec.name ?? rec.language;
    const label = typeof rawLabel === "string" && rawLabel.trim() ? rawLabel.trim() : "Unknown";
    const rawType = rec.format ?? rec.type;
    const typeStr = typeof rawType === "string" ? rawType.toLowerCase() : "";
    const format = typeStr === "vtt" || typeStr === "srt" || typeStr === "ass" ? typeStr : inferFormatFromUrl(rawUrl);
    out.push({
      url: rawUrl,
      label,
      language: typeof rec.language === "string" && rec.language ? rec.language : labelToBcp47(label),
      ...format ? { format } : {}
    });
  }
  return out;
}
function inferFormatFromUrl(url) {
  const path = url.split("?")[0].toLowerCase();
  if (path.endsWith(".vtt")) return "vtt";
  if (path.endsWith(".srt")) return "srt";
  if (path.endsWith(".ass") || path.endsWith(".ssa")) return "ass";
  return void 0;
}

// ../provider_anime/src/providers/AnimeParadiseProvider.ts
var API_BASE = "https://api.animeparadise.moe";
var STREAM_BASE = "https://stream.animeparadise.moe";
var AnimeParadiseProvider = class extends BaseProvider {
  id = "animeparadise";
  supportedTypes = ["ANIME"];
  constructor(http) {
    super(http);
  }
  async searchRaw(query, options = {}) {
    const res = await this.http.get(`${API_BASE}/search?q=${encodeURIComponent(query)}&limit=20`, {
      signal: options.signal
    });
    const json = await res.json();
    const items = json?.data ?? [];
    return items.map((item) => ({
      id: item._id,
      title: item.alternativeTitle?.english ?? item.title,
      thumbnailUrl: item.posterImage?.medium ?? item.posterImage?.large,
      catalogType: "ANIME",
      providerId: this.id,
      year: typeof item.year === "number" ? item.year : item.released ? new Date(item.released).getUTCFullYear() : void 0
    }));
  }
  async fetchContentUnitsRaw(mediaId, options = {}) {
    const res = await this.http.get(`${API_BASE}/anime/${mediaId}/episode`, {
      signal: options.signal
    });
    const json = await res.json();
    const episodes = json?.data ?? [];
    return episodes.map((ep) => ({
      // encode uid and animeId so resolveStream can call /ep/{uid}?origin={animeId}
      id: `${ep.uid}:${mediaId}`,
      title: ep.title ?? `Episode ${ep.number}`,
      number: parseFloat(ep.number),
      availableLanguages: ["sub"]
    }));
  }
  async resolveStreamRaw(unitId, _language, options = {}) {
    const sep = unitId.lastIndexOf(":");
    if (sep < 0) throw new Error(`AnimeParadise: invalid unitId "${unitId}"`);
    const uid = unitId.slice(0, sep);
    const animeId = unitId.slice(sep + 1);
    const res = await this.http.get(`${API_BASE}/ep/${uid}?origin=${animeId}`, {
      signal: options.signal
    });
    const json = await res.json();
    const episode = json?.data?.episode;
    if (!episode?.streamLink) throw new Error("AnimeParadise: no streamLink in response");
    const streamUrl = `${STREAM_BASE}/m3u8?url=${encodeURIComponent(episode.streamLink)}`;
    const subtitles = normalizeSubtitleEntries(episode.subData);
    return {
      type: "video",
      streams: [
        {
          sourceUrl: streamUrl,
          isHLS: true,
          quality: "auto",
          language: "sub",
          headers: { Referer: "https://animeparadise.moe/" },
          ...subtitles.length > 0 ? { subtitles } : {}
        }
      ]
    };
  }
  /**
   * Fetch the subtitle/quality availability for a unit without resolving the
   * stream itself. AnimeParadise exposes `subData` on the `/ep/:uid` response,
   * so this is one cheap round-trip — useful for populating a subtitle selector
   * before the user hits play.
   */
  async fetchUnitTracksRaw(unitId, _language, options = {}) {
    const sep = unitId.lastIndexOf(":");
    if (sep < 0) throw new Error(`AnimeParadise: invalid unitId "${unitId}"`);
    const uid = unitId.slice(0, sep);
    const animeId = unitId.slice(sep + 1);
    const res = await this.http.get(`${API_BASE}/ep/${uid}?origin=${animeId}`, {
      signal: options.signal
    });
    const json = await res.json();
    const subtitles = normalizeSubtitleEntries(json?.data?.episode?.subData);
    return {
      subtitles,
      qualities: ["auto"],
      headers: { Referer: "https://animeparadise.moe/" }
    };
  }
};

// ../provider_anime/src/cutcrew.ts
var PROVIDERS = {
  animeparadise: AnimeParadiseProvider
};
function createProvider(id, timeoutMs = 2e4) {
  const Provider = PROVIDERS[id];
  if (!Provider) throw new Error(`Unknown anime provider: ${id}`);
  return new Provider(new HttpClient({ timeoutMs, transport: new FetchTransport() }));
}
// Annotate the CommonJS export names for ESM import in node:
0 && (module.exports = {
  AnimeParadiseProvider,
  FetchTransport,
  HttpClient,
  PROVIDERS,
  createProvider
});
