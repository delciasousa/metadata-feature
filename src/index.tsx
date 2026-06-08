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
    start: number | null;
    end: number | null;
  };
  genres: string[];
}

// fectching relevant metadata from Tivo API response and adding to the interface.
function extractArtistInfo(apiResponse: any): ArtistInfo {
  const artist = apiResponse?.artists?.[0] || {};
  return {
    image: artist.imageUrl || artist.image || null,
    name: artist.name || '',
    dateOfBirth: artist.dateOfBirth || artist.birthDate || null,
    birthPlace: artist.birthPlace || artist.placeOfBirth || null,
    timeframeAsArtist: {
      start: artist.startYear || artist.yearsActive?.start || null,
      end: artist.endYear || artist.yearsActive?.end || null,
    },
    genres: artist.genres || artist.style || [],
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

app.listen(PORT, () => {
  console.log(`Server running on http://localhost:${PORT}`);
});

