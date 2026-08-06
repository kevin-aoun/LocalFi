ALTER TABLE `travel_checkpoints` ADD `origin_city_id` integer REFERENCES travel_checkpoints(id) ON DELETE SET NULL;
