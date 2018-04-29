var DEFAULT_LAT = -27.4698, DEFAULT_LNG = 153.0251, DEFAULT_ZOOM = 15;
var LATLNG_DECIMAL_PLACES = 6;
var REFRESH_INTERVAL = 20000; // ms
var INITIAL_SPEED = 40; // km/h
var STOP_DURATION = 15000; // ms
var MOVEMENT_THRESHOLD = 0.02 // km
var PATH_THRESHOLD = 0.02 // km
var LABEL_SHOW_ZOOM_LEVEL = 12;

var ARBITARY_DATE = "2000-01-01T"; // Used for constructing a datetime string

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

function calculateNearestPoint(shape, longitude, latitude) {
  var line = turf.lineString(shape.map(function (s) { return [s.longitude, s.latitude]; }));
  var totalDistance = turf.length(line, { units: "kilometers" });
  var point = turf.point([longitude, latitude]);
  var result = turf.nearestPointOnLine(line, point);

  var index = result.properties.index;

  // Determine if stop should come before or after closest index by calculating distances
  var beforeIndexLine, beforeIndexDistance, afterIndexLine, afterIndexDistance;
  if (index === 0) {
    beforeIndexLine = turf.lineString([[longitude, latitude], [shape[0].longitude, shape[0].longitude], [shape[1].longitude, shape[1].latitude]]);
    beforeIndexDistance = turf.length(beforeIndexLine, { units: "kilometers" });
    afterIndexLine = turf.lineString([[shape[0].longitude, shape[0].longitude], [longitude, latitude], [shape[1].longitude, shape[1].latitude]]);
    afterIndexDistance = turf.length(afterIndexLine, { units: "kilometers" });

    index = beforeIndexDistance < afterIndexDistance ? 0 : 1;
  } else {
    beforeIndexLine = shape.slice(index - 1, index + 2);
    beforeIndexLine.splice(1, 0, { latitude: latitude, longitude: longitude });
    beforeIndexLine = turf.lineString(beforeIndexLine.map(function (s) { return [s.longitude, s.latitude]; }));
    beforeIndexDistance = turf.length(beforeIndexLine, { units: "kilometers" });

    afterIndexLine = shape.slice(index - 1, index + 2);
    afterIndexLine.splice(2, 0, { latitude: latitude, longitude: longitude });
    afterIndexLine = turf.lineString(afterIndexLine.map(function (s) { return [s.longitude, s.latitude]; }));
    afterIndexDistance = turf.length(afterIndexLine, { units: "kilometers" });

    index = beforeIndexDistance < afterIndexDistance ? index : index + 1;
  }

  return {
    distanceFromStart: result.properties.location,
    distanceToEnd: totalDistance - result.properties.location,
    index: index // The index at which the given point can be spliced into the shape
  };
}

function getRemainingPath(shape, index, latitude, longitude) {
  var path = shape.slice(index + 1);
  path.splice(0, 0, { latitude: latitude, longitude: longitude });
  return path.map(function (s) { return [s.latitude, s.longitude] });
}

function calculateDistance(lonLats) {
  var line = turf.lineString(lonLats);
  return turf.length(line, { units: "kilometers" });
}

function calculatePointToLineDistance(shape, latitude, longitude) {
  var pt = turf.point([longitude, latitude]);
  var line = turf.lineString(shape.map(function (s) { return [s.longitude, s.latitude]; }));
  return turf.pointToLineDistance(pt, line, { units: "kilometers" });
}

function getPosition(longitude, latitude, shape) {
  var position;
  if (longitude && latitude) { // Use current GPS location
    position = {
      longitude: longitude,
      latitude: latitude
    }
  } else { // Find estimated position based on stop times
    var currentHrs = new Date().getHours();
    var currentMins = new Date().getMinutes();
    var currentTime = currentHrs * 60 + currentMins;
    for (var i = 0; i < shape.length; i++) {
      var waypoint = shape[i];
      position = {
        latitude: waypoint.latitude,
        longitude: waypoint.longitude
      };
      if (waypoint.isStop) {
        var stopHrs = +waypoint.departureTime.substring(0, 2);
        var stopMins = +waypoint.departureTime.substring(3, 5);
        var stopTime = stopHrs * 60 + stopMins;
        if (currentTime < stopTime) {
          break;
        }
      }
    }
  }
  return position;
}

var isFetching = false;
function getFeed() {
  if (isFetching) {
    return; // Don't get feed if request is already in progress
  }
  isFetching = true;

  spinner.spin($refresh);
  var feedUrl = URI("feed")
    .addSearch("h", new Date().getHours())
    .addSearch("m", new Date().getMinutes())
    .addSearch("routes", search.routes);
  return fetch(feedUrl.toString())
    .then(function (response) {
      return response.json().then(function (entities) {
        entities.forEach(function (e) {
          var marker = vehicleLayerLookup[e.id];

          if (marker) {
            var icon = createIcon(e.routeType, e.route, e.direction, e.delay);
            marker.setIcon(icon);

            if (marker._icon) {
              if (e.longitude && e.latitude) {
                L.DomUtil.removeClass(marker._icon, "disconnected");
              } else {
                L.DomUtil.addClass(marker._icon, "disconnected");
              }
            }

            var currentPosition = getPosition(e.longitude, e.latitude, marker.options.shape);

            // Don't animate marker if:
            // - there is no shape
            // - it hasn't exceeded movement threshold, assuming that the vehicle has stopped
            // - it is too far away from the path
            // - it is at the end of the route

            if (!marker.options || !marker.options.shape) {
              marker.setLatLng([currentPosition.latitude, currentPosition.longitude]);
              marker.options.lastPosition = {
                latitude: currentPosition.latitude,
                longitude: currentPosition.longitude
              }
              marker.options.updatedAt = new Date().getTime();
              return;
            }

            var distanceFromLastPosition = calculateDistance([[marker.options.lastPosition.longitude, marker.options.lastPosition.latitude], [currentPosition.longitude, currentPosition.latitude]]);
            var distanceFromPath = calculatePointToLineDistance(marker.options.shape, currentPosition.latitude, currentPosition.longitude);
            if (distanceFromLastPosition < MOVEMENT_THRESHOLD || distanceFromPath > PATH_THRESHOLD) {
              marker.stop();
              marker.setLatLng([currentPosition.latitude, currentPosition.longitude]);
              marker.options.lastPosition = {
                latitude: currentPosition.latitude,
                longitude: currentPosition.longitude
              }
              marker.options.updatedAt = new Date().getTime();
              return;
            }

            var currNearestPoint = calculateNearestPoint(marker.options.shape, currentPosition.longitude, currentPosition.latitude);
            if (currNearestPoint.index + 1 >= marker.options.shape.length) {
              marker.stop();
              marker.setLatLng([currentPosition.latitude, currentPosition.longitude]);
              marker.options.lastPosition = {
                latitude: currentPosition.latitude,
                longitude: currentPosition.longitude
              }
              marker.options.updatedAt = new Date().getTime();
              return;
            }

            // Otherwise update position and animate
            var elapsedTime = (new Date().getTime() - marker.options.updatedAt); // ms
            var prevNearestPoint = calculateNearestPoint(marker.options.shape, marker.options.lastPosition.longitude, marker.options.lastPosition.latitude);
            var actualSpeed = Math.abs(prevNearestPoint.distanceToEnd - currNearestPoint.distanceToEnd) / elapsedTime; // km/ms
            // Adjust duration based on ratio of expected speed to actual speed
            var remainingShape = marker.options.shape.slice(currNearestPoint.index);
            var durations = remainingShape.map(function (s) { s.durationFromPrevWaypoint / actualSpeed * s.speed });

            marker.stop();
            marker._latlngs = getRemainingPath(marker.options.shape, currNearestPoint.index, currentPosition.latitude, currentPosition.longitude).map(L.latLng);
            marker._durations = durations;
            marker._currentDuration = 0;
            marker._currentIndex = 0;
            marker._state = L.Marker.MovingMarker.notStartedState;
            marker._startTime = 0;
            marker._startTimeStamp = 0;
            marker._pauseStartTime = 0;
            marker._animId = 0;
            marker._animRequested = false;
            marker._currentLine = [];
            marker._stations = {};
            marker.start();
            remainingShape.forEach(function (s, i) {
              if (s.isStop) {
                marker.addStation(i, STOP_DURATION);
              }
            });
            marker.options.lastPosition = {
              latitude: currentPosition.latitude,
              longitude: currentPosition.longitude
            }
            marker.options.updatedAt = new Date().getTime();
          } else {
            // Otherwise, create marker
            var icon = createIcon(e.routeType, e.route, e.direction, e.delay);
            if (e.shape && e.shape.length) {
              if (e.stopTimes) {
                for (var i = 0; i < e.stopTimes.length; i++) {
                  var currStopTime = e.stopTimes[i];
                  currStopTime.isStop = true;
                  var currNearestPoint = calculateNearestPoint(e.shape, currStopTime.longitude, currStopTime.latitude);
                  // Between each stop, calculate the speed
                  if (i > 0) {
                    var prevStopTime = e.stopTimes[i - 1];
                    ; // Assumes trip doesn't span across two dates
                    currStopTime.durationFromPrevStop = (Date.parse(ARBITARY_DATE + currStopTime.arrivalTime) - Date.parse(ARBITARY_DATE + prevStopTime.departureTime)); // ms
                    var prevNearestPoint = calculateNearestPoint(e.shape, prevStopTime.longitude, prevStopTime.latitude);
                    currStopTime.distanceFromPrevStop = prevNearestPoint.distanceToEnd - currNearestPoint.distanceToEnd; // km
                    currStopTime.speed = currStopTime.distanceFromPrevStop / currStopTime.durationFromPrevStop; // km/ms
                  }

                  // Insert stop into shape at right position
                  e.shape.splice(currNearestPoint.index, 0, currStopTime);
                }

                // Calculate duration between each waypoint based on speeds between stops
                for (var i = 1; i < e.shape.length; i++) {
                  var nextStop = e.shape.find(function (waypoint, index) {
                    return index > i && waypoint.isStop;
                  });
                  var currWaypoint = e.shape[i];
                  var prevWaypoint = e.shape[i - 1];
                  currWaypoint.distanceFromPrevWaypoint = calculateDistance([[prevWaypoint.longitude, prevWaypoint.latitude], [currWaypoint.longitude, currWaypoint.latitude]]);
                  if (!currWaypoint.isStop) {
                    currWaypoint.speed = nextStop && nextStop.speed || (INITIAL_SPEED / 60 / 60 / 1000) // Use
                  }
                  currWaypoint.durationFromPrevWaypoint = currWaypoint.distanceFromPrevWaypoint / currWaypoint.speed; // ms
                }
              }

              var position = getPosition(e.longitude, e.latitude, e.shape);
              var nearestPoint = calculateNearestPoint(e.shape, position.longitude, position.latitude);
              var remainingPath = getRemainingPath(e.shape, nearestPoint.index, position.latitude, position.longitude)
              marker = L.Marker.movingMarker(remainingPath, 0, {
                icon: icon,
                shape: e.shape,
                lastPosition: {
                  longitude: position.longitude,
                  latitude: position.latitude
                },
                updatedAt: new Date().getTime()
              });
            } else if (e.latitude && e.longitude) {
              // Some vehicles don't have a shape, in that case use a static marker
              marker = L.marker([e.latitude, e.longitude], {
                icon: icon,
                lastPosition: {
                  latitude: e.latitude,
                  longitude: e.longitude
                },
                updatedAt: new Date().getTime()
              });
            }
            if (marker) {
              marker.addTo(layerGroup);
              marker.on("click", function () {
                shapeGroup.clearLayers();
                if (e.shape) {
                  L.polyline(e.shape.map(function (s) { return [s.latitude, s.longitude] }), {
                    className: "shape " + e.routeType
                  }).addTo(shapeGroup);
                }
              });
              vehicleLayerLookup[e.id] = marker;
              // Need to calculate icon dimensions after adding to DOM
              var bounds = marker._icon.firstChild.getBoundingClientRect();
              icon.options.iconSize = [bounds.width, bounds.height];
              marker.setIcon(icon);
              if (e.longitude && e.latitude) {
                L.DomUtil.removeClass(marker._icon, "disconnected");
              } else {
                L.DomUtil.addClass(marker._icon, "disconnected");
              }
            }
          }
        });

        // Remove vehicles no longer in feed
        var entityIds = entities.map(function (e) { return e.id });
        var layerIds = Object.keys(vehicleLayerLookup);
        var layersToRemove = layerIds.filter(function (l) { return !entityIds.includes(l) });
        layersToRemove.forEach(function (l) {
          vehicleLayerLookup[l].remove();
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
