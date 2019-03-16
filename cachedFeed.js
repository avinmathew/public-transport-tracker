const axios = require("axios");
const GtfsRealtimeBindings = require("gtfs-realtime-bindings");

const URL = process.env.GTFS_REALTIME_URL;
const LATLNG_DECIMAL_PLACES = 5; // Precision to send back to client

const CACHE_INVALIDATE_TIME = 10000;

module.exports = function () {
  const cache = {
    date: null,
    vehicles: null,
    refreshPromise: null
  };
  return {
    get: () => {
      // Check if the cache should be invalidated
      if (cache.date && Date.now() - cache.date > CACHE_INVALIDATE_TIME) {
        cache.date = null;
        cache.gtfs = null;
      }
      // If not invalidated, return cached vehicles
      if (cache.vehicles) {
        return new Promise((resolve, reject) => {
          resolve(cache.gtfs);
        });
      }
      // If in the process of refreshing, return existing promise
      if (cache.refreshPromise) {
        return cache.refreshPromise;
      }
      // Otherwise refresh cache and return value
      cache.refreshPromise = new Promise(async (resolve, reject) => {
        try {
          const response = await axios.get(URL, { responseType: "arraybuffer" });
          const feed = GtfsRealtimeBindings.FeedMessage.decode(response.data);
          const timestamp = new Date(feed.header.timestamp.low * 1000);

          // Find vehicles with lat/lng coords
          let vehicles = feed.entity
            .filter(e => e.vehicle && e.vehicle.position && e.vehicle.position.latitude && e.vehicle.position.longitude)
            .reduce((acc, v) => {
              acc[v.vehicle.trip.trip_id] = {
                id: v.id,
                tripId: v.vehicle.trip.trip_id,
                route: v.vehicle.trip.route_id.split("-")[0],
                latitude: v.vehicle.position.latitude && +v.vehicle.position.latitude.toFixed(LATLNG_DECIMAL_PLACES),
                longitude: v.vehicle.position.longitude && +v.vehicle.position.longitude.toFixed(LATLNG_DECIMAL_PLACES)
              };
              return acc;
            }, {});

          // Add delay to vehicles
          feed.entity
            .filter(e => e.trip_update)
            .forEach(t => {
              const vehicle = vehicles[t.trip_update.trip.trip_id];
              if (!vehicle) {
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
              vehicle.delay = delay;
            });


          cache.gtfs = {
            timestamp,
            vehicles: Object.values(vehicles)
          };
          cache.refreshPromise = null;
          cache.date = Date.now();

          return resolve(cache.gtfs);
        } catch (err) {
          cache.refreshPromise = null;
          return reject(err);
        }
      });
      return cache.refreshPromise;
    },
  }
}();
