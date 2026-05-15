var DEFAULT_LAT = -27.4698, DEFAULT_LNG = 153.0251, DEFAULT_ZOOM = 15;
var LATLNG_DECIMAL_PLACES = 5;
var REFRESH_UPDATE_INTERVAL = 1000; // ms, how often to update countdown timer
var REFRESH_INTERVAL = 15000; // ms
var LABEL_SHOW_ZOOM_LEVEL = 12;
var STOP_WINDOW_MINUTES = 120;
var STOP_PANEL_REFRESH_INTERVAL = 30000;
var STOP_MARKER_RADIUS = 6;

var $refreshStatus = document.getElementById("refresh");
var $stopPanelBackdrop = document.getElementById("stop-panel-backdrop");
var $stopPanel = document.getElementById("stop-panel");
var $stopPanelClose = document.getElementById("stop-panel-close");
var $stopPanelName = document.getElementById("stop-panel-name");
var $stopPanelMeta = document.getElementById("stop-panel-meta");
var $stopPanelRoutes = document.getElementById("stop-panel-routes");
var $stopPanelStatus = document.getElementById("stop-panel-status");
var $stopPanelForm = document.getElementById("stop-panel-form");
var $stopDateTime = document.getElementById("stop-date-time");
var $stopPanelResults = document.getElementById("stop-panel-results");

var search = URI().search(true);
var stopLayerLookup = {};
var selectedStopId = null;
var selectedStopData = null;
var isFetchingStops = false;
var stopRequestController = null;
var stopTimesRequestController = null;
var stopPanelRefreshHandle = null;

function toDateTimeLocalValue(date) {
  return [
    date.getFullYear(),
    String(date.getMonth() + 1).padStart(2, "0"),
    String(date.getDate()).padStart(2, "0")
  ].join("-") + "T" + [
    String(date.getHours()).padStart(2, "0"),
    String(date.getMinutes()).padStart(2, "0")
  ].join(":");
}

function describeDelay(delaySeconds, live) {
  if (!live) {
    return "Scheduled";
  }
  if (!Number.isFinite(delaySeconds) || delaySeconds === 0) {
    return "On time";
  }

  var minutes = Math.round(Math.abs(delaySeconds) / 60);
  if (!minutes) {
    minutes = 1;
  }
  return minutes + "m " + (delaySeconds > 0 ? "late" : "early");
}

function buildBoundsUrl(path) {
  var url = URI(path);
  var bounds = map.getBounds();
  url = url.addSearch("neLat", bounds.getNorthEast().lat.toFixed(6));
  url = url.addSearch("neLng", bounds.getNorthEast().lng.toFixed(6));
  url = url.addSearch("swLat", bounds.getSouthWest().lat.toFixed(6));
  url = url.addSearch("swLng", bounds.getSouthWest().lng.toFixed(6));
  var currentSearch = URI().search(true);
  if (currentSearch.routes) {
    url = url.addSearch("routes", currentSearch.routes);
  }
  return url;
}

function stopMarkerStyle(isSelected) {
  return {
    radius: isSelected ? STOP_MARKER_RADIUS + 2 : STOP_MARKER_RADIUS,
    color: isSelected ? "#7c2d12" : "#7c2d12",
    weight: isSelected ? 3 : 2,
    fillColor: isSelected ? "#facc15" : "#fb923c",
    fillOpacity: isSelected ? 0.98 : 0.92
  };
}

function setStopMarkerStyle(marker, isSelected) {
  marker.setStyle(stopMarkerStyle(isSelected));
}

function refreshSelectedStopMarker() {
  Object.keys(stopLayerLookup).forEach(function (id) {
    setStopMarkerStyle(stopLayerLookup[id], id === selectedStopId);
  });
}

function setStopPanelStatus(message, type) {
  $stopPanelStatus.className = "stop-panel-status" + (type ? " " + type : "");
  $stopPanelStatus.textContent = message || "";
}

function closeStopPanel() {
  selectedStopId = null;
  selectedStopData = null;
  refreshSelectedStopMarker();
  $stopPanel.classList.remove("open");
  $stopPanelBackdrop.classList.remove("open");
  $stopPanel.setAttribute("aria-hidden", "true");
  setStopPanelStatus("");
  $stopPanelResults.innerHTML = "";
  if (stopTimesRequestController) {
    stopTimesRequestController.abort();
    stopTimesRequestController = null;
  }
  if (stopPanelRefreshHandle) {
    clearInterval(stopPanelRefreshHandle);
    stopPanelRefreshHandle = null;
  }
}

function ensureStopPanelRefresh() {
  if (stopPanelRefreshHandle) {
    clearInterval(stopPanelRefreshHandle);
  }
  stopPanelRefreshHandle = setInterval(function () {
    if (selectedStopId) {
      loadStopTimes();
    }
  }, STOP_PANEL_REFRESH_INTERVAL);
}

function renderStopPanel(result) {
  var services = result.services || [];
  if (!services.length) {
    $stopPanelResults.innerHTML = '<tr><td colspan="4" class="stop-panel-empty">No services in this time window.</td></tr>';
    setStopPanelStatus("Showing the next 2 hours from the selected time.");
    return;
  }

  $stopPanelResults.innerHTML = services.map(function (service) {
    var timeHtml = service.expectedTime && service.expectedTime !== service.scheduledTime ?
      '<div class="time-primary">' + service.expectedTime + '</div><div class="time-secondary">Sched ' + service.scheduledTime + '</div>' :
      '<div class="time-primary">' + service.scheduledTime + '</div>';
    var delayText = describeDelay(service.delaySeconds, service.live);
    return (
      '<tr class="' + (service.live ? 'live-service' : 'scheduled-service') + '">' +
        '<td class="route-cell">' + service.route + '</td>' +
        '<td class="time-cell">' + timeHtml + '</td>' +
        '<td class="delay-cell">' + delayText + '</td>' +
        '<td class="headsign-cell">' + (service.headsign || '') + '</td>' +
      '</tr>'
    );
  }).join("");
  setStopPanelStatus("Showing the next 2 hours from the selected time.");
}

function loadStopTimes() {
  if (!selectedStopData) {
    return;
  }

  if (stopTimesRequestController) {
    stopTimesRequestController.abort();
  }
  stopTimesRequestController = new AbortController();

  var url = URI("stop-times")
    .addSearch("stopId", selectedStopData.id)
    .addSearch("windowMins", STOP_WINDOW_MINUTES)
    .addSearch("dateTime", $stopDateTime.value || toDateTimeLocalValue(new Date()));
  var currentSearch = URI().search(true);
  if (currentSearch.routes) {
    url = url.addSearch("routes", currentSearch.routes);
  }

  setStopPanelStatus("Loading departures...", "loading");

  return fetch(url.toString(), { signal: stopTimesRequestController.signal })
    .then(function (response) {
      return response.json().then(function (result) {
        if (response.status !== 200) {
          throw new Error(result.error || result.message || "Unable to load stop timetable");
        }
        return result;
      });
    })
    .then(function (result) {
      $stopPanelName.textContent = result.stop.name;
      $stopPanelMeta.textContent = result.stop.code ? "Stop " + result.stop.code : "Stop timetable";
      renderStopPanel(result);
    })
    .catch(function (err) {
      if (err.name === "AbortError") {
        return;
      }
      $stopPanelResults.innerHTML = '<tr><td colspan="4" class="stop-panel-empty">' + err.message + '</td></tr>';
      setStopPanelStatus("Could not load timetable.", "error");
      console.error(err);
    });
}

function openStopPanel(stopData) {
  selectedStopId = stopData.id;
  selectedStopData = stopData;
  refreshSelectedStopMarker();
  $stopPanel.classList.add("open");
  $stopPanelBackdrop.classList.add("open");
  $stopPanel.setAttribute("aria-hidden", "false");
  $stopPanelName.textContent = stopData.name;
  $stopPanelMeta.textContent = stopData.code ? "Stop " + stopData.code : "Stop timetable";
  $stopPanelRoutes.innerHTML = (stopData.routes || []).map(function (route) {
    return '<span class="route-chip">' + route + '</span>';
  }).join("");
  if (!$stopDateTime.value) {
    $stopDateTime.value = toDateTimeLocalValue(new Date());
  }
  loadStopTimes();
  ensureStopPanelRefresh();
}

function syncVisibleData() {
  remaining = 0;
  getFeed();
  getStops();
  if (selectedStopId) {
    loadStopTimes();
  }
}

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
      syncVisibleData();
    };
    $routes.appendChild($route);
  });

  // Input
  var $inputRoute = document.createElement("input");
  $inputRoute.type = "text";
  $inputRoute.placeholder = "Filter route";
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
    syncVisibleData();
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
  };
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

map.on("moveend", function () {
  var latlng = map.getCenter();
  var url = URI().setSearch({
    lat: latlng.lat.toFixed(LATLNG_DECIMAL_PLACES),
    lng: latlng.lng.toFixed(LATLNG_DECIMAL_PLACES),
    z: map.getZoom()
  });
  window.history.pushState("", "", url.toString());
  remaining = 0;
  getFeed();
  getStops();
});

// Add base map
L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png').addTo(map);

var shapeGroup = L.layerGroup().addTo(map);
var layerGroup = L.layerGroup().addTo(map);
var stopLayerGroup = L.layerGroup().addTo(map);

var vehicleLayerLookup = {};

map.on("zoom", toggleLabels);

// On zoom, immediately clear CSS transitions so Leaflet's reprojection snaps
// markers to their correct map position instead of animating from the old one.
// Clear on both zoomstart (initial snap) and zoomend (catches any animate()
// calls that fired mid-zoom and re-applied a transition).
function clearAllMarkerTransitions() {
  for (var id in vehicleLayerLookup) {
    vehicleLayerLookup[id]._clearTransition();
  }
}
map.on("zoomstart", clearAllMarkerTransitions);
map.on("zoomend", clearAllMarkerTransitions);

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
    html += '<span class="dir-arrow">&#9664;</span>';
  }
  html += '<span class="route-id">' + route + '</span>';
  if (direction === "out") {
    html += '<span class="dir-arrow">&#9654;</span>';
  }
  html += "</span>";
  return html;
}

function delayLabel(delay) {
  if (!Number.isFinite(delay) || delay === 0) {
    return "";
  }

  var minutes = Math.floor(Math.abs(delay) / 60);
  var seconds = Math.abs(delay) - minutes * 60;
  var label = "";
  if (minutes) {
    label += minutes.toString() + "m";
  }
  if (seconds) {
    label += seconds.toString() + "s";
  }
  if (!label) {
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
  return L.divIcon({
    className: "div-icon " + routeType,
    html: label
  });
}

function getStops() {
  if (isFetchingStops && stopRequestController) {
    stopRequestController.abort();
  }

  isFetchingStops = true;
  stopRequestController = new AbortController();

  return fetch(buildBoundsUrl("stops").toString(), { signal: stopRequestController.signal })
    .then(function (response) {
      if (response.status !== 200) {
        throw new Error("Unable to load stops");
      }
      return response.json();
    })
    .then(function (stops) {
      var visibleStopIds = {};

      stops.forEach(function (stop) {
        var marker = stopLayerLookup[stop.id];
        visibleStopIds[stop.id] = true;

        if (!marker) {
          marker = L.circleMarker([stop.latitude, stop.longitude], {
            className: "stop-circle",
            ...stopMarkerStyle(stop.id === selectedStopId)
          });
          marker.on("click", function () {
            openStopPanel(marker.options.stopData);
          });
          marker.addTo(stopLayerGroup);
          stopLayerLookup[stop.id] = marker;
        } else {
          marker.setLatLng([stop.latitude, stop.longitude]);
        }

        marker.options.stopData = stop;
      });

      Object.keys(stopLayerLookup).forEach(function (stopId) {
        if (visibleStopIds[stopId]) {
          return;
        }
        stopLayerLookup[stopId].remove();
        delete stopLayerLookup[stopId];
        if (selectedStopId === stopId) {
          closeStopPanel();
        }
      });

      if (selectedStopId && stopLayerLookup[selectedStopId]) {
        selectedStopData = stopLayerLookup[selectedStopId].options.stopData;
      }
      refreshSelectedStopMarker();
      isFetchingStops = false;
    })
    .catch(function (err) {
      isFetchingStops = false;
      if (err.name === "AbortError") {
        return;
      }
      console.error(err);
    });
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
  return fetch(buildBoundsUrl("feed").toString())
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
              marker.stop(); // Cancel any in-progress animation before starting a new one
              marker.setLine([[marker.options.lastPosition.latitude, marker.options.lastPosition.longitude], [e.latitude, e.longitude]]);
              marker.options.lastPosition = {
                latitude: e.latitude,
                longitude: e.longitude
              };
              marker.start();
            }
          } else { // Create marker
            var icon = createIcon(e.routeType, e.route, e.direction, e.delay);
            marker = L.animatedMarker([[e.latitude, e.longitude]], {
              icon: icon,
              interval: REFRESH_INTERVAL - 1000, // Subtract 1 sec as buffer
              autoStart: false, // Don't animate on add: icon size isn't finalised yet
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
        var entityIds = entities.map(function (e) { return e.id; });
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

$stopDateTime.value = toDateTimeLocalValue(new Date());
$stopPanelClose.onclick = closeStopPanel;
$stopPanelBackdrop.onclick = closeStopPanel;
$stopPanelForm.onsubmit = function (e) {
  e.preventDefault();
  loadStopTimes();
};
window.addEventListener("keydown", function (e) {
  if (e.key === "Escape") {
    closeStopPanel();
  }
});

getFeed();
getStops();
setInterval(getFeed, REFRESH_UPDATE_INTERVAL);
