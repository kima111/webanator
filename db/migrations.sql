-- Project members roles + acceptance + comments table and RLS
-- Run in Supabase SQL editor (Postgres) or psql connected to your project.

-- Ensure gen_random_uuid() is available
CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- 1) Columns (safe if they already exist)
ALTER TABLE public.project_members
  ADD COLUMN IF NOT EXISTS role text CHECK (role IN ('viewer','editor','owner')) DEFAULT 'viewer';

ALTER TABLE public.project_members
  ADD COLUMN IF NOT EXISTS joined_at timestamptz;

-- Ensure a sensible default and backfill any nulls
ALTER TABLE public.project_members ALTER COLUMN joined_at SET DEFAULT now();
UPDATE public.project_members SET joined_at = now() WHERE joined_at IS NULL;

-- 2) Helpful index
CREATE INDEX IF NOT EXISTS idx_project_members_project_user
  ON public.project_members(project_id, user_id);

-- 3) Enable RLS (if not already)
ALTER TABLE public.projects ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.project_members ENABLE ROW LEVEL SECURITY;

-- Ensure projects.owner_id exists and RLS is enabled
ALTER TABLE public.projects ADD COLUMN IF NOT EXISTS owner_id uuid;
CREATE INDEX IF NOT EXISTS idx_projects_owner ON public.projects(owner_id);

-- Projects policies
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname='public' AND tablename='projects'
      AND policyname='projects_select_member_or_owner'
  ) THEN
    CREATE POLICY projects_select_member_or_owner
      ON public.projects FOR SELECT
      USING (
        owner_id = auth.uid()
        OR EXISTS (
          SELECT 1 FROM public.project_members pm
          WHERE pm.project_id = projects.id AND pm.user_id = auth.uid()
        )
      );
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname='public' AND tablename='projects'
      AND policyname='projects_insert_owner'
  ) THEN
    CREATE POLICY projects_insert_owner
      ON public.projects FOR INSERT
      WITH CHECK (owner_id = auth.uid());
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname='public' AND tablename='projects'
      AND policyname='projects_update_owner'
  ) THEN
    CREATE POLICY projects_update_owner
      ON public.projects FOR UPDATE
      USING (owner_id = auth.uid())
      WITH CHECK (owner_id = auth.uid());
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname='public' AND tablename='projects'
      AND policyname='projects_delete_owner'
  ) THEN
    CREATE POLICY projects_delete_owner
      ON public.projects FOR DELETE
      USING (owner_id = auth.uid());
  END IF;
END
$$;

-- Optional: comments table for annotations/discussions
CREATE TABLE IF NOT EXISTS public.project_comments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id uuid NOT NULL REFERENCES public.projects(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  body text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz
);

ALTER TABLE public.project_comments ENABLE ROW LEVEL SECURITY;

-- Helpful index for comment lookups per project
CREATE INDEX IF NOT EXISTS idx_project_comments_project
  ON public.project_comments(project_id);

-- Maintain updated_at automatically on updates
CREATE OR REPLACE FUNCTION public.set_updated_at()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  NEW.updated_at := now();
  RETURN NEW;
END
$$;

DROP TRIGGER IF EXISTS trg_project_comments_updated_at ON public.project_comments;

CREATE TRIGGER trg_project_comments_updated_at
BEFORE UPDATE ON public.project_comments
FOR EACH ROW
EXECUTE FUNCTION public.set_updated_at();

-- 4) Policies
-- View projects if you are a member

-- Replace any previous recursive project_members policies
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname='public' AND tablename='project_members'
      AND policyname='project_members_select_if_in_project'
  ) THEN
    DROP POLICY "project_members_select_if_in_project" ON public.project_members;
  END IF;

  IF EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname='public' AND tablename='project_members'
      AND policyname='project_members_insert_if_owner'
  ) THEN
    DROP POLICY "project_members_insert_if_owner" ON public.project_members;
  END IF;

  IF EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname='public' AND tablename='project_members'
      AND policyname='project_members_update_if_owner'
  ) THEN
    DROP POLICY "project_members_update_if_owner" ON public.project_members;
  END IF;

  IF EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname='public' AND tablename='project_members'
      AND policyname='project_members_delete_if_owner'
  ) THEN
    DROP POLICY "project_members_delete_if_owner" ON public.project_members;
  END IF;
END
$$;

-- Minimal non-recursive project_members policies
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname='public' AND tablename='project_members'
      AND policyname='project_members_select_own'
  ) THEN
    CREATE POLICY "project_members_select_own"
      ON public.project_members FOR SELECT
      USING (user_id = auth.uid());
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname='public' AND tablename='project_members'
      AND policyname='project_members_insert_self'
  ) THEN
    CREATE POLICY "project_members_insert_self"
      ON public.project_members FOR INSERT
      WITH CHECK (user_id = auth.uid());
  END IF;
END
$$;

-- Comments policies
-- Read: any project member can read all comments for that project
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'public'
      AND tablename = 'project_comments'
      AND policyname = 'project_comments_select_if_member'
  ) THEN
    CREATE POLICY "project_comments_select_if_member"
      ON public.project_comments FOR SELECT
      USING (
        EXISTS (
          SELECT 1
          FROM public.project_members pm
          WHERE pm.project_id = project_comments.project_id
            AND pm.user_id = auth.uid()
        )
      );
  END IF;
END
$$;

-- Insert: editor or owner can add comments, but only as themselves
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'public'
      AND tablename = 'project_comments'
      AND policyname = 'project_comments_insert_if_editor_or_owner'
  ) THEN
    ALTER POLICY "project_comments_insert_if_editor_or_owner"
      ON public.project_comments
      WITH CHECK (
        user_id = auth.uid()
        AND EXISTS (
          SELECT 1
          FROM public.project_members pm
          WHERE pm.project_id = project_comments.project_id
            AND pm.user_id = auth.uid()
            AND pm.role IN ('editor','owner')
        )
      );
  ELSE
    CREATE POLICY "project_comments_insert_if_editor_or_owner"
      ON public.project_comments FOR INSERT
      WITH CHECK (
        user_id = auth.uid()
        AND EXISTS (
          SELECT 1
          FROM public.project_members pm
          WHERE pm.project_id = project_comments.project_id
            AND pm.user_id = auth.uid()
            AND pm.role IN ('editor','owner')
        )
      );
  END IF;
END
$$;

-- Update: owner can edit any comment; editor can edit only their own.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'public'
      AND tablename = 'project_comments'
      AND policyname = 'project_comments_update_if_owner_or_self_editor'
  ) THEN
    ALTER POLICY "project_comments_update_if_owner_or_self_editor"
      ON public.project_comments
      USING (
        EXISTS (
          SELECT 1
          FROM public.project_members pm
          WHERE pm.project_id = project_comments.project_id
            AND pm.user_id = auth.uid()
            AND (pm.role = 'owner' OR (pm.role = 'editor' AND user_id = auth.uid()))
        )
      )
      WITH CHECK (
        EXISTS (
          SELECT 1
          FROM public.project_members pm
          WHERE pm.project_id = project_comments.project_id
            AND pm.user_id = auth.uid()
            AND (pm.role = 'owner' OR (pm.role = 'editor' AND user_id = auth.uid()))
        )
      );
  ELSE
    CREATE POLICY "project_comments_update_if_owner_or_self_editor"
      ON public.project_comments FOR UPDATE
      USING (
        EXISTS (
          SELECT 1
          FROM public.project_members pm
          WHERE pm.project_id = project_comments.project_id
            AND pm.user_id = auth.uid()
            AND (pm.role = 'owner' OR (pm.role = 'editor' AND user_id = auth.uid()))
        )
      )
      WITH CHECK (
        EXISTS (
          SELECT 1
          FROM public.project_members pm
          WHERE pm.project_id = project_comments.project_id
            AND pm.user_id = auth.uid()
            AND (pm.role = 'owner' OR (pm.role = 'editor' AND user_id = auth.uid()))
        )
      );
  END IF;
END
$$;

-- Delete: owner can delete any, editor can delete own
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'public'
      AND tablename = 'project_comments'
      AND policyname = 'project_comments_delete_if_owner_or_self_editor'
  ) THEN
    CREATE POLICY "project_comments_delete_if_owner_or_self_editor"
      ON public.project_comments FOR DELETE
      USING (
        EXISTS (
          SELECT 1
          FROM public.project_members pm
          WHERE pm.project_id = project_comments.project_id
            AND pm.user_id = auth.uid()
            AND (pm.role = 'owner' OR (pm.role = 'editor' AND user_id = auth.uid()))
        )
      );
  END IF;
END
$$;

-- Optional: annotations (only if table exists)
DO $$
BEGIN
  IF to_regclass('public.annotations') IS NOT NULL THEN
    IF NOT EXISTS (
      SELECT 1 FROM pg_policies
      WHERE schemaname='public' AND tablename='annotations'
        AND policyname='annotations_insert_by_member'
    ) THEN
      CREATE POLICY annotations_insert_by_member
        ON public.annotations FOR INSERT
        WITH CHECK (
          EXISTS (
            SELECT 1 FROM public.project_members pm
            WHERE pm.project_id = annotations.project_id
              AND pm.user_id = auth.uid()
          )
        );
    END IF;

    IF NOT EXISTS (
      SELECT 1 FROM pg_policies
      WHERE schemaname='public' AND tablename='annotations'
        AND policyname='annotations_select_by_member'
    ) THEN
      CREATE POLICY annotations_select_by_member
        ON public.annotations FOR SELECT
        USING (
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

-- Clean up legacy INSERT policies on projects that may reference NEW.owner
DO $$
DECLARE p record;
BEGIN
  FOR p IN
    SELECT policyname
    FROM pg_policies
    WHERE schemaname = 'public'
      AND tablename = 'projects'
      AND cmd = 'INSERT'
      AND policyname <> 'projects_insert_owner'
  LOOP
    EXECUTE format('DROP POLICY %I ON public.projects', p.policyname);
  END LOOP;
END
$$;

-- Ensure the canonical INSERT policy is present (checks owner_id)
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname='public' AND tablename='projects'
      AND policyname='projects_insert_owner'
  ) THEN
    CREATE POLICY projects_insert_owner
      ON public.projects FOR INSERT
      WITH CHECK (owner_id = auth.uid());
  END IF;
END
$$;

-- Cleanup: remove any projects RLS policies still referencing "owner" / NEW.owner
DO $$
DECLARE pol record;
BEGIN
  FOR pol IN
    SELECT policyname
    FROM pg_policies
    WHERE schemaname = 'public'
      AND tablename = 'projects'
      AND (
        COALESCE(qual, '') ILIKE '%NEW.owner%' OR
        COALESCE(with_check, '') ILIKE '%NEW.owner%' OR
        COALESCE(qual, '') ILIKE '% owner %' OR
        COALESCE(with_check, '') ILIKE '% owner %'
      )
  LOOP
    EXECUTE format('DROP POLICY %I ON public.projects', pol.policyname);
  END LOOP;
END
$$;

-- Cleanup: drop any triggers on projects whose function body references "owner"
DO $$
DECLARE trg record;
BEGIN
  FOR trg IN
    SELECT t.tgname
    FROM pg_trigger t
    JOIN pg_proc p ON p.oid = t.tgfoid
    WHERE t.tgrelid = 'public.projects'::regclass
      AND NOT t.tgisinternal
      AND pg_get_functiondef(p.oid) ILIKE '%owner%'
  LOOP
    EXECUTE format('DROP TRIGGER %I ON public.projects', trg.tgname);
  END LOOP;
END
$$;

-- Ensure canonical INSERT policy (owner_id = auth.uid()) exists
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname='public' AND tablename='projects'
      AND policyname='projects_insert_owner'
  ) THEN
    CREATE POLICY projects_insert_owner
      ON public.projects FOR INSERT
      WITH CHECK (owner_id = auth.uid());
  END IF;
END
$$;

-- Drop constraints on public.projects that still reference "owner"
DO $$
DECLARE c record;
BEGIN
  FOR c IN
    SELECT conname
    FROM pg_constraint
    WHERE conrelid = 'public.projects'::regclass
      AND pg_get_constraintdef(oid) ILIKE '%owner%'
  LOOP
    EXECUTE format('ALTER TABLE public.projects DROP CONSTRAINT %I', c.conname);
  END LOOP;
END
$$;

-- Ensure canonical INSERT policy remains (owner_id = auth.uid())
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname='public' AND tablename='projects'
      AND policyname='projects_insert_owner'
  ) THEN
    CREATE POLICY projects_insert_owner
      ON public.projects FOR INSERT
      WITH CHECK (owner_id = auth.uid());
  END IF;
END
$$;

-- Ensure a unique constraint for upserts on project_members (project_id, user_id)
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conrelid = 'public.project_members'::regclass
      AND conname = 'project_members_unique'
  ) THEN
    ALTER TABLE public.project_members
      ADD CONSTRAINT project_members_unique UNIQUE (project_id, user_id);
  END IF;
END
$$;

-- Enable RLS + policies for annotation_messages (required for Realtime delivery)
DO $$
BEGIN
  IF to_regclass('public.annotation_messages') IS NOT NULL THEN
    -- Enable RLS
    EXECUTE 'ALTER TABLE public.annotation_messages ENABLE ROW LEVEL SECURITY';

    -- SELECT: any project member can read messages for annotations in their projects
    IF NOT EXISTS (
      SELECT 1 FROM pg_policies
      WHERE schemaname='public' AND tablename='annotation_messages'
        AND policyname='annotation_messages_select_if_member'
    ) THEN
      CREATE POLICY annotation_messages_select_if_member
        ON public.annotation_messages FOR SELECT
        USING (
          EXISTS (
            SELECT 1
            FROM public.annotations a
            JOIN public.project_members pm ON pm.project_id = a.project_id
            WHERE a.id = annotation_messages.annotation_id
              AND pm.user_id = auth.uid()
          )
        );
    END IF;

    -- INSERT: editors or owners can add messages; must insert as themselves
    IF NOT EXISTS (
      SELECT 1 FROM pg_policies
      WHERE schemaname='public' AND tablename='annotation_messages'
        AND policyname='annotation_messages_insert_if_editor_or_owner'
    ) THEN
      CREATE POLICY annotation_messages_insert_if_editor_or_owner
        ON public.annotation_messages FOR INSERT
        WITH CHECK (
          author_id = auth.uid()
          AND EXISTS (
            SELECT 1
            FROM public.annotations a
            JOIN public.project_members pm ON pm.project_id = a.project_id
            WHERE a.id = annotation_messages.annotation_id
              AND pm.user_id = auth.uid()
              AND pm.role IN ('editor','owner')
          )
        );
    END IF;

    -- UPDATE: owner can edit any; editor can edit their own
    IF NOT EXISTS (
      SELECT 1 FROM pg_policies
      WHERE schemaname='public' AND tablename='annotation_messages'
        AND policyname='annotation_messages_update_if_owner_or_self_editor'
    ) THEN
      CREATE POLICY annotation_messages_update_if_owner_or_self_editor
        ON public.annotation_messages FOR UPDATE
        USING (
          EXISTS (
            SELECT 1
            FROM public.annotations a
            JOIN public.project_members pm ON pm.project_id = a.project_id
            WHERE a.id = annotation_messages.annotation_id
              AND pm.user_id = auth.uid()
              AND (pm.role = 'owner' OR (pm.role = 'editor' AND author_id = auth.uid()))
          )
        )
        WITH CHECK (
          EXISTS (
            SELECT 1
            FROM public.annotations a
            JOIN public.project_members pm ON pm.project_id = a.project_id
            WHERE a.id = annotation_messages.annotation_id
              AND pm.user_id = auth.uid()
              AND (pm.role = 'owner' OR (pm.role = 'editor' AND author_id = auth.uid()))
          )
        );
    END IF;

    -- DELETE: owner can delete any; editor can delete own
    IF NOT EXISTS (
      SELECT 1 FROM pg_policies
      WHERE schemaname='public' AND tablename='annotation_messages'
        AND policyname='annotation_messages_delete_if_owner_or_self_editor'
    ) THEN
      CREATE POLICY annotation_messages_delete_if_owner_or_self_editor
        ON public.annotation_messages FOR DELETE
        USING (
          EXISTS (
            SELECT 1
            FROM public.annotations a
            JOIN public.project_members pm ON pm.project_id = a.project_id
            WHERE a.id = annotation_messages.annotation_id
              AND pm.user_id = auth.uid()
              AND (pm.role = 'owner' OR (pm.role = 'editor' AND author_id = auth.uid()))
          )
        );
    END IF;
  END IF;
END
$$;
