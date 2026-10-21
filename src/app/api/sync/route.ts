import { initDb, syncTransactions } from '@/lib/db';

export const dynamic = 'force-dynamic';

export async function POST() {
  await initDb();
  try {
    return Response.json(await syncTransactions());
  } catch (e) {
    return Response.json({ error: (e as Error).message }, { status: 500 });
  }
}
