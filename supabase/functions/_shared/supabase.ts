import { createClient, type SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2.45.4";
import { requireEnv } from "./env.ts";

export function createSupabaseAdminClient(): SupabaseClient {
  // Supabase dashboard doesn't allow secret names starting with "SUPABASE_",
  // so we use shorter names: URL, SERVICE_ROLE_KEY
  const url = requireEnv("URL");
  const serviceRoleKey = requireEnv("SERVICE_ROLE_KEY");
  return createClient(url, serviceRoleKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}


