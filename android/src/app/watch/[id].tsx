// Full-screen player (Android ExoPlayer via expo-video).
// Tries each source in turn; if Telegram storage fails it asks for provider
// sources; saves progress, offers the next episode, and reports playback so
// the server can auto-save titles watched for a few minutes.
// Phones and tablets get CutCrew's own controls (gestures, menus, Picture in
// Picture); Android TV keeps the player's built-in controls for the remote.
import Ionicons from '@expo/vector-icons/Ionicons';
import MaterialIcons from '@expo/vector-icons/MaterialIcons';
import { useEventListener } from 'expo';
import * as Brightness from 'expo-brightness';
import * as Crypto from 'expo-crypto';
import * as Haptics from 'expo-haptics';
import { router, useLocalSearchParams } from 'expo-router';
import * as ScreenOrientation from 'expo-screen-orientation';
import { StatusBar } from 'expo-status-bar';
import { isPictureInPictureSupported, useVideoPlayer, VideoView, type AudioTrack, type SubtitleTrack } from 'expo-video';
import { useEffect, useMemo, useRef, useState } from 'react';
import { ActivityIndicator, Platform, Pressable, StyleSheet, Text, useWindowDimensions, View } from 'react-native';
import { Controls } from '../../components/player/Controls';
import { GestureLayer } from '../../components/player/GestureLayer';
import { AudioSubtitlesSheet, EpisodesSheet, SpeedSheet, type Fit } from '../../components/player/Sheets';
import { clock } from '../../components/player/time';
import { Button, Focusable } from '../../components/ui';
import { BASE, getJSON, isAnime, nextEpisode, playPath, titlePath, type PlayResponse, type Stream, type Title } from '../../lib/api';
import { useLibrary } from '../../lib/library';
import { chooseTrack, detectLanguage, languageName, loadPreferredAudio, missingNotice, preferredAudio, setPreferredAudio } from '../../lib/audio';
import { C, F } from '../../lib/theme';

const STORAGE = 'cutcrew-storage';
const HIDE_MS = 4000;
const NEXT_COUNTDOWN = 10;
const START_TIMEOUT_MS = 30000;
// A converted copy waits for the server to start converting first.
const CONVERTED_START_TIMEOUT_MS = 60000;
const STALL_TIMEOUT_MS = 45000;

export default function Watch() {
  const params = useLocalSearchParams<{ id: string; season?: string; episode?: string }>();
  const id = params.id;
  const lib = useLibrary();
  const { width, height } = useWindowDimensions();
  const tv = Platform.isTV;
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
  // Controls: shown, locked, which menu is open, dragging the timeline.
  const [chrome, setChrome] = useState(true);
  const [locked, setLocked] = useState(false);
  const [lockHint, setLockHint] = useState(0);
  const [menu, setMenu] = useState<null | 'audio' | 'speed' | 'episodes'>(null);
  const [scrubbing, setScrubbing] = useState(false);
  const [speed, setSpeed] = useState(1);
  const [fit, setFit] = useState<Fit>('contain');
  const [pip, setPip] = useState(false);
  const [time, setTime] = useState({ key: '', position: 0, duration: 0, buffered: 0 });
  const [playing, setPlaying] = useState(false);
  const [buffering, setBuffering] = useState(false);
  const [nextDismissed, setNextDismissed] = useState(false);
  const [countdown, setCountdown] = useState(NEXT_COUNTDOWN);
  const [resumeChip, setResumeChip] = useState(false);
  // A short message at the bottom left (for example, a source that cannot jump).
  const [toast, setToast] = useState({ text: '', at: 0 });
  // The last jump, checked a few seconds later: did playback land near it?
  const seekCheck = useRef<{ target: number; at: number } | null>(null);
  const videoView = useRef<VideoView>(null);
  // Audio: anime keeps its own (Japanese with subtitles); everything else starts
  // on the preferred language, and a choice in the Audio menu becomes the preference.
  const anime = isAnime(id);
  const [pref, setPref] = useState(preferredAudio());
  useEffect(() => { loadPreferredAudio().then(setPref); }, []);
  const [audioState, setAudioState] = useState<{ key: string; list: AudioTrack[]; current: AudioTrack | null }>({ key: '', list: [], current: null });
  const [subState, setSubState] = useState<{ key: string; list: SubtitleTrack[]; current: SubtitleTrack | null }>({ key: '', list: [], current: null });
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

  const player = useVideoPlayer(null, p => { p.timeUpdateEventInterval = 0.5; });

  useEffect(() => {
    ScreenOrientation.lockAsync(ScreenOrientation.OrientationLock.LANDSCAPE).catch(() => {});
    return () => {
      ScreenOrientation.unlockAsync().catch(() => {});
      // Brightness set by swiping only applies while watching.
      Brightness.restoreSystemBrightnessAsync().catch(() => {});
    };
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
  // Converted copies (an MKV without an index, made playable by the server):
  // the server starts the stream at start=, so a jump or an audio change asks
  // again from that point. Shown time is the start plus the player's time.
  const converted = !!source?.remuxed;
  const base = useRef(0);
  const [remuxAudio, setRemuxAudio] = useState({ key: '', index: -1 });
  const [fullLength, setFullLength] = useState({ key: '', value: 0 });
  const remuxAudioIndex = remuxAudio.key === sourceKey && remuxAudio.index >= 0 ? remuxAudio.index : source?.audioIndex ?? 0;
  useEffect(() => {
    if (!source?.remuxed) return;
    let live = true, timer: ReturnType<typeof setTimeout> | undefined;
    // The server reads the length from the file; while it is busy converting
    // this can take a while, so ask again a few times.
    const ask = (attempt: number) => {
      getJSON<{ duration?: number }>(source.link.replace('/api/media?', '/api/media/info?'), { timeout: 40000, fresh: true })
        .then(info => { if (live && info.duration && info.duration > 0) setFullLength({ key: sourceKey, value: info.duration }); })
        .catch(() => { if (live && attempt < 4) timer = setTimeout(() => ask(attempt + 1), 5000); });
    };
    ask(0);
    return () => { live = false; if (timer) clearTimeout(timer); };
  }, [sourceKey, source?.link]); // eslint-disable-line react-hooks/exhaustive-deps
  // Quick jumps in a row (taps, dragging) become one new stream request.
  const jumpTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => { if (jumpTimer.current) clearTimeout(jumpTimer.current); }, []);
  const totalLength = () => (converted ? (fullLength.key === sourceKey ? fullLength.value : 0) : player.duration > 0 ? player.duration : 0);

  // Load the chosen source and resume where it stopped (seek inside the file).
  useEffect(() => {
    if (!source) return;
    const start = Math.floor(offset.current);
    let uri = BASE + source.link;
    if (source.remuxed) {
      uri += `&start=${start}&audio=${remuxAudioIndex}`;
      base.current = start;
      pendingSeek.current = 0;
    } else {
      base.current = 0;
      pendingSeek.current = start;
    }
    console.log(`[CutCrew] playing ${id} from ${start}s (${source.type}${source.remuxed ? ', converted' : ''})`);
    player.replaceAsync({ uri, contentType: source.type === 'hls' ? 'hls' : 'progressive', metadata: { title: title?.title } })
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
  const position = () => base.current + (player.currentTime || 0);
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
    if (anime || converted || list.length < 2 || audioChosen.current === sourceKey) return;
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
  useEventListener(player, 'availableSubtitleTracksChange', ({ availableSubtitleTracks }) => setSubState(s => ({ key: sourceKey, list: availableSubtitleTracks, current: s.key === sourceKey ? s.current : player.subtitleTrack })));
  useEventListener(player, 'subtitleTrackChange', ({ subtitleTrack }) => setSubState(s => ({ key: sourceKey, list: s.key === sourceKey ? s.list : player.availableSubtitleTracks, current: subtitleTrack })));
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
      if (!(played.key === sourceKey && played.ready) && startAt > 0) setResumeChip(true);
      setPlayed({ key: sourceKey, ready: true });
      setBuffering(false);
    }
    else if (next === 'loading') setBuffering(true);
    else if (next === 'error') fail();
  });
  useEventListener(player, 'playingChange', ({ isPlaying }) => setPlaying(isPlaying));

  useEventListener(player, 'timeUpdate', ({ currentTime, bufferedPosition }) => {
    const now = Date.now(), st = stats.current;
    // A jump that sent playback back to the start: this file has no index to
    // jump with. Play the next source from the wanted point, if there is one.
    const check = seekCheck.current;
    if (check && !converted && now - check.at > 4000) {
      seekCheck.current = null;
      if (currentTime < 15 && check.target > 30) {
        if (streams && index + 1 < streams.list.length) {
          offset.current = check.target;
          setToast({ text: 'This copy cannot jump. Switching to another one…', at: now });
          setPick({ key: requestKey, index: index + 1 });
          return;
        }
        setToast({ text: 'This copy can only play from the start.', at: now });
      }
    }
    if (player.playing && st.lastTick) st.played += Math.min(2, (now - st.lastTick) / 1000);
    st.lastTick = now;
    const pos = base.current + currentTime;
    const duration = totalLength() || null;
    if (!scrubbing) setTime({ key: sourceKey, position: pos, duration: duration || 0, buffered: bufferedPosition > 0 ? base.current + bufferedPosition : 0 });
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
    const duration = totalLength();
    if (!source || status !== 'ready' || stats.current.played < 20 || !(duration > 0) || position() < duration - 10) return;
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
  function goEpisode(s: number, e: number) {
    setMenu(null);
    if (s === season && e === episode) return;
    router.replace({ pathname: '/watch/[id]', params: { id, season: String(s), episode: String(e) } });
  }
  const goBack = () => (router.canGoBack() ? router.back() : router.replace('/'));

  // What the Audio menu lists, and a notice when the preferred language is missing.
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
  const subList = subState.key === sourceKey ? subState.list : [];

  // Watchdog: a source that never starts (30 s) or stays stuck mid-play (45 s)
  // is given up, and the next one plays from the same point.
  useEffect(() => {
    if (!source || status !== 'loading' || error) return;
    const t = setTimeout(() => fail(), converted ? CONVERTED_START_TIMEOUT_MS : START_TIMEOUT_MS);
    return () => clearTimeout(t);
  }, [sourceKey, status, error]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (status !== 'ready' || !buffering) return;
    const t = setTimeout(() => fail(), STALL_TIMEOUT_MS);
    return () => clearTimeout(t);
  }, [sourceKey, status, buffering]); // eslint-disable-line react-hooks/exhaustive-deps

  // Controls hide after a few seconds of playback, unless a menu is open or
  // the timeline is being dragged.
  useEffect(() => {
    if (!chrome || status !== 'ready' || menu || scrubbing || !playing) return;
    const t = setTimeout(() => setChrome(false), tv ? 4000 : HIDE_MS);
    return () => clearTimeout(t);
  }, [chrome, status, menu, scrubbing, playing, tv]);
  // While locked, a tap shows the unlock button for a few seconds.
  useEffect(() => {
    if (!lockHint) return;
    const t = setTimeout(() => setLockHint(0), 3000);
    return () => clearTimeout(t);
  }, [lockHint]);
  useEffect(() => {
    if (!toast.at) return;
    const t = setTimeout(() => setToast({ text: '', at: 0 }), 5000);
    return () => clearTimeout(t);
  }, [toast.at]);
  useEffect(() => {
    if (!resumeChip) return;
    const t = setTimeout(() => setResumeChip(false), 7000);
    return () => clearTimeout(t);
  }, [resumeChip]);
  // Credits: a "Next episode" card that plays the next one after a countdown.
  const nextCard = !tv && showNext && !!next && !nextDismissed && status === 'ready';
  useEffect(() => {
    if (!nextCard) return;
    if (countdown <= 0) { goNext(); return; }
    const t = setTimeout(() => setCountdown(n => n - 1), 1000);
    return () => clearTimeout(t);
  }, [nextCard, countdown]); // eslint-disable-line react-hooks/exhaustive-deps

  function seekTo(seconds: number) {
    if (converted) {
      // Ask the server for the stream from the new point, once the jumping stops.
      const length = totalLength();
      offset.current = Math.max(0, length > 0 ? Math.min(length - 5, seconds) : seconds);
      setTime(t => ({ ...t, position: offset.current }));
      if (jumpTimer.current) clearTimeout(jumpTimer.current);
      jumpTimer.current = setTimeout(() => { jumpTimer.current = null; setReload(n => n + 1); }, 700);
      return;
    }
    if (seconds > 30) seekCheck.current = { target: seconds, at: Date.now() };
    const d = player.duration > 0 ? player.duration : seconds;
    player.currentTime = Math.max(0, Math.min(d - 1, seconds));
    setTime(t => ({ ...t, position: Math.max(0, seconds) }));
  }
  function seekBy(delta: number) { seekTo((converted && jumpTimer.current ? offset.current : position()) + delta); }
  function togglePlay() { if (player.playing) player.pause(); else player.play(); setChrome(true); }
  function startPip() { videoView.current?.startPictureInPicture().catch(() => {}); }
  function lock() { setLocked(true); setChrome(false); setLockHint(Date.now()); Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium).catch(() => {}); }
  function unlock() { setLocked(false); setLockHint(0); setChrome(true); Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium).catch(() => {}); }

  const subtitleLine = season ? (anime ? `Episode ${episode}` : `Season ${season} · Episode ${episode}`) : '';
  const shown = time.key === sourceKey ? time : { position: 0, duration: 0, buffered: 0 };
  const canPip = !tv && isPictureInPictureSupported();

  if (tv) {
    // Android TV: the built-in controls work with the remote.
    return (
      <View style={w.screen} onTouchStart={() => setChrome(true)}>
        <StatusBar hidden />
        <VideoView player={player} style={StyleSheet.absoluteFill} contentFit="contain" nativeControls fullscreenOptions={{ enable: false }} allowsPictureInPicture={false} />
        {(chrome || status !== 'ready') && (
          <View style={w.tvTop} pointerEvents="box-none">
            <Focusable onPress={goBack} accessibilityLabel="Back" style={w.tvBack}>
              <Ionicons name="chevron-back" size={28} color={C.screen} />
            </Focusable>
            <View style={{ flex: 1 }}>
              <Text style={w.tvTitle} numberOfLines={1}>{title?.title || ''}</Text>
              {!!subtitleLine && <Text style={[w.sub, { textAlign: 'left' }]}>{subtitleLine}</Text>}
            </View>
            {audioList.length > 0 && (
              <Focusable onPress={() => setAudioMenu(true)} accessibilityLabel="Audio" style={w.tvAudio}>
                <Ionicons name="language" size={20} color={C.screen} />
                <Text style={w.tvAudioText}>Audio</Text>
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
        {audioMenu && (
          <View style={w.tvShade}>
            <View style={w.tvMenu}>
              <Text style={w.tvMenuTitle}>Audio</Text>
              {audioList.map((t, i) => (
                <Focusable key={t.id || i} onPress={() => pickAudio(t, i, audioList)} style={w.tvRow} accessibilityLabel={trackLabel(t, i, audioList)}>
                  <Ionicons name={i === playingIndex ? 'checkmark' : 'ellipse-outline'} size={18} color={i === playingIndex ? C.marigold : C.dust} />
                  <Text style={[w.tvRowText, i === playingIndex && { color: C.screen }]}>{trackLabel(t, i, audioList)}</Text>
                </Focusable>
              ))}
              <Button label="Close" kind="quiet" onPress={() => setAudioMenu(false)} />
            </View>
          </View>
        )}
        {showNext && next && <View style={w.tvNext}><Button label={`Next episode  S${next.season} E${next.episode}`} icon="▶" onPress={goNext} /></View>}
      </View>
    );
  }

  return (
    <View style={w.screen}>
      <StatusBar hidden />
      <VideoView ref={videoView} player={player} style={StyleSheet.absoluteFill} contentFit={fit} nativeControls={false}
        fullscreenOptions={{ enable: false }} allowsPictureInPicture startsPictureInPictureAutomatically
        onPictureInPictureStart={() => { setPip(true); setMenu(null); }} onPictureInPictureStop={() => setPip(false)} />
      {!pip && (
        <>
          <GestureLayer width={width} height={height} locked={locked}
            onTap={() => (locked ? setLockHint(Date.now()) : setChrome(c => !c))}
            onSeekBy={delta => seekBy(delta)} onFit={fill => setFit(fill ? 'cover' : 'contain')} />

          {status === 'ready' && chrome && !locked && !menu && (
            <Controls title={title?.title || ''} subtitle={subtitleLine} playing={playing} buffering={buffering}
              position={shown.position} duration={shown.duration} buffered={shown.buffered} speed={speed} canPip={canPip}
              hasEpisodes={!!title && !!season && (title.seasons?.length || 0) > 0} hasNext={!!next} hasAudioMenu={audioList.length > 1 || (converted && (source?.audioTracks?.length || 0) > 1)}
              onBack={goBack} onPlayPause={togglePlay} onSeekBy={seekBy} onSeek={seekTo} onScrub={setScrubbing}
              onPip={startPip} onLock={lock} onMenu={setMenu} onNext={goNext} />
          )}
          {status === 'ready' && !chrome && buffering && !locked && <View style={w.center} pointerEvents="none"><ActivityIndicator size="large" color={C.screen} /></View>}

          {locked && !!lockHint && (
            <View style={w.lockBar} pointerEvents="box-none">
              <Pressable onPress={unlock} style={w.unlock} accessibilityRole="button" accessibilityLabel="Unlock screen">
                <MaterialIcons name="lock-open" size={26} color={C.screen} />
                <Text style={w.unlockText}>Tap to unlock</Text>
              </Pressable>
            </View>
          )}

          {status === 'loading' && (
            <View style={w.center}>
              <ActivityIndicator size="large" color={C.marigold} />
              <Text style={w.sub}>{streams ? 'Starting playback…' : 'Finding a playable source…'}</Text>
            </View>
          )}
          {status !== 'ready' && (
            <View style={w.loadingTop} pointerEvents="box-none">
              <Pressable onPress={goBack} hitSlop={12} accessibilityRole="button" accessibilityLabel="Back"><MaterialIcons name="arrow-back" size={28} color={C.screen} /></Pressable>
              <View style={{ flex: 1 }}>
                <Text style={w.loadingTitle} numberOfLines={1}>{title?.title || ''}</Text>
                {!!subtitleLine && <Text style={w.sub2}>{subtitleLine}</Text>}
              </View>
            </View>
          )}
          {status === 'error' && (
            <View style={w.center}>
              <Text style={w.errorTitle}>Playback stopped</Text>
              <Text style={w.sub}>{error}</Text>
              <View style={{ flexDirection: 'row', gap: 12, marginTop: 14 }}>
                <Button label="Try again" onPress={() => setRequest(r => ({ exclude: [], refresh: true, serial: r.serial + 1 }))} />
                <Button label="Go back" kind="quiet" onPress={goBack} />
              </View>
            </View>
          )}

          {resumeChip && status === 'ready' && !locked && (
            <View style={w.chip}>
              <Text style={w.chipText}>Resumed from {clock(startAt)}</Text>
              <Pressable onPress={() => { seekTo(0); setResumeChip(false); }} hitSlop={8} accessibilityRole="button"><Text style={w.chipAction}>Start over</Text></Pressable>
            </View>
          )}
          {!!noteKey && hiddenNote !== noteKey && status === 'ready' && !menu && <View style={w.note} pointerEvents="none"><Text style={w.noteText}>{missing}</Text></View>}
          {!!toast.text && !menu && <View style={w.chip} pointerEvents="none"><Text style={w.chipText}>{toast.text}</Text></View>}

          {nextCard && !menu && !locked && (
            <View style={w.nextCard}>
              <Pressable onPress={() => setNextDismissed(true)} style={w.credits} accessibilityRole="button"><Text style={w.creditsText}>Watch credits</Text></Pressable>
              <Pressable onPress={goNext} style={w.nextButton} accessibilityRole="button" accessibilityLabel="Play next episode">
                <View style={[w.nextFill, { width: `${Math.round(((NEXT_COUNTDOWN - countdown) / NEXT_COUNTDOWN) * 100)}%` }]} />
                <MaterialIcons name="play-arrow" size={24} color={C.night} />
                <Text style={w.nextText}>Next Episode ({countdown})</Text>
              </Pressable>
            </View>
          )}

          {menu === 'audio' && (
            <AudioSubtitlesSheet onClose={() => setMenu(null)}
              audio={converted && (source?.audioTracks?.length || 0) > 1
                ? (source?.audioTracks || []).map(t => ({ key: String(t.index), label: t.label, active: t.index === remuxAudioIndex, onPick: () => {
                    if (t.language) { setPreferredAudio(t.language); setPref(t.language); }
                    offset.current = position();
                    setRemuxAudio({ key: sourceKey, index: t.index });
                    setReload(n => n + 1);
                    setMenu(null);
                  } }))
                : audioList.length > 1 ? audioList.map((t, i) => ({ key: t.id || String(i), label: trackLabel(t, i, audioList), active: i === playingIndex, onPick: () => pickAudio(t, i, audioList) })) : []}
              subtitles={[{ key: 'off', label: 'Off', active: !subState.current || subState.key !== sourceKey, onPick: () => { player.subtitleTrack = null; } },
                ...subList.map((t, i) => ({ key: t.id || String(i), label: t.label || languageName(detectLanguage(t.language, t.label)) || t.language || `Subtitles ${i + 1}`,
                  active: subState.current?.id === t.id, onPick: () => { player.subtitleTrack = t; } }))]}
              note={audioList.length > 1 || converted ? `Plays first next time: ${languageName(pref)}` : undefined} />
          )}
          {menu === 'speed' && (
            <SpeedSheet speed={speed} fit={fit} onClose={() => setMenu(null)}
              onSpeed={v => { player.playbackRate = v; setSpeed(v); setMenu(null); }} onFit={v => { setFit(v); setMenu(null); }} />
          )}
          {menu === 'episodes' && title && (
            <EpisodesSheet title={title} season={season} episode={episode} onPick={goEpisode} onClose={() => setMenu(null)} />
          )}
        </>
      )}
    </View>
  );
}

const w = StyleSheet.create({
  screen: { flex: 1, backgroundColor: '#000' },
  sub: { color: C.dust, fontFamily: F.text, fontSize: 14, textAlign: 'center' },
  sub2: { color: 'rgba(242,240,234,0.75)', fontFamily: F.medium, fontSize: 13 },
  center: { position: 'absolute', top: 0, left: 0, right: 0, bottom: 0, alignItems: 'center', justifyContent: 'center', gap: 10, padding: 24 },
  errorTitle: { color: C.screen, fontFamily: F.bold, fontSize: 20 },
  loadingTop: { position: 'absolute', top: 14, left: 20, right: 20, flexDirection: 'row', alignItems: 'center', gap: 14 },
  loadingTitle: { color: C.screen, fontFamily: F.bold, fontSize: 17 },
  lockBar: { position: 'absolute', top: 0, bottom: 0, left: 0, right: 0, alignItems: 'center', justifyContent: 'flex-end', paddingBottom: 36 },
  unlock: { flexDirection: 'row', alignItems: 'center', gap: 10, paddingHorizontal: 20, height: 48, borderRadius: 24, backgroundColor: 'rgba(15,19,32,0.85)', borderWidth: 1, borderColor: 'rgba(242,240,234,0.3)' },
  unlockText: { color: C.screen, fontFamily: F.semibold, fontSize: 15 },
  chip: { position: 'absolute', left: 24, bottom: 120, flexDirection: 'row', alignItems: 'center', gap: 14, paddingHorizontal: 16, height: 42, borderRadius: 21, backgroundColor: 'rgba(15,19,32,0.88)' },
  chipText: { color: C.screen, fontFamily: F.medium, fontSize: 14 },
  chipAction: { color: C.marigold, fontFamily: F.bold, fontSize: 14 },
  note: { position: 'absolute', top: 76, left: 0, right: 0, alignItems: 'center' },
  noteText: { color: C.screen, fontFamily: F.medium, fontSize: 14, backgroundColor: 'rgba(15,19,32,0.9)', paddingHorizontal: 16, paddingVertical: 10, borderRadius: 10, overflow: 'hidden', maxWidth: 520, textAlign: 'center' },
  nextCard: { position: 'absolute', right: 28, bottom: 110, flexDirection: 'row', alignItems: 'center', gap: 12 },
  credits: { paddingHorizontal: 18, height: 46, borderRadius: 8, alignItems: 'center', justifyContent: 'center', backgroundColor: 'rgba(15,19,32,0.75)', borderWidth: 1, borderColor: 'rgba(242,240,234,0.35)' },
  creditsText: { color: C.screen, fontFamily: F.semibold, fontSize: 15 },
  nextButton: { flexDirection: 'row', alignItems: 'center', gap: 6, paddingHorizontal: 18, height: 46, borderRadius: 8, backgroundColor: 'rgba(242,240,234,0.85)', overflow: 'hidden' },
  nextFill: { position: 'absolute', top: 0, bottom: 0, left: 0, backgroundColor: C.screen },
  nextText: { color: C.night, fontFamily: F.bold, fontSize: 15 },
  // Android TV layout (built-in controls).
  tvTop: { position: 'absolute', top: 0, left: 0, right: 0, flexDirection: 'row', alignItems: 'center', gap: 6, padding: 12, backgroundColor: 'rgba(0,0,0,0.35)' },
  tvBack: { width: 46, height: 46, borderRadius: 23, alignItems: 'center', justifyContent: 'center' },
  tvTitle: { color: C.screen, fontFamily: F.bold, fontSize: 18 },
  tvAudio: { flexDirection: 'row', alignItems: 'center', gap: 6, paddingHorizontal: 14, height: 42, borderRadius: 21, backgroundColor: 'rgba(15,19,32,0.7)', borderWidth: 1, borderColor: 'rgba(242,240,234,0.3)' },
  tvAudioText: { color: C.screen, fontFamily: F.semibold, fontSize: 14 },
  tvShade: { position: 'absolute', top: 0, left: 0, right: 0, bottom: 0, backgroundColor: 'rgba(0,0,0,0.55)', alignItems: 'flex-end', justifyContent: 'center', paddingRight: 24 },
  tvMenu: { width: 300, maxHeight: '90%', backgroundColor: C.velvet, borderRadius: 14, borderWidth: 1, borderColor: C.line, padding: 16, gap: 4 },
  tvMenuTitle: { color: C.screen, fontFamily: F.bold, fontSize: 18, marginBottom: 6 },
  tvRow: { flexDirection: 'row', alignItems: 'center', gap: 10, paddingVertical: 10, paddingHorizontal: 6, borderRadius: 8 },
  tvRowText: { color: C.dust, fontFamily: F.semibold, fontSize: 15 },
  tvNext: { position: 'absolute', right: 24, bottom: 90 },
});
