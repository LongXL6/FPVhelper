import { FlightDashboard } from "@/components/flight-dashboard";
import { MeasurementProfiler } from "@/components/measurement-profiler";

export default function Home() {
  if (process.env.NEXT_PUBLIC_FPV_MEASUREMENT === "true") {
    return <MeasurementProfiler id="workbench"><FlightDashboard /></MeasurementProfiler>;
  }
  return <FlightDashboard />;
}
