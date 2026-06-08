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
  name: string;
  dateOfBirth: string | null;
  birthPlace: string | null;
  timeframeAsArtist: {
    start: string | null;
    end: string | null;
  };
  genres: string[];
  overview: string | null;
}

// extract relevant metadata from TiVo API response and adapt to our interface.
function extractArtistInfo(apiResponse: any): ArtistInfo {
  const getImageUrl = (imageObj: any): string | null => {
    if (!imageObj) return null;
    if (typeof imageObj === 'string') return imageObj;
    return imageObj.url || imageObj.href || imageObj.src || imageObj.uri || imageObj.path || null;
  };

  // Support both `artists` and `hits` shapes returned by different endpoints
  const artist = apiResponse?.artists?.[0] || apiResponse?.hits?.[0] || {};

  const rawImageUrl =
    getImageUrl(artist.images?.[0]) ||
    getImageUrl(artist.pictures?.[0]) ||
    getImageUrl(artist.imageUrl) ||
    getImageUrl(artist.image) ||
    null;

  const image = rawImageUrl && typeof rawImageUrl === 'string'
    ? `/api/image?url=${encodeURIComponent(rawImageUrl)}`
    : null;
 

  const name = artist.name || '';
  const dateOfBirth = artist.birth?.date || artist.dateOfBirth || artist.birthDate || null;
  const birthPlace = artist.birth?.place || artist.birthPlace || artist.placeOfBirth || null;

  const active = Array.isArray(artist.active) ? artist.active : null;
  const timeframeStart = active && active.length ? String(active[0]) : artist.startYear ? String(artist.startYear) : null;
  const timeframeEnd = active && active.length ? String(active[active.length - 1]) : artist.endYear ? String(artist.endYear) : null;
  const genresSource = artist.musicGenres || artist.genres || artist.style || [];
  // Normalize genres to array of strings
  const normalizedGenres = (genresSource || []).map((g: any) => (typeof g === 'string' ? g : g?.name || null)).filter(Boolean) as string[];

  const overview =
    artist.musicBio?.headlineBio ||
    artist.bio ||
    artist.overview ||
    null;
 
  return {
    image: image,
    name,
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
// calling Tivo API to fetch metadata based on artist name
app.get('/api/metadata', async (req: Request, res: Response) => {
  const artist = String(req.query.artist || '');
  const apiUrl = new URL(
    'https://tivomusicapi-staging-elb.digitalsmiths.net/sd/db9c86353d2aa209/taps/v3/search/artist'
  );

  apiUrl.searchParams.set('name', artist);
  console.log('Requesting external API:', apiUrl.toString());

  const response = await fetch(apiUrl.toString(), {
    headers: {
      'x-tmm-keyid': 'TAC1009',
      'x-tmm-apikey': 'f18efef12651c9bb089dde93ec28dda4',
    },
  });

  const data = await response.json();
  console.log('Response:', JSON.stringify(data, null, 2));
  
  const artistInfo = extractArtistInfo(data);
  return res.json(artistInfo);
});

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

