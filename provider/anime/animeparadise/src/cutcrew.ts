// What CutCrew's backend uses from anime-sdk. Bundled by provider/build-anime.js.
// Uses plain fetch (FetchTransport): the backend image has no curl.
import { HttpClient } from './transport/http.js';
import { FetchTransport } from './transport/transport.js';
import { AnimeParadiseProvider } from './providers/AnimeParadiseProvider.js';
import type { BaseProvider } from './providers/BaseProvider.js';

// Every anime provider CutCrew can use, by id. ANIME_PROVIDERS picks from these.
export const PROVIDERS: Record<string, new (http: HttpClient) => BaseProvider> = {
  animeparadise: AnimeParadiseProvider,
};

export function createProvider(id: string, timeoutMs = 20000): BaseProvider {
  const Provider = PROVIDERS[id];
  if (!Provider) throw new Error(`Unknown anime provider: ${id}`);
  return new Provider(new HttpClient({ timeoutMs, transport: new FetchTransport() }));
}

export { HttpClient, FetchTransport, AnimeParadiseProvider };
