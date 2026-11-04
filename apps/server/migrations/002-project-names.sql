-- Retain a useful display name when the repository directory is missing.
ALTER TABLE projects ADD COLUMN display_name TEXT;
