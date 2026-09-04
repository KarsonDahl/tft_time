import { NextResponse } from 'next/server';
import { clearPlayerCache, clearPuuidMapping, getPuuidMapping } from '@/lib/matchCache';

function buildNameKey(region: string, summoner: string) {
  return `${region.toLowerCase()}:${summoner.toLowerCase()}`;
}

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const summoner = searchParams.get('summoner') ?? '';
  const region = searchParams.get('region') ?? 'na1';
  const puuid = searchParams.get('puuid') ?? '';

  if (!summoner && !puuid) {
    return NextResponse.json({ error: 'Provide summoner+region or puuid.' }, { status: 400 });
  }

  try {
    let targetPuuid = puuid;
    let nameKey: string | undefined;

    if (!targetPuuid && summoner) {
      nameKey = buildNameKey(region, summoner);
      const mapping = await getPuuidMapping(nameKey);
      targetPuuid = mapping?.puuid ?? '';
    }

    if (!targetPuuid) {
      return NextResponse.json({ error: 'No matching cached player found.' }, { status: 404 });
    }

    await clearPlayerCache(targetPuuid);
    if (nameKey) {
      await clearPuuidMapping(nameKey);
    }

    return NextResponse.json({
      ok: true,
      puuid: targetPuuid,
      cleared: ['matches', 'rankHistory', ...(nameKey ? ['puuidMapping'] : [])],
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
