-- Canonical olap indexes baseline.
--
-- Name: comparison_price_changes_article_time_idx; Type: INDEX; Schema: olap; Owner: -
--

CREATE INDEX comparison_price_changes_article_time_idx ON olap.comparison_price_changes USING btree (article_id, effective_at);

--
-- Name: current_listing_scores_olap_article_idx; Type: INDEX; Schema: olap; Owner: -
--

CREATE UNIQUE INDEX current_listing_scores_olap_article_idx ON olap.current_listing_scores USING btree (article_id);

--
-- Name: current_listing_scores_olap_first_seen_idx; Type: INDEX; Schema: olap; Owner: -
--

CREATE INDEX current_listing_scores_olap_first_seen_idx ON olap.current_listing_scores USING btree (first_seen DESC);

--
-- Name: current_listing_scores_olap_market_idx; Type: INDEX; Schema: olap; Owner: -
--

CREATE INDEX current_listing_scores_olap_market_idx ON olap.current_listing_scores USING btree (deal, property_type, neighborhood, room_bucket);

--
-- Name: current_listing_scores_olap_reduction_idx; Type: INDEX; Schema: olap; Owner: -
--

CREATE INDEX current_listing_scores_olap_reduction_idx ON olap.current_listing_scores USING btree (latest_reduction_at DESC) WHERE (latest_reduction_at IS NOT NULL);

--
-- Name: current_listing_scores_olap_score_idx; Type: INDEX; Schema: olap; Owner: -
--

CREATE INDEX current_listing_scores_olap_score_idx ON olap.current_listing_scores USING btree (score DESC NULLS LAST);

--
-- Name: daily_listing_facts_dashboard_idx; Type: INDEX; Schema: olap; Owner: -
--

CREATE INDEX daily_listing_facts_dashboard_idx ON olap.daily_listing_facts USING btree (deal, property_type, neighborhood, room_bucket, day);

--
-- Name: daily_listing_facts_grain_idx; Type: INDEX; Schema: olap; Owner: -
--

CREATE UNIQUE INDEX daily_listing_facts_grain_idx ON olap.daily_listing_facts USING btree (day, article_id);

--
-- Name: lifecycle_cycles_dashboard_idx; Type: INDEX; Schema: olap; Owner: -
--

CREATE INDEX lifecycle_cycles_dashboard_idx ON olap.lifecycle_cycles USING btree (closed_day, closing_deal, closing_property_type, closing_neighborhood) WHERE is_closed;

--
-- Name: lifecycle_cycles_grain_idx; Type: INDEX; Schema: olap; Owner: -
--

CREATE UNIQUE INDEX lifecycle_cycles_grain_idx ON olap.lifecycle_cycles USING btree (article_id, cycle_no);

--
-- Name: lifecycle_movements_dashboard_idx; Type: INDEX; Schema: olap; Owner: -
--

CREATE INDEX lifecycle_movements_dashboard_idx ON olap.lifecycle_movements USING btree (event_day, deal, property_type, neighborhood, movement_type);

--
-- Name: lifecycle_movements_grain_idx; Type: INDEX; Schema: olap; Owner: -
--

CREATE UNIQUE INDEX lifecycle_movements_grain_idx ON olap.lifecycle_movements USING btree (article_id, cycle_no, movement_type);

--
-- Name: listing_categories_filter_idx; Type: INDEX; Schema: olap; Owner: -
--

CREATE INDEX listing_categories_filter_idx ON olap.listing_categories USING btree (category, article_id);

--
-- Name: listing_exit_economics_article_idx; Type: INDEX; Schema: olap; Owner: -
--

CREATE UNIQUE INDEX listing_exit_economics_article_idx ON olap.listing_exit_economics USING btree (article_id);

--
-- Name: listing_price_changes_filter_idx; Type: INDEX; Schema: olap; Owner: -
--

CREATE INDEX listing_price_changes_filter_idx ON olap.listing_price_changes USING btree (effective_at, deal, article_id);

--
-- Name: listings_active_idx; Type: INDEX; Schema: olap; Owner: -
--

CREATE INDEX listings_active_idx ON olap.listings USING btree (is_rent, last_seen) WHERE (closed_at IS NULL);

--
-- Name: listings_article_idx; Type: INDEX; Schema: olap; Owner: -
--

CREATE UNIQUE INDEX listings_article_idx ON olap.listings USING btree (article_id);

--
-- Name: listings_closed_idx; Type: INDEX; Schema: olap; Owner: -
--

CREATE INDEX listings_closed_idx ON olap.listings USING btree (closed_at) WHERE (closed_at IS NOT NULL);

--
-- Name: market_daily_day_idx; Type: INDEX; Schema: olap; Owner: -
--

CREATE INDEX market_daily_day_idx ON olap.market_daily USING btree (day);
