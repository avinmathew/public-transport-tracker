CREATE TABLE routes (
    route_id VARCHAR(100) PRIMARY KEY,
    route_short_name VARCHAR(50),
    route_long_name VARCHAR(255),
    route_desc VARCHAR(255),
    route_type VARCHAR(255),
    route_url VARCHAR(255),
    route_color VARCHAR(255),
    route_text_color VARCHAR(255)
);

CREATE TABLE shapes (
    shape_id VARCHAR(100),
    shape_pt_lat DECIMAL(9,6),
    shape_pt_lon DECIMAL(9,6),
    shape_pt_sequence INT
);

CREATE TABLE stops (
    stop_id VARCHAR(255) PRIMARY KEY,
    stop_code VARCHAR(50),
    stop_name VARCHAR(255),
    stop_desc VARCHAR(255),
    stop_lat DECIMAL(10,6),
    stop_lon DECIMAL(10,6),
    zone_id VARCHAR(255),
    stop_url VARCHAR(255),
    location_type VARCHAR(2),
    parent_station VARCHAR(100),
    platform_code VARCHAR(50)
);

CREATE TABLE trips (
    route_id VARCHAR(100),
    service_id VARCHAR(100),
    trip_id VARCHAR(255) PRIMARY KEY,
    trip_headsign VARCHAR(255),
    direction_id tinyint,
    block_id VARCHAR(11),
    shape_id VARCHAR(100)
);

CREATE TABLE stop_times (
    trip_id VARCHAR(255),
    arrival_time VARCHAR(8),
    departure_time VARCHAR(8),
    stop_id VARCHAR(255),
    stop_sequence VARCHAR(100),
    pickup_type VARCHAR(2),
    drop_off_type VARCHAR(2)
);