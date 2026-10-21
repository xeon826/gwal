import { eq } from 'drizzle-orm';
import { db, initDb, reclassifyAll } from '@/lib/db';
import { rules } from '@/lib/schema';
import { CATEGORIES, norm } from '@/lib/classifier';

export const dynamic = 'force-dynamic';

export async function POST(req: Request) {
  await initDb();
  const { action, id, pattern, category } = await req.json();
  if (action === 'delete' && id) {
    db.delete(rules).where(eq(rules.id, id)).run();
  } else if (action === 'save' && pattern && CATEGORIES.includes(category)) {
    const p = norm(pattern);
    if (p.length < 4) return Response.json({ error: 'pattern too short' }, { status: 400 });
    db.insert(rules)
      .values({ pattern: p, category, origin: 'learned' })
      .onConflictDoUpdate({ target: rules.pattern, set: { category } })
      .run();
  } else {
    return Response.json({ error: 'bad request' }, { status: 400 });
  }
  reclassifyAll();
  return Response.json({ ok: true });
}
