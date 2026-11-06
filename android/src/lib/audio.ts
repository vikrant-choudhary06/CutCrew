// Preferred audio language (saved on the phone) and the rules for naming and
// choosing audio tracks, the same as the server's (backend audioTracks.js).
import AsyncStorage from '@react-native-async-storage/async-storage';

const KEY = 'cutcrew-audio-language';

export const AUDIO_LANGUAGES: [string, string][] = [
  ['hi', 'Hindi'], ['en', 'English'], ['ta', 'Tamil'], ['te', 'Telugu'], ['ml', 'Malayalam'], ['kn', 'Kannada'], ['bn', 'Bengali'],
  ['mr', 'Marathi'], ['pa', 'Punjabi'], ['ja', 'Japanese'], ['ko', 'Korean'], ['es', 'Spanish'], ['fr', 'French'], ['de', 'German'],
];
const NAMES: Record<string, string> = Object.fromEntries([...AUDIO_LANGUAGES, ['gu', 'Gujarati'], ['ur', 'Urdu'], ['zh', 'Chinese'],
  ['it', 'Italian'], ['pt', 'Portuguese'], ['ru', 'Russian'], ['ar', 'Arabic'], ['tr', 'Turkish'], ['th', 'Thai'], ['id', 'Indonesian']]);
const THREE: Record<string, string> = { hin: 'hi', eng: 'en', tam: 'ta', tel: 'te', mal: 'ml', kan: 'kn', ben: 'bn', mar: 'mr', pan: 'pa',
  guj: 'gu', urd: 'ur', jpn: 'ja', kor: 'ko', chi: 'zh', zho: 'zh', spa: 'es', fre: 'fr', fra: 'fr', ger: 'de', deu: 'de', ita: 'it',
  por: 'pt', rus: 'ru', ara: 'ar', tur: 'tr', tha: 'th', ind: 'id' };
const WORDS: [string, RegExp][] = [['hi', /\bhindi\b|हिन्दी|हिंदी/i], ['en', /\benglish\b/i], ['ta', /\btamil\b|தமிழ்/i],
  ['te', /\btelugu\b|తెలుగు/i], ['ml', /\bmalayalam\b|മലയാളം/i], ['kn', /\bkannada\b|ಕನ್ನಡ/i], ['bn', /\bbengali\b|\bbangla\b|বাংলা/i],
  ['mr', /\bmarathi\b|मराठी/i], ['pa', /\bpunjabi\b/i], ['ja', /\bjapanese\b|日本語/i], ['ko', /\bkorean\b|한국어/i],
  ['es', /\bspanish\b|espa[ñn]ol|\blatino\b/i], ['fr', /\bfrench\b|fran[çc]ais/i], ['de', /\bgerman\b|deutsch/i]];

export type ServerTrack = { index: number; language: string; label: string; channels?: number; title?: string; default?: boolean };
export type Track = { index: number; language: string; title: string; default: boolean };

export function detectLanguage(tag?: string | null, title?: string | null) {
  const code = String(tag || '').trim().toLowerCase().split(/[-_]/)[0];
  if (NAMES[code]) return code;
  if (THREE[code]) return THREE[code];
  for (const [lang, pattern] of WORDS) if (pattern.test(String(title || ''))) return lang;
  return '';
}
export const languageName = (code: string) => NAMES[code] || (code ? code.toUpperCase() : '');

// The preferred language, then English, then the default track, then the first.
export function chooseTrack(tracks: Track[], preferred: string) {
  if (!tracks.length) return null;
  const find = (code: string) => tracks.find(t => t.language === code && !/commentary/i.test(t.title));
  const hit = find(preferred);
  if (hit) return { index: hit.index, language: hit.language, matched: true };
  const pick = find('en') || tracks.find(t => t.default) || tracks[0];
  return { index: pick.index, language: pick.language, matched: false };
}

// "Hindi audio isn't available for this title. Playing English." or ''.
export function missingNotice(preferred: string, playing?: string) {
  if (!preferred || playing === preferred) return '';
  return `${languageName(preferred)} audio isn't available for this title.${playing ? ` Playing ${languageName(playing)}.` : ''}`;
}

// Kept in memory once read, so the player knows it at once.
let preferred = 'hi';
let loaded: Promise<string> | null = null;
export function loadPreferredAudio() {
  loaded ??= AsyncStorage.getItem(KEY).then(value => { if (value && NAMES[value]) preferred = value; return preferred; }).catch(() => preferred);
  return loaded;
}
export const preferredAudio = () => preferred;
export function setPreferredAudio(code: string) {
  if (!NAMES[code]) return;
  preferred = code;
  AsyncStorage.setItem(KEY, code).catch(() => {});
}
