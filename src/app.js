var DEFAULT_LAT = -27.4698, DEFAULT_LNG = 153.0251, DEFAULT_ZOOM = 15;
var LATLNG_DECIMAL_PLACES = 6;
var REFRESH_INTERVAL = 20000; // ms
var LABEL_SHOW_ZOOM_LEVEL = 12;

var $refresh = document.getElementById("refresh");
var spinner = new Spinner({
  radius: 4,
  width: 2,
  length: 6
});

var search = URI().search(true);
var routes = [];
if (search.routes) {
  routes = search.routes.split(",");
}

var map = L.map("map", { attributionControl: false });
if (search.lat && search.lng) {
  var zoom = search.z || DEFAULT_ZOOM;
  map.setView([search.lat, search.lng], zoom);
} else {
  map.setView([DEFAULT_LAT, DEFAULT_LNG], DEFAULT_ZOOM);
}
if (navigator.geolocation && !(search.lat && search.lng)) {
  navigator.geolocation.getCurrentPosition(function (position) {
    map.setView([position.coords.latitude, position.coords.longitude], DEFAULT_ZOOM);
  });
}
map.on("moveend", function (e) {
  var latlng = map.getCenter();
  var url = URI().setSearch({
    lat: latlng.lat.toFixed(LATLNG_DECIMAL_PLACES),
    lng: latlng.lng.toFixed(LATLNG_DECIMAL_PLACES),
    z: map.getZoom()
  });
  window.history.pushState("", "", url.toString());
  getFeed();
});

var googleMaps = L.gridLayer.googleMutant({
  type: "roadmap"
}).addTo(map);
googleMaps.addGoogleLayer("TrafficLayer");

var shapeGroup = L.layerGroup().addTo(map);
var layerGroup = L.layerGroup().addTo(map);

var vehicleLayerLookup = {};

map.on("zoom", toggleLabels);

// Toggle labels depending on zoom level
function toggleLabels() {
  var zoom = map.getZoom();
  for (var id in vehicleLayerLookup) {
    var marker = vehicleLayerLookup[id];
    if (marker._icon) {
      if (zoom >= LABEL_SHOW_ZOOM_LEVEL) {
        L.DomUtil.removeClass(marker._icon, "hide-label");
      } else {
        L.DomUtil.addClass(marker._icon, "hide-label");
      }
    }
  }
}

function vehicleLabel(route, direction) {
  var html = '<span class="vehicle-label">';
  if (direction === "inbound") {
    html += "&lt;";
  }
  html += route
  if (direction === "outbound") {
    html += "&gt;";
  }
  html += "</span>";
  return html;
}

function delayLabel(delay) {
  var minutes = Math.floor(Math.abs(delay) / 60);
  var seconds = Math.abs(delay) - minutes * 60;
  var label = "";
  if (minutes) {
    label += minutes.toString() + "m";
  }
  if (seconds) {
    label += seconds.toString() + "s";
  }
  if (!minutes || !seconds) {
    return "";
  }
  return '<span class="delay-label ' + (delay > 0 ? "late" : "early") + '">' + label + "</span>";
}

function createIcon(routeType, route, direction, delay) {
  var label = "<div>" + vehicleLabel(route, direction) + "</div>";
  var delayLbl = delayLabel(delay);
  if (delayLbl) {
    label += '<div class="delay-cont">' + delayLabel(delay) + "</div>";
  }
  var icon = L.divIcon({
    className: "div-icon " + routeType,
    html: label
  });
  return icon;
}

var isFetching = false;
function getFeed() {
  if (isFetching) {
    return; // Don't get feed if request is already in progress
  }
  isFetching = true;

  spinner.spin($refresh);
  var feedUrl = URI("feed");
  var bounds = map.getBounds();
  feedUrl = feedUrl.addSearch("neLat", bounds.getNorthEast().lat.toFixed(6));
  feedUrl = feedUrl.addSearch("neLng", bounds.getNorthEast().lng.toFixed(6));
  feedUrl = feedUrl.addSearch("swLat", bounds.getSouthWest().lat.toFixed(6));
  feedUrl = feedUrl.addSearch("swLng", bounds.getSouthWest().lng.toFixed(6));
  if (search.routes) {
    feedUrl = feedUrl.addSearch("routes", search.routes);
  }
  return fetch(feedUrl.toString())
    .then(function (response) {
      if (response.status !== 200) {
        return;
      }
      return response.json().then(function (entities) {
        entities.forEach(function (e) {
          var marker = vehicleLayerLookup[e.id];

          if (marker) { // Update marker
            var icon = createIcon(e.routeType, e.route, e.direction, e.delay);
            marker.setIcon(icon);

            if (marker._icon) {
              if (e.longitude && e.latitude) {
                L.DomUtil.removeClass(marker._icon, "disconnected");
              } else {
                L.DomUtil.addClass(marker._icon, "disconnected");
              }
            }

            if (e.latitude && e.longitude) {
              marker.setLatLng([e.latitude, e.longitude]);
              marker.options.lastPosition = {
                latitude: e.latitude,
                longitude: e.longitude
              }
            }
          } else { // Create marker
            var icon = createIcon(e.routeType, e.route, e.direction, e.delay);
            marker = L.marker([e.latitude, e.longitude], {
              icon: icon,
              lastPosition: {
                latitude: e.latitude,
                longitude: e.longitude
              }
            });
            marker.addTo(layerGroup);
            vehicleLayerLookup[e.id] = marker;
            // Need to calculate icon dimensions after adding to DOM
            var bounds = marker._icon.firstChild.getBoundingClientRect();
            icon.options.iconSize = [bounds.width, bounds.height];
            marker.setIcon(icon);
          }
        });

        // Remove vehicles no longer in feed
        var entityIds = entities.map(function (e) { return e.id });
        var layerIds = Object.keys(vehicleLayerLookup);
        var layersToRemove = layerIds.filter(function (l) { return !entityIds.includes(l); });
        layersToRemove.forEach(function (l) {
          vehicleLayerLookup[l].remove();
          delete vehicleLayerLookup[l];
        });

        spinner.stop();
        isFetching = false;
      });
    })
    .catch(function (e) {
      for (var id in vehicleLayerLookup) {
        var marker = vehicleLayerLookup[id];
        if (marker.stop) {
          marker.stop();
        }
        if (marker._icon) {
          L.DomUtil.addClass(marker._icon, "disconnected");
        }
      }
      spinner.stop();
      isFetching = false;
      console.error(e);
    });
}
getFeed()
  .then(toggleLabels);
setInterval(getFeed, REFRESH_INTERVAL);
