import { NextResponse } from "next/server";
import { getRuntimeHomeDirectory } from "@/lib/runtime-paths";

export async function GET() {
  return NextResponse.json({ home: getRuntimeHomeDirectory() });
}
