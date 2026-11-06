const crypto = require('crypto');
const dns = require('dns');
const net = require('net');
const http = require('http');
const https = require('https');
const axios = require('axios');
const { CHUNK_SIZE,openRange,streamRanges } = require('./rangeStream');
const { remuxMedia } = require('./remuxService');
const metadata = require('./mediaMetadata');
const secret = crypto.createHash('sha256').update(process.env.MEDIA_TOKEN_SECRET || crypto.randomBytes(32)).digest();
const blocked = new net.BlockList();
for (const [network, prefix] of [
  ['0.0.0.0',8],['10.0.0.0',8],['100.64.0.0',10],['127.0.0.0',8],['169.254.0.0',16],
  ['172.16.0.0',12],['192.0.0.0',24],['192.0.2.0',24],['192.168.0.0',16],['198.18.0.0',15],
  ['198.51.100.0',24],['203.0.113.0',24],['224.0.0.0',4],['240.0.0.0',4],
]) blocked.addSubnet(network, prefix, 'ipv4');
function publicAddress(address) {
  if (net.isIP(address) === 4) return !blocked.check(address, 'ipv4');
  // Limit IPv6 to global unicast, excluding transition/documentation ranges.
  return net.isIP(address) === 6 && /^[23]/i.test(address) &&
    !/^2001:(?:0{0,3}[01]?[0-9a-f]{0,2}:|db8:)/i.test(address) && !/^2002:/i.test(address);
}
function validateUrl(value) {
  const url = new URL(value);
  const host = url.hostname.replace(/^\[|\]$/g, '');
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password ||
      (url.port && !['80', '443'].includes(url.port)) || host === 'localhost' ||
      host.endsWith('.local') || (net.isIP(host) && !publicAddress(host))) {
    throw new Error('Unsupported media destination');
  }
  return url;
}
function safeLookup(host, options, callback) {
  dns.lookup(host, { all: true, verbatim: true }, (error, addresses) => {
    if (error) return callback(error);
    const safe = addresses.filter(item => publicAddress(item.address));
    if (!safe.length) {
      return callback(new Error('Private media destinations are blocked'));
    }
    if (options?.all) callback(null, safe);
    else callback(null, safe[0].address, safe[0].family);
  });
}
const transport = axios.create({
  timeout: 20000, maxRedirects: 0, proxy: false,
  httpAgent: new http.Agent({ lookup: safeLookup }),
  httpsAgent: new https.Agent({ lookup: safeLookup }),
  validateStatus: status => (status >= 200 && status < 300) || (status >= 300 && status < 400),
});
function safeHeaders(input) {
  const headers = {};
  for (const [name, value] of Object.entries(input || {})) {
    if (['referer', 'origin', 'user-agent', 'cookie', 'authorization', 'accept'].includes(name.toLowerCase()) &&
        typeof value === 'string' && !/[\r\n]/.test(value)) headers[name.toLowerCase()] = value;
  }
  return headers;
}
async function openMedia(value, inputHeaders, range, signal) {
  let url = value, headers = safeHeaders(inputHeaders);
  for (let hop = 0; hop <= 5; hop++) {
    validateUrl(url);
    const response = await transport.get(url, { headers: { ...headers, range }, responseType: 'stream', signal, timeout: 5000 });
    if (response.status < 300) return response;
    response.data.destroy();
    if (!response.headers.location || hop === 5) throw new Error('Too many media redirects');
    const next = new URL(response.headers.location, url);
    if (next.origin !== new URL(url).origin) { delete headers.cookie; delete headers.authorization; }
    url = next.href;
  }
}
function signMedia(url, headers = {}, format = '', expires = Date.now() + 4 * 3600000) {
  validateUrl(url);
  // Encrypt as well as authenticate: provider cookies and signed upstream URLs stay private.
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', secret, iv);
  const encrypted = Buffer.concat([cipher.update(JSON.stringify({ url, headers: safeHeaders(headers), format, expires })), cipher.final()]);
  return '/api/media?token=' + [iv, cipher.getAuthTag(), encrypted].map(value => value.toString('base64url')).join('.');
}
function verifyToken(token) {
  if (typeof token !== 'string' || token.length > 16000) throw new Error('Invalid media token');
  const parts = token.split('.');
  if (parts.length !== 3 || parts.some(part => !/^[\w-]+$/.test(part))) throw new Error('Invalid media token');
  const [iv, tag, encrypted] = parts.map(part => Buffer.from(part, 'base64url'));
  if (iv.length !== 12 || tag.length !== 16) throw new Error('Invalid media token');
  const decipher = crypto.createDecipheriv('aes-256-gcm', secret, iv);
  decipher.setAuthTag(tag);
  const data = JSON.parse(Buffer.concat([decipher.update(encrypted), decipher.final()]).toString());
  if (!Number.isFinite(data.expires) || data.expires < Date.now()) throw new Error('Media token expired');
  validateUrl(data.url);
  return data;
}
function rewritePlaylist(body, base, ticket) {
  const rewrite = uri => signMedia(new URL(uri, base).href, ticket.headers, '', ticket.expires);
  return body.split(/\r?\n/).map(line => {
    if (!line.trim()) return line;
    if (line.startsWith('#')) return line.replace(/URI="([^"]+)"/g, (_, uri) => 'URI="' + rewrite(uri) + '"');
    return rewrite(line.trim());
  }).join('\n');
}
// Web: MKV is converted to MP4 on the fly (remuxed, not seekable by range).
// Apps (client=app) play MKV themselves, so they get the original file through
// the relay ("raw"), with byte ranges for seeking.
function presentStreams(streams, { client = 'web' } = {}) {
  const app = client === 'app';
  return streams.flatMap(stream => {
    try {
      const subtitles = stream.subtitles.flatMap(track => {
        if (!/vtt|subrip|srt/i.test(track.type || track.uri || '')) return [];
        try { return [{ ...track, uri: signMedia(track.uri, stream.headers, /subrip|srt/i.test(track.type || track.uri) ? 'srt' : 'vtt') }]; }
        catch { return []; }
      });
      if (app) return [{ ...stream, remuxed: false, headers: undefined, link: signMedia(stream.link, stream.headers, stream.type === 'mkv' ? 'raw' : stream.type), subtitles }];
      return [{ ...stream, type: stream.type === 'mkv' ? 'mp4' : stream.type, remuxed: stream.type === 'mkv',
        headers: undefined, link: signMedia(stream.link, stream.headers, stream.type), subtitles }];
    } catch { return []; }
  });
}
// What media the first bytes are, whatever the server's label says.
function mediaKind(bytes) {
  if (!bytes?.length) return null;
  if (bytes[0] === 0x47 && (bytes.length < 189 || bytes[188] === 0x47)) return 'video/mp2t';
  const box = bytes.subarray(4, 8).toString('latin1');
  if (['ftyp', 'styp', 'moof', 'moov', 'sidx'].includes(box)) return 'video/mp4';
  if (bytes.subarray(0, 4).equals(Buffer.from([0x1a, 0x45, 0xdf, 0xa3]))) return 'video/x-matroska';
  if (bytes.subarray(0, 3).toString('latin1') === 'ID3' || (bytes[0] === 0xff && (bytes[1] & 0xf0) === 0xf0)) return 'audio/aac';
  return null;
}
// First chunk of a response stream; the stream is left paused for piping.
function firstChunk(stream, timeoutMs = 15000) {
  return new Promise((resolve, reject) => {
    const done = () => { clearTimeout(timer); stream.off('data', onData); stream.off('end', onEnd); stream.off('error', onError); };
    const onData = chunk => { done(); stream.pause(); resolve(Buffer.from(chunk)); };
    const onEnd = () => { done(); resolve(Buffer.alloc(0)); };
    const onError = error => { done(); reject(error); };
    const timer = setTimeout(() => { done(); reject(new Error('Source sent no data')); }, timeoutMs);
    stream.on('data', onData); stream.once('end', onEnd); stream.once('error', onError);
  });
}
const LABELLED_MEDIA = /^(video|audio)\/|octet-stream|mpegurl|mp2t|matroska/i;

async function readText(stream, limit = 2 * 1024 * 1024) {
  const chunks = []; let size = 0;
  for await (const chunk of stream) {
    size += chunk.length;
    if (size > limit) { stream.destroy(); throw new Error('Manifest is too large'); }
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString('utf8');
}
async function relay(req, res) {
  let ticket;
  try { ticket = verifyToken(req.query.token); }
  catch { return res.status(403).json({ error: 'Invalid or expired media link' }); }
  if (ticket.format === 'mkv') return remuxMedia(req, res, ticket, signMedia);
  const controller = new AbortController();
  res.on('close', () => controller.abort());
  try {
    let url = ticket.url;
    let headers = safeHeaders(ticket.headers);
    async function open(range, requestSignal = controller.signal) {
      for (let hop = 0; hop <= 5; hop++) {
        validateUrl(url);
        const response = await transport.get(url, { headers: { ...headers, ...(range ? { range } : {}) },
          responseType: 'stream', signal: requestSignal });
        if (response.status < 300) return response;
        response.data.destroy();
        if (!response.headers.location || hop === 5) throw new Error('Too many media redirects');
        const redirected = new URL(response.headers.location, url);
        if (redirected.origin !== new URL(url).origin) { delete headers.cookie; delete headers.authorization; }
        url = redirected.href;
      }
    }
    // Some source hosts reject open-ended ranges. Read bounded pieces while
    // preserving one continuous range response and backpressure for the player.
    const start = openRange(req.headers.range);
    const knownSize=metadata.get(ticket)?.size;
    if(start!==null&&knownSize&&start>=knownSize)return res.status(416).set('Content-Range',`bytes */${knownSize}`).end();
    const end=start===null?null:Math.min(start+CHUNK_SIZE-1,knownSize?knownSize-1:Infinity);
    const response = await open(start===null?req.headers.range:`bytes=${start}-${end}`);
    const size=Number((response.headers['content-range']||'').match(/\/(\d+)$/)?.[1]||(response.status===200?response.headers['content-length']:0));
    if(Number.isSafeInteger(size)&&size>0)metadata.put(ticket,{size});
    let type = response.headers['content-type'] || '';
    res.set('Cache-Control', 'private, no-store');
    if (/mpegurl/i.test(type) || /\.m3u8(?:\?|$)/i.test(url) || ticket.format === 'hls') {
      const body = await readText(response.data);
      if (!body.trimStart().startsWith('#EXTM3U')) throw new Error('Source did not return an HLS playlist');
      res.type('application/vnd.apple.mpegurl').send(rewritePlaylist(body, url, { ...ticket, headers }));
    } else if (ticket.format === 'srt' || ticket.format === 'vtt') {
      let body = await readText(response.data);
      if (ticket.format === 'srt') body = 'WEBVTT\n\n' + body.replace(/^\uFEFF/, '').replace(/(\d{2}:\d{2}:\d{2}),(\d{3})/g, '$1.$2');
      res.type('text/vtt').send(body);
    } else {
      // A label that isn't media (image/jpeg, text/html, text/css…) is checked
      // against the first bytes: real video is passed on with the right type.
      let corrected = false;
      if (type && !LABELLED_MEDIA.test(type)) {
        const first = await firstChunk(response.data);
        const kind = mediaKind(first);
        if (!kind) { response.data.destroy(); throw new Error('Source returned a page instead of video'); }
        response.data.unshift(first);
        type = kind; corrected = true;
      }
      // Backpressure while paused or converting is normal. Keep the connection deadline
      // for opening the source, but do not apply it to the lifetime of a media response.
      response.request?.setTimeout?.(0);
      if (start!==null && response.status===206) {
        if(type)res.set('Content-Type',type);
        await streamRanges(response,start,open,res,controller.signal,{sourceId:require('./playbackHealth').sourceId(ticket.url)});return;
      }
      for (const name of ['content-type','content-length','content-range','accept-ranges']) {
        if (response.headers[name]) res.set(name, response.headers[name]);
      }
      if (corrected) res.set('Content-Type', type);
      res.status(response.status);
      response.data.on('error', () => res.destroy());
      response.data.pipe(res);
    }
  } catch (error) {
    console.warn('[Media relay]', new URL(ticket.url).hostname, error.code || error.message);
    if (!res.headersSent && !res.destroyed) res.status(502).json({ error: 'Media source is unavailable' });
    else res.destroy();
  }
}
module.exports = { mediaKind, firstChunk, relay, presentStreams, signMedia, verifyToken, rewritePlaylist, publicAddress, validateUrl, safeLookup, openMedia };
