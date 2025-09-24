-- Storage RLS for the 'uploads' bucket ONLY
-- Safe to run multiple times. Affects storage.objects reads for this bucket only.
-- Run in Supabase SQL Editor.

-- NOTE: RLS on storage.objects is already enabled by Supabase. Avoid altering table ownership.

-- Policies are created with the current session role in the SQL editor.

-- Helper membership functions are referenced in app migrations; recreate safely if missing
DO $$
BEGIN
  BEGIN
    CREATE OR REPLACE FUNCTION public.is_member_of_project(pid uuid)
    RETURNS boolean
    LANGUAGE sql
    SECURITY DEFINER
    SET search_path = public, pg_temp
    AS $fn$
      select exists (
        select 1 from public.project_members
        where project_id = pid and user_id = auth.uid()
      );
    $fn$;
  EXCEPTION WHEN others THEN NULL; END;

  BEGIN
    CREATE OR REPLACE FUNCTION public.is_owner_of_project(pid uuid)
    RETURNS boolean
    LANGUAGE sql
    SECURITY DEFINER
    SET search_path = public, pg_temp
    AS $fn$
      select exists (
        select 1 from public.projects p
        where p.id = pid and p.owner_id = auth.uid()
      );
    $fn$;
  EXCEPTION WHEN others THEN NULL; END;
END
$$;

-- Read policy: any member of the project in metadata.project_id can read objects in 'uploads' bucket
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname='storage' AND tablename='objects'
      AND policyname='uploads_select_if_member'
  ) THEN
    ALTER POLICY uploads_select_if_member
      ON storage.objects
      USING (
        bucket_id = 'uploads'
        AND (metadata ? 'project_id')
        AND public.is_member_of_project((metadata->>'project_id')::uuid)
      );
  ELSE
    CREATE POLICY uploads_select_if_member
      ON storage.objects FOR SELECT
      USING (
        bucket_id = 'uploads'
        AND (metadata ? 'project_id')
        AND public.is_member_of_project((metadata->>'project_id')::uuid)
      );
  END IF;
END
$$;

-- End of bucket-specific policy

-- Optional examples (commented): if you later want client-side uploads/deletes with user creds
-- CREATE POLICY uploads_insert_if_editor_or_owner
--   ON storage.objects FOR INSERT
--   WITH CHECK (
--     bucket_id = 'uploads'
--     AND (metadata ? 'project_id')
--     AND (
--       public.is_owner_of_project((metadata->>'project_id')::uuid)
--       OR EXISTS (
--         SELECT 1 FROM public.project_members pm
--         WHERE pm.project_id = (metadata->>'project_id')::uuid
--           AND pm.user_id = auth.uid() AND pm.role IN ('editor','owner')
--       )
--     )
--   );

-- CREATE POLICY uploads_delete_if_owner
--   ON storage.objects FOR DELETE
--   USING (
--     bucket_id = 'uploads'
--     AND (metadata ? 'project_id')
--     AND public.is_owner_of_project((metadata->>'project_id')::uuid)
--   );
