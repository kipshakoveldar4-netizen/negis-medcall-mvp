-- Recruitment intake only. No clinic membership, referral binding, commission
-- rate or payment is created by applying or approving either contributor role.
BEGIN;
CREATE TABLE IF NOT EXISTS public.growth_contributor_profiles (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  auth_user_id uuid NOT NULL UNIQUE,
  display_name text NOT NULL CHECK (char_length(btrim(display_name)) BETWEEN 1 AND 120),
  portfolio_urls text[] NOT NULL DEFAULT '{}' CHECK (cardinality(portfolio_urls) <= 5),
  partner_status text CHECK (partner_status IN ('pending','approved','suspended')),
  creator_status text CHECK (creator_status IN ('pending','approved','suspended')),
  revision uuid NOT NULL DEFAULT gen_random_uuid(),
  partner_reviewed_by uuid,
  creator_reviewed_by uuid,
  partner_reviewed_at timestamptz,
  creator_reviewed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK (partner_status IS NOT NULL OR creator_status IS NOT NULL)
);
CREATE INDEX IF NOT EXISTS growth_contributor_profiles_created_idx
  ON public.growth_contributor_profiles(created_at DESC,id);
ALTER TABLE public.growth_contributor_profiles ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.growth_contributor_profiles FROM PUBLIC,anon,authenticated;
REVOKE ALL ON public.growth_contributor_profiles FROM service_role;
GRANT SELECT ON public.growth_contributor_profiles TO service_role;

CREATE OR REPLACE FUNCTION public.apply_growth_contributor(
  p_actor uuid,p_name text,p_partner boolean,p_creator boolean,p_urls text[]
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public,pg_temp AS $$
DECLARE result public.growth_contributor_profiles;
BEGIN
  IF p_actor IS NULL OR p_name IS NULL OR char_length(btrim(p_name)) NOT BETWEEN 1 AND 120
    OR p_partner IS NULL OR p_creator IS NULL OR NOT (p_partner OR p_creator)
    OR p_urls IS NULL OR cardinality(p_urls)>5 OR EXISTS (
      SELECT 1 FROM unnest(p_urls) u WHERE u IS NULL OR char_length(u)>500 OR u !~ '^https://[^[:space:]]+$'
    ) THEN RAISE EXCEPTION 'invalid_contributor_application' USING ERRCODE='P1051'; END IF;
  INSERT INTO public.growth_contributor_profiles(auth_user_id,display_name,portfolio_urls,partner_status,creator_status)
  VALUES(p_actor,btrim(p_name),p_urls,CASE WHEN p_partner THEN 'pending' END,CASE WHEN p_creator THEN 'pending' END)
  ON CONFLICT(auth_user_id) DO NOTHING;
  SELECT * INTO STRICT result FROM public.growth_contributor_profiles WHERE auth_user_id=p_actor FOR UPDATE;
  -- Replay never edits an approved identity, resets a refusal, or removes a role.
  IF (p_partner AND result.partner_status IS NULL) OR (p_creator AND result.creator_status IS NULL) THEN
    UPDATE public.growth_contributor_profiles SET
      partner_status=CASE WHEN p_partner AND partner_status IS NULL THEN 'pending' ELSE partner_status END,
      creator_status=CASE WHEN p_creator AND creator_status IS NULL THEN 'pending' ELSE creator_status END,
      revision=gen_random_uuid()
    WHERE id=result.id RETURNING * INTO result;
  END IF;
  RETURN to_jsonb(result);
END $$;

CREATE OR REPLACE FUNCTION public.review_growth_contributor(
  p_id uuid,p_revision uuid,p_owner uuid,p_role text,p_action text
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public,pg_temp AS $$
DECLARE result public.growth_contributor_profiles; current_status text;
BEGIN
  IF p_id IS NULL OR p_revision IS NULL OR p_owner IS NULL OR p_role IS NULL OR p_action IS NULL
    OR p_role NOT IN ('partner','creator') OR p_action NOT IN ('approve','suspend')
    THEN RAISE EXCEPTION 'invalid_contributor_review' USING ERRCODE='P1051'; END IF;
  SELECT * INTO result FROM public.growth_contributor_profiles WHERE id=p_id FOR UPDATE;
  IF NOT FOUND OR result.revision<>p_revision THEN
    RAISE EXCEPTION 'contributor_review_changed' USING ERRCODE='P1052'; END IF;
  current_status=CASE WHEN p_role='partner' THEN result.partner_status ELSE result.creator_status END;
  IF current_status IS NULL OR (p_action='approve' AND current_status='approved')
    OR (p_action='suspend' AND current_status<>'approved') THEN
    RAISE EXCEPTION 'contributor_review_changed' USING ERRCODE='P1052'; END IF;
  UPDATE public.growth_contributor_profiles SET
    partner_status=CASE WHEN p_role='partner' THEN CASE WHEN p_action='approve' THEN 'approved' ELSE 'suspended' END ELSE partner_status END,
    creator_status=CASE WHEN p_role='creator' THEN CASE WHEN p_action='approve' THEN 'approved' ELSE 'suspended' END ELSE creator_status END,
    partner_reviewed_by=CASE WHEN p_role='partner' THEN p_owner ELSE partner_reviewed_by END,
    creator_reviewed_by=CASE WHEN p_role='creator' THEN p_owner ELSE creator_reviewed_by END,
    partner_reviewed_at=CASE WHEN p_role='partner' THEN now() ELSE partner_reviewed_at END,
    creator_reviewed_at=CASE WHEN p_role='creator' THEN now() ELSE creator_reviewed_at END,
    revision=gen_random_uuid()
  WHERE id=p_id RETURNING * INTO result;
  RETURN to_jsonb(result);
END $$;
REVOKE ALL ON FUNCTION public.apply_growth_contributor(uuid,text,boolean,boolean,text[]) FROM PUBLIC,anon,authenticated;
REVOKE ALL ON FUNCTION public.review_growth_contributor(uuid,uuid,uuid,text,text) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.apply_growth_contributor(uuid,text,boolean,boolean,text[]) TO service_role;
GRANT EXECUTE ON FUNCTION public.review_growth_contributor(uuid,uuid,uuid,text,text) TO service_role;
COMMIT;
