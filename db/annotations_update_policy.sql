-- Allow any project member to update annotations
DO $$
BEGIN
  IF to_regclass('public.annotations') IS NOT NULL THEN
    IF NOT EXISTS (
      SELECT 1 FROM pg_policies
      WHERE schemaname='public' AND tablename='annotations'
        AND policyname='annotations_update_by_member'
    ) THEN
      CREATE POLICY annotations_update_by_member
        ON public.annotations FOR UPDATE
        USING (
          EXISTS (
            SELECT 1 FROM public.project_members pm
            WHERE pm.project_id = annotations.project_id
              AND pm.user_id = auth.uid()
          )
        )
        WITH CHECK (
          EXISTS (
            SELECT 1 FROM public.project_members pm
            WHERE pm.project_id = annotations.project_id
              AND pm.user_id = auth.uid()
          )
        );
    END IF;
  END IF;
END
$$;
