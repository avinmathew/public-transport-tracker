import "dotenv/config";

import express from "express";
import helmet from "helmet";
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';
import { point as turf_point, polygon as turf_polygon } from "@turf/helpers"
import booleanPointInPolygon from "@turf/boolean-point-in-polygon"
import cachedFeed from "./cachedFeed.js";
import padLeft from "./padLeft.js";

const DIRECTION_LOOKUP = { 0: "in", 1: "out" };
const ROUTE_TYPE_LOOKUP = { 0: "tram", 2: "rail", 3: "bus", 4: "ferry" };

// Period after the expected arrival of the vehicle to the stop to keep showing on the feed
const DEFAULT_FEED_FILTER_TIME = 2; // minutes

const DB_PATH = process.env.DB_PATH || fileURLToPath(new URL('./db/gtfs.sqlite', import.meta.url));
const db = new DatabaseSync(DB_PATH);

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
    const bounds = turf_polygon([[
      [req.query.neLng, req.query.neLat],
      [req.query.neLng, req.query.swLat],
      [req.query.swLng, req.query.swLat],
      [req.query.swLng, req.query.neLat],
      [req.query.neLng, req.query.neLat],
    ]]);

    const feed = await cachedFeed()
    let vehicles = feed.vehicles;
    // Keep vehicles on specified routes
    if (routes.length) {
      vehicles = vehicles.filter(v => routes.includes(v.route));
    }
    // Keep vehicles within specified map bounds
    vehicles = vehicles.filter(v => {
      const point = turf_point([v.longitude, v.latitude]);
      return booleanPointInPolygon(point, bounds);
    });

    // Get direction and type of vehicle
    // Wrap in try catch in case DB is unavailable; we can still return realtime-only data
    let trips = [];
    try {
      const tripIds = vehicles.map(v => v.tripId);
      if (tripIds.length > 0) {
        const placeholders = tripIds.map(() => '?').join(',');
        trips = db.prepare(
          `SELECT t.trip_id, t.direction_id, t.shape_id, r.route_short_name, r.route_type
           FROM trips t
           INNER JOIN routes r ON r.route_id = t.route_id
           WHERE t.trip_id IN (${placeholders})`
        ).all(...tripIds);
      }
    } catch (err) {
      console.error(err);
    }

    vehicles = vehicles.map(v => {
      const trip = trips.find(t => t.trip_id === v.tripId) || {};
      return {
        id: v.id,
        route: v.route,
        latitude: v.latitude,
        longitude: v.longitude,
        route: trip.route_short_name || v.route, // if there's no name, probably an unplanned trip
        routeType: ROUTE_TYPE_LOOKUP[trip.route_type] || "rail", // Schedules seem to be missing train routes
        direction: DIRECTION_LOOKUP[trip.direction_id],
        delay: v.delay
      }
    });

    res.json(vehicles);
  } catch (err) {
    console.error(err);
    res.status(500);
    res.json(err);
  }
});

app.get("/feed-stops", async (req, res) => {
  try {
    if (!req.query.from) {
      res.status(400);
      return res.send("Need 'from' stop code");
    }
    if (!req.query.to || !req.query.to.length) {
      res.status(400);
      return res.send("Need 'to' stop code");
    }

    const feed = await cachedFeed();
    let vehicles = feed.vehicles;

    const from = req.query.from;
    let to;
    if (req.query.to.includes(",")) {
      to = req.query.to.split(",")
    } else {
      to = [req.query.to];
    }

    const toPlaceholders = to.map(() => '?').join(',');
    const trips = db.prepare(
      `SELECT t.trip_id, r.route_short_name, st1.departure_time, s2.stop_name, st2.arrival_time
       FROM trips t
       INNER JOIN routes r ON r.route_id = t.route_id
       INNER JOIN stop_times st1 ON st1.trip_id = t.trip_id
       INNER JOIN stops s1 ON s1.stop_id = st1.stop_id
       INNER JOIN stop_times st2 ON st2.trip_id = t.trip_id
       INNER JOIN stops s2 ON s2.stop_id = st2.stop_id
       WHERE s1.stop_code = ?
       AND s2.stop_code IN (${toPlaceholders})`
    ).all(from, ...to);

    vehicles = vehicles
      // Remove vehicles that aren't in the scheduled trips since we can't tell when they'll depart/arrive
      .filter(v => trips.find(t => t.trip_id === v.tripId))
      .map(v => {
        const trip = trips.find(t => t.trip_id === v.tripId) || {};
        return {
          route: trip.route_short_name,
          departs: trip.departure_time && trip.departure_time.substring(0, 5),
          delay: v.delay,
          to: trip.stop_name
            .replace("Elizabeth Street Stop 81 near George St", "Elizabeth St")
            .replace("Cultural Centre, platform 1", "Cultural Centre"),
          arrives: trip.arrival_time && trip.arrival_time.substring(0, 5)
        }
      });
    // Max Delay is used to conservatively filter out vehicles that have already "arrived" at the "from" stop
    const maxDelay = vehicles.reduce((maxDelayInMins, vehicle) => {
      const vehicleDelayInMins = Number.isFinite(vehicle.delay) ? vehicle.delay / 60 : 0;
      return Math.max(maxDelayInMins, vehicleDelayInMins);
    }, 0) + DEFAULT_FEED_FILTER_TIME;
    let earliestArrival = "99:99";
    vehicles = vehicles
      .map(v => {
        let expectDepart, expectArrive, hasDeparted, exclude;
        if (v.departs) {
          // Calculate expected departure based on delay
          const delayInMins = Math.round((v.delay || 0) / 60);

          const departsHr = Number.parseInt(v.departs.substring(0, 2));
          const departsMin = Number.parseInt(v.departs.substring(3, 5));
          const departsDelay = departsMin + Number.parseInt(delayInMins);
          const expectDepartHr = departsHr + Math.floor(departsDelay / 60);
          const expectDepartMin = departsDelay < 0 ? 60 + departsDelay : departsDelay % 60;
          expectDepart = `${padLeft(expectDepartHr, "0", 2)}:${padLeft(expectDepartMin, "0", 2)}`;

          const arrivesHr = Number.parseInt(v.arrives.substring(0, 2));
          const arrivesMin = Number.parseInt(v.arrives.substring(3, 5));
          const arrivesDelay = arrivesMin + Number.parseInt(delayInMins);
          const expectArriveHr = arrivesHr + Math.floor(arrivesDelay / 60);
          const expectArriveMin = arrivesDelay < 0 ? 60 + arrivesDelay : arrivesDelay % 60;
          expectArrive = `${padLeft(expectArriveHr, "0", 2)}:${padLeft(expectArriveMin, "0", 2)}`;

          const now = feed.timestamp;
          const nowAbs = now.getHours() * 60 + now.getMinutes();
          const departsAbs = departsHr * 60 + departsMin;
          const expectDepartAbs = expectDepartHr * 60 + expectDepartMin;
          // Use the greater of departs or expected to determine whether the vehicle has departed
          hasDeparted = Math.max(departsAbs, expectDepartAbs) < nowAbs;
          exclude = departsAbs + maxDelay < nowAbs;

          if (!exclude && !hasDeparted && expectArrive < earliestArrival) {
            earliestArrival = expectArrive;
          }
        }
        return {
          route: v.route,
          departs: v.departs,
          expectDepart: expectDepart,
          departed: hasDeparted,
          to: v.to,
          arrives: v.arrives,
          expectArrive: expectArrive,
          exclude: exclude
        };
      })
      // Exclude vehicles that have already departed from the "from" stop
      .filter(v => !v.exclude)
      .map(v => ({
        route: v.route,
        departs: v.departs,
        expectDepart: v.expectDepart,
        departed: v.departed,
        to: v.to,
        arrives: v.arrives,
        expectArrive: v.expectArrive,
        // Return undefined so the earliestArrival key is not included in the JSON object sent to client
        earliestArrival : v.expectArrive === earliestArrival ? true : undefined
      }));

    vehicles.sort((a, b) => {
      if (!a.departs || !b.departs) {
        return 0;
      }
      return a.departs.localeCompare(b.departs);
    });

    res.json(vehicles);
  } catch (err) {
    console.error(err);
    res.status(500);
    res.json(err);
  }
});

const port = parseInt(process.env.PORT, 10) || 3000;
app.listen(port, () => console.log(`Listening on port ${port}`));
