import { useEffect } from 'react';
import { useAuth } from '@/contexts/AuthContext';
import { supabase } from '@/lib/supabase';
import { initPixel } from '@/lib/fbpixel';

export default function FbPixelInit() {
  const { clinicId } = useAuth();

  useEffect(() => {
    if (!clinicId) return;
    supabase
      .from('clinics')
      .select('fb_pixel_id')
      .eq('id', clinicId)
      .single()
      .then(({ data }) => {
        if (data?.fb_pixel_id) initPixel(data.fb_pixel_id);
      });
  }, [clinicId]);

  return null;
}
