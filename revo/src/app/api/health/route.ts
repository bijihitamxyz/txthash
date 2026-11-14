import { NextRequest } from 'next/server';
import { GET as healthGet } from '@/app/health/route';

export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest) {
  return healthGet(req);
}
