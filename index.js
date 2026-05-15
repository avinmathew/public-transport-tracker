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
const DAY_COLUMN_LOOKUP = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"];

// Period after the expected arrival of the vehicle to the stop to keep showing on the feed
const DEFAULT_FEED_FILTER_TIME = 2; // minutes
const DEFAULT_STOP_WINDOW_MINUTES = 120;

const DB_PATH = process.env.DB_PATH || fileURLToPath(new URL('./db/gtfs.sqlite', import.meta.url));
const db = new DatabaseSync(DB_PATH);
const dbTables = new Set(db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all().map(row => row.name));
const hasScheduleCalendar = dbTables.has("calendar") && dbTables.has("calendar_dates");
const hasStopRoutes = dbTables.has("stop_routes");
const activeServiceIdsCache = new Map();

function splitCsvParam(value) {
  if (!value) {
    return [];
  }
  return value
    .split(",")
    .map(v => v.trim())
    .filter(Boolean);
}

function formatServiceDate(date) {
  return `${date.getFullYear()}${padLeft(date.getMonth() + 1, "0", 2)}${padLeft(date.getDate(), "0", 2)}`;
}

function parseDateTimeQuery(query) {
  const now = new Date();

  if (query.dateTime) {
    const selected = new Date(query.dateTime);
    return Number.isNaN(selected.getTime()) ? null : selected;
  }

  if (query.date || query.time) {
    const date = query.date || `${now.getFullYear()}-${padLeft(now.getMonth() + 1, "0", 2)}-${padLeft(now.getDate(), "0", 2)}`;
    const time = query.time || `${padLeft(now.getHours(), "0", 2)}:${padLeft(now.getMinutes(), "0", 2)}`;
    const selected = new Date(`${date}T${time}`);
    return Number.isNaN(selected.getTime()) ? null : selected;
  }

  return now;
}

function gtfsTimeToMinutes(value) {
  if (!value) {
    return null;
  }

  const parts = value.split(":");
  if (parts.length < 2) {
    return null;
  }

  const hours = Number.parseInt(parts[0], 10);
  const minutes = Number.parseInt(parts[1], 10);
  if (!Number.isFinite(hours) || !Number.isFinite(minutes)) {
    return null;
  }

  return hours * 60 + minutes;
}

function formatDisplayTime(totalMinutes) {
  const minutesInDay = 24 * 60;
  const normalized = ((totalMinutes % minutesInDay) + minutesInDay) % minutesInDay;
  const hours = Math.floor(normalized / 60);
  const minutes = normalized % 60;
  const dayOffset = totalMinutes >= minutesInDay ? Math.floor(totalMinutes / minutesInDay) : 0;
  const suffix = dayOffset > 0 ? ` (+${dayOffset})` : "";
  return `${padLeft(hours, "0", 2)}:${padLeft(minutes, "0", 2)}${suffix}`;
}

function formatStopTimeForDisplay(value) {
  const totalMinutes = gtfsTimeToMinutes(value);
  if (totalMinutes === null) {
    return null;
  }
  return formatDisplayTime(totalMinutes);
}

function stopDisplayName(stop) {
  if (stop.platform_code) {
    return `${stop.stop_name} Platform ${stop.platform_code}`;
  }
  return stop.stop_name;
}

function isSameLocalDate(a, b) {
  return a.getFullYear() === b.getFullYear()
    && a.getMonth() === b.getMonth()
    && a.getDate() === b.getDate();
}

function getActiveServiceIds(serviceDate) {
  if (!hasScheduleCalendar) {
    return null;
  }

  const serviceDateKey = formatServiceDate(serviceDate);
  if (activeServiceIdsCache.has(serviceDateKey)) {
    return activeServiceIdsCache.get(serviceDateKey);
  }

  const dayColumn = DAY_COLUMN_LOOKUP[serviceDate.getDay()];
  const regularRows = db.prepare(
    `SELECT service_id
     FROM calendar
     WHERE start_date <= ?
     AND end_date >= ?
     AND ${dayColumn} = 1`
  ).all(serviceDateKey, serviceDateKey);
  const exceptionRows = db.prepare(
    `SELECT service_id, exception_type
     FROM calendar_dates
     WHERE date = ?`
  ).all(serviceDateKey);

  const activeServiceIds = new Set(regularRows.map(row => row.service_id));
  exceptionRows.forEach(row => {
    if (Number(row.exception_type) === 1) {
      activeServiceIds.add(row.service_id);
    }
    if (Number(row.exception_type) === 2) {
      activeServiceIds.delete(row.service_id);
    }
  });

  const serviceIds = Array.from(activeServiceIds);
  activeServiceIdsCache.set(serviceDateKey, serviceIds);
  return serviceIds;
}

function queryStopSchedule(stopId, routes, serviceDate, startMinutes, endMinutes) {
  const serviceIds = getActiveServiceIds(serviceDate);
  if (!serviceIds || !serviceIds.length) {
    return [];
  }

  const params = [stopId, ...serviceIds];
  let sql =
    `SELECT st.trip_id,
            COALESCE(st.departure_time, st.arrival_time) AS stop_time,
            st.arrival_time,
            st.departure_time,
            t.trip_headsign,
            r.route_short_name
     FROM stop_times st
     INNER JOIN trips t ON t.trip_id = st.trip_id
     INNER JOIN routes r ON r.route_id = t.route_id
     WHERE st.stop_id = ?
     AND t.service_id IN (${serviceIds.map(() => "?").join(",")})`;

  if (routes.length) {
    sql += ` AND r.route_short_name IN (${routes.map(() => "?").join(",")})`;
    params.push(...routes);
  }

  sql += ` ORDER BY COALESCE(st.departure_time, st.arrival_time), r.route_short_name, t.trip_headsign`;

  return db.prepare(sql).all(...params)
    .map(row => {
      const scheduledMinutes = gtfsTimeToMinutes(row.stop_time);
      if (scheduledMinutes === null || scheduledMinutes < startMinutes || scheduledMinutes > endMinutes) {
        return null;
      }

      return {
        tripId: row.trip_id,
        route: row.route_short_name,
        headsign: row.trip_headsign,
        scheduledMinutes,
        scheduledTime: formatStopTimeForDisplay(row.stop_time)
      };
    })
    .filter(Boolean);
}

const app = express();
app.use(helmet());
app.use(express.static("public"));

app.get("/feed", async (req, res) => {
  try {
    let routes = splitCsvParam(req.query.routes);
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

app.get("/stops", (req, res) => {
  try {
    if (!req.query.neLat || !req.query.neLng || !req.query.swLat || !req.query.swLng) {
      res.status(400);
      return res.send("Unspecified boundary parameters");
    }

    const routes = splitCsvParam(req.query.routes);
    const params = [
      Number.parseFloat(req.query.swLat),
      Number.parseFloat(req.query.neLat),
      Number.parseFloat(req.query.swLng),
      Number.parseFloat(req.query.neLng)
    ];
    let sql;
    if (hasStopRoutes) {
      sql =
        `SELECT s.stop_id,
                s.stop_code,
                s.stop_name,
                s.platform_code,
                s.stop_lat,
                s.stop_lon,
                GROUP_CONCAT(sr.route_short_name) AS route_names
         FROM stops s
         INNER JOIN stop_routes sr ON sr.stop_id = s.stop_id
         WHERE s.stop_lat BETWEEN ? AND ?
         AND s.stop_lon BETWEEN ? AND ?
         AND (s.location_type IS NULL OR s.location_type = '' OR s.location_type = '0')`;

      if (routes.length) {
        sql += ` AND sr.route_short_name IN (${routes.map(() => "?").join(",")})`;
        params.push(...routes);
      }

      sql += ` GROUP BY s.stop_id, s.stop_code, s.stop_name, s.platform_code, s.stop_lat, s.stop_lon
               ORDER BY s.stop_name`;
    } else {
      sql =
        `SELECT s.stop_id,
                s.stop_code,
                s.stop_name,
                s.platform_code,
                s.stop_lat,
                s.stop_lon,
                GROUP_CONCAT(DISTINCT r.route_short_name) AS route_names
         FROM stops s
         INNER JOIN stop_times st ON st.stop_id = s.stop_id
         INNER JOIN trips t ON t.trip_id = st.trip_id
         INNER JOIN routes r ON r.route_id = t.route_id
         WHERE s.stop_lat BETWEEN ? AND ?
         AND s.stop_lon BETWEEN ? AND ?
         AND (s.location_type IS NULL OR s.location_type = '' OR s.location_type = '0')`;

      if (routes.length) {
        sql += ` AND r.route_short_name IN (${routes.map(() => "?").join(",")})`;
        params.push(...routes);
      }

      sql += ` GROUP BY s.stop_id, s.stop_code, s.stop_name, s.platform_code, s.stop_lat, s.stop_lon
               ORDER BY s.stop_name`;
    }

    const stops = db.prepare(sql).all(...params).map(stop => ({
      id: stop.stop_id,
      code: stop.stop_code,
      name: stopDisplayName(stop),
      latitude: stop.stop_lat,
      longitude: stop.stop_lon,
      routes: stop.route_names ? stop.route_names.split(",").filter(Boolean).sort() : []
    }));

    res.json(stops);
  } catch (err) {
    console.error(err);
    res.status(500);
    res.json(err);
  }
});

app.get("/stop-times", async (req, res) => {
  try {
    if (!req.query.stopId) {
      res.status(400);
      return res.send("Need 'stopId'");
    }
    if (!hasScheduleCalendar) {
      res.status(503);
      return res.json({ error: "Schedule calendar data is missing. Rebuild the GTFS database with npm run db:build." });
    }

    const selectedDateTime = parseDateTimeQuery(req.query);
    if (!selectedDateTime) {
      res.status(400);
      return res.send("Invalid date or time");
    }

    const routes = splitCsvParam(req.query.routes);
    const requestedWindow = Number.parseInt(req.query.windowMins, 10);
    const windowMinutes = Number.isFinite(requestedWindow) && requestedWindow > 0 ? Math.min(requestedWindow, 12 * 60) : DEFAULT_STOP_WINDOW_MINUTES;
    const stop = db.prepare(
      `SELECT stop_id, stop_code, stop_name, platform_code
       FROM stops
       WHERE stop_id = ?`
    ).get(req.query.stopId);

    if (!stop) {
      res.status(404);
      return res.send("Stop not found");
    }

    const selectedMinutes = selectedDateTime.getHours() * 60 + selectedDateTime.getMinutes();
    const scheduleWindowQueries = [
      {
        serviceDate: new Date(selectedDateTime.getTime() - 24 * 60 * 60 * 1000),
        startMinutes: selectedMinutes + 24 * 60,
        endMinutes: selectedMinutes + windowMinutes + 24 * 60
      },
      {
        serviceDate: selectedDateTime,
        startMinutes: selectedMinutes,
        endMinutes: selectedMinutes + windowMinutes
      }
    ];

    let services = [];
    scheduleWindowQueries.forEach(query => {
      services = services.concat(queryStopSchedule(req.query.stopId, routes, query.serviceDate, query.startMinutes, query.endMinutes));
    });

    const liveTrips = isSameLocalDate(selectedDateTime, new Date())
      ? new Map((await cachedFeed()).vehicles.map(vehicle => [vehicle.tripId, vehicle]))
      : new Map();

    services = services
      .map(service => {
        const liveVehicle = liveTrips.get(service.tripId);
        const liveDelay = liveVehicle && Number.isFinite(liveVehicle.delay) ? liveVehicle.delay : 0;
        const expectedMinutes = liveVehicle ? service.scheduledMinutes + Math.round(liveDelay / 60) : null;

        return {
          route: service.route,
          headsign: service.headsign,
          scheduledTime: service.scheduledTime,
          expectedTime: expectedMinutes === null ? null : formatDisplayTime(expectedMinutes),
          delaySeconds: liveVehicle ? liveDelay : null,
          live: Boolean(liveVehicle),
          sortMinutes: service.scheduledMinutes
        };
      })
      .sort((a, b) => a.sortMinutes - b.sortMinutes || a.route.localeCompare(b.route) || a.headsign.localeCompare(b.headsign))
      .map(service => ({
        route: service.route,
        headsign: service.headsign,
        scheduledTime: service.scheduledTime,
        expectedTime: service.expectedTime,
        delaySeconds: service.delaySeconds,
        live: service.live
      }));

    res.json({
      stop: {
        id: stop.stop_id,
        code: stop.stop_code,
        name: stopDisplayName(stop)
      },
      services,
      windowMinutes
    });
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
