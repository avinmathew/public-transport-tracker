require("dotenv").config();

const express = require("express");
const helmet = require("helmet");
const turf = {
  point: require("@turf/helpers").point,
  polygon: require("@turf/helpers").polygon,
  booleanPointInPolygon: require("@turf/boolean-point-in-polygon").default
};
const cachedFeed = require("./cachedFeed");
const padLeft = require("./padLeft");

const DIRECTION_LOOKUP = { 0: "in", 1: "out" };
const ROUTE_TYPE_LOOKUP = { 0: "tram", 2: "rail", 3: "bus", 4: "ferry" };

// Period after the expected arrival of the vehicle to the stop to keep showing on the feed
const DEFAULT_FEED_FILTER_TIME = 2; // minutes

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

    let vehicles = await cachedFeed.get();
    // Keep vehicles on specified routes
    if (routes.length) {
      vehicles = vehicles.filter(v => routes.includes(v.route));
    }
    // Keep vehicles within specified map bounds
    vehicles = vehicles.filter(v => {
      const point = turf.point([v.longitude, v.latitude]);
      return turf.booleanPointInPolygon(point, bounds);
    });

    // Get direction and type of vehicle
    const trips = await knex
      .select("trip_id", "direction_id", "shape_id", "route_short_name", "route_type")
      .from("trips")
      .innerJoin("routes", "routes.route_id", "trips.route_id")
      .whereIn("trip_id", vehicles.map(v => v.tripId));

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

    let vehicles = await cachedFeed.get();

    const from = req.query.from;
    let to;
    if (req.query.to.includes(",")) {
      to = req.query.to.split(",")
    } else {
      to = [req.query.to];
    }

    const trips = await knex
      .select("t.trip_id", "r.route_short_name", "st1.departure_time", "s2.stop_name", "st2.arrival_time")
      .from("trips as t")
      .innerJoin("routes as r", "r.route_id", "t.route_id")
      .innerJoin("stop_times as st1", "st1.trip_id", "t.trip_id")
      .innerJoin("stops as s1", "s1.stop_id", "st1.stop_id")
      .innerJoin("stop_times as st2", "st2.trip_id", "t.trip_id")
      .innerJoin("stops as s2", "s2.stop_id", "st2.stop_id")
      .where("s1.stop_code", from)
      .whereIn("s2.stop_code", to);

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
    const maxDelay = vehicles.reduce((prev, curr) => curr.delay > prev.delay ? curr : prev).delay / 60 + DEFAULT_FEED_FILTER_TIME;
    vehicles = vehicles
      .map(v => {
        let expectedDeparture, hasDeparted, exclude;
        if (v.departs) {
          // Calculate expected departure based on delay
          const delayInMins = Math.round((v.delay || 0) / 60);
          const departsHr = Number.parseInt(v.departs.substring(0, 2));
          const departsMin = Number.parseInt(v.departs.substring(3, 5));
          const minDelay = departsMin + Number.parseInt(delayInMins);
          const expectedHr = departsHr + Math.floor(minDelay / 60);
          const expectedMin = minDelay % 60;
          expectedDeparture = `${padLeft(expectedHr, "0", 2)}:${padLeft(expectedMin, "0", 2)}`;

          // Use the greater of departs or expected to determine whether the vehicle has departed
          const now = new Date();
          const nowAbs = now.getHours() * 60 + now.getMinutes();
          const departsAbs = departsHr * 60 + departsMin;
          const expectedAbs = expectedHr * 60 + expectedMin;
          hasDeparted = Math.max(departsAbs, expectedAbs) > nowAbs;
          exclude = departsAbs + maxDelay < nowAbs;
        }
        return {
          route: v.route,
          departs: v.departs,
          expected: expectedDeparture,
          departed: hasDeparted,
          to: v.to,
          arrives: v.arrives,
          exclude: exclude
        };
      })
      // Exclude vehicles that have already departed from the "from" stop
      .filter(v => !v.exclude)
      .map(v => ({
        route: v.route,
        departs: v.departs,
        expected: v.expected,
        departed: v.departed,
        to: v.to,
        arrives: v.arrives
      }))
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

app.get("/debug", async (req, res) => {
  try {
    let vehicles = await fileFeed.get();

    const trips = await knex
      .select("t.trip_id", "r.route_short_name", "st1.departure_time", "s2.stop_name", "st2.arrival_time")
      .from("trips as t")
      .innerJoin("routes as r", "r.route_id", "t.route_id")
      .innerJoin("stop_times as st1", "st1.trip_id", "t.trip_id")
      .innerJoin("stops as s1", "s1.stop_id", "st1.stop_id")
      .innerJoin("stop_times as st2", "st2.trip_id", "t.trip_id")
      .innerJoin("stops as s2", "s2.stop_id", "st2.stop_id")
      .where("s1.stop_code", "005840");

      vehicles = vehicles
      .map(v => {
        const trip = trips.find(t => t.trip_id === v.tripId) || {};
        let status;
        if (trip.trip_id) {
          status = "1 Match";
        } else if (["P129", "P137", "P141", "P151"].includes(v.route)) {
          status = "2 Missing match";
        } else {
          status = "3 No match"
        }
        return {
          route: v.route,
          tripId: v.tripId,
          status
        }
      });
    vehicles.sort((a, b) => a.tripId.localeCompare(b.tripId));
    vehicles.sort((a, b) => a.status.localeCompare(b.status));
    vehicles = vehicles
      .map(v => {
        return `<tr><td>${v.route}</td><td>${v.tripId}</td><td>${v.status}</td></tr>`
      });

    res.send("<table><thead><th>Route</th><th>Trip Id</th><th>Match Status</th></thead><tbody>" + vehicles.join("") + "</tbody></table>");
  } catch (err) {
    console.error(err);
    res.status(500);
    res.json(err);
  }
});


const port = parseInt(process.env.PORT, 10) || 3000;
app.listen(port, () => console.log(`Listening on port ${port}`));
