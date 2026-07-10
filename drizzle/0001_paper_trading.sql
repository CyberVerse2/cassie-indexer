CREATE TABLE "paper_accounts" (
  "id" uuid PRIMARY KEY NOT NULL,
  "starting_cash_usd" numeric(20, 2) DEFAULT '25000' NOT NULL,
  "cash_usd" numeric(20, 2) DEFAULT '25000' NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint

CREATE TABLE "paper_orders" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "account_id" uuid NOT NULL REFERENCES "paper_accounts"("id"),
  "idea_id" uuid NOT NULL REFERENCES "trade_ideas"("id"),
  "route_id" uuid NOT NULL REFERENCES "routes"("id"),
  "venue" text NOT NULL,
  "instrument" text NOT NULL,
  "ticker" text NOT NULL,
  "direction" text NOT NULL,
  "requested_usd" numeric(20, 2) NOT NULL,
  "status" text NOT NULL,
  "fill_price" numeric(20, 8),
  "filled_quantity" numeric(28, 12),
  "fee_usd" numeric(20, 2) DEFAULT '0' NOT NULL,
  "rejection_reason" text,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "filled_at" timestamp with time zone
);
--> statement-breakpoint

CREATE INDEX "paper_orders_account_created_idx" ON "paper_orders" ("account_id", "created_at");
--> statement-breakpoint

CREATE TABLE "paper_positions" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "account_id" uuid NOT NULL REFERENCES "paper_accounts"("id"),
  "order_id" uuid NOT NULL UNIQUE REFERENCES "paper_orders"("id"),
  "idea_id" uuid NOT NULL REFERENCES "trade_ideas"("id"),
  "route_id" uuid NOT NULL REFERENCES "routes"("id"),
  "venue" text NOT NULL,
  "instrument" text NOT NULL,
  "ticker" text NOT NULL,
  "market_label" text NOT NULL,
  "direction" text NOT NULL,
  "status" text DEFAULT 'open' NOT NULL,
  "collateral_usd" numeric(20, 2) NOT NULL,
  "quantity" numeric(28, 12) NOT NULL,
  "entry_price" numeric(20, 8) NOT NULL,
  "current_mark_price" numeric(20, 8) NOT NULL,
  "current_value_usd" numeric(20, 2) NOT NULL,
  "unrealized_pnl_usd" numeric(20, 2) DEFAULT '0' NOT NULL,
  "realized_pnl_usd" numeric(20, 2),
  "mark_error" text,
  "opened_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  "closed_at" timestamp with time zone,
  "close_price" numeric(20, 8)
);
--> statement-breakpoint

CREATE INDEX "paper_positions_account_status_idx" ON "paper_positions" ("account_id", "status", "opened_at");
