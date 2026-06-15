import type { Request, Response } from 'express';
import cors from 'cors';
import express from 'express';
import { Readable } from 'stream';

const app = express();
const PORT = Number(process.env.PORT) || 4000;

app.use(cors());
app.use(express.json());

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
}

interface AlbumInfo {
  title: string;
  releaseDate: string | null;
  image: string | null;
}

interface TrackInfo {
  title: string;
  artist: string | null;
}

// extract track metadata from TiVo API response and return the first 5 singles
function extractTrackInfo(apiResponse: any): TrackInfo[] {
  const tracks = Array.isArray(apiResponse?.hits) ? apiResponse.hits : [];

  return tracks.slice(1, 6).map((track: any) => ({
    title: track.title || track.name || '',
    artist:
      Array.isArray(track.primaryArtists)
        ? track.primaryArtists.map((a: any) => a?.name).filter(Boolean).join(', ')
        : typeof track.primaryArtist === 'object'
        ? track.primaryArtist?.name || null
        : null,
  }));
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
    artist.musicBio?.headlineBio ||
    artist.bio ||
    artist.overview ||
    null;
 
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
    overview
  };
}


// extract album data
function extractAlbumInfo(apiResponse: any): AlbumInfo[] {
  const albums =
    apiResponse?.albums ||
    apiResponse?.hits ||
    apiResponse?.data ||
    apiResponse?.results ||
    [];

  if (!Array.isArray(albums)) {
    return [];
  }

  return albums.map((album: any) => {
    const title = album.title || album.name || album.albumTitle || '';
    const releaseDate = album.releaseDate || album.date || album.year || null;

    const imageUrl =
      album.imageUrl ||
      album.image ||
      album.cover ||
      (album.images?.[0]?.url ?? null);

    return {
      title,
      releaseDate,
      image: imageUrl
        ? `/api/image?url=${encodeURIComponent(imageUrl)}`
        : null,
    };
  });
}


// extract album data from artist
function extractAlbumsFromArtist(apiResponse: any): AlbumInfo[] {
  const artist = apiResponse?.artists?.[0] || apiResponse?.hits?.[0] || {};
  const albumEntries =
    artist.albums ||
    artist.releases ||
    artist.discography ||
    artist.records ||
    [];

  if (!Array.isArray(albumEntries)) {
    return [];
  }

  return extractAlbumInfo({ albums: albumEntries });
}

// calling Tivo API to fetch metadata based on artist name
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
  const apiUrl = new URL(
    'https://tivomusicapi-staging-elb.digitalsmiths.net/sd/db9c86353d2aa209/taps/v3/search/artist'
  );

  apiUrl.searchParams.set('name', artist);
  //console.log('Requesting external API:', apiUrl.toString());

  const response = await fetch(apiUrl.toString(), {
    headers: {
      'x-tmm-keyid': 'TAC1009',
      'x-tmm-apikey': 'f18efef12651c9bb089dde93ec28dda4',
    },
  });

  const data = await response.json();
  //console.log('Response:', JSON.stringify(data, null, 2));
  const artistInfo = extractArtistInfo(data);
  const resolvedNameId = nameId || artistInfo.nameId;
  console.log('Resolved nameId for discography:', resolvedNameId);
  let albums: AlbumInfo[] = [];

  try {
    const albumUrl = new URL(
      'https://tivomusicapi-staging-elb.digitalsmiths.net/sd/db9c86353d2aa209/taps/v3/search/album'
    );
    albumUrl.searchParams.set('title', artist);
    albumUrl.searchParams.set('primaryArtist', artist);
    albumUrl.searchParams.set('limit', '20');
    albumUrl.searchParams.set('offset', '0');

    //console.log('Requesting album API:', albumUrl.toString());
    const albumResponse = await fetch(albumUrl.toString());
    const albumData = await albumResponse.json();
    albums = extractAlbumInfo(albumData);

    console.log('Album API response count:', albums.length);
  } catch (error) {
    console.warn('Album API fetch failed, falling back to artist payload:', error);
  }

  if (!albums.length) {
    albums = extractAlbumsFromArtist(data);
    if (albums.length) {
      console.log('Falling back to artist payload album metadata.');
    } else {
      console.log('No album metadata found in either album API or artist payload.');
    }
  }
  
  console.log('Discography query parameters:', { resolvedNameId});
  let trackInfo: TrackInfo[] = [];
  if (resolvedNameId || title) {
    try {
      const trackUrl = new URL('https://tivomusicapi-staging-elb.digitalsmiths.net/sd/db9c86353d2aa209/taps/v3/lookup/discography');
      if (resolvedNameId) {  
        trackUrl.searchParams.set('nameId', resolvedNameId);
      }
      trackUrl.searchParams.set('type', 'Single');
      trackUrl.searchParams.set('limit', '100');
      if (includeAllFields.toLowerCase() === 'true') {
        trackUrl.searchParams.set('includeAllFields', 'true');
      }

      console.log('Requesting track API:', trackUrl.toString());
      const trackResponse = await fetch(trackUrl.toString(), {
        headers: {
          'Accept': '*/*',
          'x-tmm-keyid': 'TAC1009',
          'x-tmm-apikey': 'f18efef12651c9bb089dde93ec28dda4',
        },
      });
      
      if (trackResponse.ok) {
        const trackData = await trackResponse.json();
        console.log('Track API raw response:', JSON.stringify(trackData, null, 2));
        trackInfo = extractTrackInfo(trackData);
        console.log('Track info:', trackInfo);
      } else {
        console.warn('Track API returned status:', trackResponse.status);
      }
    } catch (error) {
      console.warn('Track API fetch failed:', error);
    }
  }
  //console.log('Final metadata response:',JSON.stringify(albums, null, 2));
  return res.json({
    ...artistInfo,
    albums,
    trackInfo,
  });
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

