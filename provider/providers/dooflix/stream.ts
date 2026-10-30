import { Stream } from "../types";

export const getStream = async function ({
  link,
}: {
  link: string;
}): Promise<Stream[]> {
  try {
    const streams: Stream[] = [];
    const headers = {
      Connection: "Keep-Alive",
      "User-Agent":
        "Mozilla/5.0 (WindowsNT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/132.0.0.0 Safari/537.37",
      Referer: "https://molop.art/",
    };
    const response = await fetch(link, {
      redirect: "manual",
      headers: headers,
    });

    if (response.status >= 300 && response.status < 400) {
      const redirectLink = response.headers.get("Location");
      if (redirectLink) {
        link = redirectLink;
      }
    }
    if (response.url) {
      link = response.url;
    }

    streams.push({
      server: "Dooflix",
      link: link,
      headers: headers,
      type: "m3u8",
    });
    console.log("doo streams", streams);
    return streams;
  } catch (err) {
    console.error(err);
    return [];
  }
};
