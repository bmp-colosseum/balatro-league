"use client";

// Ranked-MMR-over-time line chart for player profiles (shadcn Chart / Recharts).
// Fed from the per-BMP-season snapshots; oldest → newest left to right.

import { CartesianGrid, Line, LineChart, XAxis, YAxis } from "recharts";
import {
  ChartContainer,
  ChartTooltip,
  ChartTooltipContent,
  type ChartConfig,
} from "@/components/ui/chart";

export interface MmrPoint {
  season: string;
  mmr: number;
  peak?: number | null;
}

const config = {
  mmr: { label: "MMR", color: "var(--accent-2)" },
  peak: { label: "Peak", color: "var(--accent)" },
} satisfies ChartConfig;

export function MmrChart({ data }: { data: MmrPoint[] }) {
  return (
    <ChartContainer config={config} className="h-[200px] w-full">
      <LineChart data={data} margin={{ left: 4, right: 12, top: 8, bottom: 4 }}>
        <CartesianGrid vertical={false} stroke="var(--border)" />
        <XAxis dataKey="season" tickLine={false} axisLine={false} tickMargin={8} fontSize={11} />
        <YAxis
          tickLine={false}
          axisLine={false}
          width={40}
          fontSize={11}
          domain={["dataMin - 50", "dataMax + 50"]}
        />
        <ChartTooltip content={<ChartTooltipContent />} />
        <Line dataKey="mmr" type="monotone" stroke="var(--color-mmr)" strokeWidth={2} dot={{ r: 3 }} />
        <Line
          dataKey="peak"
          type="monotone"
          stroke="var(--color-peak)"
          strokeWidth={1.5}
          strokeDasharray="4 4"
          dot={false}
          connectNulls
        />
      </LineChart>
    </ChartContainer>
  );
}
