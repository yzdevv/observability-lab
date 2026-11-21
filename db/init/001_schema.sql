-- Observability Lab schema. Synthetic demo data only.

CREATE TABLE products (
  id          text PRIMARY KEY,
  name        text NOT NULL,
  price_cents integer NOT NULL CHECK (price_cents > 0)
);

CREATE TABLE orders (
  id               uuid PRIMARY KEY,
  product_id       text NOT NULL REFERENCES products(id),
  quantity         integer NOT NULL CHECK (quantity BETWEEN 1 AND 10),
  unit_price_cents integer NOT NULL,
  total_cents      integer,
  impl             text NOT NULL CHECK (impl IN ('node', 'go')),
  scenario         text NOT NULL,
  status           text NOT NULL CHECK (status IN ('queued', 'completed', 'failed')),
  attempts         integer NOT NULL DEFAULT 0,
  created_at       timestamptz NOT NULL DEFAULT now(),
  processed_at     timestamptz
);

CREATE INDEX orders_created_at_idx ON orders (created_at);
