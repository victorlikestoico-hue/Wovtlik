import { NextResponse } from "next/server";
import { authErrorToResponse, requireRequestRole } from "@/lib/auth/session";
import { runtimeSessionDeps as authDeps } from "@/lib/auth/runtime";
import { listFormAgents, addFormAgent } from "@/lib/db";

export async function GET(req: Request) {
	try {
		await requireRequestRole(req, authDeps, "viewer");
		return NextResponse.json(await listFormAgents());
	} catch (error: any) {
		const authResponse = authErrorToResponse(error);
		if (authResponse) return authResponse;
		return NextResponse.json({ error: error.message }, { status: 500 });
	}
}

export async function POST(req: Request) {
	try {
		await requireRequestRole(req, authDeps, "manager");
		const { name, phone } = await req.json() as { name?: string; phone?: string };
		if (!name?.trim() || !phone?.trim()) {
			return NextResponse.json({ error: "name y phone son requeridos" }, { status: 400 });
		}
		const agent = await addFormAgent(name, phone);
		return NextResponse.json(agent, { status: 201 });
	} catch (error: any) {
		const authResponse = authErrorToResponse(error);
		if (authResponse) return authResponse;
		if (error.code === "23505") {
			return NextResponse.json({ error: "El número ya existe en la lista" }, { status: 409 });
		}
		return NextResponse.json({ error: error.message }, { status: 500 });
	}
}
