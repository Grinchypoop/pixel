import { createClient } from '@supabase/supabase-js';

const url = process.env.PIXEL_SUPABASE_URL!;
const key = process.env.PIXEL_SUPABASE_SERVICE_KEY!;

if (!url || !key) throw new Error('PIXEL_SUPABASE_URL and PIXEL_SUPABASE_SERVICE_KEY must be set');

export const db = createClient(url, key, {
  auth: { persistSession: false },
});
