import { useCallback, useEffect, useMemo, useRef, useState } from 'react'

import { createPortal } from 'react-dom'
import VideoPlayer from './VideoPlayer'

import { useLibrary, titleSummary } from './LibraryContext'
import { AUDIO_LANGUAGES, chooseTrack, detectLanguage, missingNotice, preferredAudio, setPreferredAudio } from '../lib/audioPrefs'

const base=(import.meta.env.VITE_BACKEND_URL||'').replace(/\/$/,'')

const mediaUrl=value=>value?.startsWith('/')?base+value:value

const STORAGE='cutcrew-storage'

// Tracks as /api/media/info lists them, with a two-letter language code and a name.
const fileTracks=list=>(list||[]).map(t=>({index:t.index,language:t.code||detectLanguage(t.language,t.title),label:t.title||`Audio ${t.index+1}`,title:t.title||'',default:!!t.default}))


export default function PlaybackPanel({film,onEnded,onBack,episodeControls}){

 const screenRef=useRef(null),idleRef=useRef(null),activeRef=useRef(false),menuRef=useRef(null)
 const [controlsVisible,setControlsVisible]=useState(true),[menu,setMenu]=useState(null)
 const activity=useCallback(()=>{setControlsVisible(true);clearTimeout(idleRef.current);if(activeRef.current&&!menuRef.current)idleRef.current=setTimeout(()=>{if(!screenRef.current?.querySelector(':focus-visible'))setControlsVisible(false)},3000)},[])
 const playbackState=useCallback(active=>{activeRef.current=active;if(active)activity();else{clearTimeout(idleRef.current);setControlsVisible(true)}},[activity])
 function changeMenu(value){const previous=menuRef.current;menuRef.current=value;setMenu(value);activity();if(!value&&previous){const label=previous==='settings'?'Playback settings':previous==='language'?'Audio and subtitles':'Episodes';screenRef.current?.querySelector(`[aria-label="${label}"]`)?.focus()}}
 async function goBack(){try{if(document.fullscreenElement)await document.exitFullscreen()}catch{/* Close the view even if fullscreen has already ended. */}onBack?.()}
 useEffect(()=>{const previous=document.activeElement;const siblings=[...document.body.children].filter(node=>node!==screenRef.current&&!['SCRIPT','STYLE'].includes(node.tagName)).map(node=>({node,inert:node.inert}));siblings.forEach(({node})=>{node.inert=true});document.body.classList.add('watching');screenRef.current?.querySelector('button')?.focus();return()=>{clearTimeout(idleRef.current);siblings.forEach(({node,inert})=>{node.inert=inert});document.body.classList.remove('watching');previous?.focus()}},[])
 function keys(event){activity();if(event.key==='Escape'&&!document.fullscreenElement){event.stopPropagation();if(menu)changeMenu(null);else goBack()}if(event.key==='Tab'){event.stopPropagation();const nodes=[...screenRef.current.querySelectorAll('button,input,select,video,a')].filter(node=>!node.disabled&&node.getClientRects().length);if(event.shiftKey&&document.activeElement===nodes[0]){event.preventDefault();nodes.at(-1)?.focus()}else if(!event.shiftKey&&document.activeElement===nodes.at(-1)){event.preventDefault();nodes[0]?.focus()}}}
 const lib=useLibrary(); const [saved]=useState(()=>lib.library.progress.find(p=>p.imdb_id===film.id&&(p.season||0)===(film.season||0)&&(p.episode||0)===(film.episode||0)&&!p.completed))

 const [streams,setStreams]=useState([]),[index,setIndex]=useState(0),[provider,setProvider]=useState(''),[busy,setBusy]=useState(true),[error,setError]=useState(''),[request,setRequest]=useState({refresh:false,excluded:[],serial:0})

 const [offset,setOffset]=useState(saved?.position||0),[audio,setAudio]=useState(0),[info,setInfo]=useState(null),[inspecting,setInspecting]=useState(true),[notice,setNotice]=useState('')

 const refreshed=useRef(false),lastPosition=useRef(saved?.position||0),positionRef=useRef(null)
 const [conversionQuality,setConversionQuality]=useState(0)
 const anime=film.kind==='anime'
 const [pref,setPref]=useState(()=>preferredAudio()),[hiddenNote,setHiddenNote]=useState('')
 function prefer(code){if(!code)return;setPreferredAudio(code);setPref(code)}
 function position(){return positionRef.current?.()??lastPosition.current}

 useEffect(()=>{const controller=new AbortController(),params=new URLSearchParams();if(film.season&&film.episode){params.set('season',film.season);params.set('episode',film.episode)}if(request.refresh)params.set('refresh','1');if(request.excluded.length)params.set('exclude',request.excluded.join(','));if(film.kind!=='anime')params.set('lang',preferredAudio());(async()=>{try{const response=await fetch(film.kind==='anime'?`${base}/api/anime/${film.anilist_id}/play?${params}`:`${base}/api/movies/play/${film.id}?${params}`,{signal:AbortSignal.any([controller.signal,AbortSignal.timeout(100000)])});const body=await response.json();if(!response.ok)throw new Error(body.message||body.error||'No playable sources are available. Please retry.');const sources=(body.streams||[]).filter(s=>s.link).map(s=>({...s,link:mediaUrl(s.link),subtitles:(s.subtitles||[]).map(track=>({...track,uri:mediaUrl(track.uri)}))}));if(!sources.length)throw new Error('No playable sources were returned.');if(!controller.signal.aborted){setInspecting(true);setStreams(sources);setIndex(0);setAudio(sources[0].audioIndex??0);setProvider(body.provider||'')}}catch(e){if(!controller.signal.aborted)setError(e.name==='TimeoutError'?'Finding a source took too long. Please retry.':e.message)}finally{if(!controller.signal.aborted)setBusy(false)}})();return()=>controller.abort()},[film.id,film.kind,film.anilist_id,film.season,film.episode,request])

 useEffect(()=>{const current=streams[index];if(!current)return;if(!current.remuxed)return;const controller=new AbortController();const url=new URL(current.link,window.location.origin);url.pathname=url.pathname.replace(/\/media$/,'/media/info');fetch(url,{signal:AbortSignal.any([controller.signal,AbortSignal.timeout(17000)])}).then(async response=>{if(!response.ok)throw new Error('Media inspection failed');const data=await response.json();if(controller.signal.aborted)return;setInfo(data);if(film.kind!=='anime'&&current.audioIndex===undefined&&data.audio?.length>1){const pick=chooseTrack(fileTracks(data.audio),preferredAudio());if(pick)setAudio(pick.index)}if(data.duration>0&&offset>Math.max(0,data.duration-1)){setOffset(Math.max(0,data.duration-1));return}if(!data.seekable){if(index+1<streams.length){setNotice('Checking another source to resume your film...');setInspecting(true);setIndex(index+1);return}setNotice(offset>0?'These sources cannot seek. You can start from the beginning or try another provider.':'This source supports playback from the beginning. Full-film seeking and audio changes need another source.')}else setNotice('');setInspecting(false)}).catch(()=>{if(!controller.signal.aborted){setNotice('Source information is unavailable. Seeking and audio changes may be limited.');setInspecting(false)}});return()=>controller.abort()},[streams,index,offset,film.kind])



 const source=useMemo(()=>{const value=streams[index];if(!value)return null;if(!value.remuxed)return value;const url=new URL(value.link,window.location.origin);url.searchParams.set('start',String(offset));url.searchParams.set('audio',String(audio));url.searchParams.set('height',String(conversionQuality));return{...value,link:url.href,startOffset:offset}},[streams,index,offset,audio,conversionQuality])

 const saveProgress=lib.saveProgress

 const progress=useCallback(entry=>{lastPosition.current=entry.position;saveProgress({...entry,duration:info?.duration||entry.duration,data:titleSummary({ ...film,imdb_id:film.id }),season:film.season||0,episode:film.episode||0})},[saveProgress,film,info])

 function reload({another=false,reset=false}={}){const excluded=reset?[]:another&&provider?[...new Set([...request.excluded,provider])]:request.excluded;if(reset||another)refreshed.current=false;setOffset(position());setInfo(null);setAudio(0);setBusy(true);setError('');setStreams([]);setRequest(current=>({refresh:true,excluded,serial:current.serial+1}))}

 function chooseSource(value){setOffset(position());setInfo(null);setAudio(streams[value]?.audioIndex??0);setError('');setInspecting(true);setIndex(value)}

 // Stored (Telegram) copies failed: ask for provider sources, keeping the current position. No forced refresh, so cached provider links still help.
 function skipStorage(){setOffset(position());setInfo(null);setAudio(0);setBusy(true);setError('');setStreams([]);setNotice('');setRequest(current=>({refresh:false,excluded:[...new Set([...current.excluded,STORAGE])],serial:current.serial+1}))}

 function failed(details={}){if(source?.remuxed&&info?.seekable&&details.reason==='rebuffer'&&(conversionQuality===0||conversionQuality>480)){setOffset(position());setConversionQuality(480);setNotice('Switched to a lighter stream to improve playback.');return}if(index+1<streams.length){chooseSource(index+1);return}if(provider===STORAGE){skipStorage();return}if(!refreshed.current){refreshed.current=true;reload();return}if(provider&&request.excluded.length<2){reload({another:true});return}setError('These sources could not play. Retry or try another provider.')}

 const metrics=useCallback(sample=>{if(!source)return;try{const url=new URL(source.link,window.location.origin),token=url.searchParams.get('token'),storedTicket=source.stored?url.pathname.split('/').pop():undefined;if(!token&&!storedTicket)return;fetch(base+'/api/playback/metrics',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({...sample,titleId:film.id,season:film.season,episode:film.episode,token,storedTicket}),keepalive:true}).catch(()=>{})}catch{/* Diagnostics must not interrupt playback. */}},[source,film.id,film.season,film.episode])
 const settings=<>{source?.remuxed&&<label>Quality<select aria-label="Converted video quality" disabled={info?.seekable===false} value={conversionQuality} onChange={event=>{setOffset(position());setConversionQuality(Number(event.target.value))}}><option value={0}>Auto</option><option value={720}>720p</option><option value={480}>480p · lighter</option><option value={360}>360p · data saver</option></select></label>}<p className="watch-provider">Provider: <strong>{provider===STORAGE?'CutCrew storage':provider||'Automatic'}</strong></p><label>Source<select aria-label="Video source" value={index} onChange={event=>chooseSource(Number(event.target.value))}>{streams.map((item,i)=><option key={i} value={i}>{item.server||`Source ${i+1}`}{item.quality?` · ${item.quality}`:''}{item.language?` · ${item.language}`:''}</option>)}</select></label><button className="watch-action" onClick={()=>{changeMenu(null);reload({another:true})}}>Try another provider</button>{notice&&<p className="watch-help">{notice}</p>}<p className="watch-help">Progress saved {lib.auth?'to this profile':'on this device'}.</p></>
 const tracks=source?.remuxed?fileTracks(info?.audio):source?.audioTracks||[]
 const canSwitch=source?.remuxed&&info?.seekable&&tracks.length>1
 const playing=source?.remuxed?tracks.find(t=>t.index===audio)?.language:source?.audioLanguage
 // Preference missing from what this source carries: say what plays instead.
 const missing=!anime&&tracks.length>0&&!tracks.some(t=>t.language===pref)?missingNotice(pref,playing):''
 // Shown for 9 seconds per source and message.
 const noteKey=missing?(source?.link||'')+'|'+missing:''
 useEffect(()=>{if(!noteKey)return;const timer=setTimeout(()=>setHiddenNote(noteKey),9000);return()=>clearTimeout(timer)},[noteKey])
 const audioNote=noteKey&&hiddenNote!==noteKey?missing:''
 function switchTrack(value){const track=tracks.find(t=>t.index===value);setOffset(position());setAudio(value);prefer(track?.language)}
 function changePreference(code){prefer(code);const track=canSwitch&&tracks.find(t=>t.language===code);if(track&&track.index!==audio){setOffset(position());setAudio(track.index)}}
 const languages=anime?null:<>{canSwitch&&<label>Audio<select aria-label="Audio track" value={audio} onChange={event=>switchTrack(Number(event.target.value))}>{tracks.map(track=><option key={track.index} value={track.index}>{track.label}</option>)}</select></label>}
   {!canSwitch&&tracks.length===1&&<p className="watch-help">Audio: {tracks[0].label}</p>}
   <label>Preferred audio<select aria-label="Preferred audio language" value={pref} onChange={event=>changePreference(event.target.value)}>{AUDIO_LANGUAGES.map(([code,name])=><option key={code} value={code}>{name}</option>)}</select></label>
   {missing&&<p className="watch-help">{missing}</p>}</>
 return createPortal(<section ref={screenRef} className={`watch-screen ${controlsVisible||menu||busy||error?'controls-visible':'controls-hidden'}`} role="dialog" aria-modal="true" aria-labelledby="watch-title" onPointerMove={activity} onPointerDown={activity} onKeyDown={keys}>
   <header className="watch-header"><button className="watch-back" type="button" aria-label="Back to browsing" onClick={goBack}>←</button><div><h1 id="watch-title">{film.title}</h1>{film.season&&film.episode&&<p>{film.kind==='anime'?`Episode ${film.episode}`:`Season ${film.season} · Episode ${film.episode}`}</p>}</div></header>
   {busy&&<div className="watch-state" role="status"><span className="playback-spinner"/><h2>Getting it ready</h2><p>Checking for a playable source…</p></div>}
   {!busy&&error&&<div className="watch-state" role="alert"><h2>Playback unavailable</h2><p>{error}</p><button className="watch-action" onClick={()=>reload({reset:true})}>Retry playback</button><button className="watch-action" onClick={()=>reload({another:true})}>Try another provider</button></div>}
   {!busy&&!error&&inspecting&&source?.remuxed&&<div className="watch-state" role="status"><span className="playback-spinner"/><p>Preparing your video…</p></div>}
   {!busy&&!error&&(!inspecting||!source?.remuxed)&&source&&!(offset>0&&info?.seekable===false)&&<VideoPlayer source={source} onFailure={failed} initialTime={offset} onProgress={progress} onMetrics={metrics} positionRef={positionRef} onEnded={onEnded} fullDuration={info?.duration} canSeek={info?.seekable===true} onSeek={target=>{lastPosition.current=target;setOffset(target)}} controlsVisible={controlsVisible} fullscreenTargetRef={screenRef} onPlaybackState={playbackState} menu={menu} onMenuChange={changeMenu} settingsContent={settings} languageContent={languages} episodeControls={episodeControls} preferredAudio={anime?null:pref} onAudioPick={prefer}/>}
   {audioNote&&!busy&&!error&&<p className="watch-audio-note" role="status">{audioNote}</p>}
   {!busy&&!error&&offset>0&&info?.seekable===false&&<div className="watch-state"><p>{notice}</p><button className="watch-action" onClick={()=>{setOffset(0);lastPosition.current=0;setNotice('')}}>Start from beginning</button><button className="watch-action" onClick={()=>reload({another:true})}>Try another provider</button></div>}
 </section>,document.body)
}
