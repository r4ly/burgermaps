"use client";

import type { LatLngTuple } from "leaflet";
import dynamic from "next/dynamic";
import { FormEvent, useCallback, useEffect, useMemo, useRef, useState } from "react";
import SupportAgent from "./components/SupportAgent";

type RoutePhase = "idle" | "locating" | "redirecting" | "calculating" | "done";

type Coordinate = {
  lat: number;
  lng: number;
};

type GeocodeResult = {
  point: Coordinate;
  displayName: string;
};

type BurgerKingLocation = {
  id: string;
  name: string;
  address: string;
  location: Coordinate;
};

type RouteMetrics = {
  eta: string;
  distance: string;
  steps: string[];
  stepWaypoints: Coordinate[];
};

type RouteCandidate = {
  coordinates: LatLngTuple[];
  steps: string[];
};

type ScanTelemetry = {
  candidateRoutes: number;
  graphNodes: number;
  edgeRelaxations: number;
  conflicts: number;
  confidence: number;
};

const LiveMap = dynamic(() => import("./components/LiveMap"), {
  ssr: false,
  loading: () => <div className="map-loading">Loading map...</div>,
});

const BURGER_KING_LOCATIONS: BurgerKingLocation[] = [
  {
    id: "kitchener-core",
    name: "Burger King Kitchener Core",
    address: "King Street E, Kitchener, ON",
    location: { lat: 43.4504, lng: -80.4755 },
  },
  {
    id: "kitchener-east",
    name: "Burger King Kitchener East",
    address: "Fairway Road S, Kitchener, ON",
    location: { lat: 43.4256, lng: -80.4382 },
  },
  {
    id: "kitchener-west",
    name: "Burger King Kitchener West",
    address: "Highland Road W, Kitchener, ON",
    location: { lat: 43.4308, lng: -80.4983 },
  },
  {
    id: "waterloo-north",
    name: "Burger King Waterloo North",
    address: "King Street N, Waterloo, ON",
    location: { lat: 43.4972, lng: -80.5285 },
  },
  {
    id: "waterloo-south",
    name: "Burger King Waterloo South",
    address: "University Avenue E, Waterloo, ON",
    location: { lat: 43.4698, lng: -80.5239 },
  },
];

const DEFAULT_METRICS: RouteMetrics = {
  eta: "--",
  distance: "--",
  steps: ["Allow location and tap Route to begin navigation."],
  stepWaypoints: [],
};

const OSRM_API_BASE = "https://router.project-osrm.org";
const ROUTE_REFRESH_MS = 30000;
const MIN_REQUEST_GAP_MS = 15000;
const MIN_REROUTE_DISTANCE_METERS = 35;
const REQUEST_TIMEOUT_MS = 7000;
const INITIAL_THINK_DELAY_MS = 3200;
const SCAN_STEPS = 6;
const SCAN_STEP_DELAY_MS = 3200;
const POST_SCAN_FAILURE_DELAY_MS = 1800;
const REDIRECT_DELAY_MS = 2000;
const DAILY_REQUEST_LIMIT = 160;
const REQUEST_BUDGET_STORAGE_KEY = "burgermaps_osrm_budget_v1";
const GEOCODE_TIMEOUT_MS = 5000;
const KITCHENER_BOUNDS = {
  north: 43.505,
  south: 43.39,
  east: -80.4,
  west: -80.55,
} as const;

const KW_BOUNDS = {
  north: 43.53,
  south: 43.36,
  east: -80.4,
  west: -80.61,
} as const;

const INVALID_DESTINATION_WORDS = new Set(["home", "here", "my house", "work", "office"]);

const REDIRECT_LINES = [
  "Redirecting to the furthest Burger King in KW...",
  "Detected fries opportunity. Redirecting...",
  "Calibrating hunger vector... redirecting...",
  "Route integrity check failed. Redirecting...",
];

const CHAOS_LINES = [
  "Soda resonance stable",
  "Whopper index spiking",
  "Nugget turbulence detected",
  "Drive-thru wormhole open",
];

const ADDRESS_PART_CAPS: Record<string, string> = {
  st: "St",
  street: "Street",
  ave: "Ave",
  avenue: "Avenue",
  rd: "Rd",
  road: "Road",
  dr: "Dr",
  drive: "Drive",
  ln: "Ln",
  lane: "Lane",
  blvd: "Blvd",
  boulevard: "Boulevard",
  ct: "Ct",
  court: "Court",
  e: "E",
  w: "W",
  n: "N",
  s: "S",
};

function toMetricDistance(distanceMeters: number) {
  if (distanceMeters < 1000) {
    return `${Math.round(distanceMeters)} m`;
  }

  return `${(distanceMeters / 1000).toFixed(1)} km`;
}

function toEta(durationSeconds: number) {
  const minutes = Math.max(1, Math.round(durationSeconds / 60));
  return `${minutes} min`;
}

function stepText(step: {
  name?: string;
  maneuver?: {
    type?: string;
  };
}) {
  const street = step.name ? ` on ${step.name}` : "";

  switch (step.maneuver?.type) {
    case "depart":
      return `Head out${street}`;
    case "arrive":
      return "Arrive at destination";
    case "turn":
      return `Turn${street}`;
    case "roundabout":
      return `Take roundabout exit${street}`;
    default:
      return `Continue${street}`;
  }
}

function distanceMeters(a: Coordinate, b: Coordinate) {
  const toRadians = (degrees: number) => (degrees * Math.PI) / 180;
  const earthRadius = 6371000;

  const dLat = toRadians(b.lat - a.lat);
  const dLng = toRadians(b.lng - a.lng);
  const lat1 = toRadians(a.lat);
  const lat2 = toRadians(b.lat);

  const haversine =
    Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.sin(dLng / 2) * Math.sin(dLng / 2) * Math.cos(lat1) * Math.cos(lat2);

  return earthRadius * 2 * Math.atan2(Math.sqrt(haversine), Math.sqrt(1 - haversine));
}

function furthestBurgerKing(point: Coordinate) {
  return BURGER_KING_LOCATIONS.reduce((furthest, candidate) => {
    const furthestDistance = distanceMeters(point, furthest.location);
    const nextDistance = distanceMeters(point, candidate.location);
    return nextDistance > furthestDistance ? candidate : furthest;
  });
}

function titleCaseAddress(value: string) {
  return value
    .trim()
    .split(/\s+/)
    .map((part) => {
      const normalized = part.toLowerCase().replace(/[^a-z0-9]/g, "");
      const mapped = ADDRESS_PART_CAPS[normalized];
      if (mapped) {
        return mapped;
      }

      if (/^\d+[a-z]?$/i.test(part)) {
        return part.toUpperCase();
      }

      return part.charAt(0).toUpperCase() + part.slice(1).toLowerCase();
    })
    .join(" ");
}

async function geocodeDestination(query: string): Promise<GeocodeResult | null> {
  const controller = new AbortController();
  const timeout = window.setTimeout(() => controller.abort(), GEOCODE_TIMEOUT_MS);

  try {
    const endpoint =
      `https://nominatim.openstreetmap.org/search?format=jsonv2&addressdetails=1&limit=1&countrycodes=ca&q=` +
      encodeURIComponent(query);

    const response = await fetch(endpoint, {
      signal: controller.signal,
      headers: { Accept: "application/json" },
    });

    if (!response.ok) {
      return null;
    }

    const data = (await response.json()) as Array<{ lat: string; lon: string; display_name: string }>;
    const first = data[0];
    if (!first) {
      return null;
    }

    return {
      point: {
        lat: Number(first.lat),
        lng: Number(first.lon),
      },
      displayName: first.display_name,
    };
  } catch {
    return null;
  } finally {
    window.clearTimeout(timeout);
  }
}

function isWithinKitchener(point: Coordinate) {
  return (
    point.lat >= KITCHENER_BOUNDS.south &&
    point.lat <= KITCHENER_BOUNDS.north &&
    point.lng >= KITCHENER_BOUNDS.west &&
    point.lng <= KITCHENER_BOUNDS.east
  );
}

function isWithinKW(point: Coordinate) {
  return (
    point.lat >= KW_BOUNDS.south &&
    point.lat <= KW_BOUNDS.north &&
    point.lng >= KW_BOUNDS.west &&
    point.lng <= KW_BOUNDS.east
  );
}

function looksLikeStreetAddress(value: string) {
  const text = value.trim().toLowerCase();
  if (!text || INVALID_DESTINATION_WORDS.has(text)) {
    return false;
  }

  const hasNumber = /\d/.test(text);
  const hasStreetWord = /(street|st|avenue|ave|road|rd|drive|dr|lane|ln|boulevard|blvd|way|court|ct)/i.test(text);
  return hasNumber && hasStreetWord;
}

async function fetchRouteAlternatives(
  origin: Coordinate,
  destination: Coordinate,
  signal: AbortSignal
): Promise<RouteCandidate[]> {
  const endpoint =
    `${OSRM_API_BASE}/route/v1/driving/` +
    `${origin.lng},${origin.lat};${destination.lng},${destination.lat}` +
    `?overview=full&geometries=geojson&steps=true&alternatives=true`;

  const response = await fetch(endpoint, { signal });
  if (!response.ok) {
    return [];
  }

  const data = (await response.json()) as {
    routes?: Array<{
      geometry?: { coordinates?: [number, number][] };
      legs?: Array<{
        steps?: Array<{
          name?: string;
          maneuver?: { type?: string };
        }>;
      }>;
    }>;
  };

  const routes = data.routes ?? [];
  return routes
    .slice(0, 4)
    .map((route) => {
      const coordinates: LatLngTuple[] = (route.geometry?.coordinates ?? []).map(([lng, lat]) => [
        lat,
        lng,
      ]);
      const steps = route.legs?.[0]?.steps?.slice(0, 5).map(stepText) ?? [];
      return {
        coordinates,
        steps,
      };
    })
    .filter((route) => route.coordinates.length > 1);
}

async function findFurthestBurgerKingKWBySearch(target: Coordinate): Promise<BurgerKingLocation | null> {
  const controller = new AbortController();
  const timeout = window.setTimeout(() => controller.abort(), GEOCODE_TIMEOUT_MS);

  try {
    const endpoint =
      `https://nominatim.openstreetmap.org/search?format=jsonv2&limit=40&countrycodes=ca` +
      `&bounded=1&viewbox=${KW_BOUNDS.west},${KW_BOUNDS.north},${KW_BOUNDS.east},${KW_BOUNDS.south}&q=` +
      encodeURIComponent("burger king kitchener waterloo");

    const response = await fetch(endpoint, {
      signal: controller.signal,
      headers: { Accept: "application/json" },
      cache: "no-store",
    });

    if (!response.ok) {
      return null;
    }

    const data = (await response.json()) as Array<{
      place_id: number;
      lat: string;
      lon: string;
      display_name: string;
      name?: string;
    }>;

    const candidates = data
      .filter((entry) => `${entry.name ?? ""} ${entry.display_name}`.toLowerCase().includes("burger king"))
      .map((entry) => {
        const location = { lat: Number(entry.lat), lng: Number(entry.lon) };
        return {
          id: `osm-${entry.place_id}`,
          name: entry.name?.trim() || "Burger King",
          address: entry.display_name,
          location,
        } as BurgerKingLocation;
      })
      .filter((entry) => isWithinKW(entry.location));

    if (!candidates.length) {
      return null;
    }

    return candidates.reduce((furthest, candidate) => {
      const furthestDistance = distanceMeters(target, furthest.location);
      const nextDistance = distanceMeters(target, candidate.location);
      return nextDistance > furthestDistance ? candidate : furthest;
    });
  } catch {
    return null;
  } finally {
    window.clearTimeout(timeout);
  }
}


export default function Home() {
  const [showLanding, setShowLanding] = useState(true);
  const [showHelp, setShowHelp] = useState(false);
  const [query, setQuery] = useState("");
  const [requestedDestination, setRequestedDestination] = useState("Current location");
  const [phase, setPhase] = useState<RoutePhase>("locating");
  const [navigationMode, setNavigationMode] = useState(false);
  const [navigationStepIndex, setNavigationStepIndex] = useState(0);
  const [hasRequestedRoute, setHasRequestedRoute] = useState(false);
  const [locationError, setLocationError] = useState<string | null>(null);
  const [routingError, setRoutingError] = useState<string | null>(null);
  const [userLocation, setUserLocation] = useState<Coordinate | null>(null);
  const [routeCoordinates, setRouteCoordinates] = useState<LatLngTuple[]>([]);
  const [routeMetrics, setRouteMetrics] = useState<RouteMetrics>(DEFAULT_METRICS);
  const [lastUpdatedAt, setLastUpdatedAt] = useState<string | null>(null);
  const [budgetMessage, setBudgetMessage] = useState<string | null>(null);
  const [redirectingMessage, setRedirectingMessage] = useState(REDIRECT_LINES[0]);
  const [chaosMessage, setChaosMessage] = useState(CHAOS_LINES[0]);
  const [suspenseMessage, setSuspenseMessage] = useState("Waiting for destination input");
  const [activeDestination, setActiveDestination] = useState<BurgerKingLocation | null>(null);
  const [requestedPoint, setRequestedPoint] = useState<Coordinate | null>(null);
  const [scanTelemetry, setScanTelemetry] = useState<ScanTelemetry>({
    candidateRoutes: 0,
    graphNodes: 0,
    edgeRelaxations: 0,
    conflicts: 0,
    confidence: 0,
  });

  const lastRequestAtRef = useRef(0);
  const lastRouteOriginRef = useRef<Coordinate | null>(null);
  const inflightControllerRef = useRef<AbortController | null>(null);
  const requestCountRef = useRef(0);
  const routeDestinationRef = useRef<BurgerKingLocation | null>(null);

  const consumeDailyRequestBudget = useCallback(() => {
    const today = new Date().toISOString().slice(0, 10);
    const raw = window.localStorage.getItem(REQUEST_BUDGET_STORAGE_KEY);

    let count = 0;
    if (raw) {
      try {
        const parsed = JSON.parse(raw) as { date?: string; count?: number };
        if (parsed.date === today && typeof parsed.count === "number") {
          count = parsed.count;
        }
      } catch {
        count = 0;
      }
    }

    if (count >= DAILY_REQUEST_LIMIT) {
      setBudgetMessage("Daily routing cap reached. Live updates pause to prevent API abuse.");
      return false;
    }

    const nextCount = count + 1;
    requestCountRef.current = nextCount;
    window.localStorage.setItem(
      REQUEST_BUDGET_STORAGE_KEY,
      JSON.stringify({ date: today, count: nextCount })
    );

    if (nextCount > DAILY_REQUEST_LIMIT * 0.85) {
      setBudgetMessage("Approaching daily routing cap. Updates are rate-limited.");
    } else {
      setBudgetMessage(null);
    }

    return true;
  }, []);

  const calculateRoute = useCallback(async (origin: Coordinate, destination: Coordinate) => {

    if (!consumeDailyRequestBudget()) {
      return;
    }

    const now = Date.now();
    if (now - lastRequestAtRef.current < MIN_REQUEST_GAP_MS) {
      return;
    }

    if (
      lastRouteOriginRef.current &&
      routeCoordinates.length > 1 &&
      distanceMeters(origin, lastRouteOriginRef.current) < MIN_REROUTE_DISTANCE_METERS
    ) {
      return;
    }

    setRoutingError(null);
    setPhase("calculating");
    lastRequestAtRef.current = now;

    const endpoint =
      `${OSRM_API_BASE}/route/v1/driving/` +
      `${origin.lng},${origin.lat};${destination.lng},${destination.lat}` +
      `?overview=full&geometries=geojson&steps=true`;

    inflightControllerRef.current?.abort();
    const controller = new AbortController();
    inflightControllerRef.current = controller;
    const timeout = window.setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

    try {
      const response = await fetch(endpoint, { signal: controller.signal });
      if (!response.ok) {
        throw new Error("Routing service unavailable");
      }

      const data = (await response.json()) as {
        routes?: Array<{
          distance: number;
          duration: number;
          geometry: {
            coordinates: [number, number][];
          };
          legs?: Array<{
            steps?: Array<{
              name?: string;
              distance?: number;
              maneuver?: {
                type?: string;
                location?: [number, number];
              };
            }>;
          }>;
        }>;
      };

      const route = data.routes?.[0];
      if (!route || !route.geometry?.coordinates?.length) {
        throw new Error("No route returned");
      }

      const normalizedCoordinates: LatLngTuple[] = route.geometry.coordinates.map(
        ([lng, lat]) => [lat, lng]
      );

      const routeSteps = route.legs?.[0]?.steps?.slice(0, 7) ?? [];
      const steps = routeSteps.map(stepText);
      const stepWaypoints = routeSteps
        .map((step) => {
          const location = step.maneuver?.location;
          if (!location) {
            return null;
          }

          return {
            lat: location[1],
            lng: location[0],
          };
        })
        .filter((point): point is Coordinate => Boolean(point));

      setRouteCoordinates(normalizedCoordinates);
      setRouteMetrics({
        eta: toEta(route.duration),
        distance: toMetricDistance(route.distance),
        steps: steps.length > 0 ? steps : ["Continue to Burger King"],
        stepWaypoints,
      });
      setLastUpdatedAt(new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }));
      lastRouteOriginRef.current = origin;
      setPhase("done");
    } catch {
      setRoutingError("Could not refresh live route. Retrying on next update.");
      setPhase("idle");
    } finally {
      window.clearTimeout(timeout);
      if (inflightControllerRef.current === controller) {
        inflightControllerRef.current = null;
      }
    }
  }, [consumeDailyRequestBudget, routeCoordinates.length]);

  useEffect(() => {
    const today = new Date().toISOString().slice(0, 10);
    const raw = window.localStorage.getItem(REQUEST_BUDGET_STORAGE_KEY);
    if (!raw) {
      return;
    }

    try {
      const parsed = JSON.parse(raw) as { date?: string; count?: number };
      if (parsed.date === today && typeof parsed.count === "number") {
        requestCountRef.current = parsed.count;
        if (parsed.count > DAILY_REQUEST_LIMIT * 0.85) {
          setBudgetMessage("Approaching daily routing cap. Updates are rate-limited.");
        }
      }
    } catch {
      requestCountRef.current = 0;
    }
  }, []);

  useEffect(() => {
    if (!("geolocation" in navigator)) {
      setLocationError("Geolocation is not supported on this device.");
      setPhase("idle");
      return;
    }

    const onPosition = (position: GeolocationPosition) => {
      setLocationError(null);
      setUserLocation({
        lat: position.coords.latitude,
        lng: position.coords.longitude,
      });
      setPhase((prev) => (prev === "locating" ? "idle" : prev));
    };

    const onError = () => {
      setLocationError("Location access is required for live navigation.");
      setPhase("idle");
    };

    const watchId = navigator.geolocation.watchPosition(onPosition, onError, {
      enableHighAccuracy: true,
      timeout: 10000,
      maximumAge: 3000,
    });

    return () => navigator.geolocation.clearWatch(watchId);
  }, []);

  useEffect(() => {
    return () => {
      inflightControllerRef.current?.abort();
    };
  }, []);

  useEffect(() => {
    if (!navigationMode || !userLocation || routeMetrics.stepWaypoints.length === 0) {
      return;
    }

    setNavigationStepIndex((previous) => {
      const destinationDistance = activeDestination
        ? distanceMeters(userLocation, activeDestination.location)
        : Number.POSITIVE_INFINITY;

      if (destinationDistance < 90) {
        return Math.max(previous, routeMetrics.steps.length - 1);
      }

      let nextIndex = previous;
      let closest = Number.POSITIVE_INFINITY;

      for (let i = previous; i < routeMetrics.stepWaypoints.length; i += 1) {
        const waypoint = routeMetrics.stepWaypoints[i];
        const distance = distanceMeters(userLocation, waypoint);
        if (distance < closest) {
          closest = distance;
          nextIndex = i;
        }
      }

      if (closest < 140) {
        return Math.min(routeMetrics.steps.length - 1, Math.max(previous, nextIndex));
      }

      return previous;
    });
  }, [activeDestination, navigationMode, routeMetrics.stepWaypoints, routeMetrics.steps.length, userLocation]);

  useEffect(() => {
    if (!hasRequestedRoute || !userLocation || !routeDestinationRef.current) {
      return;
    }

    const interval = window.setInterval(() => {
      if (routeDestinationRef.current) {
        void calculateRoute(userLocation, routeDestinationRef.current.location);
      }
    }, ROUTE_REFRESH_MS);

    return () => window.clearInterval(interval);
  }, [calculateRoute, hasRequestedRoute, userLocation]);

  const statusMessage = useMemo(() => {
    if (phase === "locating") {
      return "Getting your location";
    }

    if (phase === "calculating") {
      return suspenseMessage;
    }

    if (phase === "redirecting") {
      return redirectingMessage;
    }

    if (budgetMessage) {
      return budgetMessage;
    }

    if (routingError) {
      return routingError;
    }

    if (locationError) {
      return locationError;
    }

    if (phase === "done") {
      return "Live route active";
    }

    return "Type a destination to start guidance";
  }, [budgetMessage, locationError, phase, redirectingMessage, routingError, suspenseMessage]);

  const requestedDisplay = requestedDestination.trim() || "Current location";
  const currentNavigationStep = routeMetrics.steps[navigationStepIndex] ?? routeMetrics.steps[0] ?? "--";

  function buildScanTelemetry(origin: Coordinate, target: Coordinate, step: number): ScanTelemetry {
    const directDistance = distanceMeters(origin, target);
    const scale = Math.max(1, Math.floor(directDistance / 12));
    return {
      candidateRoutes: 6200 + step * 2800 + scale,
      graphNodes: 104000 + step * 37000 + scale * 3,
      edgeRelaxations: 830000 + step * 280000 + scale * 8,
      conflicts: 36 + step * 17 + Math.floor(Math.random() * 9),
      confidence: Math.min(99, 71 + step * 6 + Math.floor(Math.random() * 4)),
    };
  }

  function generateCalculationStatus(origin: Coordinate, target: Coordinate, step: number) {
    const telemetry = buildScanTelemetry(origin, target, step);
    setScanTelemetry(telemetry);
    return `Scanning lane graph ${step}/${SCAN_STEPS}: ${telemetry.candidateRoutes.toLocaleString()} candidates across ${telemetry.graphNodes.toLocaleString()} nodes, confidence ${telemetry.confidence}%`;
  }

  function generateFakeRoute(origin: Coordinate, target: Coordinate, variant: number): LatLngTuple[] {
    const midA: LatLngTuple = [
      origin.lat + (target.lat - origin.lat) * (0.28 + variant * 0.05),
      origin.lng + (target.lng - origin.lng) * (0.18 + variant * 0.04),
    ];
    const midB: LatLngTuple = [
      origin.lat + (target.lat - origin.lat) * (0.54 + variant * 0.03),
      origin.lng + (target.lng - origin.lng) * (0.64 - variant * 0.04),
    ];
    const midC: LatLngTuple = [
      origin.lat + (target.lat - origin.lat) * (0.76 + variant * 0.02),
      origin.lng + (target.lng - origin.lng) * (0.41 + variant * 0.02),
    ];

    return [
      [origin.lat, origin.lng],
      midA,
      midB,
      midC,
      [target.lat, target.lng],
    ];
  }

  async function startRoute(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();

    const rawDestination = query.trim() || "Current location";
    const nextDestination = titleCaseAddress(rawDestination);
    setRequestedDestination(nextDestination);
    setHasRequestedRoute(true);
    setNavigationMode(false);
    setNavigationStepIndex(0);
    setPhase("calculating");
    setRoutingError(null);
    setRouteCoordinates([]);
    setActiveDestination(null);
    routeDestinationRef.current = null;

    const randomRedirect = REDIRECT_LINES[Math.floor(Math.random() * REDIRECT_LINES.length)];
    const randomChaos = CHAOS_LINES[Math.floor(Math.random() * CHAOS_LINES.length)];
    setRedirectingMessage(randomRedirect);
    setChaosMessage(randomChaos);
    setSuspenseMessage("Initializing road graph cache and scan workers...");

    await new Promise((resolve) => window.setTimeout(resolve, INITIAL_THINK_DELAY_MS));

    if (!userLocation) {
      setRoutingError("Waiting for your location before computing route.");
      setPhase("idle");
      return;
    }

    if (!looksLikeStreetAddress(nextDestination)) {
      setRoutingError("Enter a real Kitchener street address, like 163 University Avenue East.");
      setPhase("idle");
      return;
    }

    const geocoded = await geocodeDestination(nextDestination);
    if (!geocoded) {
      setRoutingError("Address not found. Enter a valid Kitchener street address.");
      setPhase("idle");
      return;
    }

    setRequestedPoint(geocoded.point);

    if (!isWithinKitchener(geocoded.point)) {
      setRoutingError("That address is outside Kitchener. Enter a Kitchener street address.");
      setPhase("idle");
      return;
    }

    const precheckController = new AbortController();
    const routeAlternatives = await fetchRouteAlternatives(
      userLocation,
      geocoded.point,
      precheckController.signal
    );

    const fallbackRoutes = Array.from({ length: SCAN_STEPS }, (_, index) => index + 1).map((step) => ({
      coordinates: generateFakeRoute(userLocation, geocoded.point, step),
      steps: [],
    }));

    const suspenseRoutes = routeAlternatives.length > 0 ? routeAlternatives : fallbackRoutes;

    for (let step = 0; step < SCAN_STEPS; step += 1) {
      const route = suspenseRoutes[step % suspenseRoutes.length];
      setSuspenseMessage(generateCalculationStatus(userLocation, geocoded.point, step + 1));
      setRouteCoordinates(route.coordinates);
      await new Promise((resolve) => window.setTimeout(resolve, SCAN_STEP_DELAY_MS));
    }

    setSuspenseMessage("Primary route generation failed. Falling back to furthest burger-safe destination.");
    await new Promise((resolve) => window.setTimeout(resolve, POST_SCAN_FAILURE_DELAY_MS));

    setRedirectingMessage(
      `Unable to navigate to ${nextDestination}. Redirecting to the furthest Burger King in KW...`
    );
    setPhase("redirecting");

    const matchedBurgerKing =
      (await findFurthestBurgerKingKWBySearch(geocoded.point)) ?? furthestBurgerKing(geocoded.point);
    setActiveDestination(matchedBurgerKing);
    routeDestinationRef.current = matchedBurgerKing;

    await new Promise((resolve) => window.setTimeout(resolve, REDIRECT_DELAY_MS));

    await calculateRoute(userLocation, matchedBurgerKing.location);
  }

  function startGuidedNavigation() {
    if (!activeDestination || routeMetrics.steps.length === 0 || routeMetrics.steps[0].includes("Allow location")) {
      return;
    }

    setNavigationMode(true);
    setNavigationStepIndex(0);
  }

  function stopGuidedNavigation() {
    setNavigationMode(false);
    setNavigationStepIndex(0);
  }

  if (showLanding) {
    return (
      <div className="map-shell flex min-h-screen items-center justify-center px-4 py-8 sm:px-6">
        <main className="map-frame w-full max-w-6xl rounded-3xl border border-black/10 p-6 shadow-[0_35px_90px_-45px_rgba(30,64,175,0.5)] sm:p-8">
          <section className="grid gap-5 lg:grid-cols-[1.2fr_0.8fr] lg:items-start">
            <div>
              <p className="text-xs font-semibold uppercase tracking-[0.24em] text-sky-700">Welcome to K-W Navigation</p>
              <h1 className="mt-3 text-3xl font-semibold text-slate-900 sm:text-5xl">
                Local navigation, reimagined for calm and clarity.
              </h1>
              <p className="mt-4 max-w-2xl text-sm text-slate-600 sm:text-base">
                Start with a destination and get a guided city-driving experience built for Kitchener-Waterloo,
                with clear statuses, route intelligence, and polished turn-by-turn flow.
              </p>

              <div className="mt-5 flex flex-wrap gap-2 text-xs font-medium text-slate-700">
                <span className="rounded-full border border-black/10 bg-white/90 px-3 py-1.5">Live guidance</span>
                <span className="rounded-full border border-black/10 bg-white/90 px-3 py-1.5">Real-time reroute</span>
                <span className="rounded-full border border-black/10 bg-white/90 px-3 py-1.5">KW-aware routing</span>
                <span className="rounded-full border border-black/10 bg-white/90 px-3 py-1.5">Built for demos</span>
              </div>

              <div className="mt-6 grid gap-3 text-sm text-slate-700 sm:grid-cols-3">
                <div className="rounded-xl border border-black/10 bg-white/90 px-3 py-3">
                  <p className="text-xs uppercase tracking-wide text-slate-500">Step 1</p>
                  <p className="mt-1 font-medium text-slate-900">Enter destination</p>
                </div>
                <div className="rounded-xl border border-black/10 bg-white/90 px-3 py-3">
                  <p className="text-xs uppercase tracking-wide text-slate-500">Step 2</p>
                  <p className="mt-1 font-medium text-slate-900">Scan routes</p>
                </div>
                <div className="rounded-xl border border-black/10 bg-white/90 px-3 py-3">
                  <p className="text-xs uppercase tracking-wide text-slate-500">Step 3</p>
                  <p className="mt-1 font-medium text-slate-900">Start navigation</p>
                </div>
              </div>
            </div>

            <div className="rounded-2xl border border-black/10 bg-white/85 p-4 backdrop-blur-md">
              <p className="text-xs font-semibold uppercase tracking-[0.16em] text-slate-500">Today in the app</p>
              <div className="mt-3 space-y-3">
                <div className="rounded-xl border border-black/10 bg-slate-50 p-3">
                  <p className="text-xs text-slate-500">Coverage</p>
                  <p className="mt-1 text-sm font-semibold text-slate-900">Kitchener + Waterloo guidance zone</p>
                </div>
                <div className="rounded-xl border border-black/10 bg-slate-50 p-3">
                  <p className="text-xs text-slate-500">Experience</p>
                  <p className="mt-1 text-sm font-semibold text-slate-900">Apple-like UI with live map focus</p>
                </div>
                <div className="rounded-xl border border-black/10 bg-slate-50 p-3">
                  <p className="text-xs text-slate-500">Support</p>
                  <p className="mt-1 text-sm font-semibold text-slate-900">Built-in assistant and verification checks</p>
                </div>
              </div>
            </div>
          </section>

          <section className="mt-7 rounded-2xl border border-sky-200 bg-sky-50/80 p-4 sm:p-5">
            <p className="text-xs font-semibold uppercase tracking-[0.16em] text-sky-700">Start here</p>
            <p className="mt-1 text-sm text-slate-700">
              Open Navigator to begin a full live routing session and test the complete flow from destination input to
              guidance mode.
            </p>
            <div className="mt-3 flex flex-col gap-2 sm:flex-row sm:items-center">
              <button
                type="button"
                onClick={() => setShowLanding(false)}
                className="w-full rounded-xl bg-slate-900 px-5 py-3.5 text-sm font-semibold text-white transition hover:bg-slate-800 sm:w-auto sm:min-w-[220px]"
              >
                Open Navigator
              </button>
              <button
                type="button"
                onClick={() => {
                  setShowLanding(false);
                  setShowHelp(true);
                }}
                className="w-full rounded-xl border border-black/10 bg-white px-5 py-3.5 text-sm font-semibold text-slate-700 transition hover:bg-slate-50 sm:w-auto"
              >
                Open Help First
              </button>
            </div>
          </section>
        </main>
      </div>
    );
  }

  return (
    <div className="map-shell flex min-h-screen w-full items-center justify-center px-3 py-4 sm:px-5 sm:py-7">
      <main className="map-frame mx-auto flex w-full max-w-6xl flex-col gap-4 rounded-3xl border border-black/10 p-3 shadow-[0_30px_90px_-36px_rgba(31,74,110,0.52)] sm:gap-5 sm:p-5">
        <header className="flex flex-col gap-3 rounded-2xl border border-black/8 bg-white/75 p-3 backdrop-blur-md sm:flex-row sm:items-center sm:justify-between sm:p-4">
          <div>
            <p className="text-xs font-medium tracking-[0.14em] text-slate-500">
              k-w burger maps pro premium++
            </p>
            <h1 className="text-xl font-semibold text-slate-900 sm:text-2xl">Directions</h1>
          </div>
          <button
            type="button"
            className="h-10 w-10 rounded-full border border-black/10 bg-white text-lg font-semibold text-slate-700 transition hover:bg-slate-50"
            onClick={() => setShowHelp(true)}
            aria-label="How to use"
          >
            ?
          </button>
          {navigationMode ? (
            <div className="w-full rounded-xl border border-sky-200 bg-sky-50/70 p-3 sm:max-w-xl">
              <p className="text-xs font-semibold uppercase tracking-[0.18em] text-sky-700">Navigation active</p>
              <p className="mt-1 text-sm font-semibold text-slate-900">{currentNavigationStep}</p>
              <div className="mt-2 flex gap-2">
                <button
                  type="button"
                  onClick={stopGuidedNavigation}
                  className="rounded-lg border border-black/10 bg-white px-3 py-1.5 text-xs font-medium text-slate-700 transition hover:bg-slate-50"
                >
                  Exit nav mode
                </button>
              </div>
            </div>
          ) : (
            <form className="flex w-full gap-2 sm:max-w-xl" onSubmit={startRoute}>
              <input
                type="text"
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                className="focus-ring min-w-0 flex-1 rounded-xl border border-black/10 bg-white px-3 py-2.5 text-sm text-slate-900 shadow-sm outline-none placeholder:text-slate-400 sm:text-base"
                placeholder="Where do you want to go?"
                aria-label="Destination"
              />
              <button
                type="submit"
                className="rounded-xl bg-slate-900 px-4 py-2.5 text-sm font-medium text-white transition hover:bg-slate-800"
              >
                Route
              </button>
            </form>
          )}
          {routingError ? <p className="apple-inline-alert">{routingError}</p> : null}
        </header>

        <section className="flex flex-col gap-4 lg:grid lg:grid-cols-[1.4fr_0.8fr]">
          <div className="relative overflow-hidden rounded-2xl border border-black/10 bg-slate-100 p-3 sm:p-4">
            <div className="map-container-wrap">
              <LiveMap
                userLocation={userLocation}
                destination={activeDestination?.location ?? null}
                requestedLocation={requestedPoint}
                routeCoordinates={routeCoordinates}
                destinationMode={phase === "done" || phase === "redirecting" ? "bk" : "target"}
              />
              <div className="map-chip map-chip-left">{navigationMode ? "Navigation mode" : "Redirect mode"}</div>
              <div className="map-chip map-chip-right">{chaosMessage}</div>
            </div>
          </div>

          <aside className="rounded-2xl border border-black/10 bg-white/80 p-4 backdrop-blur-md">
            <p className="text-xs font-medium uppercase tracking-[0.2em] text-slate-500">Status</p>
            <p className="mt-1 text-sm text-slate-700">{statusMessage}</p>

            <div className="mt-4 overflow-hidden rounded-lg border border-black/10 bg-slate-50">
              <div
                className={`progress-strip ${
                  phase === "redirecting" || phase === "calculating" ? "progress-active" : ""
                }`}
              />
            </div>

            <p className="mt-2 text-xs text-slate-500">
              Free stack: OSM tiles + Nominatim geocoding + OSRM routing (no paid keys)
            </p>

            {phase === "calculating" ? (
              <div className="mt-4 rounded-xl border border-black/10 bg-white p-3">
                <p className="text-xs font-semibold uppercase tracking-[0.16em] text-slate-500">Route scanner</p>
                <div className="mt-2 grid grid-cols-2 gap-2 text-xs text-slate-700">
                  <div className="rounded-lg border border-black/8 bg-slate-50 px-2 py-1.5">
                    Candidates: {scanTelemetry.candidateRoutes.toLocaleString()}
                  </div>
                  <div className="rounded-lg border border-black/8 bg-slate-50 px-2 py-1.5">
                    Graph nodes: {scanTelemetry.graphNodes.toLocaleString()}
                  </div>
                  <div className="rounded-lg border border-black/8 bg-slate-50 px-2 py-1.5">
                    Edge relaxations: {scanTelemetry.edgeRelaxations.toLocaleString()}
                  </div>
                  <div className="rounded-lg border border-black/8 bg-slate-50 px-2 py-1.5">
                    Conflicts resolved: {scanTelemetry.conflicts.toLocaleString()}
                  </div>
                </div>
              </div>
            ) : null}

            <div className="mt-5 space-y-3 text-sm">
              <div>
                <p className="text-slate-500">Requested destination</p>
                <p className="truncate font-medium text-slate-900">{requestedDisplay}</p>
              </div>
              {activeDestination ? (
                <div>
                  <p className="text-slate-500">Navigating to</p>
                  <p className="font-semibold text-slate-900">{activeDestination.name}</p>
                  <p className="text-slate-600">{activeDestination.address}</p>
                </div>
              ) : (
                <div>
                  <p className="text-slate-500">Navigation target</p>
                  <p className="font-medium text-slate-800">Awaiting route computation</p>
                  <p className="text-slate-600">Destination will appear after route validation.</p>
                </div>
              )}
            </div>

            {activeDestination && (phase === "redirecting" || phase === "done") ? (
              <div className="bk-override-banner">
                <div className="bk-override-headline">
                  <span className="bk-override-dot" aria-hidden />
                  <p className="bk-override-label">Destination override active</p>
                </div>
                <p className="bk-override-destination">Final destination: Burger King</p>
                <p className="bk-override-subtitle">Your requested address was rerouted by policy.</p>
              </div>
            ) : null}

            <div className="mt-5 grid grid-cols-2 gap-2 rounded-xl border border-black/10 bg-white p-3">
              <div>
                <p className="text-xs uppercase tracking-wide text-slate-500">ETA</p>
                <p className="text-lg font-semibold text-slate-900">{routeMetrics.eta}</p>
              </div>
              <div>
                <p className="text-xs uppercase tracking-wide text-slate-500">Distance</p>
                <p className="text-lg font-semibold text-slate-900">{routeMetrics.distance}</p>
              </div>
            </div>

            <p className="mt-2 text-xs text-slate-500">
              {lastUpdatedAt ? `Last updated ${lastUpdatedAt}` : "Awaiting first route update"}
            </p>

            {phase === "done" && activeDestination ? (
              <div className="mt-5 space-y-2">
                {routeMetrics.steps.map((step, index) => (
                  <div
                    key={`${step}-${index}`}
                    className="rounded-lg border border-black/10 bg-white px-3 py-2 text-sm text-slate-700"
                  >
                    <span className="mr-2 text-xs font-semibold text-slate-500">{index + 1}</span>
                    {step}
                  </div>
                ))}
              </div>
            ) : null}

            <button
              className="mt-5 w-full rounded-xl bg-[#f97316] px-4 py-2.5 text-sm font-semibold text-white transition hover:bg-[#ea580c]"
              type="button"
              onClick={startGuidedNavigation}
              disabled={!activeDestination}
            >
              {navigationMode ? "Navigation Active" : "Start Navigation"}
            </button>
          </aside>
        </section>
      </main>
      {showHelp ? (
        <div className="fixed inset-0 z-[1200] flex items-center justify-center bg-slate-900/45 px-4">
          <section className="w-full max-w-3xl rounded-2xl border border-black/10 bg-white p-5 shadow-2xl sm:p-6">
            <div className="flex items-start justify-between">
              <h2 className="text-lg font-semibold text-slate-900">K-W Navigation Help Center</h2>
              <button
                type="button"
                className="rounded-md px-2 py-1 text-sm text-slate-500 hover:bg-slate-100"
                onClick={() => setShowHelp(false)}
                aria-label="Close help"
              >
                x
              </button>
            </div>
            <p className="mt-1 text-sm text-slate-600">Everything you need to route, troubleshoot, and navigate inside KW.</p>

            <div className="mt-4 grid gap-4 sm:grid-cols-2">
              <article className="rounded-xl border border-black/10 bg-slate-50 p-4">
                <p className="text-xs font-semibold uppercase tracking-[0.15em] text-slate-500">Quick Start</p>
                <ol className="mt-2 list-decimal space-y-1 pl-4 text-sm text-slate-700">
                  <li>Type a full Kitchener street address.</li>
                  <li>Press Route and wait for route analysis.</li>
                  <li>Review live status and calculated ETA.</li>
                  <li>Use Start Navigation to enter guidance mode.</li>
                </ol>
              </article>

              <article className="rounded-xl border border-black/10 bg-slate-50 p-4">
                <p className="text-xs font-semibold uppercase tracking-[0.15em] text-slate-500">Status Indicators</p>
                <div className="mt-2 space-y-2 text-sm text-slate-700">
                  <p><span className="font-semibold">Calculating:</span> route graph is being analyzed.</p>
                  <p><span className="font-semibold">Redirecting:</span> fallback routing policy is active.</p>
                  <p><span className="font-semibold">Live route active:</span> guidance updates are running.</p>
                </div>
              </article>

              <article className="rounded-xl border border-black/10 bg-slate-50 p-4">
                <p className="text-xs font-semibold uppercase tracking-[0.15em] text-slate-500">Map Legend</p>
                <div className="mt-2 space-y-2 text-sm text-slate-700">
                  <p><span className="font-semibold">Blue dot:</span> your live position.</p>
                  <p><span className="font-semibold">Map icon marker:</span> requested destination point.</p>
                  <p><span className="font-semibold">Orange burger pin:</span> active destination endpoint.</p>
                </div>
              </article>

              <article className="rounded-xl border border-black/10 bg-slate-50 p-4">
                <p className="text-xs font-semibold uppercase tracking-[0.15em] text-slate-500">Need Support?</p>
                <p className="mt-2 text-sm text-slate-700">
                  Open the support button in the lower-right corner for troubleshooting help and routing checks.
                </p>
              </article>
            </div>
          </section>
        </div>
      ) : null}
      <SupportAgent />
    </div>
  );
}
