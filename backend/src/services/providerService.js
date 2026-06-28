const path = require('path');
const { getProviderContext, getAvailableProvidersLocal } = require('../utils/providerHelper');

/**
 * Calculates string similarity using a basic matching logic.
 * Checks if one string is contained within the other after normalizing.
 */
function isSimilar(str1, str2) {
  if (!str1 || !str2) return false;
  const s1 = str1.toLowerCase().replace(/[^a-z0-9]/g, '');
  const s2 = str2.toLowerCase().replace(/[^a-z0-9]/g, '');
  
  if (s1 === s2) return true;
  if (s1.includes(s2) && s2.length > 3) return true;
  if (s2.includes(s1) && s1.length > 3) return true;
  return false;
}

/**
 * Fetches intermediate streaming links by executing local provider modules
 * and attaches them to the movieData object before saving to MongoDB.
 * Implements Double Verification logic using IMDb ID and fallback string similarity.
 * @param {Object} movieData - The movie data mapped from scraper
 * @returns {Object} The updated movie data
 */
async function fetchAndAttachProviderLinks(movieData) {
  try {
    const movieName = movieData.title || movieData.original_title;
    if (!movieName) return movieData;

    const targetImdbId = movieData.imdb_id;
    let targetYear = '';
    if (movieData.release_date && typeof movieData.release_date === 'string') {
      targetYear = movieData.release_date.substring(0, 4);
    } else if (movieData.year) {
      targetYear = String(movieData.year);
    }

    // Dynamic Content Type Logic
    let isSeries = false;
    const titleType = (movieData.title_type || '').toLowerCase();
    if (titleType.includes('tv') || titleType.includes('series') || titleType.includes('episode')) {
      isSeries = true;
    }
    const contentType = isSeries ? 'tv' : 'movie';

    console.log(`[ProviderService] Fetching links for: ${movieName} (${targetImdbId}) - Content Type: ${contentType}`);
    
    // Dynamically fetch ALL available providers from local dist directory
    const PROVIDERS = getAvailableProvidersLocal();
    console.log(`[ProviderService] Will attempt ${PROVIDERS.length} providers: ${PROVIDERS.join(', ')}`);

    const distDir = path.join(__dirname, '../../../provider/dist');
    const providerContext = getProviderContext();

    // Multi-Provider Fallback Logic
    for (const provider of PROVIDERS) {
      try {
        console.log(`[ProviderService] Trying provider: ${provider}`);
        
        // Load posts.js module
        const postsModulePath = path.join(distDir, provider, 'posts.js');
        const postsModule = require(postsModulePath);
        
        if (!postsModule.getSearchPosts) {
          console.log(`[ProviderService] [${provider}] getSearchPosts not supported.`);
          continue;
        }

        const signal = new AbortController().signal;
        
        // Call 1: Search provider for the movie directly
        const searchResults = await postsModule.getSearchPosts({
          searchQuery: movieName,
          page: 1,
          providerValue: provider,
          signal,
          providerContext
        });
        
        // Check if we have valid results
        if (searchResults && Array.isArray(searchResults) && searchResults.length > 0) {
          // Take first 5 results to process in parallel
          const topResults = searchResults.slice(0, 5);
          
          const metaModulePath = path.join(distDir, provider, 'meta.js');
          const metaModule = require(metaModulePath);
          
          if (!metaModule.getMeta) {
             console.log(`[ProviderService] [${provider}] getMeta not supported.`);
             continue;
          }

          // Call 2: Execute metadata fetch IN PARALLEL
          const metaPromises = topResults.map(async (result) => {
            if (!result.link) return null;
            try {
              const metaData = await metaModule.getMeta({ link: result.link, providerContext });
              return {
                searchResult: result,
                metaData: metaData
              };
            } catch (err) {
              // Suppress individual errors so Promise.all can proceed
              return null;
            }
          });

          // Wait for all parallel requests to complete
          const metaResponses = await Promise.all(metaPromises);
          
          let matchedMeta = null;

          // First Pass: Strict IMDb ID match
          if (targetImdbId) {
            matchedMeta = metaResponses.find(res => {
               return res && res.metaData && res.metaData.imdbId === targetImdbId;
            });
            if (matchedMeta) {
              console.log(`[ProviderService] [${provider}] Double Verification Passed: Exact IMDb ID match (${targetImdbId})`);
            }
          }

          // Second Pass: Fallback Logic (Title + Year similarity)
          if (!matchedMeta) {
            matchedMeta = metaResponses.find(res => {
               if (!res) return false;
               
               const providerTitle = (res.metaData && res.metaData.title) || res.searchResult.title || res.searchResult.name || '';
               const providerYear = (res.metaData && res.metaData.year) || res.searchResult.year || '';
               
               const titleMatch = isSimilar(movieName, providerTitle);
               
               let yearMatch = true;
               if (targetYear && providerYear) {
                 const tYear = parseInt(targetYear, 10);
                 const pYear = parseInt(providerYear, 10);
                 if (!isNaN(tYear) && !isNaN(pYear)) {
                   yearMatch = Math.abs(tYear - pYear) <= 1; // Allow ±1 year difference
                 }
               }

               if (titleMatch && yearMatch) {
                   console.log(`[ProviderService] [${provider}] Fallback match found: Title "${providerTitle}" & Year "${providerYear}"`);
                   return true;
               }
               return false;
            });
          }
          
          if (matchedMeta && matchedMeta.metaData && Array.isArray(matchedMeta.metaData.linkList)) {
            const links = matchedMeta.metaData.linkList;
            
            if (isSeries) {
              // TV Series Flow
              const episodesLinkItem = links.find(item => item.episodesLink);
              if (episodesLinkItem) {
                console.log(`[ProviderService] [${provider}] Found episodesLink. Executing episodes...`);
                try {
                  const episodesModulePath = path.join(distDir, provider, 'episodes.js');
                  const episodesModule = require(episodesModulePath);
                  
                  if (!episodesModule.getEpisodes) {
                     console.log(`[ProviderService] [${provider}] getEpisodes not supported.`);
                     continue;
                  }

                  const rawEpisodes = await episodesModule.getEpisodes({ 
                    url: episodesLinkItem.episodesLink, 
                    providerContext 
                  });
                  
                  if (rawEpisodes && Array.isArray(rawEpisodes)) {
                    const seasonsMap = {};
                    
                    rawEpisodes.forEach((ep, idx) => {
                      let sNum = 1;
                      let eNum = idx + 1;
                      
                      const match = ep.title.match(/S(\d+)[\sE]*(\d+)/i) || ep.title.match(/Season\s*(\d+)[\s-]*Episode\s*(\d+)/i) || ep.title.match(/S(\d+)/i);
                      if (match) {
                        sNum = parseInt(match[1], 10);
                        if (match[2]) {
                          eNum = parseInt(match[2], 10);
                        }
                      }
                      
                      if (!seasonsMap[sNum]) {
                        seasonsMap[sNum] = { season_number: sNum, episodes: [] };
                      }
                      
                      let epLink = "";
                      if (typeof ep.link === 'string') {
                          epLink = ep.link;
                      } else if (ep.url) {
                          epLink = ep.url;
                      } else {
                          epLink = JSON.stringify(ep.link); // Fallback
                      }

                      seasonsMap[sNum].episodes.push({
                        episode_number: eNum,
                        title: ep.title || `Episode ${eNum}`,
                        link: epLink
                      });
                    });
                    
                    movieData.seasons = Object.values(seasonsMap);
                    movieData.provider_name = provider;
                    console.log(`[ProviderService] [${provider}] Extracted ${rawEpisodes.length} episodes across ${movieData.seasons.length} seasons.`);
                    break; // Loop Break: We found a matching series, stop checking other providers
                  }
                } catch (e) {
                   console.error(`[ProviderService] [${provider}] Error fetching episodes:`, e.message);
                }
              } else {
                 console.log(`[ProviderService] [${provider}] Series matched but no episodesLink found.`);
              }
            } else {
              // Movie Flow
              // Auto-Select Logic: Prefer 720p, then 1080p, then fallback to first
              let bestItem = links.find(item => {
                const q = (item.quality || item.name || '').toLowerCase();
                return q.includes('720p');
              });

              if (!bestItem) {
                bestItem = links.find(item => {
                  const q = (item.quality || item.name || '').toLowerCase();
                  return q.includes('1080p');
                });
              }

              if (!bestItem && links.length > 0) {
                bestItem = links[0];
              }

              if (bestItem) {
                let extractedLink = "";
                if (bestItem.directLinks && bestItem.directLinks.length > 0) {
                  const dl = bestItem.directLinks[0];
                  extractedLink = typeof dl === 'string' ? dl : (dl.link || dl.url || "");
                } else {
                  extractedLink = bestItem.link || bestItem.url || bestItem;
                }
                
                movieData.defaultStreamLink = typeof extractedLink === 'string' ? extractedLink : "";
                movieData.provider_name = provider; // Save the successful provider
                console.log(`[ProviderService] [${provider}] Auto-selected quality: ${bestItem.quality || 'unknown'}. Link attached: ${movieData.defaultStreamLink}`);
                break; // Loop Break: We found a matching link, stop checking other providers
              } else {
                 console.log(`[ProviderService] [${provider}] No valid quality found in linkList.`);
              }
            }
          } else {
            console.log(`[ProviderService] [${provider}] No match found after Double Verification.`);
          }
        } else {
          console.log(`[ProviderService] [${provider}] No search results found.`);
        }
      } catch (err) {
        console.error(`[ProviderService Error] Provider ${provider} failed:`, err.message);
        // Do not crash, let the loop move to the next provider
      }
    }

  } catch (error) {
    // If something fundamentally fails, catch here
    console.error(`[ProviderService Error] Fatal error fetching provider links for ${movieData.title || 'Unknown'}:`, error.message);
  }
  
  // Always return movieData, even if link fetching failed completely
  return movieData;
}

module.exports = { fetchAndAttachProviderLinks };
