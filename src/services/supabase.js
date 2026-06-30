/**
 * Wheel Edge — Supabase Client
 *
 * Configuration via environment variables:
 *   REACT_APP_SUPABASE_URL      https://xxxx.supabase.co
 *   REACT_APP_SUPABASE_ANON_KEY  eyJhbGc...
 *
 * The app works without Supabase (falls back to localStorage cache).
 */

import { createClient } from '@supabase/supabase-js';

const SUPABASE_URL  = process.env.REACT_APP_SUPABASE_URL  || '';
const SUPABASE_KEY  = process.env.REACT_APP_SUPABASE_ANON_KEY || '';

export const isSupabaseConfigured = () =>
  Boolean(SUPABASE_URL && SUPABASE_KEY &&
    SUPABASE_URL.startsWith('https://') &&
    SUPABASE_KEY.length > 20);

export const supabase = isSupabaseConfigured()
  ? createClient(SUPABASE_URL, SUPABASE_KEY, {
      auth: { persistSession: true, autoRefreshToken: true },
    })
  : null;

/** Quick reachability check — returns true if Supabase responded */
export async function checkSupabaseConnection() {
  if (!supabase) return { ok: false, reason: 'Not configured' };
  try {
    const { error } = await supabase.from('positions').select('id').limit(1);
    if (error) return { ok: false, reason: error.message };
    return { ok: true };
  } catch (e) {
    return { ok: false, reason: e.message };
  }
}
