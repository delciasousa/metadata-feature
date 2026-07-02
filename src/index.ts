import type { Request, Response } from 'express';
import cors from 'cors';
import express from 'express';
import { Readable } from 'stream';

const app = express();
const PORT = Number(process.env.PORT) || 4000;

app.use(cors());
app.use(express.json());

const TIVO_HEADERS = {
  Accept: '*/*',
  'x-tmm-keyid': 'TAC1009',
  'x-tmm-apikey': 'f18efef12651c9bb089dde93ec28dda4',
};

const TIVO_CACHE_TTL_MS = 60_000;
const tivoResponseCache = new Map<string, { expiresAt: number; value: unknown }>();


// Fetch JSON data from Tivo API with caching and timeout handling
async function fetchTivoJson(url: URL | string, init: RequestInit = {}) {
  const cacheKey = `${url.toString()}::${init.method ?? 'GET'}`;
  const cachedEntry = tivoResponseCache.get(cacheKey);

  if (cachedEntry && cachedEntry.expiresAt > Date.now()) {
    return cachedEntry.value;
  }

  if (cachedEntry) {
    tivoResponseCache.delete(cacheKey);
  }

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 10000);

  try {
    const start = Date.now();
    const response = await fetch(url.toString(), {
      ...init,
      headers: {
        ...TIVO_HEADERS,
        ...(init.headers as Record<string, string> | undefined),
      },
      signal: controller.signal,
      
    });
    console.log(`Request took ${Date.now() - start}ms`);

    if (!response.ok) {
      throw new Error(`Tivo request failed with ${response.status}`);
    }

    const data = await response.json();
    tivoResponseCache.set(cacheKey, {
      expiresAt: Date.now() + TIVO_CACHE_TTL_MS,
      value: data,
    });

    return data;
  } catch (error) {
    if (error instanceof Error && error.name === 'AbortError') {
      throw new Error('Tivo request timed out');
    }

    throw error;
  } finally {
    clearTimeout(timeoutId);
  }
}

interface ArtistInfo {
  image: string | null;
  images: string[];
  name: string;
  nameId: string;
  dateOfBirth: string | null;
  birthPlace: string | null;
  timeframeAsArtist: {
    start: string | null;
    end: string | null;
  };
  genres: string[];
  overview: string | null;
  cleanOverview: string | null;
  country : string | null;
}

interface AlbumInfo {
  id: string;
  title: string;
  releaseDate: string | null;
  flags: string[];
  image: string | null;
  primaryArtists: { name: string; id: string | null }[];
  genres: string[] | null;
  tracks: Track[];
  allCredits: Credit[];
  subgenres: string[] | null;

}

interface TrackInfo {
  id: string;
  title: string;
  duration: number;
  performers: string[];
  image: string | null;
  albumId: string | null;
  releaseId: string;
}

interface  SimilarAlbumInfo{
  id: string;
  title: string;
  artist: string;
  image: string | null;
}

type Credit = {
  name: string;
  nameID: string | null;
  roleID: string | null;
  role: string;
};

type Track = {
  id: string;
  title: string;
  duration: number;
  performers: string[];
  image: string | null;
};




function normalizeTrack(track: any, image: string | null = null) {
  let performers: string[] = [];

  if (Array.isArray(track.performers)) {
    performers = track.performers
      .filter(
        (p: any) =>
          p?.role === "Primary Artist" ||
          p?.role === "Featured Artist"
      )
      .map((p: any) => p?.name)
      .filter(Boolean);

  } else if (Array.isArray(track.primaryArtists)) {
    performers = track.primaryArtists
      .map((a: any) => a?.name)
      .filter(Boolean);
  }
  performers = [...new Set(performers)];

  return {
    id: track?.ids?.mainTrackId ?? track?.id ?? null,
    title: track?.title || "",
    duration: track?.duration ?? 0,
    performers,
    image: image || track?.images?.[0]?.url || null,
    albumId:
      track?.album?.[0]?.id ??
      track?.release?.[0]?.ids?.albumId ??
      null,
    releaseId: track?.ids?.mainReleaseId ?? null,
  };
}

// extract relevant metadata from TiVo API response and adapt to our interface.
function extractArtistInfo(apiResponse: any): ArtistInfo {
  // extract image url from various
  const getImageUrl = (imageObj: any): string | null => {
    if (!imageObj) return null;
    if (typeof imageObj === 'string') return imageObj;
    return imageObj.url;
  };
  // handling cases where images could be an array of objects, single objects, or array of strings
  const getImageUrls = (imageObj: any): string[] => {
    if (!imageObj) return [];
    if (Array.isArray(imageObj)) {
      return imageObj
        .map((item) => getImageUrl(item))
        .filter(Boolean) as string[];
    }
    const url = getImageUrl(imageObj);
    return url ? [url] : [];
  };
  // Support both `artists` and `hits` shapes returned by different endpoints
  const artist = apiResponse?.artists?.[0] || apiResponse?.hits?.[0] || {};
  const rawImageUrls = [
    ...getImageUrls(artist.images),
    ...getImageUrls(artist.pictures),
    ...getImageUrls(artist.imageUrl),
    ...getImageUrls(artist.image),
  ];

  const uniqueImageUrls = Array.from(new Set(rawImageUrls));
  const images = uniqueImageUrls.map((url) => `/api/image?url=${encodeURIComponent(url)}`);
  const image = images[0] ?? null;
 
  const name = artist.name || '';
  const dateOfBirth = artist.birth?.date || artist.dateOfBirth || artist.birthDate || null;
  const birthPlace = artist.birth?.place || artist.birthPlace || artist.placeOfBirth || null;

  const active = Array.isArray(artist.active) ? artist.active : null;
  const timeframeStart = active && active.length ? String(active[0]) : artist.startYear ? String(artist.startYear) : null;
  const timeframeEnd = active && active.length ? String(active[active.length - 1]) : artist.endYear ? String(artist.endYear) : null;
  const genresSource = artist.musicGenres || artist.genres || artist.style || [];
  // Normalize genres to array of strings
  const normalizedGenres = (genresSource || []).map((g: any) => (typeof g === 'string' ? g : g?.name || null)).filter(Boolean) as string[];
  const nameId = artist.nameId || artist.id || artist.artistId || null;

  const overview = 
    artist.musicBio?.musicBioOverviewEnglish?.[0]?.overview ||
    artist.musicBio?.headlineBio ||
    artist.bio ||
    artist.overview ||
    null;
  const cleanOverview = overview
  ?.replace(/\[\/?roviLink.*?\]/g, '')   
  ?.replace(/\[\/?muzeItalic\]/g, '')   
  || null;

  const country = artist.country || ' ';
 
  return {
    image,
    images,
    name,
    nameId,
    dateOfBirth,
    birthPlace,
    timeframeAsArtist: {
      start: timeframeStart,
      end: timeframeEnd,
    },
    genres: normalizedGenres,
    overview,
    cleanOverview,
    country
  };
}


async function fetchReleaseImage(releaseId: string) {
  const url = new URL('https://tivomusicapi-staging-elb.digitalsmiths.net/sd/db9c86353d2aa209/taps/v3/lookup/release');
  url.searchParams.set('releaseId', releaseId);

  try {
    const data = await fetchTivoJson(url);
    const rawImage = data.hits?.[0]?.images?.[0]?.url;

    if (!rawImage) return null;

    const cleaned = rawImage.replace(/&amp;/g, '&');

    return `/api/image?url=${encodeURIComponent(cleaned)}`;
  } catch (error) {
    console.warn('Release image lookup failed:', error);
    return null;
  }
}

// extract album data
async function extractAlbumInfo(apiResponse: any): Promise<AlbumInfo[]> {
  const albums =
    apiResponse?.albums ||
    apiResponse?.hits ||
    apiResponse?.data ||
    apiResponse?.results ||
    [];

  if (!Array.isArray(albums)) {
    return [];
  }

  return await Promise.all(
    albums.map(async (album: any) => {
      const title = album.title || album.name || album.albumTitle || '';
      const releaseDate =
        album.originalReleaseDate || album.date || album.year || null;

      const imageUrl =
        album.imageUrl ||
        album.image ||
        album.cover ||
        (album.images?.[0]?.url ?? null);

      const primaryArtists =
        album.primaryArtists?.map((artist: any) => ({
          name: artist.name,
          id: artist.nameId || artist.id || null, 
        })) || [];

      const genres =
        album.genres?.map((genre: any) => genre.name) || [];

      const subgenres =
        album.subGenres?.map((subgenre: any) => subgenre.name) || [];
      
      const albumId = album.id;
      const albumImage = imageUrl
        ? `/api/image?url=${encodeURIComponent(imageUrl)}`
        : null;

      const globalCreditsMap = new Map<string, Credit>();

      const tracks = (album.tracks ?? []).map((track: any) =>
        normalizeTrack(track, albumImage)
      );
            
      const primaryArtistIds = new Set(
        (album.primaryArtists ?? [])
          .map((a: { id: string | null }) => a.id)
          .filter((id: string | null): id is string => id !== null)
      );

      const primaryArtistNames = new Set(
        (album.primaryArtists ?? [])
          .map((a: { name: string }) => a.name.toLowerCase())
      );

      const rawCredits = [
        ...new Map<string, Credit>(
          (album.tracks ?? [])
            .flatMap((track: any) => track.performers ?? [])
            .filter((p: any) => {
              if (!p) return false;

              if (p.nameID && primaryArtistIds.has(p.nameID)) return false;
              if (p.name && primaryArtistNames.has(p.name.toLowerCase())) return false;

              return true;
            })
            .map((p: any) => [
              `${p.nameID ?? p.name}`,
              {
                name: p.name ?? "",
                nameID: p.nameID ?? null,
                roleID: p.roleID ?? null,
                role: p.role ?? "",
              },
            ])
        ).values(),
      ];
      const allCredits = await Promise.all(
        rawCredits.map(async (credit) => {
   
            let apiUrl;

            if (credit.nameID) {
              apiUrl = new URL(
                'https://tivomusicapi-staging-elb.digitalsmiths.net/sd/db9c86353d2aa209/taps/v3/lookup/artist'
              );
              apiUrl.searchParams.set('nameId', credit.nameID);
            } else {
              apiUrl = new URL(
                'https://tivomusicapi-staging-elb.digitalsmiths.net/sd/db9c86353d2aa209/taps/v3/search/artist'
              );
              apiUrl.searchParams.set('name', credit.name);
            }

            const data = await fetchTivoJson(apiUrl);
            const artistInfo = extractArtistInfo(data);

            return {
              ...credit,
              image: artistInfo.image,
            };
        })
      );
      
      return {
        id: album.id,
        title,
        releaseDate,
        flags: album.flags || [],
        image: imageUrl
          ? `/api/image?url=${encodeURIComponent(imageUrl)}`
          : null,
        primaryArtists,
        genres,
        tracks,
        allCredits, 
        subgenres,
      };
    })
  );
}



function extractSimilarAlbumsInfo(apiResponse: any): SimilarAlbumInfo[] {
  const albums =
    apiResponse?.hits ||
    apiResponse?.albums ||
    apiResponse?.data ||
    apiResponse?.results ||
    [];

  if (!Array.isArray(albums)) {
    return [];
  }

  return albums.map((album: any) => {
    const id = album.id;

    const title =
      album.title ||
      album.name ||
      album.albumTitle ||
      'Unknown Album';

    const artist =
      album.primaryArtists?.[0]?.name ||
      album.artists?.[0]?.name ||
      'Unknown Artist';

    let image =
      album.imageUrl ||
      album.image ||
      album.cover ||
      album.images?.[0]?.url ||
      null;

    if (image) {
      image = image.replace(/&amp;/g, '&');

      image = `/api/image?url=${encodeURIComponent(image)}`;
    }

    return {
      id,
      title,
      artist,
      image,
    };
  });
}


// calling Tivo API to fetch metadata
app.get('/api/metadata', async (req: Request, res: Response) => {
  const artist = String(req.query.artist || '');
  const title = String(
    req.query.title ||
    req.query.track ||
    req.query.song ||
    req.query.trackName ||
    ''
  );
  const primaryArtistId = String(req.query.primaryArtistId || '');
  const nameId = String(req.query.nameId || '');
  const includeAllFields = String(req.query.includeAllFields || '');
  const albumId = String(req.query.albumId || '');
 
  let apiUrl;
// ARTIST INFORMATION API - ID RETRIEVAL 
if (nameId) {
  // endpoint for ID lookup
  apiUrl = new URL(
    'https://tivomusicapi-staging-elb.digitalsmiths.net/sd/db9c86353d2aa209/taps/v3/lookup/artist'
  );
  apiUrl.searchParams.set('nameId', nameId);
// ARTIST INFORMATION API - NAME RETRIEVAL 
} else {
  //  endpoint for name search
  apiUrl = new URL(
    'https://tivomusicapi-staging-elb.digitalsmiths.net/sd/db9c86353d2aa209/taps/v3/search/artist'
  );
  apiUrl.searchParams.set('name', artist);
}

  const data = await fetchTivoJson(apiUrl);
  const artistInfo = extractArtistInfo(data);
  const resolvedNameId = nameId || artistInfo.nameId;
  const artistName = artist || artistInfo.name;

  let selectedAlbum: AlbumInfo | null = null;
  let albums: AlbumInfo[] = [];
  let trackInfo: TrackInfo[] = [];
  let similarAlbumInfo: SimilarAlbumInfo[] = [];

  const [selectedAlbumResult, albumsResult, trackInfoResult] = await Promise.allSettled([
    albumId
      ? (async () => {
          const lookupUrl = new URL(
            'https://tivomusicapi-staging-elb.digitalsmiths.net/sd/db9c86353d2aa209/taps/v3/lookup/album'
          );
          lookupUrl.searchParams.set('albumId', albumId);

          const albumData = await fetchTivoJson(lookupUrl);
          const extracted = await extractAlbumInfo(albumData);
          return extracted[0] || null;
        })()
      : Promise.resolve(null),
    (async () => {
      const albumUrl = new URL(
        'https://tivomusicapi-staging-elb.digitalsmiths.net/sd/db9c86353d2aa209/taps/v3/search/album'
      );
      albumUrl.searchParams.set('title', title);
      albumUrl.searchParams.set('primaryArtist', artistName);
      albumUrl.searchParams.set('primaryArtistId', resolvedNameId);
      albumUrl.searchParams.set('limit', '20');
      albumUrl.searchParams.set('offset', '0');

      const albumData = await fetchTivoJson(albumUrl);
      return (await extractAlbumInfo(albumData)).filter((album) =>
        Array.isArray(album.flags) &&
        album.flags.some((flag) => flag.toLowerCase().includes('studio'))
      );
    })(),
    (async () => {
      if (!resolvedNameId && !title) return [];

      const trackUrl = new URL(
        'https://tivomusicapi-staging-elb.digitalsmiths.net/sd/db9c86353d2aa209/taps/v3/lookup/discography'
      );
      if (resolvedNameId) {
        trackUrl.searchParams.set('nameId', resolvedNameId);
      }
      trackUrl.searchParams.set('type', 'Single');
      trackUrl.searchParams.set('limit', '10');

      if (includeAllFields.toLowerCase() === 'true') {
        trackUrl.searchParams.set('includeAllFields', 'true');
      }

      const trackData = await fetchTivoJson(trackUrl);
      const singles = (trackData?.hits ?? [])
        .filter((t: any) => t.type === 'Single')
        .slice(0, 5);

      const enrichedTracks = await Promise.all(
        singles.map(async (single: any) => {
          try {
            const releaseId = single?.ids?.mainReleaseId;
            if (!releaseId) return null;

            const url = new URL(
              'https://tivomusicapi-staging-elb.digitalsmiths.net/sd/db9c86353d2aa209/taps/v3/lookup/release'
            );
            url.searchParams.set('releaseId', releaseId);

            const data = await fetchTivoJson(url);
            const raw = data?.hits?.[0];

            if (!raw) return null;

            const track = raw.tracks?.[0];
            const image = raw.images?.[0]?.url || null;

            return {
              id: track?.id ?? null,
              title: track?.title || single.title,
              duration: track?.duration ?? single.duration,
              performers: track?.performers
                ?.filter(
                  (p: any) =>
                    p?.role === 'Primary Artist' ||
                    p?.role === 'Featured Artist'
                )
                ?.map((p: any) => p?.name) ||
                single.primaryArtists?.map((a: any) => a.name) ||
                [],
              image: image ? `/api/image?url=${encodeURIComponent(image)}` : null,
              albumId: raw?.ids?.albumId ?? single.id,
              releaseId,
            };
          } catch (err) {
            console.warn('Release enrichment failed:', single.title);
            return null;
          }
        })
      );

      return enrichedTracks.filter(Boolean);
    })(),
  ]);

  if (selectedAlbumResult.status === 'fulfilled' && selectedAlbumResult.value) {
    selectedAlbum = selectedAlbumResult.value;
  }

  if (albumsResult.status === 'fulfilled') {
    albums = albumsResult.value;
  }

  if (trackInfoResult.status === 'fulfilled') {
    trackInfo = trackInfoResult.value as TrackInfo[];
  }

  if (selectedAlbum) {
    const exists = albums.some((album) => album.id === selectedAlbum.id);
    if (!exists) {
      albums.unshift(selectedAlbum);
    }
  }

  if (albums.length) {
    const similarAlbumUrl = new URL(
      'https://tivomusicapi-staging-elb.digitalsmiths.net/sd/db9c86353d2aa209/taps/v3/recommendations/albumMLT'
    );
    const resolvedAlbumId = albumId || albums[0]?.id || '';

    if (resolvedAlbumId) {
      similarAlbumUrl.searchParams.set('albumId', resolvedAlbumId);
      try {
        const data = await fetchTivoJson(similarAlbumUrl);
        similarAlbumInfo = extractSimilarAlbumsInfo(data);
      } catch (error) {
        console.warn('Similar album lookup failed:', error);
      }
    }
  }

  return res.json({
    ...artistInfo,
    albums,
    trackInfo,
    similarAlbums: similarAlbumInfo,
  });
});

app.get('/api/track', async (req, res) => {
  const trackId = String(req.query.trackId || '');

  if (!trackId) {
    return res.status(400).json({ error: 'trackId required' });
  }

  const url = new URL(
    'https://tivomusicapi-staging-elb.digitalsmiths.net/sd/db9c86353d2aa209/taps/v3/lookup/track'
  );

  url.searchParams.set('trackId', trackId);

  const response = await fetch(url.toString(), {
    headers: {
      'x-tmm-keyid': 'TAC1009',
      'x-tmm-apikey': 'f18efef12651c9bb089dde93ec28dda4',
    },
  });

  const data = await response.json();
  const raw = data?.hits?.[0];

  if (!raw) {
    return res.json(null);
  }

  const composersWithImages = await Promise.all(
    (raw.composers ?? []).map(async (composer: any) => {
      try {
        let apiUrl;

        if (composer.nameId) {
          apiUrl = new URL(
            'https://tivomusicapi-staging-elb.digitalsmiths.net/sd/db9c86353d2aa209/taps/v3/lookup/artist'
          );
          apiUrl.searchParams.set('nameId', composer.nameId);
        } else {
          apiUrl = new URL(
            'https://tivomusicapi-staging-elb.digitalsmiths.net/sd/db9c86353d2aa209/taps/v3/search/artist'
          );
          apiUrl.searchParams.set('name', composer.name);
        }

        const data = await fetchTivoJson(apiUrl);
        const artistInfo = extractArtistInfo(data);

        return {
          name: composer.name,
          image: artistInfo.image,
        };
      } catch (err) {
        return {
          name: composer.name,
          image: null,
        };
      }
    })
  );

  const performerEntries = [
    ...(raw.performers ?? [])
      .filter((p: any) =>
        p?.role === 'Primary Artist' ||
        p?.role === 'Featured Artist'
      )
      .map((p: any) => ({
        name: p?.name || '',
        id: p?.nameID || p?.id || p?.nameId || null,
      }))
      .filter((p: any) => p.name),
    ...(raw.primaryArtists ?? []).map((artist: any) => ({
      name: artist?.name || '',
      id: artist?.nameID || artist?.id || artist?.nameId || null,
    })),
  ];

  const uniquePerformers = performerEntries.filter(
    (performer: { name: string; id: string | null }, index: number, list: { name: string; id: string | null }[]) =>
      list.findIndex((entry) => entry.name === performer.name && entry.id === performer.id) === index
  );

  const track = {
    id: raw.id,
    title: raw.title,
    duration: raw.duration,
    albumId: raw.ids?.albumId  || null,
    performers: uniquePerformers,

    composers: composersWithImages, 

    image: raw.images?.[0]?.url
    ? `/api/image?url=${encodeURIComponent(
        raw.images[0].url.replace(/&amp;/g, "&")
      )}`
    : null,

    genres: raw.song?.[0]?.genres?.map((g: any) => g.name) || [],
    moods: raw.song?.[0]?.moods?.map((m: any) => m.name) || [],
    themes: raw.song?.[0]?.themes?.map((t: any) => t.name) || [],
    year: raw.song?.[0]?.year || null,
  };

  return res.json(track);

});

// Proxy endpoint to fetch images from Tivo API and stream them back to frontend.
app.get('/api/image', async (req: Request, res: Response) => {
  const imageUrl = String(req.query.url || '');
  if (!imageUrl) {
    return res.status(400).json({ error: 'Missing image URL' });
  }

  let parsedUrl: URL;
  parsedUrl = new URL(imageUrl);

  const imageResponse = await fetch(parsedUrl.toString(), {
    headers: {
      'x-tmm-keyid': 'TAC1009',
      'x-tmm-apikey': 'f18efef12651c9bb089dde93ec28dda4',
    },
  });

  if (!imageResponse.ok) {
    const message = await imageResponse.text();
    return res.status(imageResponse.status).send(message);
  }
  const contentType = imageResponse.headers.get('content-type');
  if (contentType) {
    res.setHeader('Content-Type', contentType);
  }
  const contentLength = imageResponse.headers.get('content-length');
  if (contentLength) {
    res.setHeader('Content-Length', contentLength);
  }
  const body = imageResponse.body;
  if (!body) {
    return res.status(500).json({ error: 'Missing image response body' });
  }

  const nodeStream = Readable.fromWeb(body as any);
  nodeStream.pipe(res);
});


app.listen(PORT, () => {
  console.log(`Server running on http://localhost:${PORT}`);
});

