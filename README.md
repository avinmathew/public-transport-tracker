# Public Transport Tracker

Displays vehicle data from a [GTFS (General Transit Feed Specification) Realtime](https://developers.google.com/transit/gtfs-realtime/) feed on a map. The map uses a Google Maps basemap with the traffic layer turned on.

The map can also show stops within the current viewport as clickable circles. Stop results respect the active route filters, and each stop opens a mobile-friendly timetable panel showing the next 2 hours of services from a selected date/time. When a matching trip is currently operating, its live delay is shown alongside the scheduled time.

Uses [GTFS Static](https://developers.google.com/transit/gtfs/) to provide vehicle type and direction data. GTFS Static data must be first stored in a database, while the Realtime data can be queried directly from an API provided by the transit provider.

Realtime vehicle data is cached in memory for 10 seconds to avoid refetching the upstream feed on every request.

The application has only been tested with the [Translink South East QLD feed](https://gtfsrt.api.translink.com.au/).

## Build the static GTFS database

The app uses a local SQLite file (no database server required). Build it with:

```sh
npm run db:build
```

This downloads the SEQ GTFS zip from Translink, parses the CSV files, and writes `db/gtfs.sqlite`. Re-run whenever the static schedule data needs refreshing.

If you pull a version of the app with stop timetables for the first time, rebuild the GTFS database so the `calendar` and `calendar_dates` tables are present.

The download URL can be overridden with the `GTFS_URL` environment variable, and the output path with `DB_PATH`.

## Environment variables

Environment variables can either be supplied via command line or put in a `.env` file.

* `GTFS_REALTIME_URL`: GTFS Realtime URL, e.g. `https://gtfsrt.api.translink.com.au/api/realtime/SEQ/VehiclePositions`
* `DB_PATH`: Path to the SQLite database file. Defaults to `db/gtfs.sqlite` relative to the project root.
* `GTFS_URL`: GTFS static zip URL used by `npm run db:build`. Defaults to the Translink SEQ feed.
* `PORT`: Port to run the Node.js server on. Defaults to `3000`.

## Requirements

Node.js ≥ 22.5.0

## Browser query string

The browser supports the following query strings

* routes: comma-delimited set of routes that would match the `route_short_name` of a trip. If omitted, then all vehicles are displayed; however, GTFS Static data is not queried from the database for performance reasons.
* lat: initial latitude of the map center. If omitted, uses HTML5 geolocation and if not available, defaults to Brisbane, Australia.
* lng: initial longitude of the map center. If omitted, uses HTML5 geolocation and if not available, defaults to Brisbane, Australia.
* z: initial zoom level of the map.
* traffic: "on" or "off" to enable/disable traffic layer on startup

## Development

First build the database:

    npm run db:build

Prepare static, minified assets:

    npm run prepare

To start the server, either run `watch` or `start`.

To watch asset sources and rebuild on changes:

    npm run watch

This runs `npm run prepare` once on startup, then rebuilds whenever files in `src` change.

To start server with no watch:

    npm run start
    
Visit <http://localhost:3000>.
