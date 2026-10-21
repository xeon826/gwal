import { initDb, tagTransactions } from '@/lib/db';
import { CATEGORIES } from '@/lib/classifier';

export const dynamic = 'force-dynamic';

export async function POST(req: Request) {
  await initDb();
  const { ids, category, create_rule } = await req.json();
  if (!Array.isArray(ids) || !CATEGORIES.includes(category)) {
    return Response.json({ error: 'bad request' }, { status: 400 });
  }
  tagTransactions(ids as string[], category as string, Boolean(create_rule));
  return Response.json({ ok: true });
}
