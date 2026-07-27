// Security-1A: the Meta Pixel bootstrap previously read `clinics.fb_pixel_id`
// directly from the browser. The `clinics` table does not exist in the
// production Supabase project, so the lookup always failed and the pixel never
// initialised.
//
// There is currently no supported configuration source for a per-clinic pixel
// ID, so the pixel stays disabled rather than falling back to a hardcoded or
// guessed value. No customer or medical data is transmitted. When a real,
// server-provided pixel configuration exists, initialise it from that source.
export default function FbPixelInit() {
  return null;
}
