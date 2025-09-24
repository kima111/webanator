#!/usr/bin/env ts-node
/**
 * One-off helper: convert existing /image-viewer?src=<public supabase url>
 * origins to new proxied internal path form.
 * Run with: npx ts-node scripts/migrate_image_origins.ts
 */
import { createClient } from '@supabase/supabase-js';

const url = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const service = process.env.SUPABASE_SERVICE_ROLE_KEY!;
const anon = process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_OR_ANON_KEY!; // just for reference

(async () => {
  const admin = createClient(url, service, { auth: { persistSession: false } });
  const { data: projects, error } = await admin.from('projects').select('id, origin');
  if (error) throw error;
  const updates: Array<{ id: string; origin: string }> = [];
  for (const p of projects || []) {
    if (!p.origin || !p.id) continue;
    try {
      const u = new URL(p.origin.startsWith('/image-viewer') ? 'http://x'+p.origin : p.origin);
      const srcParam = u.searchParams.get('src');
      if (!srcParam) continue;
      // if srcParam is a public supabase URL pointing to uploads bucket
      if (/\/storage\/v1\/object\/public\/uploads\//.test(srcParam)) {
        // derive object path after /uploads/
        const idx = srcParam.indexOf('/uploads/');
        if (idx === -1) continue;
        const objectPath = srcParam.slice(idx + '/uploads/'.length);
        const proxy = `/api/storage/image/${objectPath}?project=${p.id}`;
        const newOrigin = `/image-viewer?src=${encodeURIComponent(proxy)}`;
        if (newOrigin !== p.origin) updates.push({ id: p.id, origin: newOrigin });
      }
    } catch {}
  }
  if (!updates.length) {
    console.log('No updates needed.');
    return;
  }
  console.log('Updating', updates.length, 'projects');
  for (const chunk of chunked(updates, 50)) {
    const { error: upErr } = await admin.from('projects').upsert(chunk, { onConflict: 'id' });
    if (upErr) throw upErr;
  }
  console.log('Done.');
})();

function chunked<T>(arr: T[], size: number): T[][] { const out: T[][] = []; for (let i=0;i<arr.length;i+=size) out.push(arr.slice(i,i+size)); return out; }
