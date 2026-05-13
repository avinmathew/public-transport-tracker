#!/usr/bin/env node
/**
 * GTFS static data importer
 * Downloads the SEQ GTFS zip and builds a local SQLite database.
 * Usage: npm run db:build
 */

import { DatabaseSync } from 'node:sqlite';
import { createReadStream, existsSync } from 'node:fs';
import { rm, mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { join, dirname } from 'node:path';
import fetch from 'node-fetch';
import AdmZip from 'adm-zip';
import { parse } from 'csv-parse';

const __dirname = dirname(fileURLToPath(import.meta.url));

const GTFS_URL = process.env.GTFS_URL || 'https://gtfsrt.api.translink.com.au/GTFS/SEQ_GTFS.zip';
const DB_PATH = process.env.DB_PATH || join(__dirname, 'gtfs.sqlite');
const TMP_DIR = join(__dirname, '.gtfs_tmp');
const BATCH_SIZE = 10_000;

const SCHEMA = `
DROP TABLE IF EXISTS stop_times;
DROP TABLE IF EXISTS trips;
DROP TABLE IF EXISTS stops;
DROP TABLE IF EXISTS shapes;
DROP TABLE IF EXISTS routes;

CREATE TABLE routes (
  route_id          TEXT PRIMARY KEY,
  route_short_name  TEXT,
  route_long_name   TEXT,
  route_desc        TEXT,
  route_type        TEXT,
  route_url         TEXT,
  route_color       TEXT,
  route_text_color  TEXT
);

CREATE TABLE shapes (
  shape_id           TEXT,
  shape_pt_lat       REAL,
  shape_pt_lon       REAL,
  shape_pt_sequence  INTEGER
);

CREATE TABLE stops (
  stop_id         TEXT PRIMARY KEY,
  stop_code       TEXT,
  stop_name       TEXT,
  stop_desc       TEXT,
  stop_lat        REAL,
  stop_lon        REAL,
  zone_id         TEXT,
  stop_url        TEXT,
  location_type   TEXT,
  parent_station  TEXT,
  platform_code   TEXT
);

CREATE TABLE trips (
  route_id      TEXT,
  service_id    TEXT,
  trip_id       TEXT PRIMARY KEY,
  trip_headsign TEXT,
  direction_id  INTEGER,
  block_id      TEXT,
  shape_id      TEXT
);

CREATE TABLE stop_times (
  trip_id         TEXT,
  arrival_time    TEXT,
  departure_time  TEXT,
  stop_id         TEXT,
  stop_sequence   TEXT,
  pickup_type     TEXT,
  drop_off_type   TEXT
);

CREATE INDEX ix_shapes_shape_id    ON shapes    (shape_id);
CREATE INDEX ix_trips_covering     ON trips     (trip_id, route_id, direction_id, shape_id);
CREATE INDEX ix_stop_times_trip_id ON stop_times (trip_id);
CREATE INDEX ix_stop_times_stop_id ON stop_times (stop_id);
CREATE INDEX ix_stops_stop_id      ON stops     (stop_id);
CREATE INDEX ix_stops_stop_code    ON stops     (stop_code);
`;

// ---------------------------------------------------------------------------
// Download

async function downloadGTFS() {
  console.log(`Downloading GTFS data from ${GTFS_URL} ...`);
  const response = await fetch(GTFS_URL);
  if (!response.ok) {
    throw new Error(`Download failed: HTTP ${response.status} ${response.statusText}`);
  }
  const buffer = Buffer.from(await response.arrayBuffer());
  console.log(`  Downloaded ${(buffer.length / 1024 / 1024).toFixed(1)} MB`);
  return buffer;
}

// ---------------------------------------------------------------------------
// Extract

async function extractGTFS(buffer) {
  console.log('Extracting GTFS files...');
  if (existsSync(TMP_DIR)) await rm(TMP_DIR, { recursive: true });
  await mkdir(TMP_DIR, { recursive: true });
  const zip = new AdmZip(buffer);
  zip.extractAllTo(TMP_DIR, /* overwrite */ true);
  console.log('  Extracted');
}

// ---------------------------------------------------------------------------
// CSV parsing (streaming via csv-parse for RFC4180 quoting support)

async function* parseCSVStream(filePath) {
  const parser = createReadStream(filePath).pipe(parse({
    bom: true,
    columns: headers => headers.map(header => header.trim()),
    skip_empty_lines: true,
  }));

  for await (const row of parser) {
    yield row;
  }
}

// ---------------------------------------------------------------------------
// Import one GTFS table

async function importTable(db, tableName, filePath, columns) {
  if (!existsSync(filePath)) {
    console.log(`  Skipping ${tableName}: file not found`);
    return 0;
  }

  const placeholders = columns.map(() => '?').join(',');
  const insert = db.prepare(
    `INSERT INTO ${tableName} (${columns.join(',')}) VALUES (${placeholders})`
  );

  let count = 0;
  db.exec('BEGIN');
  try {
    for await (const row of parseCSVStream(filePath)) {
      const values = columns.map(col => row[col] ?? '');
      insert.run(...values);
      count++;
      if (count % BATCH_SIZE === 0) {
        db.exec('COMMIT');
        db.exec('BEGIN');
        process.stdout.write(`\r  ${tableName}: ${count.toLocaleString()} rows...`);
      }
    }
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
  process.stdout.write(`\r  ${tableName}: ${count.toLocaleString()} rows imported\n`);
  return count;
}

// ---------------------------------------------------------------------------
// Main

async function main() {
  const buffer = await downloadGTFS();
  await extractGTFS(buffer);

  console.log(`Building SQLite database at ${DB_PATH} ...`);
  const db = new DatabaseSync(DB_PATH);
  db.exec(SCHEMA);

  await importTable(db, 'routes', join(TMP_DIR, 'routes.txt'), [
    'route_id', 'route_short_name', 'route_long_name', 'route_desc',
    'route_type', 'route_url', 'route_color', 'route_text_color',
  ]);
  await importTable(db, 'shapes', join(TMP_DIR, 'shapes.txt'), [
    'shape_id', 'shape_pt_lat', 'shape_pt_lon', 'shape_pt_sequence',
  ]);
  await importTable(db, 'stops', join(TMP_DIR, 'stops.txt'), [
    'stop_id', 'stop_code', 'stop_name', 'stop_desc',
    'stop_lat', 'stop_lon', 'zone_id', 'stop_url',
    'location_type', 'parent_station', 'platform_code',
  ]);
  await importTable(db, 'trips', join(TMP_DIR, 'trips.txt'), [
    'route_id', 'service_id', 'trip_id', 'trip_headsign',
    'direction_id', 'block_id', 'shape_id',
  ]);
  await importTable(db, 'stop_times', join(TMP_DIR, 'stop_times.txt'), [
    'trip_id', 'arrival_time', 'departure_time', 'stop_id',
    'stop_sequence', 'pickup_type', 'drop_off_type',
  ]);

  db.close();
  await rm(TMP_DIR, { recursive: true });
  console.log(`\nDone. Database ready at: ${DB_PATH}`);
}

main().catch(err => {
  console.error('\nImport failed:', err.message);
  process.exit(1);
});
