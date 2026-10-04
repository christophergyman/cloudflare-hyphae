/**
 * Thin metrics seam (ADR-022). The Hub and the merge Workflow write points
 * here; the Cloudflare adapter feeds Workers Analytics Engine.
 *
 * Keeping this as an interface means shared packages stay runtime-agnostic
 * and tests can use the no-op implementation.
 */

export interface MetricPoint {
  /** Analytics Engine index, usually the repo id. */
  index: string;
  /** Numeric samples, e.g. [latencyMs, version]. */
  doubles?: number[];
  /** String samples, e.g. ["merge", "verified", actorId]. */
  blobs?: string[];
}

export interface Metrics {
  write(point: MetricPoint): void;
}

export const noopMetrics: Metrics = {
  write() {},
};

/** Minimal shape of an Analytics Engine binding (env.METRICS). */
export interface AnalyticsEngineDatasetLike {
  writeDataPoint(point: { index?: string; doubles?: number[]; blobs?: string[] }): void;
}

export function analyticsEngineMetrics(dataset: AnalyticsEngineDatasetLike): Metrics {
  return {
    write(point: MetricPoint) {
      dataset.writeDataPoint({
        index: point.index,
        doubles: point.doubles,
        blobs: point.blobs,
      });
    },
  };
}
