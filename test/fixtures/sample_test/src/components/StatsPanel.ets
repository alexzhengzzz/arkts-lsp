import { clampCount, type MetricSummary } from "../utils/format.ts";

@Reusable
@Component
export struct StatsPanel {
  @State totalUsers: number = 0;
  @State activeUsers: number = 0;

  private toMetricSummary(): MetricSummary {
    return {
      label: "activity",
      value: `${clampCount(this.activeUsers)}/${clampCount(this.totalUsers)}`,
    };
  }

  build() {
    return this.toMetricSummary();
  }
}
