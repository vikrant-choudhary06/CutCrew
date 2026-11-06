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
import { useVideoPlayer, VideoView, type AudioTrack } from 'expo-video';
import { useEffect, useMemo, useRef, useState } from 'react';
import { ActivityIndicator, StyleSheet, Text, View } from 'react-native';
import { Button, Focusable } from '../../components/ui';
import { BASE, getJSON, isAnime, nextEpisode, playPath, titlePath, type PlayResponse, type Stream, type Title } from '../../lib/api';
import { useLibrary } from '../../lib/library';
import { chooseTrack, detectLanguage, languageName, loadPreferredAudio, missingNotice, preferredAudio, setPreferredAudio } from '../../lib/audio';
import { C, F } from '../../lib/theme';

const STORAGE = 'cutcrew-storage';

export default function Watch() {
  const params = useLocalSearchParams<{ id: string; season?: string; episode?: string }>();
  const id = params.id;
  const lib = useLibrary();
  // Anime opened without an episode (Play on Home): the latest unfinished
  // episode, else episode 1, always in season 1 as on the website. Chosen once,
  // so saving progress does not change it mid-play.
  const [animeStart] = useState(() => {
    if (!isAnime(id) || params.episode) return null;
    const last = lib.resumeFor(id);
    return { season: 1, episode: last && last.episode > 0 ? last.episode : 1 };
  });
  const season = params.season ? Number(params.season) : animeStart ? animeStart.season : isAnime(id) ? 1 : 0;
  const episode = params.episode ? Number(params.episode) : animeStart ? animeStart.episode : 0;
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
  // Audio: anime keeps its own (Japanese with subtitles); everything else starts
  // on the preferred language, and a choice in the Audio menu becomes the preference.
  const anime = isAnime(id);
  const [pref, setPref] = useState(preferredAudio());
  useEffect(() => { loadPreferredAudio().then(setPref); }, []);
  const [audioState, setAudioState] = useState<{ key: string; list: AudioTrack[]; current: AudioTrack | null }>({ key: '', list: [], current: null });
  const [audioMenu, setAudioMenu] = useState(false);
  const [hiddenNote, setHiddenNote] = useState('');
  const audioChosen = useRef('');

  // Where to start: this episode's saved position, unless it was finished.
  const startAt = useMemo(() => {
    const p = lib.progress.find(x => x.data.imdb_id === id && x.season === season && x.episode === episode);
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
    getJSON<PlayResponse>(playPath(id, { season, episode, exclude: request.exclude, refresh: request.refresh, lang: preferredAudio() }), { timeout: 120000, fresh: true })
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
    // Keep the resume point if the failed source never got going (it reports 0).
    const reached = position();
    if (reached > 1 && !pendingSeek.current) offset.current = reached;
    else if (pendingSeek.current) offset.current = pendingSeek.current;
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

  // ExoPlayer's tracks in the shared form; names from the file when the server read them.
  const trackInfo = (list: AudioTrack[]) => list.map((t, i) => ({ index: i, language: detectLanguage(t.language, `${t.name || ''} ${t.label || ''}`), title: t.name || t.label || '', default: !!t.isDefault }));
  const trackLabel = (t: AudioTrack, i: number, list: AudioTrack[]) => {
    const server = source?.audioTracks;
    if (server?.length === list.length && server[i]?.label) return server[i].label;
    return languageName(detectLanguage(t.language, `${t.name || ''} ${t.label || ''}`)) || t.name || t.label || `Audio ${i + 1}`;
  };
  // Once per source: switch to the preferred language's track.
  function chooseAudio(list: AudioTrack[]) {
    if (anime || list.length < 2 || audioChosen.current === sourceKey) return;
    audioChosen.current = sourceKey;
    const server = source?.audioTracks;
    const index = server?.length === list.length && source?.audioIndex !== undefined ? source.audioIndex : chooseTrack(trackInfo(list), preferredAudio())?.index;
    const target = index !== undefined ? list[index] : undefined;
    if (target && player.audioTrack?.id !== target.id) player.audioTrack = target;
  }
  useEventListener(player, 'availableAudioTracksChange', ({ availableAudioTracks }) => {
    setAudioState(s => ({ key: sourceKey, list: availableAudioTracks, current: s.key === sourceKey ? s.current : player.audioTrack }));
    if (player.status === 'readyToPlay') chooseAudio(availableAudioTracks);
  });
  useEventListener(player, 'audioTrackChange', ({ audioTrack }) => setAudioState(s => ({ key: sourceKey, list: s.key === sourceKey ? s.list : player.availableAudioTracks, current: audioTrack })));
  function pickAudio(track: AudioTrack, i: number, list: AudioTrack[]) {
    player.audioTrack = track;
    const code = trackInfo(list)[i].language;
    if (code) { setPreferredAudio(code); setPref(code); }
    setAudioMenu(false);
  }

  useEventListener(player, 'statusChange', ({ status: next }) => {
    if (next === 'readyToPlay') {
      jumpToStart();
      chooseAudio(player.availableAudioTracks);
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

  // What the Audio button lists, and a notice when the preferred language is missing.
  const audioList = !anime && audioState.key === sourceKey ? audioState.list : [];
  const playingIndex = audioList.findIndex(t => t.id === audioState.current?.id);
  const playingLang = playingIndex >= 0 ? trackInfo(audioList)[playingIndex].language : '';
  const missing = audioList.length > 0 && !trackInfo(audioList).some(t => t.language === pref) ? missingNotice(pref, playingLang) : '';
  const noteKey = missing ? `${sourceKey}|${missing}` : '';
  useEffect(() => {
    if (!noteKey) return;
    const t = setTimeout(() => setHiddenNote(noteKey), 9000);
    return () => clearTimeout(t);
  }, [noteKey]);

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
          {audioList.length > 0 && (
            <Focusable onPress={() => setAudioMenu(true)} accessibilityLabel="Audio" style={w.audioButton}>
              <Ionicons name="language" size={20} color={C.screen} />
              <Text style={w.audioText}>Audio</Text>
            </Focusable>
          )}
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
      {!!noteKey && hiddenNote !== noteKey && status === 'ready' && <View style={w.note} pointerEvents="none"><Text style={w.noteText}>{missing}</Text></View>}
      {audioMenu && (
        <View style={w.menuShade}>
          <View style={w.menu}>
            <Text style={w.menuTitle}>Audio</Text>
            {audioList.map((t, i) => (
              <Focusable key={t.id || i} onPress={() => pickAudio(t, i, audioList)} style={w.menuRow} accessibilityLabel={trackLabel(t, i, audioList)}>
                <Ionicons name={i === playingIndex ? 'checkmark' : 'ellipse-outline'} size={18} color={i === playingIndex ? C.marigold : C.dust} />
                <Text style={[w.menuText, i === playingIndex && { color: C.screen }]}>{trackLabel(t, i, audioList)}</Text>
              </Focusable>
            ))}
            <Text style={w.menuHelp}>{`Plays first next time: ${languageName(pref)}`}</Text>
            <Button label="Close" kind="quiet" onPress={() => setAudioMenu(false)} />
          </View>
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
  audioButton: { flexDirection: 'row', alignItems: 'center', gap: 6, paddingHorizontal: 14, height: 42, borderRadius: 21, backgroundColor: 'rgba(15,19,32,0.7)', borderWidth: 1, borderColor: 'rgba(242,240,234,0.3)' },
  audioText: { color: C.screen, fontFamily: F.semibold, fontSize: 14 },
  note: { position: 'absolute', top: 76, left: 0, right: 0, alignItems: 'center' },
  noteText: { color: C.screen, fontFamily: F.medium, fontSize: 14, backgroundColor: 'rgba(15,19,32,0.9)', paddingHorizontal: 16, paddingVertical: 10, borderRadius: 10, overflow: 'hidden', maxWidth: 520, textAlign: 'center' },
  menuShade: { position: 'absolute', top: 0, left: 0, right: 0, bottom: 0, backgroundColor: 'rgba(0,0,0,0.55)', alignItems: 'flex-end', justifyContent: 'center', paddingRight: 24 },
  menu: { width: 300, maxHeight: '90%', backgroundColor: C.velvet, borderRadius: 14, borderWidth: 1, borderColor: C.line, padding: 16, gap: 4 },
  menuTitle: { color: C.screen, fontFamily: F.bold, fontSize: 18, marginBottom: 6 },
  menuRow: { flexDirection: 'row', alignItems: 'center', gap: 10, paddingVertical: 10, paddingHorizontal: 6, borderRadius: 8 },
  menuText: { color: C.dust, fontFamily: F.semibold, fontSize: 15 },
  menuHelp: { color: C.dust, fontFamily: F.text, fontSize: 12, marginTop: 6, marginBottom: 8 },
});
