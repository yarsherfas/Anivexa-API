import { json, episodeMeta } from "../core/new-provider-utils.js";
import { getMedia } from "../core/anilist.js";
import {
  get as cacheGet,
  set as cacheSet,
  isFresh,
  SHOW_IDENTITY_TTL
} from "../core/smartcache.js";

const BASE = "https://anime-dunya.com";

const USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) " +
  "AppleWebKit/537.36 (KHTML, like Gecko) " +
  "Chrome/124.0.0.0 Safari/537.36";

/**
 * Resolve AniList ID -> MAL ID
 */
async function resolveMalId(anilistId) {
  const cacheKey = `np:animedunya:${anilistId}`;

  const cached = cacheGet(cacheKey);

  if (isFresh(cached)) {
    return cached.data;
  }

  const media = await getMedia(anilistId);

  if (!media?.idMal) {
    throw new Error("AnimeDunya: no MAL ID found");
  }

  cacheSet(cacheKey, media.idMal, SHOW_IDENTITY_TTL);

  return media.idMal;
}

/**
 * Fetch AnimeDunya HTML.
 *
 * IMPORTANT:
 * Do NOT use curl / child_process here.
 * Node.js fetch works on Railway, Render, VPS, etc.
 */
async function fetchHtml(url) {
  const response = await fetch(url, {
    method: "GET",
    redirect: "follow",
    headers: {
      "User-Agent": USER_AGENT,

      "Accept":
        "text/html,application/xhtml+xml,application/xml;q=0.9," +
        "image/avif,image/webp,image/apng,*/*;q=0.8",

      "Accept-Language": "en-US,en;q=0.9",

      "Referer": `${BASE}/`,

      "Cache-Control": "no-cache"
    }
  });

  if (!response.ok) {
    throw new Error(
      `AnimeDunya: HTTP ${response.status} ${response.statusText}`
    );
  }

  return await response.text();
}

/**
 * Extract episodes array from AnimeDunya HTML.
 */
function extractEpisodesList(html) {
  const match = html.match(/\\?"episodes\\?":\s*\[/);

  if (!match) {
    return [];
  }

  const idx = match.index;
  const matchLen = match[0].length;

  let bracketCount = 1;
  let result = "[";

  for (let i = idx + matchLen; i < html.length; i++) {
    const char = html[i];

    if (char === "[") {
      bracketCount++;
    } else if (char === "]") {
      bracketCount--;
    }

    result += char;

    if (bracketCount === 0) {
      break;
    }
  }

  try {
    const cleanStr = result
      .replace(/\\u0026/g, "&")
      .replace(/\\"/g, '"')
      .replace(/\\\\/g, "\\");

    return JSON.parse(cleanStr);
  } catch {
    return [];
  }
}

/**
 * Extract stream object from AnimeDunya HTML.
 */
function extractStream(html) {
  const match = html.match(/\\?"stream\\?":\s*/);

  if (!match) {
    return null;
  }

  const idx = match.index;
  const matchLen = match[0].length;

  let braceCount = 0;
  let started = false;
  let result = "";

  for (let i = idx + matchLen; i < html.length; i++) {
    const char = html[i];

    if (char === "{") {
      braceCount++;
      started = true;
    } else if (char === "}") {
      braceCount--;
    }

    if (started) {
      result += char;

      if (braceCount === 0) {
        break;
      }
    }
  }

  try {
    const cleanStr = result
      .replace(/\\u0026/g, "&")
      .replace(/\\"/g, '"')
      .replace(/\\\\/g, "\\");

    return JSON.parse(cleanStr);
  } catch {
    const sourceMatch = html.match(
      /"source"\s*:\s*"([^"]+)"/
    );

    if (sourceMatch) {
      return {
        source: sourceMatch[1].replace(/\\/g, "")
      };
    }

    return null;
  }
}

/**
 * Get AnimeDunya episode list.
 */
export async function getEpisodes(anilistId, ctx = {}) {
  const malId = await resolveMalId(anilistId);

  const html = await fetchHtml(
    `${BASE}/en/anime/${malId}`
  );

  if (!html) {
    throw new Error(
      "AnimeDunya: episodes fetch failed"
    );
  }

  let cdnBase =
    "https://cdn.anime-dunya.com/thumbnail/";

  let cdnExt = "small.jpg";

  const thumbMatch = html.match(
    /(https?:\/\/[^\s"'`<>]+?\/thumbnail\/)([a-zA-Z0-9]+?)\/((?:small|large)\.jpg)/
  );

  if (thumbMatch) {
    cdnBase = thumbMatch[1];
    cdnExt = thumbMatch[3];
  }

  const episodes = extractEpisodesList(html);

  const watchable = episodes.filter(
    (ep) =>
      ep.streamId !== null &&
      ep.streamId !== undefined
  );

  const sub = [];

  for (const ep of watchable) {
    const epNum = ep.episodeNumber;

    const meta = episodeMeta(epNum, ctx);

    const customTitle =
      Array.isArray(ep.translations)
        ? ep.translations.find(
            (t) => t.language === "en"
          )?.title
        : ep.translations?.title;

    sub.push({
      id: `watch/animedunya/${anilistId}/sub/animedunya-${epNum}`,

      number: epNum,

      title:
        customTitle ||
        meta.title ||
        `Episode ${epNum}`,

      duration: meta.duration,

      audio: "sub",

      filler:
        ep.filler ||
        meta.filler ||
        false,

      uncensored: false,

      description: meta.description,

      image: ep.streamId
        ? `${cdnBase}${ep.streamId}/${cdnExt}`
        : meta.image,

      airDate: meta.airDate
    });
  }

  sub.sort(
    (a, b) => a.number - b.number
  );

  return {
    meta: {
      title:
        ctx.media?.title?.english ??
        ctx.media?.title?.romaji ??
        null,

      malId,

      source: "animedunya"
    },

    episodes: {
      sub,
      dub: []
    }
  };
}

/**
 * Get stream for a specific episode.
 */
async function handleWatch(
  anilistId,
  audio,
  epNum
) {
  const malId = await resolveMalId(anilistId);

  const html = await fetchHtml(
    `${BASE}/en/play/${malId}/${epNum}`
  );

  if (!html) {
    return json(
      {
        error:
          "AnimeDunya watch fetch failed"
      },
      500
    );
  }

  const streamData = extractStream(html);

  if (
    !streamData ||
    !streamData.source
  ) {
    return json(
      {
        error:
          "AnimeDunya: stream source not found"
      },
      404
    );
  }

  /**
   * Normalize subtitles.
   */
  const subtitles = Array.isArray(
    streamData.subtitles
  )
    ? streamData.subtitles
        .filter((s) => s?.src)
        .map((s, index) => ({
          id:
            `animedunya-sub-${index}`,

          url: s.src,

          label:
            s.label ||
            s.language ||
            `Subtitle ${index + 1}`,

          srclang:
            s.srclang ||
            s.language ||
            "en",

          default:
            Boolean(s.default)
        }))
    : [];

  /**
   * AnimeDunya normally returns HLS.
   */
  const streams = [
    {
      url: streamData.source,

      type: "hls",

      server: "AnimeDunya",

      referer: `${BASE}/`,

      subtitles,

      priority: 5,

      isActive: true
    }
  ];

  return json({
    anilistId: Number(anilistId),

    malId,

    episode: Number(epNum),

    audio,

    streams
  });
}

/**
 * Worker / provider handler.
 */
export default {
  async fetch(request) {
    /**
     * CORS
     */
    if (request.method === "OPTIONS") {
      return new Response(null, {
        status: 204,

        headers: {
          "Access-Control-Allow-Origin":
            "*",

          "Access-Control-Allow-Methods":
            "GET,OPTIONS",

          "Access-Control-Allow-Headers":
            "*"
        }
      });
    }

    const url = new URL(
      request.url
    );

    try {
      const match =
        url.pathname.match(
          /^\/watch\/animedunya\/(\d+)\/(sub|dub)\/animedunya-(\d+)\/?$/
        );

      if (match) {
        return await handleWatch(
          match[1],
          match[2],
          match[3]
        );
      }

      return json(
        {
          error: "Not found"
        },
        404
      );
    } catch (err) {
      console.error(
        "AnimeDunya provider error:",
        err
      );

      return json(
        {
          error:
            err?.message ||
            "AnimeDunya provider failed",

          stack:
            process.env.NODE_ENV ===
            "production"
              ? undefined
              : err?.stack
        },
        500
      );
    }
  }
};
