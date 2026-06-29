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

}

interface TrackInfo {
  id: string;
  title: string;
  duration: number;
  performers: string[];
  image: string | null;
  albumId: string | null;
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



// extract track metadata from TiVo API response and return the first 5 singles
function extractTrackInfo(apiResponse: any): TrackInfo[] {
  const tracks = Array.isArray(apiResponse?.hits) ? apiResponse.hits : [];

  return tracks.slice(1, 6).map((track: any) =>
    normalizeTrack(track)
  );
}

function normalizeTrack(track: any, image: string | null = null) {
  const performers = Array.isArray(track.primaryArtists)
    ? track.primaryArtists.map((a: any) => a?.name).filter(Boolean)
    : Array.isArray(track.performers)
    ? track.performers
        .filter(
          (p: any) =>
            p?.role === "Primary Artist" ||
            p?.role === "Featured Artist"
        )
        .map((p: any) => p?.name)
    : [];

  return {
    id: track?.id ?? track?.ids?.trackId ?? "",
    title: track?.title || track?.name || "",
    duration: track?.duration ?? 0,
    performers,
    image,
    albumId: track?.ids?.mainReleaseId ?? null,
  };
}

function normalizeFullTrack(raw: any) {
  return raw
    ? {
        id: raw.id,
        title: raw.title,
        duration: raw.duration ?? 0,

        performers: raw.performers
          ?.map((p: any) => p?.name)
          ?.filter(Boolean) || [],

        image: raw.images?.[0]?.url
          ? `/api/image?url=${encodeURIComponent(
              raw.images[0].url.replace(/&amp;/g, "&")
            )}`
          : null,

        albumId: raw.ids?.albumId ?? null,
        genres: raw.song?.[0]?.genres?.map((g: any) => g.name) || [],
        moods: raw.song?.[0]?.moods?.map((m: any) => m.name) || [],
        themes: raw.song?.[0]?.themes?.map((t: any) => t.name) || [],
        year: raw.song?.[0]?.year ?? null,
      }
    : null;
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

  const res = await fetch(url.toString(), {
    headers: {
      'Accept': '*/*',
      'x-tmm-keyid': 'TAC1009',
      'x-tmm-apikey': 'f18efef12651c9bb089dde93ec28dda4',
    },
  });

  if (!res.ok) return null;

  const data = await res.json();

  const rawImage = data.hits?.[0]?.images?.[0]?.url;

  if (!rawImage) return null;

  const cleaned = rawImage.replace(/&amp;/g, '&');

  // return your proxy URL
  return `/api/image?url=${encodeURIComponent(cleaned)}`;
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
          try {
            let apiUrl; 

            if (credit.nameID) {
              apiUrl = new URL(
                "https://tivomusicapi-staging-elb.digitalsmiths.net/sd/db9c86353d2aa209/taps/v3/lookup/artist"
              );
              apiUrl.searchParams.set("nameId", credit.nameID);
            } else {
              apiUrl = new URL(
                "https://tivomusicapi-staging-elb.digitalsmiths.net/sd/db9c86353d2aa209/taps/v3/search/artist"
              );
              apiUrl.searchParams.set("name", credit.name);
            }

            const response = await fetch(apiUrl.toString(), {
              headers: {
                "x-tmm-keyid": "TAC1009",
                "x-tmm-apikey": "f18efef12651c9bb089dde93ec28dda4",
              },
            });

            const data = await response.json();
            const artistInfo = extractArtistInfo(data);

            return {
              ...credit,
              image: artistInfo.image,
            };

          } catch (err) {
            console.log("Failed to fetch credit artist:", credit.name);

            return {
              ...credit,
              image: null,
            };
          }
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

  // console.log('Requesting external API:', apiUrl.toString());

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
  const artistName = artist || artistInfo.name;
  

  let selectedAlbum: AlbumInfo | null = null;

  if (albumId) {
    const lookupUrl = new URL(
      'https://tivomusicapi-staging-elb.digitalsmiths.net/sd/db9c86353d2aa209/taps/v3/lookup/album'
    );

    lookupUrl.searchParams.set('albumId', albumId);

    const albumRes = await fetch(lookupUrl.toString(), {
      headers: {
        'Accept': '*/*',
        'x-tmm-keyid': 'TAC1009',
        'x-tmm-apikey': 'f18efef12651c9bb089dde93ec28dda4',
      },
    });

    if (albumRes.ok) {
      const albumData = await albumRes.json();
      const extracted = await extractAlbumInfo(albumData);
      selectedAlbum = extracted[0] || null;
    }
  }
  // ALBUMS INFORMATION API CALL
  let albums: AlbumInfo[] = [];
  try {
    const albumUrl = new URL(
      'https://tivomusicapi-staging-elb.digitalsmiths.net/sd/db9c86353d2aa209/taps/v3/search/album'
    );
    albumUrl.searchParams.set('title', title);
    albumUrl.searchParams.set('primaryArtist', artistName);
    albumUrl.searchParams.set('primaryArtistId', resolvedNameId);
    albumUrl.searchParams.set('limit', '20');
    albumUrl.searchParams.set('offset', '0');

    //console.log('Requesting album API:', albumUrl.toString());
    const albumResponse = await fetch(albumUrl.toString());
    const albumData = await albumResponse.json();
    albums = (await extractAlbumInfo(albumData)).filter(album =>
      Array.isArray(album.flags) &&
      album.flags.some(flag =>
        flag.toLowerCase().includes("studio")
      )
    );

    if (selectedAlbum) {
      const exists = albums.some(a => a.id === selectedAlbum.id);

      if (!exists) {
        albums.unshift(selectedAlbum); 
      }
    }

    //console.log('Album API response count:', albums, null, 2);

    //console.log('Album API raw response:', JSON.stringify(albumData, null, 2));
  } catch (error) {
    console.warn('Album API fetch failed, falling back to artist payload:', error);
  }

  //console.log('Discography query parameters:', { resolvedNameId});
  // TRACKS INFORMATION API CALL
  let trackInfo: TrackInfo[] = [];
  if (resolvedNameId || title) {
      const trackUrl = new URL('https://tivomusicapi-staging-elb.digitalsmiths.net/sd/db9c86353d2aa209/taps/v3/lookup/discography');
      if (resolvedNameId) {  
        trackUrl.searchParams.set('nameId', resolvedNameId);
      }
      trackUrl.searchParams.set('type', 'Single');
      trackUrl.searchParams.set('limit', '10');

      
      if (includeAllFields.toLowerCase() === 'true') {
        trackUrl.searchParams.set('includeAllFields', 'true');
      }

      const trackResponse = await fetch(trackUrl.toString(), {
        headers: {
          'Accept': '*/*',
          'x-tmm-keyid': 'TAC1009',
          'x-tmm-apikey': 'f18efef12651c9bb089dde93ec28dda4',
        },
      });
      
      if (trackResponse.ok) {
        const trackData = await trackResponse.json();
        //console.log('Track API raw response:', JSON.stringify(trackData, null, 2));
        trackInfo = extractTrackInfo(trackData);

        // enrich singles with release images
        trackInfo = await Promise.all(
          trackInfo.map(async (track) => {
            if (!track.albumId) return track;

            try {
              const url = new URL('https://tivomusicapi-staging-elb.digitalsmiths.net/sd/db9c86353d2aa209/taps/v3/lookup/release');
              url.searchParams.set('releaseId', track.albumId);

              const res = await fetch(url.toString(), {
                headers: {
                  'Accept': '*/*',
                  'x-tmm-keyid': 'TAC1009',
                  'x-tmm-apikey': 'f18efef12651c9bb089dde93ec28dda4',
                },
              });
              
              if (!res.ok) return track;

              const data = await res.json();
              //console.log('Release lookup response:', JSON.stringify(data, null, 1));

              const image = await fetchReleaseImage(track.albumId);
              return {
                ...track,
                image, 
              };
            } catch (err) {
              console.warn('Error fetching release image:', err);
              return track;
            }
          })
        );
        //console.log('Enriched trackInfo:', JSON.stringify(trackInfo, null, 2));
      }
      
    }
    //console.log('Final metadata response:',JSON.stringify(albums, null, 2));
    // SIMILAR ALBUMS INFORMATION API CALL
    let similarAlbumInfo: SimilarAlbumInfo[] = [];

    if (albums.length) {
      const similarAlbumUrl = new URL(
        'https://tivomusicapi-staging-elb.digitalsmiths.net/sd/db9c86353d2aa209/taps/v3/recommendations/albumMLT'
      );
    const resolvedAlbumId = albumId || albums[0]?.id || '';

    if (resolvedAlbumId ) {
      similarAlbumUrl.searchParams.set('albumId', resolvedAlbumId);
    }
      const res = await fetch(similarAlbumUrl.toString(), {
        headers: {
          'Accept': '*/*',
          'x-tmm-keyid': 'TAC1009',
          'x-tmm-apikey': 'f18efef12651c9bb089dde93ec28dda4',
        },
      });

      if (res.ok) {
        const data = await res.json();
        similarAlbumInfo = extractSimilarAlbumsInfo(data)
        //console.log("FINAL RESPONSE:", {albums,similarAlbums: similarAlbumInfo,});
        const similarAlbums = extractSimilarAlbumsInfo(data);
        //console.log("API response:", data);
        //console.log("Similar albums:", similarAlbums);
        //console.log('Similar albums:', JSON.stringify(data, null, 2));
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
            "https://tivomusicapi-staging-elb.digitalsmiths.net/sd/db9c86353d2aa209/taps/v3/lookup/artist"
          );
          apiUrl.searchParams.set("nameId", composer.nameId);
        } else {
          apiUrl = new URL(
            "https://tivomusicapi-staging-elb.digitalsmiths.net/sd/db9c86353d2aa209/taps/v3/search/artist"
          );
          apiUrl.searchParams.set("name", composer.name);
        }

        const response = await fetch(apiUrl.toString(), {
          headers: {
            "x-tmm-keyid": "TAC1009",
            "x-tmm-apikey": "f18efef12651c9bb089dde93ec28dda4",
          },
        });

        const data = await response.json();
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

  const track = {
    id: raw.id,
    title: raw.title,
    duration: raw.duration,

    performers: raw.performers
      ?.filter((p: any) =>
        p?.role === "Primary Artist" ||
        p?.role === "Featured Artist"
      )
      ?.map((p: any) => p?.name)
      ?.filter(Boolean) || [],

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

