# Public Transport Tracker

Displays vehicle data from a [GTFS (General Transit Feed Specification) Realtime](https://developers.google.com/transit/gtfs-realtime/) feed on a map. The map uses a Google Maps basemap with the traffic layer turned on.

Uses [GTFS Static](https://developers.google.com/transit/gtfs/) data to approximate positions to allow moving markers. GTFS Static data must be first stored in a database, while the Realtime data can be queried directly from an API provided by the transit provider.

The application has only been tested with the [Translink South East QLD feed](https://gtfsrt.api.translink.com.au/).

## Create database

See `db` for SQL scripts to create tables, insert data (MySQL scripts for bulk loading data) and creating indexes for GTFS Static data.

Note: drop indexes before bulk loading data.

## Environment variables

Environment variables can either be supplied via command line or put in a `.env` file.

* REALTIME_URL: GTFS Realtime URL, e.g. https://gtfsrt.api.translink.com.au/Feed/SEQ
* DB_CLIENT: Knex database client, e.g. mysql
* DB_HOST: Database server, e.g. localhost
* DB_USER: Database user
* DB_PASSWORD: Database user password
* DB_DATABASE: Database name, e.g. translink_gtfs
* PORT: Port to run Node.js server, e.g. 3000

## Browser query string

The browser supports the following query strings

* routes: comma-delimited set of routes that would match the `route_short_name` of a trip. If omitted, then all vehicles are displayed; however, GTFS Static data is not queried from the database for performance reasons.
* lat: initial latitude of the map center. If omitted, uses HTML5 geolocation and if not available, defaults to Brisbane, Australia.
* lng: initial longitude of the map center. If omitted, uses HTML5 geolocation and if not available, defaults to Brisbane, Australia.
* z: initial zoom level of the map.

## Run server

In development, start the server with `npm start` and visit <http://localhost:3000>.

## Dependency changes

`node_modules/gtfs-realtime-bindings/gtfs-realtime.js` has been modified to allow an extra `ScheduleRelationship` enum  of `5` to prevent the Translink feed from crashing.
