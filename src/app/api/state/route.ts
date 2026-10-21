import { initDb } from '@/lib/db';
import { computeState } from '@/lib/budget';

export const dynamic = 'force-dynamic';

export async function GET() {
  await initDb();
  return Response.json(computeState());
}
