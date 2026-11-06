// Full-screen player (Android ExoPlayer via expo-video).
// Tries each source in turn; if Telegram storage fails it asks for provider
// sources; saves progress, offers the next episode, and reports playback so
// the server can auto-save titles watched for a few minutes.
import Ionicons from '@expo/vector-icons/Ionicons';
import { useEventListener } from 'expo';
import * as Crypto from 'expo-crypto';
import { router, useLocalSearchParams } from 'expo-router';
import * as ScreenOrientation from 'expo-screen-orientation';
import { StatusBar } from 'expo-status-bar';
import { useVideoPlayer, VideoView } from 'expo-video';
import { useEffect, useMemo, useRef, useState } from 'react';
import { ActivityIndicator, StyleSheet, Text, View } from 'react-native';
import { Button, Focusable } from '../../components/ui';
import { BASE, getJSON, isAnime, nextEpisode, playPath, titlePath, type PlayResponse, type Stream, type Title } from '../../lib/api';
import { useLibrary } from '../../lib/library';
import { C, F } from '../../lib/theme';

const STORAGE = 'cutcrew-storage';

export default function Watch() {
  const params = useLocalSearchParams<{ id: string; season?: string; episode?: string }>();
  const id = params.id;
  const season = params.season ? Number(params.season) : 0;
  const episode = params.episode ? Number(params.episode) : 0;
  const lib = useLibrary();
  const [title, setTitle] = useState<Title | null>(null);
  const [request, setRequest] = useState({ exclude: [] as string[], refresh: false, serial: 0 });
  // Each answer, chosen source and player state is tagged with the request it
  // belongs to, so status is derived instead of reset inside effects.
  const requestKey = `${id}|${season}|${episode}|${request.serial}`;
  const [answer, setAnswer] = useState<{ key: string; list: Stream[]; provider?: string; error: string }>({ key: '', list: [], error: '' });
  const [pick, setPick] = useState({ key: '', index: 0 });
  const [played, setPlayed] = useState({ key: '', ready: false });
  const [fatal, setFatal] = useState({ key: '', message: '' });
  const streams = answer.key === requestKey && !answer.error ? { list: answer.list, provider: answer.provider } : null;
  const index = pick.key === requestKey ? pick.index : 0;
  const sourceKey = `${requestKey}#${index}`;
  const error = fatal.key === requestKey ? fatal.message : answer.key === requestKey ? answer.error : '';
  const status: 'loading' | 'ready' | 'error' = error ? 'error' : played.key === sourceKey && played.ready ? 'ready' : 'loading';
  const [showNext, setShowNext] = useState(false);
  // A stored (Telegram) copy gets one retry from the same spot before the
  // player falls back to providers: a slow block shouldn't lose the stored copy.
  const [reload, setReload] = useState(0);
  const retried = useRef(new Set<string>());
  const [chrome, setChrome] = useState(true);

  // Where to start: this episode's saved position, unless it was finished.
  const startAt = useMemo(() => {
    const p = lib.progress.find(x => x.data.imdb_id === id && x.season === season && x.episode === episode);
    console.log(`[CutCrew] resume lookup ${id}: ${lib.progress.length} saved, match=${p ? JSON.stringify({ position: Math.round(p.position), duration: p.duration && Math.round(p.duration), completed: p.completed }) : "none"}`);
    return p && !p.completed && p.position > 10 ? p.position - 3 : 0;
  }, [id, season, episode]); // eslint-disable-line react-hooks/exhaustive-deps
  const offset = useRef(startAt);
  // Where to jump once the loaded source is ready. Seeking straight after
  // loading is ignored for progressive files (MKV/MP4), so it waits.
  const pendingSeek = useRef(0);
  const stats = useRef({ session: Crypto.randomUUID(), played: 0, lastTick: 0, lastSave: 0, lastReport: 0 });

  const player = useVideoPlayer(null, p => { p.timeUpdateEventInterval = 1; });

  useEffect(() => {
    ScreenOrientation.lockAsync(ScreenOrientation.OrientationLock.LANDSCAPE).catch(() => {});
    return () => { ScreenOrientation.unlockAsync().catch(() => {}); };
  }, []);

  useEffect(() => { getJSON<{ data: Title }>(titlePath(id), { timeout: 90000 }).then(b => setTitle(b.data)).catch(() => {}); }, [id]);

  // Ask the server for sources.
  useEffect(() => {
    let live = true;
    // client=app: MKV comes as the original file through the relay, so ExoPlayer
    // can seek in it by byte range; nothing is converted on the server.
    getJSON<PlayResponse>(playPath(id, { season, episode, exclude: request.exclude, refresh: request.refresh }), { timeout: 120000, fresh: true })
      .then(body => {
        if (!live) return;
        if (!body.streams?.length) { setAnswer({ key: requestKey, list: [], error: 'No playable source was found for this title right now.' }); return; }
        setAnswer({ key: requestKey, list: body.streams, provider: body.provider, error: '' });
      })
      .catch((e: Error) => { if (live) setAnswer({ key: requestKey, list: [], error: e.message }); });
    return () => { live = false; };
  }, [id, season, episode, request, requestKey]);

  const source = streams?.list[index];
  // Load the chosen source and resume where it stopped (seek inside the file).
  useEffect(() => {
    if (!source) return;
    const start = Math.floor(offset.current);
    pendingSeek.current = start;
    console.log(`[CutCrew] playing ${id} from ${start}s (${source.type})`);
    player.replaceAsync({ uri: BASE + source.link, contentType: source.type === 'hls' ? 'hls' : 'progressive', metadata: { title: title?.title } })
      .then(() => { if (player.status === 'readyToPlay') jumpToStart(); player.play(); })
      .catch(() => fail());
  }, [source, reload]); // eslint-disable-line react-hooks/exhaustive-deps

  function fail() {
    offset.current = position();
    if (source?.stored && !retried.current.has(sourceKey)) { retried.current.add(sourceKey); setReload(n => n + 1); return; }
    if (streams && index + 1 < streams.list.length) { setPick({ key: requestKey, index: index + 1 }); return; }
    if (streams?.provider === STORAGE) { setRequest(r => ({ exclude: [...r.exclude, STORAGE], refresh: false, serial: r.serial + 1 })); return; }
    if (!request.refresh) { setRequest(r => ({ ...r, refresh: true, serial: r.serial + 1 })); return; }
    setFatal({ key: requestKey, message: 'These sources could not play. Try again later.' });
  }
  const position = () => player.currentTime || 0;
  function jumpToStart() {
    if (pendingSeek.current > 0) { player.currentTime = pendingSeek.current; pendingSeek.current = 0; }
  }

  useEventListener(player, 'statusChange', ({ status: next }) => {
    if (next === 'readyToPlay') {
      jumpToStart();
      setPlayed({ key: sourceKey, ready: true });
    }
    else if (next === 'error') fail();
  });

  useEventListener(player, 'timeUpdate', ({ currentTime }) => {
    const now = Date.now(), st = stats.current;
    if (player.playing && st.lastTick) st.played += Math.min(2, (now - st.lastTick) / 1000);
    st.lastTick = now;
    const pos = currentTime;
    const duration = player.duration > 0 ? player.duration : null;
    if (title && now - st.lastSave > 10000 && pos > 5) {
      st.lastSave = now;
      lib.saveProgress({ data: title, season, episode, position: pos, duration, completed: Boolean(duration && pos > duration - 60) });
    }
    if (season && duration) setShowNext(duration - pos < 30 && duration - pos > 0);
    if (now - st.lastReport > 15000 && source) { st.lastReport = now; report(source, st.played); }
  });

  // ExoPlayer also reports "ended" for an empty player (before a source is
  // loaded). Only a source that really played to its last seconds counts.
  useEventListener(player, 'playToEnd', () => {
    const duration = player.duration || 0;
    if (!source || status !== 'ready' || stats.current.played < 20 || !(duration > 0) || (player.currentTime || 0) < duration - 10) return;
    if (title) lib.saveProgress({ data: title, season, episode, position: position(), duration, completed: true });
    goNext();
  });

  // Same report the website sends: lets the server auto-save to Telegram.
  function report(src: Stream, playedSeconds: number) {
    const link = src.link;
    const token = /[?&]token=([^&]+)/.exec(link)?.[1];
    const storedTicket = src.stored ? link.split('/').pop() : undefined;
    if (!token && !storedTicket) return;
    fetch(BASE + '/api/playback/metrics', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sessionId: stats.current.session, titleId: id, ...(season ? { season, episode } : {}),
        token: token ? decodeURIComponent(token) : undefined, storedTicket, event: 'sample', playedSeconds,
        bufferAhead: Math.max(0, (player.bufferedPosition || 0) - (player.currentTime || 0)), stalls: 0, stalledSeconds: 0, startupMs: 0, droppedFrames: 0, totalFrames: 0 }),
    }).catch(() => {});
  }

  const next = title && season ? nextEpisode(title, season, episode) : null;
  function goNext() {
    if (!next) return;
    router.replace({ pathname: '/watch/[id]', params: { id, season: String(next.season), episode: String(next.episode) } });
  }

  // Controls overlay hides after a few seconds of playback.
  useEffect(() => {
    if (!chrome || status !== 'ready') return;
    const t = setTimeout(() => setChrome(false), 4000);
    return () => clearTimeout(t);
  }, [chrome, status]);

  return (
    <View style={w.screen} onTouchStart={() => setChrome(true)}>
      <StatusBar hidden />
      <VideoView player={player} style={StyleSheet.absoluteFill} contentFit="contain" nativeControls fullscreenOptions={{ enable: false }} allowsPictureInPicture={false} />
      {(chrome || status !== 'ready') && (
        <View style={w.top} pointerEvents="box-none">
          <Focusable onPress={() => (router.canGoBack() ? router.back() : router.replace('/'))} accessibilityLabel="Back" style={w.back}>
            <Ionicons name="chevron-back" size={28} color={C.screen} />
          </Focusable>
          <View style={{ flex: 1 }}>
            <Text style={w.title} numberOfLines={1}>{title?.title || ''}</Text>
            {!!season && <Text style={[w.sub, { textAlign: 'left' }]}>{isAnime(id) ? `Episode ${episode}` : `Season ${season} · Episode ${episode}`}</Text>}
          </View>
        </View>
      )}
      {status === 'loading' && <View style={w.center} pointerEvents="none"><ActivityIndicator size="large" color={C.marigold} /><Text style={w.sub}>{streams ? 'Starting playback…' : 'Finding a playable source…'}</Text></View>}
      {status === 'error' && (
        <View style={w.center}>
          <Text style={w.errorTitle}>Playback stopped</Text>
          <Text style={w.sub}>{error}</Text>
          <Button label="Try again" kind="quiet" style={{ marginTop: 14 }} onPress={() => setRequest(r => ({ exclude: [], refresh: true, serial: r.serial + 1 }))} />
        </View>
      )}
      {showNext && next && <View style={w.next}><Button label={`Next episode  S${next.season} E${next.episode}`} icon="▶" onPress={goNext} /></View>}
    </View>
  );
}

const w = StyleSheet.create({
  screen: { flex: 1, backgroundColor: '#000' },
  top: { position: 'absolute', top: 0, left: 0, right: 0, flexDirection: 'row', alignItems: 'center', gap: 6, padding: 12, backgroundColor: 'rgba(0,0,0,0.35)' },
  back: { width: 46, height: 46, borderRadius: 23, alignItems: 'center', justifyContent: 'center' },
  title: { color: C.screen, fontFamily: F.bold, fontSize: 18 },
  sub: { color: C.dust, fontFamily: F.text, fontSize: 14, textAlign: 'center' },
  center: { position: 'absolute', top: 0, left: 0, right: 0, bottom: 0, alignItems: 'center', justifyContent: 'center', gap: 10, padding: 24 },
  errorTitle: { color: C.screen, fontFamily: F.bold, fontSize: 20 },
  next: { position: 'absolute', right: 24, bottom: 90 },
});
