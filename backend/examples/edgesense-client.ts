/** Copy into the frontend when integrating. No camera frames belong in this module. */
export type Landmark = { x: number; y: number; z: number; visibility: number };
export type Pose = { zone_id: string; landmarks: Landmark[]; received_at: string };
export type Aggregate = {
  batch_id: string;
  zone_id: string;
  window_start: string;
  window_seconds: number;
  valid_observation_seconds: number;
  posture_alert_episodes: number;
  heat_alert_episodes: number;
  noise_alert_episodes: number;
  air_quality_alert_episodes: number;
  environment: {
    source: "simulated" | "sensor";
    temperature_max_c: number;
    noise_max_db: number;
    air_quality_max_aqi: number;
  };
};
export type AlertCounts = Pick<Aggregate,
  "posture_alert_episodes" | "heat_alert_episodes" |
  "noise_alert_episodes" | "air_quality_alert_episodes">;
export type Dashboard = {
  hours: number;
  zones: (AlertCounts & { zone_id: string; batches: number;
    valid_observation_seconds: number; environment_sources: string[] })[];
  hourly: (AlertCounts & { hour: string })[];
  recommendations: { zone_id: string; category: keyof AlertCounts;
    alert_episodes: number; message: string; source: "rule_based" }[];
  notice: string;
};

export function createEdgeSenseClient(baseUrl: string, apiKey = "") {
  const base = baseUrl.replace(/\/$/, "");
  async function request<T>(path: string, method = "GET", body?: unknown): Promise<T | null> {
    const response = await fetch(`${base}${path}`, {
      method,
      cache: "no-store",
      signal: AbortSignal.timeout(5000),
      headers: {
        ...(body === undefined ? {} : { "Content-Type": "application/json" }),
        ...(apiKey ? { "X-API-Key": apiKey } : {}),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    if (!response.ok) throw new Error(`EdgeSense API: ${response.status}`);
    return response.status === 204 ? null : response.json() as Promise<T>;
  }
  return {
    sendPose(zoneId: string, landmarks: Landmark[]) {
      // Explicit allowlist: never spread MediaPipe results, video or canvas objects.
      return request<{ accepted: boolean; expires_in_seconds: number }>("/api/v1/pose", "POST", {
        zone_id: zoneId,
        landmarks: landmarks.map(({ x, y, z, visibility }) => ({ x, y, z, visibility })),
      });
    },
    getPose(zoneId: string) {
      return request<Pose>(`/api/v1/pose/${encodeURIComponent(zoneId)}`);
    },
    clearPose(zoneId: string) {
      return request<never>(`/api/v1/pose/${encodeURIComponent(zoneId)}`, "DELETE");
    },
    sendAggregate(batch: Aggregate) {
      return request<{ accepted: boolean; duplicate: boolean; batch_id: string }>("/api/v1/aggregates", "POST", batch);
    },
    dashboard(zoneId?: string, hours = 24) {
      const query = new URLSearchParams({ hours: String(hours) });
      if (zoneId) query.set("zone_id", zoneId);
      return request<Dashboard>(`/api/v1/dashboard?${query}`);
    },
  };
}
