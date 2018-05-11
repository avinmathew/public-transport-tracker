require("dotenv").config();

const express = require("express");
const helmet = require("helmet");
const GtfsRealtimeBindings = require("gtfs-realtime-bindings");
const axios = require("axios");
const turf = {
  point: require("@turf/helpers").point,
  polygon: require("@turf/helpers").polygon,
  booleanPointInPolygon: require("@turf/boolean-point-in-polygon").default
};

const URL = process.env.GTFS_REALTIME_URL;
const MAX_ROUTE_COUNT = 10; // Max number of routes before we ignore querying the database
const LATLNG_DECIMAL_PLACES = 5; // Precision to send back to client

const DIRECTION_LOOKUP = { 0: "in", 1: "out" };
const ROUTE_TYPE_LOOKUP = { 0: "tram", 2: "rail", 3: "bus", 4: "ferry" };

const knex = require("knex")({
  client: process.env.DB_CLIENT,
  connection: {
    host: process.env.DB_HOST,
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    database: process.env.DB_DATABASE
  }
});

const app = express();
app.use(helmet());
app.use(express.static("public"));

app.get("/feed", async (req, res) => {
  try {
    let routes = [];
    if (req.query.routes) {
      routes = req.query.routes.split(",");
    }
    if (!req.query.neLat || !req.query.neLng || !req.query.swLat || !req.query.swLng) {
      res.status(400);
      return res.send("Unspecified boundary parameters");
    }
    const bounds = turf.polygon([[
      [req.query.neLng, req.query.neLat],
      [req.query.neLng, req.query.swLat],
      [req.query.swLng, req.query.swLat],
      [req.query.swLng, req.query.neLat],
      [req.query.neLng, req.query.neLat],
    ]]);

    const response = await axios.get(URL, { responseType: "arraybuffer" });
    const feed = GtfsRealtimeBindings.FeedMessage.decode(response.data);

    const tripUpdates = feed.entity.filter(e => e.trip_update);
    const vehicles = feed.entity.filter(e => e.vehicle);

    let entities = {};
    // Add trip updates to trips to capture delay and vehicles that may not provide lat/lon coords
    tripUpdates.forEach(t => {
      // Ignore non-specified routes
      const route = t.trip_update.trip.route_id.split("-")[0];
      if (routes.length && !routes.includes(route)) {
        return;
      }

      let delay;
      // Don't show a delay if waiting at first stop
      if (t.trip_update.stop_time_update[0] && t.trip_update.stop_time_update[0].stop_sequence > 1) {
        if (t.trip_update.stop_time_update[0].arrival) {
          delay = t.trip_update.stop_time_update[0].arrival.delay;
        } else if (t.trip_update.stop_time_update[0].departure) {
          delay = t.trip_update.stop_time_update[0].departure.delay;
        }
      }
      entities[t.trip_update.trip.trip_id] = {
        id: t.id,
        tripId: t.trip_update.trip.trip_id,
        route: route,
        delay: delay
      }
    });
    // Add vehicles to trips to capture vehicles emitting real time lat/lon coords
    vehicles.forEach(v => {
      // Ignore non-specified routes
      const route = v.vehicle.trip.route_id.split("-")[0];
      if (routes.length && !routes.includes(route)) {
        return;
      }

      // Ignore vehicles outside specified map bounds
      const latitude = v.vehicle.position.latitude && +v.vehicle.position.latitude.toFixed(LATLNG_DECIMAL_PLACES);
      const longitude = v.vehicle.position.longitude && +v.vehicle.position.longitude.toFixed(LATLNG_DECIMAL_PLACES);
      const point = turf.point([longitude, latitude]);
      if (!turf.booleanPointInPolygon(point, bounds)) {
        return;
      }

      entities[v.vehicle.trip.trip_id] = entities[v.vehicle.trip.trip_id] || {};
      entities[v.vehicle.trip.trip_id] = {
        ...entities[v.vehicle.trip.trip_id],
        id: v.id,
        tripId: v.vehicle.trip.trip_id,
        route: route,
        latitude: latitude,
        longitude: longitude
      }
    });

    // Only keep entities with a lat/lon
    entities = Object.values(entities)
      .filter(e => e.latitude && e.longitude);

    // Get direction and type of vehicle
    const trips = await knex
      .select("trip_id", "direction_id", "shape_id", "route_short_name", "route_type")
      .from("trips")
      .innerJoin("routes", "routes.route_id", "trips.route_id")
      .whereIn("trip_id", entities.map(e => e.tripId));

    entities = entities.map(e => {
      const trip = trips.find(t => t.trip_id === e.tripId) || {};
      return {
        id: e.id,
        route: e.route,
        latitude: e.latitude,
        longitude: e.longitude,
        route: trip.route_short_name || e.route, // if there's no name, probably an unplanned trip
        routeType: ROUTE_TYPE_LOOKUP[trip.route_type],
        direction: DIRECTION_LOOKUP[trip.direction_id],
      }
    });

    res.json(entities);
  } catch(err) {
    console.error(err);
    res.status(500);
    res.json(err);
  }
});

const port = parseInt(process.env.PORT, 10) || 3000;
app.listen(port, () => console.log(`Listening on port ${port}`));
