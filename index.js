require("dotenv").config();

const express = require("express");
const GtfsRealtimeBindings = require("gtfs-realtime-bindings");
const axios = require("axios");

const URL = process.env.GTFS_REALTIME_URL;
const MAX_ROUTE_COUNT = 10; // Max number of routes before we ignore querying the database

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
app.use(express.static("public"));

app.get("/feed", (req, res) => {
  let routes = [];
  if (req.query.routes) {
    routes = req.query.routes.split(",");
  }
  let entities;
  axios.get(URL, { responseType: "arraybuffer" })
    .then(response => {
      const feed = GtfsRealtimeBindings.FeedMessage.decode(response.data);

      const tripUpdates = feed.entity.filter(e => e.trip_update);
      const vehicles = feed.entity.filter(e => e.vehicle);

      const trips = {};
      // Add trip updates to trips to capture any vehicles that may not provide lat/lon coords
      tripUpdates.forEach(t => {
        let delay;
        // Don't show a delay if waiting at first stop
        if (t.trip_update.stop_time_update[0] && t.trip_update.stop_time_update[0].stop_sequence > 1) {
          if (t.trip_update.stop_time_update[0].arrival) {
            delay = t.trip_update.stop_time_update[0].arrival.delay;
          } else if (t.trip_update.stop_time_update[0].departure) {
            delay = t.trip_update.stop_time_update[0].departure.delay;
          }
        }
        trips[t.trip_update.trip.trip_id] = {
          id: t.id,
          tripId: t.trip_update.trip.trip_id,
          routeId: t.trip_update.trip.route_id,
          route: t.trip_update.trip.route_id.split("-")[0],
          delay: delay
        }
      });
      // Add vehicles to trips to capture  vehicles emitting real time lat/lon coords
      vehicles.forEach(v => {
        trips[v.vehicle.trip.trip_id] = trips[v.vehicle.trip.trip_id] || {};
        trips[v.vehicle.trip.trip_id] = {
          ...trips[v.vehicle.trip.trip_id],
          id: v.id,
          tripId: v.vehicle.trip.trip_id,
          routeId: v.vehicle.trip.route_id,
          route: v.vehicle.trip.route_id.split("-")[0],
          latitude: v.vehicle.position.latitude,
          longitude: v.vehicle.position.longitude
        }
      });

      // Filter trips to those requested, or if none specifically requested, show all
      entities = Object.values(trips)
        .filter(e => {
          if (!routes.length) {
            return true;
          }
          return routes.includes(e.routeId.split("-")[0]);
        });
      return entities;
    }).then(() => {
      return knex.select("trip_id", "direction_id", "shape_id", "route_short_name", "route_type")
        .from("trips")
        .innerJoin("routes", "routes.route_id", "trips.route_id")
        .whereIn("trip_id", entities.map(e => e.tripId))
    }).then(rows => {
      const directionLookup = { 0: "inbound", 1: "outbound" };
      const routeTypeLookup = { 0: "tram", 2: "rail", 3: "bus", 4: "ferry" };
      entities = entities.map(e => {
        const row = rows.find(r => r.trip_id === e.tripId) || {};
        return {
          ...e,
          route: row.route_short_name || e.route, // if there's no name, probably an unplanned trip
          routeType: routeTypeLookup[row.route_type],
          direction: directionLookup[row.direction_id],
          shapeId: row.shape_id
        }
      });
    }).then(() => {
      // Prevent users from querying large amounts of data from the database
      if (routes.length === 0 || routes.length > MAX_ROUTE_COUNT) {
        return entities;
      } else {
        const distinctIds = new Set(entities.map(e => e.shapeId).filter(shapeId => shapeId))
        return knex.select("shape_id", "shape_pt_lat", "shape_pt_lon")
          .from("shapes")
          .whereIn("shape_id", [...distinctIds])
          .orderBy("shape_pt_sequence", "asc")
          .then(rows => {
            entities = entities.map(e => {
              const shape = rows.filter(r => r.shape_id === e.shapeId) || [];
              return {
                ...e,
                shape: shape.map(s => ({ latitude: s.shape_pt_lat, longitude: s.shape_pt_lon }))
              }
            });
          }).then(() => {
            return knex.select("trip_id", "stop_sequence", "arrival_time", "departure_time", "stop_lat", "stop_lon")
              .from("stop_times")
              .innerJoin("stops", "stops.stop_id", "stop_times.stop_id")
              .whereIn("trip_id", entities.map(e => e.tripId))
              .orderBy("trip_id", "asc")
              .orderBy("stop_sequence", "asc")
          }).then(rows => {
            entities = entities.map(e => {
              const stopTimes = rows.filter(r => r.trip_id === e.tripId) || [];
              stopTimes.sort((a, b) => a.stop_sequence - b.stop_sequence);
              return {
                ...e,
                stopTimes: stopTimes.map(s => ({
                  arrivalTime: s.arrival_time,
                  departureTime: s.departure_time,
                  latitude: s.stop_lat,
                  longitude: s.stop_lon
                }))
              }
            });

            if (req.query.h && req.query.m) {
              const clientHrs = +req.query.h;
              const clientMins = +req.query.m;
              const clientTime = clientHrs * 60 + clientMins;
              entities = entities.filter(e => {
                // If no position, or no stop times, ignore
                // todo These are unplanned trips. We could possibly look at stop_time_update
                if ((!e.latitude || !e.longitude) && (!e.stopTimes || !e.stopTimes.length)) {
                  return false;
                }

                // If currently has a position, include the vehicle
                if (e.latitude && e.longitude) {
                  return true;
                }

                const firstStopHrs = +e.stopTimes[0].departureTime.substring(0, 2);
                const firstStopMins = +e.stopTimes[0].departureTime.substring(3, 5);
                const firstStopTime = firstStopHrs * 60 + firstStopMins;
                const lastStopHrs = +e.stopTimes[e.stopTimes.length - 1].departureTime.substring(0, 2);
                const lastStopMins = +e.stopTimes[e.stopTimes.length - 1].departureTime.substring(3, 5);
                const lastStopTime = lastStopHrs * 60 + lastStopMins;
                if ((clientTime >= firstStopTime && clientTime <= lastStopTime) === false) {
                  return "failed time validation"
                }
                return clientTime >= firstStopTime && clientTime <= lastStopTime;
              });
            }
          });
      }
    })
    .then(() => res.json(entities))
    .catch(err => {
      console.error(err);
      res.json([]);
    });
});

const port = parseInt(process.env.PORT, 10) || 3000;
app.listen(port, () => console.log(`Listening on port ${port}`));
