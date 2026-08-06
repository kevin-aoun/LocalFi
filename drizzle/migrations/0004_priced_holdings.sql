/*
 0004 — priced holdings: an asset says WHICH FEED prices it.

 WHY. Live pricing was inferred from `assets.commodity_type`, so the only things
 the app could price were the four metals SwissQuote's forex feed carries. The
 owner also holds Bitcoin and Ethereum. Those are NOT commodities and are NOT on
 a forex feed, so adding "Bitcoin" to commodity_type would have put a lie in the
 schema and sent a broken symbol (BTC/USD) to SwissQuote.

 So an asset now names its own price symbol and a small provider registry
 (lib/prices.ts) decides who to ask:

   XAU XAG XPT XPD  ->  SwissQuote public forex feed  (USD per troy ounce)
   BTC ETH          ->  CoinGecko public simple/price (USD per coin)

 WHAT THIS DOES

 1. Adds `assets.price_symbol` (text, nullable). NULL means "hand-valued".
 2. Adds `assets.priced_at` (integer unix seconds, nullable): when
    `current_value_cents` last came from a live quote. NULL means it never did.
    This is what lets the UI say "this value is stale, the feed is unreachable"
    instead of overwriting a real holding with 0 when the network is down.
 3. BACKFILLS every existing commodity row onto its symbol
    (Gold -> XAU, Silver -> XAG, Platinum -> XPT, Palladium -> XPD), so the
    metals that already work keep working — through the new code path.

 WHAT IT DELIBERATELY DOES NOT DO

 - It does NOT drop or rewrite `commodity_type`. Existing readers (the assets
   table on the dashboard, lib/db/verify-migration.ts, lib/db/migrate-from-json.ts)
   still ask for "Gold" and still get it. The column is now redundant for pricing
   but authoritative for nothing else, and removing it is a separate decision.
 - It does NOT touch `quantity`. It is a `real` on purpose: a troy-ounce weight
   and a fractional coin count are physical amounts, not money, and rounding
   either would destroy precision. For crypto, `unit` is 'coins' — a COUNT of
   coins, so 0.0345 means 0.0345 BTC.
 - It does NOT add a CHECK constraint tying `use_live_price` to `price_symbol`,
   however tempting. That would require rebuilding `assets`, and
   `asset_history.asset_id` REFERENCES assets ON DELETE CASCADE — a rebuild there
   can cascade real history rows away. Two nullable ADD COLUMNs cannot lose a
   single byte, so no rebuild happens and no `PRAGMA foreign_keys` dance is
   needed. (The one-shot script that applies this to a live database still
   brackets its work with foreign_keys OFF/ON and re-checks
   `PRAGMA foreign_key_check` before and after: see
   lib/db/migrate-to-priced-holdings.ts.)
 - It does NOT invent quantities. A hand-valued row such as the existing
   "BTC + ETH" note ($70.00, no quantity) keeps its manual value and gets no
   symbol: nobody can tell from "$70 of BTC + ETH" how many coins that is. The
   owner can convert it by entering a quantity, which is a decision, not a
   migration.
*/
ALTER TABLE `assets` ADD COLUMN `price_symbol` text;--> statement-breakpoint
ALTER TABLE `assets` ADD COLUMN `priced_at` integer;--> statement-breakpoint
/*
 The backfill. Guarded by `price_symbol IS NULL` so re-running is a no-op, and by
 an explicit CASE so an unrecognised commodity_type is left NULL (loudly absent)
 rather than mapped to something arbitrary.
*/
UPDATE `assets`
SET `price_symbol` = CASE `commodity_type`
	WHEN 'Gold' THEN 'XAU'
	WHEN 'Silver' THEN 'XAG'
	WHEN 'Platinum' THEN 'XPT'
	WHEN 'Palladium' THEN 'XPD'
END
WHERE `commodity_type` IS NOT NULL AND `price_symbol` IS NULL;
