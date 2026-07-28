import { createClient, type SupabaseClient } from "@supabase/supabase-js";

let cachedClient: SupabaseClient | null | undefined;

/**
 * Test-only override for the service client.
 *
 * ESM namespace objects are frozen, so the tenant-isolation suite cannot patch
 * getSupabaseServerClient from the outside. This seam lets a test install a
 * spying client and assert which tables and filters a request reaches.
 *
 * It is inert unless something explicitly calls the setter below: no request
 * path, environment variable or header can reach it, and the default export
 * behaviour is unchanged.
 */
let testClientFactory: (() => SupabaseClient | null) | null = null;

export function setSupabaseServerClientFactoryForTests(
  factory: (() => SupabaseClient | null) | null,
): void {
  testClientFactory = factory;
}

export function getSupabaseServerClient(): SupabaseClient | null {
  if (testClientFactory) {
    return testClientFactory();
  }

  const supabaseUrl = process.env.SUPABASE_URL?.trim();
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY?.trim();

  if (!supabaseUrl || !serviceRoleKey) {
    return null;
  }

  if (cachedClient === undefined) {
    cachedClient = createClient(supabaseUrl, serviceRoleKey, {
      auth: {
        autoRefreshToken: false,
        persistSession: false,
      },
    });
  }

  return cachedClient;
}
