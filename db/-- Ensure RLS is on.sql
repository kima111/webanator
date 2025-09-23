-- Ensure RLS is on
ALTER TABLE public.project_members ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.annotations ENABLE ROW LEVEL SECURITY;

-- Allow any member of a project to read all members of that same project
DO $$
BEGIN
  -- Helper function (idempotent)
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
    ALTER FUNCTION public.is_member_of_project(pid uuid) OWNER TO postgres;
    GRANT EXECUTE ON FUNCTION public.is_member_of_project(uuid) TO authenticated, anon;
  EXCEPTION WHEN others THEN NULL;
  END;

  -- Helper function to check ownership without cross-table EXISTS in policies
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
    ALTER FUNCTION public.is_owner_of_project(pid uuid) OWNER TO postgres;
    GRANT EXECUTE ON FUNCTION public.is_owner_of_project(uuid) TO authenticated, anon;
  EXCEPTION WHEN others THEN NULL;
  END;

  -- Drop recursive policy if present
  BEGIN
    EXECUTE 'DROP POLICY IF EXISTS "project_members_select_if_in_project" ON public.project_members';
  EXCEPTION WHEN others THEN NULL; END;

  IF EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname='public' AND tablename='project_members'
      AND policyname='project_members_select_if_in_project'
  ) THEN
    ALTER POLICY "project_members_select_if_in_project"
      ON public.project_members
      USING (
        public.is_member_of_project(project_members.project_id)
        OR public.is_owner_of_project(project_members.project_id)
      );
  ELSE
    CREATE POLICY "project_members_select_if_in_project"
      ON public.project_members FOR SELECT
      USING (
        public.is_member_of_project(project_members.project_id)
        OR public.is_owner_of_project(project_members.project_id)
      );
  END IF;
END
$$;

-- Ensure projects select uses function-based membership to avoid recursion
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname='public' AND tablename='projects'
      AND policyname='projects_select_member_or_owner'
  ) THEN
    ALTER POLICY projects_select_member_or_owner
      ON public.projects
      USING (
        owner_id = auth.uid()
        OR public.is_member_of_project(projects.id)
      );
  ELSE
    CREATE POLICY projects_select_member_or_owner
      ON public.projects FOR SELECT
      USING (
        owner_id = auth.uid()
        OR public.is_member_of_project(projects.id)
      );
  END IF;
END
$$;

-- Only editors/owners can update annotations (e.g., status, assigned_to)
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname='public' AND tablename='annotations'
      AND policyname='annotations_update_if_editor_or_owner'
  ) THEN
    ALTER POLICY annotations_update_if_editor_or_owner
      ON public.annotations
      USING (
        EXISTS (
          SELECT 1 FROM public.project_members pm
          WHERE pm.project_id = annotations.project_id
            AND pm.user_id = auth.uid()
            AND pm.role IN ('editor','owner')
        )
        OR public.is_owner_of_project(annotations.project_id)
      )
      WITH CHECK (
        EXISTS (
          SELECT 1 FROM public.project_members pm
          WHERE pm.project_id = annotations.project_id
            AND pm.user_id = auth.uid()
            AND pm.role IN ('editor','owner')
        )
        OR public.is_owner_of_project(annotations.project_id)
      );
  ELSE
    CREATE POLICY annotations_update_if_editor_or_owner
      ON public.annotations FOR UPDATE
      USING (
        EXISTS (
          SELECT 1 FROM public.project_members pm
          WHERE pm.project_id = annotations.project_id
            AND pm.user_id = auth.uid()
            AND pm.role IN ('editor','owner')
        )
        OR public.is_owner_of_project(annotations.project_id)
      )
      WITH CHECK (
        EXISTS (
          SELECT 1 FROM public.project_members pm
          WHERE pm.project_id = annotations.project_id
            AND pm.user_id = auth.uid()
            AND pm.role IN ('editor','owner')
        )
        OR public.is_owner_of_project(annotations.project_id)
      );
  END IF;
END
$$;