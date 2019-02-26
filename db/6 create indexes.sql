CREATE INDEX ix_shapes_shape_id ON shapes (shape_id);

CREATE INDEX ix_trips_trip_id ON trips (trip_id, route_id, direction_id, shape_id);

CREATE INDEX ix_stop_times_trip_id ON stop_times (trip_id);

CREATE INDEX ix_stop_times_stop_id ON stop_times (stop_id);

CREATE INDEX ix_stops_stop_id ON stops (stop_id);

CREATE INDEX ix_stops_stop_code ON stops (stop_code);
