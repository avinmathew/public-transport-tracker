LOAD DATA LOCAL INFILE 'routes.txt'
INTO TABLE `translink_gtfs`.`routes`
CHARACTER SET ascii
FIELDS TERMINATED BY ','
OPTIONALLY ENCLOSED BY '"'
ESCAPED BY '"'
LINES TERMINATED BY '\r\n'
IGNORE 1 LINES
(`route_id`, `route_short_name`, `route_long_name`, `route_desc`, `route_type`, `route_url`, `route_color`, `route_text_color`);

LOAD DATA LOCAL INFILE 'shapes.txt'
INTO TABLE `translink_gtfs`.`shapes`
CHARACTER SET ascii
FIELDS TERMINATED BY ','
OPTIONALLY ENCLOSED BY '"'
ESCAPED BY '"'
LINES TERMINATED BY '\r\n'
IGNORE 1 LINES
(`shape_id`, `shape_pt_lat`, `shape_pt_lon`, `shape_pt_sequence`);

LOAD DATA LOCAL INFILE 'stops.txt'
INTO TABLE `translink_gtfs`.`stops`
CHARACTER SET ascii
FIELDS TERMINATED BY ','
OPTIONALLY ENCLOSED BY '"'
ESCAPED BY '"'
LINES TERMINATED BY '\r\n'
IGNORE 1 LINES
(`stop_id`, `stop_code`, `stop_name`, `stop_desc`, `stop_lat`, `stop_lon`, `zone_id`, `stop_url`, `location_type`, `parent_station`, `platform_code`);

LOAD DATA LOCAL INFILE 'trips.txt'
INTO TABLE `translink_gtfs`.`trips`
CHARACTER SET ascii
FIELDS TERMINATED BY ','
OPTIONALLY ENCLOSED BY '"'
ESCAPED BY '"'
LINES TERMINATED BY '\r\n'
IGNORE 1 LINES
(`route_id`, `service_id`, `trip_id`, `trip_headsign`, `direction_id`, `block_id`, `shape_id`);

LOAD DATA LOCAL INFILE 'stop_times.txt'
INTO TABLE `translink_gtfs`.`stop_times`
CHARACTER SET ascii
FIELDS TERMINATED BY ','
OPTIONALLY ENCLOSED BY '"'
ESCAPED BY '"'
LINES TERMINATED BY '\r\n'
IGNORE 1 LINES
(`trip_id`, `arrival_time`, `departure_time`, `stop_id`, `stop_sequence`, `pickup_type`, `drop_off_type`);
