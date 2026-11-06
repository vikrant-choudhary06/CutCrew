import { test } from 'node:test'
import assert from 'node:assert/strict'
import { chooseTrack, detectLanguage, missingNotice, preferredAudio, setPreferredAudio } from '../src/lib/audioPrefs.js'

test('the player names tracks by tag or title, as the server does', () => {
  assert.equal(detectLanguage('hin', ''), 'hi')
  assert.equal(detectLanguage('und', 'हिन्दी 5.1'), 'hi')
  assert.equal(detectLanguage('', 'Tamil'), 'ta')
  assert.equal(detectLanguage('kor', ''), 'ko')
  assert.equal(detectLanguage('', 'Track 2'), '')
})

test('the preferred language plays first, then English, then the default track', () => {
  const tracks = [{ index: 0, language: 'kn', default: true }, { index: 1, language: 'hi' }, { index: 2, language: 'en' }]
  assert.deepEqual(chooseTrack(tracks, 'hi'), { index: 1, language: 'hi', matched: true })
  assert.deepEqual(chooseTrack(tracks, 'ja'), { index: 2, language: 'en', matched: false })
  assert.deepEqual(chooseTrack([{ index: 0, language: 'ko' }, { index: 1, language: 'es', default: true }], 'hi'), { index: 1, language: 'es', matched: false })
  assert.equal(missingNotice('hi', 'en'), "Hindi audio isn't available for this title. Playing English.")
  assert.equal(missingNotice('hi', 'hi'), '')
})

test('the preference defaults to Hindi and only accepts known languages', () => {
  const store = new Map()
  globalThis.localStorage = { getItem: key => store.get(key) ?? null, setItem: (key, value) => store.set(key, value) }
  assert.equal(preferredAudio(), 'hi')
  setPreferredAudio('en')
  assert.equal(preferredAudio(), 'en')
  setPreferredAudio('<x>')
  assert.equal(preferredAudio(), 'en')
  delete globalThis.localStorage
  assert.equal(preferredAudio(), 'hi', 'no storage (private window): Hindi')
})
