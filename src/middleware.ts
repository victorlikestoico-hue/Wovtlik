import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';

export function middleware(request: NextRequest) {
	const { pathname } = request.nextUrl;
	
	// Permitir rutas de API públicas, de autenticación o archivos multimedia
	// (/api/meta/webhook lo llama Meta directamente y /api/meta/reminders lo llama
	// el GitHub Action de recordatorios-turnos; ninguno tiene cookie de sesión.
	// Ambos endpoints validan su propia clave — ver route.ts de cada uno.)
	if (
		pathname.startsWith('/api/auth/') ||
		pathname.startsWith('/media/') ||
		pathname === '/api/meta/webhook' ||
		pathname === '/api/meta/reminders'
	) {
		return NextResponse.next();
	}

	if (pathname === '/login') {
		const sessionCookie = request.cookies.get('bot_session');
		if (sessionCookie?.value) {
			return NextResponse.redirect(new URL('/', request.url));
		}
		return NextResponse.next();
	}

	// Proteger todas las demás rutas (raíz, páginas y otras APIs)
	const sessionCookie = request.cookies.get('bot_session');

	// Si no hay cookie de sesión, bloquear antes de exponer datos protegidos
	if (!sessionCookie?.value) {
		// Si es una petición a la API (no auth), devolver 401
		if (pathname.startsWith('/api/')) {
			return NextResponse.json({ error: 'No autorizado' }, { status: 401 });
		}

		// Redirigir al login
		return NextResponse.redirect(new URL('/login', request.url));
	}

	return NextResponse.next();
}

export const config = {
	matcher: [
		/*
		 * Match all request paths except for the ones starting with:
		 * - _next/static (static files)
		 * - _next/image (image optimization files)
		 * - media (whatsapp media)
		 * - favicon.ico, sitemap.xml, robots.txt (metadata files)
		 */
		'/((?!_next/static|_next/image|media|favicon.ico|sitemap.xml|robots.txt).*)',
	],
};
