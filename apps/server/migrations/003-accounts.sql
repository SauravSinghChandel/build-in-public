-- M5: connected publishing accounts. Secrets live in the OS keychain (or the
-- encrypted fallback file); these tables only hold metadata and references.
CREATE TABLE platform_apps(platform TEXT PRIMARY KEY CHECK(platform IN ('x','linkedin')),client_id TEXT NOT NULL,secret_ref TEXT,updated_at TEXT NOT NULL);
CREATE TABLE accounts(id TEXT PRIMARY KEY,platform TEXT NOT NULL UNIQUE CHECK(platform IN ('x','linkedin')),handle TEXT NOT NULL,display_name TEXT,external_user_id TEXT NOT NULL,keychain_ref TEXT NOT NULL,scopes TEXT NOT NULL DEFAULT '',expires_at TEXT,created_at TEXT NOT NULL);
