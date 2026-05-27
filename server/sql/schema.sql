-- Schema Postgres equivalente al flat-file ecommagic.json.
-- Compatible con Supabase. Diseño 1:1 con las tablas/colecciones JS
-- existentes en server/db.js, preservando nombres y tipos para que el
-- refactor de db.js sólo cambie la implementación, no la interfaz pública.
--
-- Tipos:
--   • IDs: SERIAL (autoincrement)
--   • Timestamps: TIMESTAMPTZ con default NOW()
--   • booleans guardados como SMALLINT (compat con el shape JSON: 0/1)
--   • Campos array/object complejos: JSONB

-- ─────────────────────────────────────────────────────────────────
-- USERS
-- ─────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS users (
  id           SERIAL PRIMARY KEY,
  first_name   TEXT NOT NULL,
  last_name    TEXT NOT NULL,
  email        TEXT UNIQUE NOT NULL,
  country      TEXT,
  phone_prefix TEXT,
  phone        TEXT,
  password     TEXT NOT NULL,
  role         TEXT NOT NULL DEFAULT 'user',
  plan         TEXT NOT NULL DEFAULT 'trial',
  credits      INTEGER NOT NULL DEFAULT 0,
  is_active    SMALLINT NOT NULL DEFAULT 1,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS users_email_lower_idx ON users (LOWER(email));
CREATE INDEX IF NOT EXISTS users_role_idx        ON users (role);
CREATE INDEX IF NOT EXISTS users_created_at_idx  ON users (created_at DESC);

-- ─────────────────────────────────────────────────────────────────
-- USER SETTINGS (1:1 con users)
-- ─────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS user_settings (
  user_id        INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  claude_key     TEXT,
  gemini_key     TEXT,
  openai_key     TEXT,
  kieai_key      TEXT,
  apify_key      TEXT,
  elevenlabs_key TEXT,
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ─────────────────────────────────────────────────────────────────
-- PRODUCTS + sus tablas hijas (todas con cascade)
-- ─────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS products (
  id          SERIAL PRIMARY KEY,
  user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name        TEXT NOT NULL,
  description TEXT,
  image       TEXT,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at  TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS products_user_id_idx    ON products (user_id);
CREATE INDEX IF NOT EXISTS products_created_at_idx ON products (created_at DESC);

CREATE TABLE IF NOT EXISTS product_research (
  id         SERIAL PRIMARY KEY,
  product_id INTEGER NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  title      TEXT,
  content    TEXT,
  model      TEXT,
  provider   TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS product_research_product_id_idx ON product_research (product_id);

CREATE TABLE IF NOT EXISTS product_angles (
  id         SERIAL PRIMARY KEY,
  product_id INTEGER NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  content    TEXT,
  model      TEXT,
  provider   TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS product_angles_product_id_idx ON product_angles (product_id);

CREATE TABLE IF NOT EXISTS product_ads (
  id         SERIAL PRIMARY KEY,
  product_id INTEGER NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  image_path TEXT NOT NULL,
  prompt     TEXT,
  size       TEXT,
  template   TEXT,
  headline   TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS product_ads_product_id_idx ON product_ads (product_id);

CREATE TABLE IF NOT EXISTS product_landings (
  id         SERIAL PRIMARY KEY,
  product_id INTEGER NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  image_path TEXT NOT NULL,
  prompt     TEXT,
  size       TEXT,
  template   TEXT,
  category   TEXT,
  headline   TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS product_landings_product_id_idx ON product_landings (product_id);

CREATE TABLE IF NOT EXISTS product_assembled_landings (
  id              SERIAL PRIMARY KEY,
  user_id         INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  product_id      INTEGER NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  sequence_number INTEGER,
  sections        JSONB NOT NULL DEFAULT '[]'::jsonb,
  elements        JSONB NOT NULL DEFAULT '[]'::jsonb,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS product_assembled_landings_product_id_idx ON product_assembled_landings (product_id);

CREATE TABLE IF NOT EXISTS product_descriptions (
  id                  SERIAL PRIMARY KEY,
  product_id          INTEGER NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  user_id             INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  description         TEXT,
  usage               TEXT,
  technical_features  TEXT,
  package_contents    TEXT,
  model               TEXT,
  provider            TEXT,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS product_descriptions_product_id_idx ON product_descriptions (product_id);

CREATE TABLE IF NOT EXISTS product_audios (
  id         SERIAL PRIMARY KEY,
  product_id INTEGER NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  script     TEXT,
  voice_type TEXT,
  category   TEXT,
  country    TEXT DEFAULT 'cl',
  model      TEXT,
  provider   TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS product_audios_product_id_idx ON product_audios (product_id);

CREATE TABLE IF NOT EXISTS product_voiceovers (
  id                SERIAL PRIMARY KEY,
  user_id           INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  product_id        INTEGER NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  source_type       TEXT NOT NULL DEFAULT 'generated', -- 'generated' | 'uploaded'
  source_script_id  INTEGER REFERENCES product_audios(id) ON DELETE SET NULL,
  angle_ref         TEXT,
  angle_data        JSONB,
  text              TEXT,
  voice_type        TEXT,
  voice_id          TEXT,
  voice_name        TEXT,
  model_id          TEXT,
  audio_path        TEXT NOT NULL,
  audio_format      TEXT DEFAULT 'mp3',
  original_filename TEXT,
  char_count        INTEGER DEFAULT 0,
  file_size_bytes   BIGINT DEFAULT 0,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS product_voiceovers_product_id_idx ON product_voiceovers (product_id);

CREATE TABLE IF NOT EXISTS product_pricings (
  id         SERIAL PRIMARY KEY,
  product_id INTEGER NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name       TEXT,
  inputs     JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS product_pricings_product_id_idx ON product_pricings (product_id);

CREATE TABLE IF NOT EXISTS product_copys (
  id            SERIAL PRIMARY KEY,
  product_id    INTEGER NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  user_id       INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  angle_ref     TEXT,
  angle_content TEXT,
  length        TEXT DEFAULT 'medium',
  content       TEXT,
  model         TEXT,
  provider      TEXT,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS product_copys_product_id_idx ON product_copys (product_id);

CREATE TABLE IF NOT EXISTS product_testimonials (
  id            SERIAL PRIMARY KEY,
  product_id    INTEGER NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  user_id       INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  contact_name  TEXT,
  customer_name TEXT,
  tone          TEXT DEFAULT 'casual',
  language      TEXT DEFAULT 'es',
  messages      JSONB NOT NULL DEFAULT '[]'::jsonb,
  model         TEXT,
  provider      TEXT,
  date          DATE,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS product_testimonials_product_id_idx ON product_testimonials (product_id);

CREATE TABLE IF NOT EXISTS product_mockups (
  id           SERIAL PRIMARY KEY,
  product_id   INTEGER NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  user_id      INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  image_path   TEXT NOT NULL,
  prompt       TEXT,
  size         TEXT,
  template     TEXT,
  brand_name   TEXT,
  brand_slogan TEXT,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS product_mockups_product_id_idx ON product_mockups (product_id);

CREATE TABLE IF NOT EXISTS product_logos (
  id           SERIAL PRIMARY KEY,
  product_id   INTEGER NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  user_id      INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  image_path   TEXT NOT NULL,
  prompt       TEXT,
  size         TEXT,
  template     TEXT,
  brand_name   TEXT,
  brand_slogan TEXT,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS product_logos_product_id_idx ON product_logos (product_id);

CREATE TABLE IF NOT EXISTS product_ebooks (
  id                    SERIAL PRIMARY KEY,
  user_id               INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  product_id            INTEGER NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  status                TEXT NOT NULL DEFAULT 'generating',
  title                 TEXT,
  subtitle              TEXT,
  intro_content         TEXT,
  conclusion_content    TEXT,
  angle_ref             TEXT,
  angle_content         TEXT,
  pages_target          INTEGER DEFAULT 20,
  text_model            TEXT,
  text_provider         TEXT,
  image_model           TEXT,
  text_model_id         TEXT,
  image_model_id        TEXT,
  angle_data            JSONB,
  idea_data             JSONB,
  chapters              JSONB NOT NULL DEFAULT '[]'::jsonb,
  cover_image_path      TEXT,
  back_cover_image_path TEXT,
  pdf_path              TEXT,
  theme_color           TEXT DEFAULT '#2d8b6f',
  progress              JSONB,
  error                 TEXT,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at            TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS product_ebooks_product_id_idx ON product_ebooks (product_id);
CREATE INDEX IF NOT EXISTS product_ebooks_status_idx     ON product_ebooks (status);

-- ─────────────────────────────────────────────────────────────────
-- Standalone tools / cross-product
-- ─────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS text_to_image_outputs (
  id           SERIAL PRIMARY KEY,
  user_id      INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  image_path   TEXT NOT NULL,
  prompt       TEXT DEFAULT '',
  model        TEXT,
  photos_count INTEGER DEFAULT 0,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS text_to_image_outputs_user_id_idx ON text_to_image_outputs (user_id);

CREATE TABLE IF NOT EXISTS shopify_connections (
  id                      SERIAL PRIMARY KEY,
  user_id                 INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  store_domain            TEXT,
  client_id               TEXT,
  client_secret_encrypted TEXT,
  access_token            TEXT,
  access_token_expires_at TIMESTAMPTZ,
  scope                   TEXT,
  store_name              TEXT,
  last_verified_at        TIMESTAMPTZ,
  created_at              TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at              TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (user_id, store_domain)
);
CREATE INDEX IF NOT EXISTS shopify_connections_user_id_idx ON shopify_connections (user_id);

CREATE TABLE IF NOT EXISTS ad_templates (
  id         SERIAL PRIMARY KEY,
  name       TEXT,
  image_path TEXT NOT NULL,
  kind       TEXT NOT NULL DEFAULT 'ad',     -- 'ad' | 'landing' | 'mockup' | 'logo' | 'authority'
  category   TEXT,
  owner_id   INTEGER REFERENCES users(id) ON DELETE CASCADE,  -- NULL = global
  created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS ad_templates_kind_idx     ON ad_templates (kind);
CREATE INDEX IF NOT EXISTS ad_templates_owner_id_idx ON ad_templates (owner_id);

-- ─────────────────────────────────────────────────────────────────
-- Meta Ads Spy
-- ─────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS meta_spy_searches (
  id               SERIAL PRIMARY KEY,
  user_id          INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  query            TEXT DEFAULT '',
  country          TEXT DEFAULT 'all',
  ad_active        TEXT DEFAULT 'all',
  media_type       TEXT DEFAULT 'all',
  days_active      TEXT DEFAULT 'all',
  active_ads_count TEXT DEFAULT 'all',
  search_type      TEXT DEFAULT 'broad',
  max_results      INTEGER DEFAULT 50,
  results_count    INTEGER DEFAULT 0,
  duration_ms      INTEGER DEFAULT 0,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS meta_spy_searches_user_id_idx ON meta_spy_searches (user_id);

CREATE TABLE IF NOT EXISTS meta_spy_ads (
  id               SERIAL PRIMARY KEY,
  search_id        INTEGER NOT NULL REFERENCES meta_spy_searches(id) ON DELETE CASCADE,
  user_id          INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  page_id          TEXT,
  page_name        TEXT,
  page_profile_pic TEXT,
  ad_text          TEXT DEFAULT '',
  title            TEXT,
  caption          TEXT,
  link_description TEXT,
  cta_text         TEXT,
  cta_type         TEXT,
  link_url         TEXT,
  media_type       TEXT DEFAULT 'image',
  local_path       TEXT,
  original_url     TEXT,
  start_date       TEXT,
  end_date         TEXT,
  platforms        JSONB NOT NULL DEFAULT '[]'::jsonb,
  display_format   TEXT,
  ad_archive_id    TEXT,
  collation_count  INTEGER,
  categories       JSONB NOT NULL DEFAULT '[]'::jsonb,
  is_active        BOOLEAN DEFAULT TRUE,
  snapshot_url     TEXT,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS meta_spy_ads_search_id_idx ON meta_spy_ads (search_id);

CREATE TABLE IF NOT EXISTS meta_spy_folders (
  id         SERIAL PRIMARY KEY,
  user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name       TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS meta_spy_folders_user_id_idx ON meta_spy_folders (user_id);

CREATE TABLE IF NOT EXISTS meta_spy_saved (
  id        SERIAL PRIMARY KEY,
  user_id   INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  ad_id     INTEGER NOT NULL REFERENCES meta_spy_ads(id) ON DELETE CASCADE,
  folder_id INTEGER REFERENCES meta_spy_folders(id) ON DELETE SET NULL,
  saved_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (user_id, ad_id)
);
CREATE INDEX IF NOT EXISTS meta_spy_saved_user_id_idx ON meta_spy_saved (user_id);

CREATE TABLE IF NOT EXISTS meta_spy_competitors (
  id             SERIAL PRIMARY KEY,
  user_id        INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  page_id        TEXT NOT NULL,
  page_name      TEXT,
  last_ads_count INTEGER DEFAULT 0,
  last_checked   TIMESTAMPTZ,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (user_id, page_id)
);
CREATE INDEX IF NOT EXISTS meta_spy_competitors_user_id_idx ON meta_spy_competitors (user_id);

-- ─────────────────────────────────────────────────────────────────
-- TikTok Shop Spy
-- ─────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS tiktok_spy_searches (
  id            SERIAL PRIMARY KEY,
  user_id       INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  query         TEXT,
  country       TEXT,
  results_count INTEGER DEFAULT 0,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS tiktok_spy_searches_user_id_idx ON tiktok_spy_searches (user_id);

CREATE TABLE IF NOT EXISTS tiktok_spy_products (
  id          SERIAL PRIMARY KEY,
  search_id   INTEGER NOT NULL REFERENCES tiktok_spy_searches(id) ON DELETE CASCADE,
  external_id TEXT,
  title       TEXT DEFAULT '',
  price       NUMERIC(18,4),
  currency    TEXT,
  sold_count  NUMERIC(18,2),
  rating      NUMERIC(5,2),
  image_url   TEXT,
  shop_name   TEXT,
  shop_id     TEXT,
  product_url TEXT,
  country     TEXT,
  raw         JSONB,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS tiktok_spy_products_search_id_idx ON tiktok_spy_products (search_id);

CREATE TABLE IF NOT EXISTS tiktok_spy_folders (
  id         SERIAL PRIMARY KEY,
  user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name       TEXT NOT NULL,
  color      TEXT DEFAULT '#8b5cf6',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS tiktok_spy_folders_user_id_idx ON tiktok_spy_folders (user_id);

CREATE TABLE IF NOT EXISTS tiktok_spy_saved (
  id         SERIAL PRIMARY KEY,
  user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  product_id INTEGER NOT NULL REFERENCES tiktok_spy_products(id) ON DELETE CASCADE,
  folder_id  INTEGER REFERENCES tiktok_spy_folders(id) ON DELETE SET NULL,
  saved_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (user_id, product_id)
);
CREATE INDEX IF NOT EXISTS tiktok_spy_saved_user_id_idx ON tiktok_spy_saved (user_id);
