"use client";

// Horizontal bar chart of ban rates (shadcn Chart / Recharts), for the public
// stats page. Highest ban-rate at the top.

import { Bar, BarChart, CartesianGrid, XAxis, YAxis } from "recharts";
import {
  ChartContainer,
  ChartTooltip,
  ChartTooltipContent,
  type ChartConfig,
} from "@/components/ui/chart";

export interface BanRatePoint {
  name: string;
  rate: number;
}

const config = {
  rate: { label: "Ban rate", color: "var(--danger)" },
} satisfies ChartConfig;

export function BanRateChart({ data }: { data: BanRatePoint[] }) {
  const rows = [...data].sort((a, b) => a.rate - b.rate); // recharts vertical layout draws bottom→top
  return (
    <ChartContainer config={config} className="h-[240px] w-full">
      <BarChart data={rows} layout="vertical" margin={{ left: 8, right: 24, top: 4, bottom: 4 }}>
        <CartesianGrid horizontal={false} stroke="var(--border)" />
        <XAxis type="number" tickLine={false} axisLine={false} fontSize={11} unit="%" />
        <YAxis type="category" dataKey="name" tickLine={false} axisLine={false} width={96} fontSize={11} />
        <ChartTooltip content={<ChartTooltipContent />} />
        <Bar dataKey="rate" fill="var(--color-rate)" radius={4} unit="%" />
      </BarChart>
    </ChartContainer>
  );
}
