// Preferred audio language (remembered on this device) and the rules for
// naming and choosing audio tracks, the same as the server's
// (backend/src/services/audioTracks.js).
const KEY = 'cutcrew-audio-language'

// Languages offered as a preference, most watched first.
export const AUDIO_LANGUAGES = [
  ['hi', 'Hindi'], ['en', 'English'], ['ta', 'Tamil'], ['te', 'Telugu'], ['ml', 'Malayalam'], ['kn', 'Kannada'], ['bn', 'Bengali'],
  ['mr', 'Marathi'], ['pa', 'Punjabi'], ['ja', 'Japanese'], ['ko', 'Korean'], ['es', 'Spanish'], ['fr', 'French'], ['de', 'German'],
]
const NAMES = Object.fromEntries([...AUDIO_LANGUAGES, ['gu', 'Gujarati'], ['ur', 'Urdu'], ['zh', 'Chinese'], ['it', 'Italian'],
  ['pt', 'Portuguese'], ['ru', 'Russian'], ['ar', 'Arabic'], ['tr', 'Turkish'], ['th', 'Thai'], ['id', 'Indonesian']])
const THREE = { hin: 'hi', eng: 'en', tam: 'ta', tel: 'te', mal: 'ml', kan: 'kn', ben: 'bn', mar: 'mr', pan: 'pa', guj: 'gu', urd: 'ur',
  jpn: 'ja', kor: 'ko', chi: 'zh', zho: 'zh', spa: 'es', fre: 'fr', fra: 'fr', ger: 'de', deu: 'de', ita: 'it', por: 'pt', rus: 'ru',
  ara: 'ar', tur: 'tr', tha: 'th', ind: 'id' }
const WORDS = [['hi', /\bhindi\b|हिन्दी|हिंदी/i], ['en', /\benglish\b/i], ['ta', /\btamil\b|தமிழ்/i], ['te', /\btelugu\b|తెలుగు/i],
  ['ml', /\bmalayalam\b|മലയാളം/i], ['kn', /\bkannada\b|ಕನ್ನಡ/i], ['bn', /\bbengali\b|\bbangla\b|বাংলা/i], ['mr', /\bmarathi\b|मराठी/i],
  ['pa', /\bpunjabi\b/i], ['ja', /\bjapanese\b|日本語/i], ['ko', /\bkorean\b|한국어/i], ['es', /\bspanish\b|espa[ñn]ol|\blatino\b/i],
  ['fr', /\bfrench\b|fran[çc]ais/i], ['de', /\bgerman\b|deutsch/i]]

export function detectLanguage(tag, title) {
  const code = String(tag || '').trim().toLowerCase().split(/[-_]/)[0]
  if (NAMES[code]) return code
  if (THREE[code]) return THREE[code]
  for (const [lang, pattern] of WORDS) if (pattern.test(String(title || ''))) return lang
  return ''
}
export const languageName = code => NAMES[code] || (code ? code.toUpperCase() : '')

export function preferredAudio() {
  try { const value = localStorage.getItem(KEY); return NAMES[value] ? value : 'hi' } catch { return 'hi' }
}
export function setPreferredAudio(code) {
  if (!NAMES[code]) return
  try { localStorage.setItem(KEY, code) } catch { /* Private windows may block storage; the choice still applies now. */ }
}

// tracks: [{ index, language }] (language as a two-letter code). The preferred
// language, then English, then the default track, then the first.
export function chooseTrack(tracks, preferred) {
  if (!tracks?.length) return null
  const find = code => tracks.find(t => t.language === code && !/commentary/i.test(t.title || ''))
  const hit = find(preferred)
  if (hit) return { index: hit.index, language: hit.language, matched: true }
  const pick = find('en') || tracks.find(t => t.default) || tracks[0]
  return { index: pick.index, language: pick.language, matched: false }
}

// "Hindi audio isn't available for this title. Playing English." or ''.
export function missingNotice(preferred, playing) {
  if (!preferred || playing === preferred) return ''
  return `${languageName(preferred)} audio isn't available for this title.${playing ? ` Playing ${languageName(playing)}.` : ''}`
}
