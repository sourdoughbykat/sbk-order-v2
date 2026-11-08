-- Kat's View can text the waitlist from Kat's own phone. This remembers when each
-- person was last texted, so she can see who she's already reached.
alter table public.waitlist add column last_texted_at timestamptz;
