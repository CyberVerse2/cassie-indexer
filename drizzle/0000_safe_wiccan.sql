CREATE TABLE "raw_posts" (
	"tweet_id" text PRIMARY KEY NOT NULL,
	"source_id" uuid NOT NULL,
	"author_handle" text NOT NULL,
	"text" text NOT NULL,
	"lang" text,
	"posted_at" timestamp with time zone NOT NULL,
	"is_reply" boolean DEFAULT false NOT NULL,
	"is_self_reply" boolean DEFAULT false NOT NULL,
	"is_retweet" boolean DEFAULT false NOT NULL,
	"is_quote" boolean DEFAULT false NOT NULL,
	"reply_to_tweet_id" text,
	"referenced_text" text,
	"media" jsonb,
	"raw" jsonb,
	"status" text DEFAULT 'pending' NOT NULL,
	"process_error" text,
	"ideas_extracted" integer,
	"fetched_at" timestamp with time zone DEFAULT now() NOT NULL,
	"processed_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "route_pricing" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"route_id" uuid NOT NULL,
	"entry_price" numeric(20, 8),
	"entry_priced_at" timestamp with time zone,
	"entry_note" text,
	"current_price" numeric(20, 8),
	"current_priced_at" timestamp with time zone,
	"since_posted_pct" numeric(10, 4),
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "route_pricing_route_id_unique" UNIQUE("route_id")
);
--> statement-breakpoint
CREATE TABLE "routes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"idea_id" uuid NOT NULL,
	"status" text NOT NULL,
	"unrouted_reason" text,
	"venue" text,
	"instrument" text,
	"ticker" text,
	"direction" text,
	"trade_type" text,
	"pipeline" jsonb,
	"alternatives" jsonb,
	"market_meta" jsonb,
	"router_version" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "sources" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"handle" text NOT NULL,
	"x_user_id" text,
	"name" text,
	"profile_url" text,
	"tracked" boolean DEFAULT true NOT NULL,
	"last_tweet_id" text,
	"last_polled_at" timestamp with time zone,
	"last_error_at" timestamp with time zone,
	"last_error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "sources_handle_unique" UNIQUE("handle"),
	CONSTRAINT "sources_x_user_id_unique" UNIQUE("x_user_id")
);
--> statement-breakpoint
CREATE TABLE "trade_ideas" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tweet_id" text NOT NULL,
	"author_handle" text NOT NULL,
	"posted_at" timestamp with time zone NOT NULL,
	"thesis" text NOT NULL,
	"reasoning" jsonb,
	"subjects" jsonb NOT NULL,
	"direction" text NOT NULL,
	"stated_by_author" boolean,
	"horizon" text,
	"target" text,
	"invalidation" text,
	"strategy" jsonb,
	"conviction" text,
	"quotes" jsonb NOT NULL,
	"headline_quote" text NOT NULL,
	"asset_class" text NOT NULL,
	"context" text,
	"references" jsonb,
	"candidate_tickers" jsonb NOT NULL,
	"status" text DEFAULT 'extracted' NOT NULL,
	"extractor_version" text NOT NULL,
	"model" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "raw_posts" ADD CONSTRAINT "raw_posts_source_id_sources_id_fk" FOREIGN KEY ("source_id") REFERENCES "public"."sources"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "route_pricing" ADD CONSTRAINT "route_pricing_route_id_routes_id_fk" FOREIGN KEY ("route_id") REFERENCES "public"."routes"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "routes" ADD CONSTRAINT "routes_idea_id_trade_ideas_id_fk" FOREIGN KEY ("idea_id") REFERENCES "public"."trade_ideas"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "trade_ideas" ADD CONSTRAINT "trade_ideas_tweet_id_raw_posts_tweet_id_fk" FOREIGN KEY ("tweet_id") REFERENCES "public"."raw_posts"("tweet_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "raw_posts_status_idx" ON "raw_posts" USING btree ("status","posted_at");--> statement-breakpoint
CREATE INDEX "raw_posts_source_idx" ON "raw_posts" USING btree ("source_id","posted_at");--> statement-breakpoint
CREATE INDEX "routes_idea_idx" ON "routes" USING btree ("idea_id");--> statement-breakpoint
CREATE INDEX "trade_ideas_status_idx" ON "trade_ideas" USING btree ("status");--> statement-breakpoint
CREATE INDEX "trade_ideas_author_idx" ON "trade_ideas" USING btree ("author_handle","posted_at");