var DEFAULT_LAT = -27.4698, DEFAULT_LNG = 153.0251, DEFAULT_ZOOM = 15;
var LATLNG_DECIMAL_PLACES = 5;
var REFRESH_UPDATE_INTERVAL = 1000; // ms, how often to update countdown timer
var REFRESH_INTERVAL = 15000; // ms
var LABEL_SHOW_ZOOM_LEVEL = 12;

var $refreshStatus = document.getElementById("refresh");

var search = URI().search(true);

// Setup routes panel
function refreshRoutesPanel() {
  var search = URI().search(true);
  var routes = [];
  if (search.routes) {
    routes = search.routes.split(",");
    routes.sort();
  }

  var $routes = document.querySelector("#routes");

  // Clear existing content. This also removes all existing event handlers
  $routes.innerHTML = "";

  // Add existing routes
  routes.forEach(function (route) {
    var $route = document.createElement("span");
    $route.classList.add("route");
    $route.innerHTML = route;
    $route.onclick = function () {
      var newRoutes = routes.filter(function (r) { return route !== r; });
      var url = URI().setSearch({routes: newRoutes.join(",")});
      window.history.pushState("", "", url.toString());
      refreshRoutesPanel();
    };
    $routes.appendChild($route);
  });

  // Input
  var $inputRoute = document.createElement("input");
  $inputRoute.type = "text";
  $inputRoute.placeholder = "Add route";
  $inputRoute.maxLength = 4;
  var addRoute = function () {
    if ($inputRoute.value === "") {
      return;
    }
    var existingRoute = routes.find(function (r) { return r === $inputRoute.value; });
    if (existingRoute) {
      $inputRoute.value = "";
      return;
    }
    routes.push($inputRoute.value);
    var url = URI().setSearch({routes: routes.join(",")});
    window.history.pushState("", "", url.toString());
    refreshRoutesPanel();
  };
  $inputRoute.onfocus = function () {
    // On Android, selecting input triggers a resize event which then rerenders the panel and creates a new input,
    // and thus the input loses focus. So stop resize event and restore it on blur.
    window.onresize = null;
  };
  $inputRoute.onblur = function () {
    window.onresize = refreshRoutesPanel;
    addRoute();
  };
  $inputRoute.onkeyup = function (e) {
    if (e.keyCode == 13) {
      window.onresize = refreshRoutesPanel;
      addRoute();
    }
  }
  $routes.appendChild($inputRoute);

  // Center panel
  var windowWidth = window.innerWidth;
  var routesWidth = $routes.offsetWidth;
  $routes.style.left = windowWidth / 2 - routesWidth / 2;
}
refreshRoutesPanel();
window.onresize = refreshRoutesPanel;

var map = L.map("map", { attributionControl: false });

// Set map position
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
  remaining = 0;
  getFeed();
});

// Add base map
L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png').addTo(map);

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
  if (direction === "in") {
    html += "&lt;";
  }
  html += route
  if (direction === "out") {
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
var remaining = 0;
function getFeed() {
  if (isFetching) {
    return; // Don't get feed if request is already in progress
  }

  if (remaining > 0) {
    $refreshStatus.innerHTML = "Updating in " + remaining / 1000 + " sec";
    remaining -= REFRESH_UPDATE_INTERVAL;
    return;
  }

  isFetching = true;

  $refreshStatus.innerHTML = "Updating";
  var feedUrl = URI("feed");
  var bounds = map.getBounds();
  feedUrl = feedUrl.addSearch("neLat", bounds.getNorthEast().lat.toFixed(6));
  feedUrl = feedUrl.addSearch("neLng", bounds.getNorthEast().lng.toFixed(6));
  feedUrl = feedUrl.addSearch("swLat", bounds.getSouthWest().lat.toFixed(6));
  feedUrl = feedUrl.addSearch("swLng", bounds.getSouthWest().lng.toFixed(6));
  var search = URI().search(true);
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
              marker.setLine([[marker.options.lastPosition.latitude, marker.options.lastPosition.longitude], [e.latitude, e.longitude]]);
              marker.options.lastPosition = {
                latitude: e.latitude,
                longitude: e.longitude
              }
              marker.start();
            }
          } else { // Create marker
            var icon = createIcon(e.routeType, e.route, e.direction, e.delay);
            marker = L.animatedMarker([[e.latitude, e.longitude]], {
              icon: icon,
              interval: REFRESH_INTERVAL - 1000, // Subtract 1 sec as buffer
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

        toggleLabels();

        $refreshStatus.innerHTML = "Updated";
        isFetching = false;
        remaining = REFRESH_INTERVAL;
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
      $refreshStatus.innerHTML = "Error";
      isFetching = false;
      remaining = REFRESH_INTERVAL;
      console.error(e);
    });
}
getFeed();
setInterval(getFeed, REFRESH_UPDATE_INTERVAL);
