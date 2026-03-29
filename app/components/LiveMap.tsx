"use client";

import L, { type LatLngTuple } from "leaflet";
import { useEffect, useMemo } from "react";
import { MapContainer, Marker, Polyline, TileLayer, useMap } from "react-leaflet";

type Coordinate = {
  lat: number;
  lng: number;
};

type LiveMapProps = {
  userLocation: Coordinate | null;
  destination: Coordinate | null;
  requestedLocation?: Coordinate | null;
  routeCoordinates: LatLngTuple[];
  destinationMode?: "target" | "bk";
};

function MapViewportController({
  userLocation,
  destination,
  requestedLocation,
  routeCoordinates,
}: LiveMapProps) {
  const map = useMap();

  useEffect(() => {
    if (routeCoordinates.length > 1) {
      const bounds = L.latLngBounds(routeCoordinates);
      if (requestedLocation) {
        bounds.extend([requestedLocation.lat, requestedLocation.lng]);
      }
      map.fitBounds(bounds, { padding: [48, 48], maxZoom: 15 });
      return;
    }

    if (userLocation) {
      map.setView([userLocation.lat, userLocation.lng], 13, { animate: true });
      return;
    }

    if (destination) {
      map.setView([destination.lat, destination.lng], 13, { animate: true });
    }
  }, [destination, map, requestedLocation, routeCoordinates, userLocation]);

  return null;
}

export default function LiveMap({
  userLocation,
  destination,
  requestedLocation,
  routeCoordinates,
  destinationMode = "bk",
}: LiveMapProps) {
  const userIcon = useMemo(
    () =>
      L.divIcon({
        className: "map-marker-wrapper",
        html: '<span class="user-dot" />',
        iconSize: [18, 18],
        iconAnchor: [9, 9],
      }),
    []
  );

  const destinationIcon = useMemo(
    () =>
      L.divIcon({
        className: "map-marker-wrapper",
        html: '<span class="destination-pin"><span class="destination-pin-core"></span></span>',
        iconSize: [26, 38],
        iconAnchor: [13, 36],
      }),
    []
  );

  const targetIcon = useMemo(
    () =>
      L.divIcon({
        className: "map-marker-wrapper",
        html: '<span class="target-pin"></span>',
        iconSize: [20, 20],
        iconAnchor: [10, 10],
      }),
    []
  );

  const center: LatLngTuple = userLocation
    ? [userLocation.lat, userLocation.lng]
    : destination
      ? [destination.lat, destination.lng]
      : [43.4516, -80.4925];

  return (
    <MapContainer
      className="live-map"
      center={center}
      zoom={13}
      scrollWheelZoom
      zoomControl
      attributionControl={false}
    >
      <TileLayer
        url="https://{s}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}{r}.png"
        maxZoom={19}
      />

      {userLocation ? (
        <Marker position={[userLocation.lat, userLocation.lng]} icon={userIcon} />
      ) : null}

      {destination ? (
        <Marker
          position={[destination.lat, destination.lng]}
          icon={destinationMode === "bk" ? destinationIcon : targetIcon}
        />
      ) : null}

      {requestedLocation ? (
        <Marker position={[requestedLocation.lat, requestedLocation.lng]} icon={targetIcon} />
      ) : null}

      {routeCoordinates.length > 1 ? (
        <>
          <Polyline
            positions={routeCoordinates}
            pathOptions={{ color: "#ffffff", weight: 9, opacity: 0.95 }}
          />
          <Polyline
            positions={routeCoordinates}
            pathOptions={
              destinationMode === "target"
                ? {
                    color: "#0ea5e9",
                    weight: 5,
                    opacity: 0.7,
                    dashArray: "6 10",
                  }
                : {
                    color: "#2563eb",
                    weight: 6,
                    opacity: 0.95,
                  }
            }
          />
        </>
      ) : null}

      <MapViewportController
        userLocation={userLocation}
        destination={destination}
        requestedLocation={requestedLocation}
        routeCoordinates={routeCoordinates}
      />
    </MapContainer>
  );
}
