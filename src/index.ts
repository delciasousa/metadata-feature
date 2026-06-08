import type { Request, Response } from 'express';
import cors from 'cors';
import express from 'express';

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
}

// extract relevant metadata from TiVo API response and adapt to our interface.
function extractArtistInfo(apiResponse: any): ArtistInfo {
  // Support both `artists` and `hits` shapes returned by different endpoints
  const artist = apiResponse?.artists?.[0] || apiResponse?.hits?.[0] || {};

  const images = artist.images || artist.pictures || [];
  const image = images && images.length ? images[0].url || null : artist.imageUrl || artist.image || null;

  const name = artist.name || '';
  const dateOfBirth = artist.birth?.date || artist.dateOfBirth || artist.birthDate || null;
  const birthPlace = artist.birth?.place || artist.birthPlace || artist.placeOfBirth || null;

  const active = Array.isArray(artist.active) ? artist.active : null;
  const timeframeStart = active && active.length ? String(active[0]) : artist.startYear ? String(artist.startYear) : null;
  const timeframeEnd = active && active.length ? String(active[active.length - 1]) : artist.endYear ? String(artist.endYear) : null;
  const genresSource = artist.musicGenres || artist.genres || artist.style || [];
  // Normalize genres to array of strings
  const normalizedGenres = (genresSource || []).map((g: any) => (typeof g === 'string' ? g : g?.name || null)).filter(Boolean) as string[];

  // Expose image through our proxy endpoint to avoid CORS/hotlink issues
  const proxiedImage = image ? `/api/image?url=${encodeURIComponent(image)}` : null;

  return {
    image: proxiedImage,
    name,
    dateOfBirth,
    birthPlace,
    timeframeAsArtist: {
      start: timeframeStart,
      end: timeframeEnd,
    },
    genres: normalizedGenres,
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


  const response = await fetch(apiUrl.toString());

  const data = await response.json();
  console.log('Response:', JSON.stringify(data, null, 2));
  
  const artistInfo = extractArtistInfo(data);
  return res.json(artistInfo);
});

// Image proxy: fetches an external image and pipes it through to the client.
// Basic allowlist prevents arbitrary URL fetching.
app.get('/api/image', async (req: Request, res: Response) => {
  const imageUrl = String(req.query.url || '');
  if (!imageUrl) return res.status(400).json({ error: 'Missing url parameter' });

  let parsed: URL;
  try {
    parsed = new URL(imageUrl);
  } catch (e) {
    return res.status(400).json({ error: 'Invalid url parameter' });
  }

  // Allowlist hosts (expand if you trust other domains)
  const allowedHosts = ['rovimusic.rovicorp.com'];
  if (!allowedHosts.includes(parsed.hostname)) {
    return res.status(400).json({ error: 'Host not allowed' });
  }

  try {
    const resp = await fetch(imageUrl);
    if (!resp.ok) return res.status(502).json({ error: 'Failed to fetch image' });
    const contentType = resp.headers.get('content-type') || 'application/octet-stream';
    const buffer = Buffer.from(await resp.arrayBuffer());
    res.setHeader('Content-Type', contentType);
    res.setHeader('Cache-Control', 'public, max-age=86400');
    return res.send(buffer);
  } catch (err) {
    console.error('Image proxy error:', err);
    return res.status(500).json({ error: 'Image proxy failed' });
  }
});

app.listen(PORT, () => {
  console.log(`Server running on http://localhost:${PORT}`);
});

