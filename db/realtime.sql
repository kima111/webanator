-- Enable Supabase Realtime for annotations and messages tables
-- Run these in Supabase SQL editor (Dashboard → SQL) on your project.

-- Ensure DELETE/UPDATE events provide enough info for listeners
ALTER TABLE public.annotations REPLICA IDENTITY FULL;
ALTER TABLE public.annotation_messages REPLICA IDENTITY FULL;

-- Add tables to the realtime publication (so changes are streamed)
ALTER PUBLICATION supabase_realtime ADD TABLE public.annotations;
ALTER PUBLICATION supabase_realtime ADD TABLE public.annotation_messages;

-- If the table is already in the publication, Postgres will warn; it is safe to ignore.
