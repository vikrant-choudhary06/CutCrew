import { Post, ProviderContext } from "../types";

export const getPosts = async function ({
  filter,
  page,
  signal,
  providerContext,
}: {
  filter: string;
  page: number;
  providerValue: string;
  signal: AbortSignal;
  providerContext: ProviderContext;
}): Promise<Post[]> {
  const { getBaseUrl, cheerio } = providerContext;
  const baseUrl = await getBaseUrl("4khdhub");
  const url = `${baseUrl + filter}/page/${page}`;
  return posts({ url, signal, cheerio });
};

export const getSearchPosts = async function ({
  searchQuery,
  page,
  signal,
  providerContext,
}: {
  searchQuery: string;
  page: number;
  providerValue: string;
  signal: AbortSignal;
  providerContext: ProviderContext;
}): Promise<Post[]> {
  const { getBaseUrl, cheerio } = providerContext;
  const baseUrl = await getBaseUrl("4khdhub");
  const url =
    page == 1
      ? `${baseUrl}/?s=${searchQuery}`
      : `${baseUrl}/page/${page}?s=${searchQuery}`;
  return posts({ url, signal, cheerio });
};

async function posts({
  url,
  signal,
  cheerio,
}: {
  url: string;
  signal: AbortSignal;
  cheerio: ProviderContext["cheerio"];
}): Promise<Post[]> {
  try {
    const res = await fetch(url, { signal });
    const data = await res.text();
    const $ = cheerio.load(data);
    const catalog: Post[] = [];
    $(".card-grid")
      .children()
      .map((i, element) => {
        const title = $(element).find(".movie-card-title").text();
        const link = $(element).attr("href");
        const image = $(element).find("img").attr("src");
        if (title && link && image) {
          catalog.push({
            title: title,
            link: link,
            image: image,
          });
        }
      });
    return catalog;
  } catch (err) {
    console.error("4khdhub posts:", (err as any)?.message || err);
    return [];
  }
}
