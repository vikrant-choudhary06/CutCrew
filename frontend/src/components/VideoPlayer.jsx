import { useEffect, useRef, useState } from 'react'
import Hls from 'hls.js'
import {bufferAhead,bufferTarget,canResume} from './bufferPolicy'

const clock = value => {
  const seconds = Math.max(0, Math.floor(value || 0))
  return seconds >= 3600
    ? `${Math.floor(seconds / 3600)}:${String(Math.floor(seconds / 60) % 60).padStart(2, '0')}:${String(seconds % 60).padStart(2, '0')}`
    : `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`
}
function ControlIcon({ name }) {
  const paths = {
    captions: 'M3 5h18v14H3zM10 10H8v4h2M17 10h-2v4h2', episodes: 'M4 6h2M9 6h11M4 12h2M9 12h11M4 18h2M9 18h11', next: 'M5 5l10 7-10 7zM19 5v14',
    play: 'M8 5v14l11-7z', pause: 'M8 5v14M16 5v14',
    volume: 'M11 5 6 9H3v6h3l5 4zM15 8a6 6 0 0 1 0 8M18 5a10 10 0 0 1 0 14',
    muted: 'M11 5 6 9H3v6h3l5 4zM16 9l5 6M21 9l-5 6',
    fullscreen: 'M8 3H3v5M16 3h5v5M21 16v5h-5M8 21H3v-5',
  }
  return <svg viewBox="0 0 24 24" fill={name === 'play' ? 'currentColor' : 'none'} stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d={paths[name]} /></svg>
}
export default function VideoPlayer({ source, onFailure, onProgress, onEnded, initialTime = 0, fullDuration, canSeek = false, onSeek, fullscreenTargetRef, onPlaybackState, menu, onMenuChange, settingsContent, languageContent, episodeControls, controlsVisible = true, onMetrics, positionRef }) {
  const touchReveal=useRef(false),intentRef=useRef(true),gateRef=useRef(false),requestPlayback=useRef(null)
  const videoRef = useRef(null), shellRef = useRef(null), hlsRef = useRef(null)
  const callbacks = useRef({ onFailure, onProgress, onEnded, onPlaybackState, onMetrics, fullDuration }), resume = useRef(initialTime), lastSent = useRef(0), speed = useRef(1)
  const volumeRef = useRef({ value: 1, muted: false }), dragRef = useRef(false), previewRef = useRef(null), seekTimer = useRef(null)
  const lastPointer = useRef('mouse'), pendingTap = useRef(null), tapHintTimer = useRef(null)
  const [tapHint, setTapHint] = useState(null), [showKeys, setShowKeys] = useState(false)
  useEffect(() => () => { clearTimeout(pendingTap.current); clearTimeout(tapHintTimer.current) }, [])
  const [playbackSpeed,setPlaybackSpeed]=useState(1)
  const [view, setView] = useState(null), [draft, setDraft] = useState(null), [controlError, setControlError] = useState('')
  const [levels, setLevels] = useState([]), [quality, setQuality] = useState(-1), [audio, setAudio] = useState([]), [audioIndex, setAudioIndex] = useState(0), [captions, setCaptions] = useState(() => (Number.isInteger(source.defaultSubtitle) && source.subtitles?.[source.defaultSubtitle] ? source.defaultSubtitle : -1)), [captionSize, setCaptionSize] = useState(20)
  const current = view?.link === source.link ? view : { time: source.startOffset || 0, duration: 0, paused: view?.paused ?? false, waiting: true, buffered: 0, volume: view?.volume ?? 1, muted: view?.muted ?? false }
  const duration = source.remuxed ? Number(fullDuration) || 0 : current.duration
  const seekEnabled = duration > 0 && (!source.remuxed || canSeek)
  const shownTime = duration > 0 ? Math.min(draft ?? current.time, duration) : draft ?? current.time
  useEffect(() => { callbacks.current = { onFailure, onProgress, onEnded, onPlaybackState, onMetrics, fullDuration } }, [onFailure, onProgress, onEnded, onPlaybackState, onMetrics, fullDuration])
  useEffect(() => () => clearTimeout(seekTimer.current), [])
  useEffect(() => {
    const video=videoRef.current,created=Date.now(),sessionId=crypto.randomUUID()
    let recentStalls=[]
    let hls,reported=false,endedPlayback=false,hasPlayed=false,timer,monitor,internalPause=false,waitingForData=true,gateStarted=0,gateReason='startup',lastSeek=0,lastWait=0,lastSample=0,lastTick=Date.now(),lastFrame=0
    const stats={sessionId,playedSeconds:0,stalls:0,stalledSeconds:0,startupMs:0,droppedFrames:0,totalFrames:0}
    gateRef.current=false
    if(positionRef)positionRef.current=()=>(video.currentTime||0)+(source.startOffset||0)
    const sync=()=>{
      let buffered=source.startOffset||0
      try{if(video.buffered.length)buffered+=video.buffered.end(video.buffered.length-1)}catch{/* Source ranges may change during seeking. */}
      volumeRef.current={value:video.volume,muted:video.muted}
      setView({link:source.link,time:(video.currentTime||0)+(source.startOffset||0),duration:Number.isFinite(video.duration)?video.duration:0,paused:!intentRef.current,waiting:waitingForData,volume:video.volume,muted:video.muted,buffered})
    }
    const emit=(event='sample')=>{
      const now=Date.now();if(event==='sample'&&now-lastSample<15000)return;lastSample=now
      const quality=video.getVideoPlaybackQuality?.();
      callbacks.current.onMetrics?.({...stats,event,bufferAhead:bufferAhead(video),stalledSeconds:stats.stalledSeconds+(gateRef.current&&gateReason==='rebuffer'?(now-gateStarted)/1000:0),droppedFrames:quality?.droppedVideoFrames||0,totalFrames:quality?.totalVideoFrames||0})
    }
    const report=(complete=false,force=false)=>{
      if(!hasPlayed)return
      const position=(video.currentTime||0)+(source.startOffset||0)
      if(position<=0&&!complete)return
      if(force||Date.now()-lastSent.current>10000){lastSent.current=Date.now();callbacks.current.onProgress?.({position,duration:Number.isFinite(video.duration)&&video.duration>0&&!source.remuxed?video.duration:null,completed:complete})}
    }
    const finishGate=()=>{if(gateRef.current&&gateReason==='rebuffer')stats.stalledSeconds+=(Date.now()-gateStarted)/1000;gateRef.current=false}
    const fail=(reason='source-error')=>{if(reported)return;reported=true;emit('failure');callbacks.current.onFailure?.({reason,stats:{...stats}})}
    const checkGate=()=>{
      if(!gateRef.current||!intentRef.current||reported)return
      let total=source.remuxed?(Number(callbacks.current.fullDuration)||(Number.isFinite(video.duration)?video.duration+(source.startOffset||0):0)):video.duration
      if(video.networkState===1&&Number.isFinite(video.duration)&&video.duration>0)total=Math.min(total||Infinity,video.duration+(source.startOffset||0))
      const remaining=Number.isFinite(total)&&total>0?Math.max(0,total-video.currentTime-(source.startOffset||0)):Infinity
      const target=bufferTarget({converted:source.remuxed,rebuffer:gateReason==='rebuffer',remaining})
      if(canResume({ahead:bufferAhead(video),target,elapsedMs:Date.now()-gateStarted,readyState:video.readyState})){
        finishGate();video.play().catch(()=>{intentRef.current=false;waitingForData=false;clearTimeout(timer);callbacks.current.onPlaybackState?.(false);sync()})
      }
    }
    const beginGate=reason=>{
      if(!intentRef.current)return
      if(!gateRef.current){gateRef.current=true;gateStarted=Date.now();gateReason=reason;clearTimeout(timer);timer=setTimeout(()=>fail(hasPlayed?'rebuffer':'startup-timeout'),source.remuxed?45000:30000);if(!video.paused){internalPause=true;video.pause()}}
      waitingForData=true;callbacks.current.onPlaybackState?.(false);sync();checkGate()
    }
    requestPlayback.current=active=>{
      intentRef.current=active
      if(active){if(video.ended)video.currentTime=0;beginGate('startup')}
      else{finishGate();waitingForData=false;clearTimeout(timer);video.pause();callbacks.current.onPlaybackState?.(false);sync();report(false,true)}
    }
    const waiting=()=>{
      if(!intentRef.current)return
      const now=Date.now()
      if(hasPlayed&&!video.seeking&&!gateRef.current&&now-lastSeek>3000&&now-lastWait>3000){stats.stalls++;recentStalls=recentStalls.filter(value=>now-value<90000);recentStalls.push(now);lastWait=now;report(false,true);if(hls?.autoLevelEnabled&&hls.currentLevel>0){hls.autoLevelCapping=hls.currentLevel-1;hls.nextAutoLevel=hls.currentLevel-1}if(recentStalls.length>=3){fail('rebuffer');return}}
      beginGate(hasPlayed?'rebuffer':'startup')
    }
    const playing=()=>{
      if(!intentRef.current){internalPause=true;video.pause();return}
      finishGate();if(!hasPlayed)stats.startupMs=Date.now()-created;hasPlayed=true;waitingForData=false;clearTimeout(timer);callbacks.current.onPlaybackState?.(true);sync();report(false,true);emit()
    }
    const pause=()=>{if(internalPause){internalPause=false;sync();return}intentRef.current=false;finishGate();waitingForData=false;clearTimeout(timer);callbacks.current.onPlaybackState?.(false);sync();report(endedPlayback,true)}
    const ended=()=>{if(!hasPlayed||video.currentTime<.1){fail();return}endedPlayback=true;finishGate();waitingForData=false;intentRef.current=false;clearTimeout(timer);callbacks.current.onPlaybackState?.(false);sync();report(true,true);emit('ended');callbacks.current.onEnded?.()}
    const ready=()=>{
      video.playbackRate=speed.current;video.volume=volumeRef.current.value;video.muted=volumeRef.current.muted
      if(!source.remuxed&&resume.current>0&&Number.isFinite(video.duration)){try{video.currentTime=Math.min(resume.current,Math.max(0,video.duration-1))}catch{/* Another source may support seeking. */}}
      previewRef.current=null;setDraft(null);sync();if(intentRef.current)beginGate('startup')
    }
    const available=()=>{if(gateRef.current)checkGate();else{waitingForData=false;clearTimeout(timer);sync()}}
    const update=()=>{sync();report(endedPlayback);checkGate()}
    const seeking=()=>{lastSeek=Date.now();if(intentRef.current)beginGate('seek');else sync()}
    const progressed=()=>{sync();checkGate()}
    const events=[['error',()=>fail()],['loadedmetadata',ready],['waiting',waiting],['stalled',waiting],['seeking',seeking],['canplay',available],['loadeddata',available],['seeked',available],['playing',playing],['timeupdate',update],['pause',pause],['ended',ended],['progress',progressed],['durationchange',progressed],['volumechange',sync]]
    events.forEach(([event,handler])=>video.addEventListener(event,handler))
    timer=setTimeout(()=>fail('startup-timeout'),source.remuxed?45000:30000);sync()
    monitor=setInterval(()=>{
      const now=Date.now();if(hasPlayed&&!video.paused&&!gateRef.current&&video.currentTime>lastFrame+.01)stats.playedSeconds+=Math.min(2,(now-lastTick)/1000)
      lastTick=now;lastFrame=video.currentTime;checkGate();if(hasPlayed)emit()
    },500)
    if(source.type==='hls'){
      if(Hls.isSupported()){
        hls=new Hls({startPosition:resume.current>0?resume.current:-1,enableWorker:true,capLevelToPlayerSize:true,abrEwmaDefaultEstimate:1500000,maxBufferLength:45,maxMaxBufferLength:90,maxBufferSize:48*1024*1024,backBufferLength:30,manifestLoadingMaxRetry:2,fragLoadingMaxRetry:3});hlsRef.current=hls
        hls.on(Hls.Events.MANIFEST_PARSED,()=>{setLevels(hls.levels.map((level,index)=>({index,height:level.height,bitrate:level.bitrate})));setQuality(-1);setAudio(hls.audioTracks);setAudioIndex(hls.audioTrack)})
        hls.on(Hls.Events.AUDIO_TRACKS_UPDATED,()=>setAudio(hls.audioTracks));hls.on(Hls.Events.ERROR,(_,data)=>{if(data.fatal)fail('hls-error')});hls.loadSource(source.link);hls.attachMedia(video)
      }else if(video.canPlayType('application/vnd.apple.mpegurl'))video.src=source.link;else fail('unsupported-format')
    }else video.src=source.link
    return()=>{emit(endedPlayback?'ended':'sample');report(endedPlayback,true);callbacks.current.onPlaybackState?.(false);if(hasPlayed)resume.current=(video.currentTime||0)+(source.startOffset||0)||resume.current;events.forEach(([event,handler])=>video.removeEventListener(event,handler));clearTimeout(timer);clearTimeout(seekTimer.current);clearInterval(monitor);requestPlayback.current=null;if(positionRef)positionRef.current=null;gateRef.current=false;hls?.destroy();hlsRef.current=null;video.pause();video.removeAttribute('src');video.load()}
  },[source,positionRef])
  function togglePlay(){
    const video=videoRef.current;setControlError('')
    if(video.ended&&source.remuxed&&canSeek&&(source.startOffset||0)>0){intentRef.current=true;onSeek?.(0);return}
    requestPlayback.current?.(!intentRef.current)
  }

  function seekTo(value) {
    clearTimeout(seekTimer.current); previewRef.current = null; setDraft(null)
    if (!seekEnabled || !Number.isFinite(value)) return
    const target = Math.max(0, Math.min(value, Math.max(0, duration - .1)))
    setControlError('')
    if (source.remuxed) {
      // Buffered output can seek instantly; other positions restart conversion.
      const local = target - (source.startOffset || 0), video = videoRef.current
      let buffered = false
      for (let index = 0; index < video.buffered.length; index++) if (local >= video.buffered.start(index) && local < video.buffered.end(index)) buffered = true
      if (buffered) { const ended = video.ended; video.currentTime = local; if (ended) video.play().catch(() => {}); return }
      onSeek?.(target)
    } else {
      try { videoRef.current.currentTime = target } catch { setControlError('This source could not seek. Try another source.') }
    }
  }
  function preview(value) {
    const target = Number(value); previewRef.current = target; setDraft(target)
    clearTimeout(seekTimer.current)
    if (!dragRef.current) seekTimer.current = setTimeout(() => seekTo(target), 350)
  }
  async function fullscreen() {
    setControlError('')
    try {
      const target = fullscreenTargetRef?.current || shellRef.current
      if (document.fullscreenElement) await document.exitFullscreen()
      else if (target.requestFullscreen) await target.requestFullscreen()
      else if (videoRef.current.webkitEnterFullscreen) videoRef.current.webkitEnterFullscreen()
    } catch { setControlError('Fullscreen is unavailable in this browser.') }
  }
  function keyboard(event) {
    if (event.key === 'Escape' && showKeys) { event.preventDefault(); event.stopPropagation(); setShowKeys(false); return }
    if (event.key === 'Escape' && menu) { event.preventDefault(); event.stopPropagation(); onMenuChange?.(null); return }
    if (event.key === 'Escape' && document.fullscreenElement) { event.stopPropagation(); return }
    if (event.target.closest('button,input,select')) return
    const key = event.key.length === 1 ? event.key.toLowerCase() : event.key
    if ([' ', 'k'].includes(key)) { event.preventDefault(); togglePlay() }
    else if (['ArrowLeft', 'ArrowRight', 'j', 'l'].includes(key)) { event.preventDefault(); const step = key === 'ArrowRight' || key === 'l' ? 10 : -10; seekTo(current.time + step); flashSeek(step) }
    else if (['ArrowUp', 'ArrowDown'].includes(key)) { event.preventDefault(); const video = videoRef.current; video.muted = false; video.volume = Math.max(0, Math.min(1, Math.round((video.volume + (key === 'ArrowUp' ? .1 : -.1)) * 10) / 10)) }
    else if (key === 'f') { event.preventDefault(); fullscreen() }
    else if (key === 'm') { event.preventDefault(); videoRef.current.muted = !videoRef.current.muted }
    else if (key === '?') { event.preventDefault(); setShowKeys(value => !value) }
  }
  // Brief "-10 s" / "+10 s" mark on the side that was seeked.
  function flashSeek(step) {
    clearTimeout(tapHintTimer.current); setTapHint(step)
    tapHintTimer.current = setTimeout(() => setTapHint(null), 650)
  }
  // Touch: a single tap waits briefly so a double tap can seek instead of pausing.
  function surfaceTap(event) {
    if (lastPointer.current !== 'touch') { if (touchReveal.current) { touchReveal.current = false; return } togglePlay(); return }
    const rect = event.currentTarget.getBoundingClientRect(), x = (event.clientX - rect.left) / rect.width
    if (pendingTap.current) {
      clearTimeout(pendingTap.current); pendingTap.current = null
      if (x < .4 || x > .6) { const step = x > .6 ? 10 : -10; seekTo(current.time + step); flashSeek(step) } else fullscreen()
      return
    }
    const reveal = touchReveal.current; touchReveal.current = false
    pendingTap.current = setTimeout(() => { pendingTap.current = null; if (!reveal) togglePlay() }, 260)
  }
  return <div className="video-player integrated-player" ref={shellRef} onKeyDown={keyboard}>
    <div className="video-surface">
      <video ref={videoRef} preload="auto" playsInline crossOrigin="anonymous" tabIndex={0} onPointerDown={event=>{lastPointer.current=event.pointerType;touchReveal.current=event.pointerType==='touch'&&!controlsVisible}} onClick={surfaceTap} onDoubleClick={()=>{if(lastPointer.current!=='touch')fullscreen()}} style={{ '--caption-size': `${captionSize}px` }} aria-label="Video player">
        {(source.subtitles || []).map((track, index) => <track key={track.uri || index} kind="subtitles" default={index === captions} src={track.uri} srcLang={track.language || 'und'} label={track.title || track.language || 'Subtitles'} />)}
      </video>
      {tapHint !== null && <div className={`seek-hint seek-hint--${tapHint > 0 ? 'forward' : 'back'}`} aria-hidden="true">{tapHint > 0 ? '+10 s' : '−10 s'}</div>}
      {showKeys && <div className="key-help" role="dialog" aria-label="Keyboard shortcuts">
        <p className="key-help-title">Keyboard shortcuts</p>
        <dl>{[['Space or K', 'Play or pause'], ['← or J', 'Back 10 seconds'], ['→ or L', 'Forward 10 seconds'], ['↑ ↓', 'Volume'], ['M', 'Mute'], ['F', 'Full screen'], ['?', 'Show or hide this list']].map(([k, v]) => <div key={k}><dt><kbd>{k}</kbd></dt><dd>{v}</dd></div>)}</dl>
        <button type="button" className="button button--quiet" onClick={() => setShowKeys(false)}>Close</button>
      </div>}
      {current.waiting && <div className="video-buffering" role="status" aria-label="Buffering video"><span className="playback-spinner" /><span>Loading video…</span></div>}
      <div className="video-controls" role="group" aria-label="Playback controls">
        <input className="video-timeline" aria-label="Movie timeline" aria-valuetext={`${clock(shownTime)} of ${clock(duration)}`} type="range" min="0" max={duration || 1} step=".1" disabled={!seekEnabled} value={Math.min(shownTime || 0, duration || 1)} style={{ '--played': `${duration ? Math.min(100, shownTime / duration * 100) : 0}%`, '--buffered': `${duration ? Math.min(100, current.buffered / duration * 100) : 0}%` }} onPointerDown={event => { dragRef.current = true; event.currentTarget.setPointerCapture?.(event.pointerId) }} onInput={event => preview(event.currentTarget.value)} onChange={event => preview(event.currentTarget.value)} onPointerUp={event => { dragRef.current = false; seekTo(Number(event.currentTarget.value)) }} onPointerCancel={() => { dragRef.current = false; previewRef.current = null; setDraft(null) }} onKeyUp={event => { if (['ArrowLeft','ArrowRight','ArrowUp','ArrowDown','Home','End','PageUp','PageDown'].includes(event.key)) seekTo(Number(event.currentTarget.value)) }} onBlur={() => { if (previewRef.current !== null && !dragRef.current) seekTo(previewRef.current) }} />
        <div className="video-control-row">
          <button type="button" onClick={togglePlay} aria-label={current.paused ? 'Play video' : 'Pause video'} title={current.paused ? 'Play (Space)' : 'Pause (Space)'}><ControlIcon name={current.paused ? 'play' : 'pause'} /></button>
          <button type="button" className="skip-control" disabled={!seekEnabled} onClick={() => seekTo(current.time - 10)} aria-label="Back 10 seconds">↶<small>10</small></button>
          <button type="button" className="skip-control" disabled={!seekEnabled} onClick={() => seekTo(current.time + 10)} aria-label="Forward 10 seconds">↷<small>10</small></button>
          <output className="video-clock" aria-label="Playback time">{clock(shownTime)}<span> / {duration > 0 ? clock(duration) : '—:—'}</span></output>
          {episodeControls?.next&&<button type="button" className="watch-next" aria-label="Next episode" title="Next episode" onClick={episodeControls.advance}><ControlIcon name="next"/></button>}
          <div className="video-volume"><button type="button" aria-label={current.muted || current.volume === 0 ? 'Unmute video' : 'Mute video'} onClick={() => { volumeRef.current.muted = !videoRef.current.muted; videoRef.current.muted = volumeRef.current.muted }}><ControlIcon name={current.muted || current.volume === 0 ? 'muted' : 'volume'} /></button><input aria-label="Volume" type="range" min="0" max="1" step=".05" value={current.muted ? 0 : current.volume ?? 1} onChange={event => { const value = Number(event.target.value); volumeRef.current = { value, muted: value === 0 }; videoRef.current.volume = value; videoRef.current.muted = value === 0 }} /></div>
          <button type="button" onClick={fullscreen} aria-label="Toggle fullscreen" title="Fullscreen (F)"><ControlIcon name="fullscreen" /></button>
        </div>
      </div>
    </div>
    <div className="watch-menu-buttons" role="group" aria-label="Player menus">
      <button className="watch-menu-trigger" aria-label="Audio and subtitles" title="Audio and subtitles" aria-expanded={menu==='language'} onClick={()=>onMenuChange(menu==='language'?null:'language')}><ControlIcon name="captions"/></button>
      {episodeControls&&<button className="watch-menu-trigger" aria-label="Episodes" title="Episodes" aria-expanded={menu==='episodes'} onClick={()=>onMenuChange(menu==='episodes'?null:'episodes')}><ControlIcon name="episodes"/></button>}
      <button className="watch-menu-trigger watch-settings-trigger" aria-label="Playback settings" title="Playback settings" aria-expanded={menu==='settings'} onClick={()=>onMenuChange(menu==='settings'?null:'settings')}>⋮</button>
    </div>
    {menu&&<><div className="watch-menu-shade" onClick={()=>onMenuChange(null)} aria-hidden="true"/><section className="watch-menu-panel" role="region" aria-label={menu==='language'?'Audio and subtitles':menu==='episodes'?'Episodes':'Playback settings'}><div className="watch-menu-heading"><h2>{menu==='language'?'Audio & subtitles':menu==='episodes'?'Episodes':'Playback settings'}</h2><button aria-label="Close player menu" onClick={()=>onMenuChange(null)}>×</button></div>
    {menu==='settings'&&<div className="watch-menu-fields">
      <label>Speed<select aria-label="Playback speed" value={playbackSpeed} onChange={event => { setPlaybackSpeed(Number(event.target.value)); speed.current = Number(event.target.value); videoRef.current.playbackRate = speed.current }}>{[.5, .75, 1, 1.25, 1.5, 2].map(value => <option key={value} value={value}>{value}×</option>)}</select></label>
      {source.type === 'hls' && levels.length > 1 && <label>Quality<select aria-label="Video quality" value={quality} onChange={event => { setQuality(Number(event.target.value)); if (hlsRef.current) { hlsRef.current.autoLevelCapping=-1; hlsRef.current.currentLevel = Number(event.target.value) } }}><option value={-1}>Auto</option>{levels.map(level => <option key={level.index} value={level.index}>{level.height ? level.height + 'p' : Math.round(level.bitrate / 1000) + ' kbps'}</option>)}</select></label>}
      {settingsContent}
    </div>}
    {menu==='language'&&<div className="watch-menu-fields">
      {languageContent}
      {source.type === 'hls' && audio.length > 1 && <label>Audio<select aria-label="HLS audio track" value={audioIndex} onChange={event => { setAudioIndex(Number(event.target.value)); if (hlsRef.current) hlsRef.current.audioTrack = Number(event.target.value) }}>{audio.map((track, index) => <option key={index} value={index}>{track.name || track.lang || `Audio ${index + 1}`}</option>)}</select></label>}
      {source.subtitles?.length > 0 && <><label>Subtitles<select aria-label="Subtitle language" value={captions} onChange={event => { const value = Number(event.target.value); setCaptions(value); [...videoRef.current.textTracks].forEach((track, index) => { track.mode = index === value ? 'showing' : 'disabled' }) }}><option value={-1}>Off</option>{source.subtitles.map((track, index) => <option key={index} value={index}>{track.title || track.language || `Subtitles ${index + 1}`}</option>)}</select></label><label>Text size<select aria-label="Subtitle size" value={captionSize} onChange={event => setCaptionSize(Number(event.target.value))}>{[16, 20, 24, 28, 32].map(size => <option key={size}>{size}</option>)}</select></label></>}
      {!languageContent&&audio.length<=1&&!source.subtitles?.length&&<p className="watch-help">Using this source’s default audio. No additional audio or subtitle tracks are available.</p>}
    </div>}
    {menu==='episodes'&&episodeControls&&<div className="watch-menu-fields"><label className="watch-autoplay"><input type="checkbox" aria-label="Autoplay next episode" checked={episodeControls.autoplay} onChange={event=>episodeControls.toggle(event.target.checked)}/>Autoplay next episode</label>{episodeControls.next&&<button className="watch-action" onClick={()=>{onMenuChange(null);episodeControls.advance()}}>Next episode →</button>}<div className="watch-episode-list">{episodeControls.list.map(item=><button key={`${item.season}:${item.episode}`} aria-current={item.season===episodeControls.target.season&&item.episode===episodeControls.target.episode?'true':undefined} onClick={()=>{onMenuChange(null);episodeControls.choose(item)}}><strong>{item.plain?`E${item.episode}`:`S${item.season} · E${item.episode}`}</strong><span>{item.title||`Episode ${item.episode}`}</span></button>)}</div></div>}
    </section></>}
    {controlError && <p className="video-control-error" role="status">{controlError}</p>}
  </div>
}
