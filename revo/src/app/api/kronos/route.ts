import { NextRequest, NextResponse } from 'next/server';
import { POST as predictPost } from '@/app/v1/predict/route';
import { GET as healthGet } from '@/app/health/route';

export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest) {
  return healthGet(req);
}

export async function POST(req: NextRequest) {
  return predictPost(req);
}
